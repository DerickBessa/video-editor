// background — blur, darken or replace what is behind the subject.
//
// The brief says to build this ONLY if the quality is acceptable, so here is
// the honest position:
//
//   vignette   Needs no model at all. Darkens the edges of the frame. Not
//              true background separation, but it is reliable, cheap, and
//              often all a talking head needs.
//   blur       Real segmentation (MediaPipe selfie segmenter) + `maskedmerge`.
//   darken     Same, but dims instead of blurring.
//   replace    Same, compositing over an image or video.
//
// The segmentation MODEL is MediaPipe's, and its quality on any given footage
// is not something this project measured — there is no real person footage in
// the repo to measure it on. What IS verified here is the mechanism: a mask is
// produced, and the effect lands outside it and not inside. `foregroundRatio`
// is reported so a caller can see when segmentation found nothing and refuse
// the result rather than shipping a fully blurred video.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, encodeArgs } from '../lib/ffmpeg.mjs';
import { runPython } from '../lib/python.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { cacheKey } from '../lib/hash.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

export const MODES = ['vignette', 'blur', 'darken', 'replace'];
export const SEGMENTER_MODEL = 'selfie_segmenter.tflite';

/** Modes that need a person/background matte. */
const NEEDS_MASK = new Set(['blur', 'darken', 'replace']);

/**
 * @param {string} input
 * @param {{mode?:string, strength?:number, replaceWith?:string, feather?:number,
 *          temporal?:number, out?:string, quality?:string, hw?:string, force?:boolean}} opts
 */
export async function background(input, opts = {}) {
  const mode = opts.mode || 'vignette';
  if (!MODES.includes(mode)) throw usageError(`Unknown mode "${mode}"`, `Use: ${MODES.join(', ')}`);

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) throw inputError(`${relToRoot(abs)} has no video track`);

  const strength = Math.min(1, Math.max(0, opts.strength ?? 0.7));
  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-bg-${mode}.mp4`));
  const { args: enc } = await encodeArgs({ quality: opts.quality || 'final', hw: opts.hw || 'auto' });

  /* ------------------------------------------------ no-model path */

  if (mode === 'vignette') {
    // A plain vignette. Honest about what it is: it dims the EDGES, it does
    // not know where the person is.
    const angle = (Math.PI / 5) * (1 - strength * 0.45);
    await ffmpeg([
      '-y', '-i', abs,
      '-vf', `vignette=angle=${angle.toFixed(4)}:mode=forward,format=yuv420p`,
      ...(meta.hasAudio ? ['-map', '0:v', '-map', '0:a', '-c:a', 'copy'] : ['-map', '0:v', '-an']),
      ...stripVf(enc), out,
    ], { label: 'background(vignette)', totalSec: meta.duration });

    const got = await probeVideo(out);
    return shape({ abs, out, got, mode, strength, mask: null, meta });
  }

  /* ------------------------------------------------ segmentation path */

  const model = path.join(DIR.models, SEGMENTER_MODEL);
  if (!fs.existsSync(model)) {
    throw inputError(`segmentation model not found: ${relToRoot(model)}`,
      'Download selfie_segmenter.tflite from ' +
      'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/ ' +
      `into ${relToRoot(DIR.models)}/ — or use --mode vignette, which needs no model.`);
  }

  const feather = opts.feather ?? 9;
  const temporal = opts.temporal ?? 0.6;

  // An externally supplied matte bypasses segmentation entirely. Useful when a
  // better mask exists (a green-screen key, a hand-made matte), and it is how
  // the compositing itself is tested independently of the model.
  if (opts.mask) {
    const maskFile = resolveInput(opts.mask, 'mask');
    const composed = await composite({
      abs, meta, mode, strength, maskFile, out, enc,
      replaceWith: opts.replaceWith, duration: meta.duration,
    });
    return shape({ abs, out, got: composed, mode, strength,
      mask: { mask: maskFile, cached: true, foregroundRatio: null, supplied: true },
      meta, replaceWith: opts.replaceWith });
  }
  const key = cacheKey(abs, { feather, temporal });
  const maskFile = path.join(ensureDir(path.join(DIR.cache, 'masks')), `${slug(abs)}-${key}.mkv`);

  // The mask's STATS are cached beside it. Without this, a cached mask came
  // back with foregroundRatio = null, the "found no subject" guard below was
  // skipped, and a re-run of a video with no subject silently blurred the whole
  // frame — the exact failure the guard exists to prevent.
  const statsFile = `${maskFile}.json`;
  let maskInfo;
  if (!opts.force && fs.existsSync(maskFile) && fs.statSync(maskFile).size > 1000 && fs.existsSync(statsFile)) {
    log.debug(`background: reusing mask ${relToRoot(maskFile)}`);
    maskInfo = { ...JSON.parse(fs.readFileSync(statsFile, 'utf8')), mask: maskFile, cached: true };
  } else {
    maskInfo = await runPython('segment_person.py', [
      '--video', abs, '--model', model, '--output', maskFile,
      '--feather', String(feather), '--temporal', String(temporal),
    ], { label: 'segment-person', timeoutMs: 0, onLog: line => log.debug(line) });
    maskInfo.cached = false;
    fs.writeFileSync(statsFile, JSON.stringify({
      foregroundRatio: maskInfo.foregroundRatio, frames: maskInfo.frames,
      feather: maskInfo.feather, temporal: maskInfo.temporal,
    }));
  }

  if (typeof maskInfo.foregroundRatio === 'number' && maskInfo.foregroundRatio < 0.02) {
    throw validationError(
      `segmentation found essentially no subject (${((maskInfo.foregroundRatio ?? 0) * 100).toFixed(1)}% foreground)`,
      { hint: 'The whole frame would be treated as background. Use --mode vignette, or check the footage.' }
    );
  }

  const got = await composite({
    abs, meta, mode, strength, maskFile, out, enc,
    replaceWith: opts.replaceWith, duration: meta.duration,
  });

  return shape({ abs, out, got, mode, strength, mask: maskInfo, meta, replaceWith: opts.replaceWith });
}


/**
 * Composite a processed background with the untouched subject, using a matte.
 *
 * `maskedmerge` takes (base, overlay, mask) and picks the OVERLAY where the
 * mask is white. So the overlay is the original frame (the subject) and the
 * base is the processed background — getting these the wrong way round blurs
 * the person and leaves the room sharp.
 */
async function composite({ abs, meta, mode, strength, maskFile, out, enc, replaceWith, duration }) {
  const parts = [];
  const inputs = ['-i', abs, '-i', maskFile];

  if (mode === 'replace') {
    if (!replaceWith) throw usageError('--mode replace needs --replace-with <image or video>');
    const bg = resolveInput(replaceWith, 'replaceWith');
    const isImage = /\.(png|jpe?g|webp|bmp)$/i.test(bg);
    if (isImage) inputs.push('-loop', '1', '-t', String(duration), '-i', bg);
    else inputs.push('-stream_loop', '-1', '-t', String(duration), '-i', bg);
    parts.push(
      `[2:v]scale=${meta.width}:${meta.height}:force_original_aspect_ratio=increase,` +
      `crop=${meta.width}:${meta.height},setsar=1,format=yuv420p,fps=${meta.fps || 30}[bg]`
    );
  } else if (mode === 'blur') {
    const sigma = Math.max(6, Math.round(meta.height * 0.03 * (0.4 + strength)));
    parts.push(`[0:v]gblur=sigma=${sigma}:steps=3,format=yuv420p[bg]`);
  } else {
    parts.push(
      `[0:v]eq=brightness=${(-0.55 * strength).toFixed(3)}:saturation=${(1 - 0.5 * strength).toFixed(3)},` +
      `format=yuv420p[bg]`
    );
  }

  parts.push(`[0:v]format=yuv420p[fg]`);
  parts.push(`[1:v]format=gray,scale=${meta.width}:${meta.height}[mask]`);
  parts.push(`[bg][fg][mask]maskedmerge,format=yuv420p[vout]`);

  await ffmpeg([
    '-y', ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', '[vout]',
    ...(meta.hasAudio ? ['-map', '0:a', '-c:a', 'copy'] : ['-an']),
    ...stripVf(enc),
    '-t', String(duration),
    out,
  ], { label: `background(${mode})`, totalSec: duration });

  const got = await probeVideo(out);
  if (got.width !== meta.width || got.height !== meta.height) {
    throw validationError(`background changed the frame size to ${got.width}x${got.height}`);
  }
  return got;
}

function shape({ abs, out, got, mode, strength, mask, meta, replaceWith }) {
  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    mode,
    strength,
    segmented: Boolean(mask),
    maskFile: mask ? relToRoot(mask.mask) : null,
    maskCached: mask?.cached ?? null,
    foregroundRatio: mask?.foregroundRatio ?? null,
    replaceWith: replaceWith ? relToRoot(path.resolve(replaceWith)) : null,
    width: got.width,
    height: got.height,
    duration: got.duration,
    sourceDuration: meta.duration,
    hasAudio: got.hasAudio,
    sizeBytes: got.sizeBytes,
  };
}

function stripVf(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-vf') { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

export const tool = {
  name: 'background',
  summary: 'Blur, darken or replace the background behind the subject.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    mode: { type: 'enum', values: MODES, default: 'vignette', help: 'vignette (no model) | blur | darken | replace' },
    strength: { type: 'number', default: 0.7, help: '0..1' },
    replaceWith: { type: 'string', help: 'Image or video to use as the new background' },
    feather: { type: 'number', default: 9, help: 'Mask edge softness in px' },
    temporal: { type: 'number', default: 0.6, help: '0..1 — mask smoothing between frames, to stop flicker' },
    mask: { type: 'string', help: 'Use a supplied matte video instead of segmenting' },
    force: { type: 'bool', default: false, help: 'Re-run segmentation instead of reusing a cached mask' },
    out: { type: 'string', help: 'Output path' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've background raw/talk.mp4 --mode vignette',
    've background raw/talk.mp4 --mode blur --strength 0.8',
    've background raw/talk.mp4 --mode replace --replace-with assets/overlays/office.jpg',
  ],
  run: opts => background(opts.input, opts),
  pretty: r => `${r.mode}${r.segmented ? ` (foreground ${r.foregroundRatio === null ? 'cached' : `${Math.round(r.foregroundRatio * 100)}%`})` : ''}` +
    ` -> ${r.output}  ${r.width}x${r.height}`,
};

runIfMain(tool, import.meta.url);
