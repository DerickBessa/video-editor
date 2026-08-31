// qa-video — inspect a finished render and say whether it is actually good.
//
// Every check answers a failure that has really happened in editing pipelines:
// a render that silently truncated, a filter chain that dropped the audio, a
// black frame at a cut, captions running off the bottom of a vertical crop,
// audio that clips because two mixes stacked.
//
// Checks are graded. `fail` means do not ship it; `warn` means look at it. The
// tool exits non-zero only on failures, so it can gate a pipeline.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, ffprobeJson } from '../lib/ffmpeg.mjs';
import { run } from '../lib/proc.mjs';
import { FFMPEG } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { VeError, EXIT } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

/**
 * @param {string} input
 * @param {{expectDuration?:number, expectWidth?:number, expectHeight?:number, expectFps?:number,
 *          durationTolerance?:number, maxBlackRatio?:number, requireAudio?:boolean,
 *          captionsAss?:string, out?:string}} opts
 */
export async function qaVideo(input, opts = {}) {
  const abs = resolveInput(input, 'video');
  const checks = [];
  const add = (name, status, message, detail) => checks.push({ name, status, message, ...(detail ? { detail } : {}) });

  /* --- the file itself */
  const size = fs.statSync(abs).size;
  if (size < 1024) add('file-size', 'fail', `output is only ${size} bytes`);
  else add('file-size', 'pass', `${(size / 1048576).toFixed(2)} MB`);

  let meta;
  try {
    meta = await probeVideo(abs);
  } catch (e) {
    add('readable', 'fail', `ffprobe cannot read the file: ${e.message}`);
    return finish(abs, checks, null, opts);
  }
  add('readable', 'pass', `${meta.container}`);

  /* --- streams */
  if (!meta.hasVideo) add('video-stream', 'fail', 'no video stream');
  else add('video-stream', 'pass', `${meta.codec} ${meta.width}x${meta.height}`);

  if (!meta.hasAudio) {
    add('audio-stream', opts.requireAudio === false ? 'warn' : 'fail', 'no audio stream');
  } else {
    add('audio-stream', 'pass', `${meta.audioCodec} ${meta.sampleRate}Hz ${meta.channels}ch`);
  }

  /* --- geometry */
  if (opts.expectWidth && opts.expectHeight) {
    const ok = meta.width === opts.expectWidth && meta.height === opts.expectHeight;
    add('resolution', ok ? 'pass' : 'fail',
      `${meta.width}x${meta.height}${ok ? '' : ` (expected ${opts.expectWidth}x${opts.expectHeight})`}`);
  } else {
    add('resolution', 'pass', `${meta.width}x${meta.height}`);
  }
  if (meta.width % 2 || meta.height % 2) {
    add('even-dimensions', 'fail', `${meta.width}x${meta.height} — yuv420p requires even dimensions`);
  }

  if (opts.expectFps) {
    const ok = Math.abs(meta.fps - opts.expectFps) < 0.5;
    add('framerate', ok ? 'pass' : 'warn', `${meta.fps}fps${ok ? '' : ` (expected ${opts.expectFps})`}`);
  }

  /* --- duration */
  if (opts.expectDuration) {
    const tol = opts.durationTolerance ?? Math.max(0.5, opts.expectDuration * 0.03);
    const drift = meta.duration - opts.expectDuration;
    add('duration', Math.abs(drift) <= tol ? 'pass' : 'fail',
      `${meta.duration}s (expected ${opts.expectDuration}s, drift ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s)`);
  } else {
    add('duration', meta.duration > 0.2 ? 'pass' : 'fail', `${meta.duration}s`);
  }

  /* --- A/V sync: the two streams should end together */
  if (meta.hasAudio && meta.hasVideo) {
    const j = await ffprobeJson(abs);
    const v = Number(j.streams.find(s => s.codec_type === 'video')?.duration);
    const a = Number(j.streams.find(s => s.codec_type === 'audio')?.duration);
    if (Number.isFinite(v) && Number.isFinite(a)) {
      const skew = Math.abs(v - a);
      add('av-sync', skew < 0.25 ? 'pass' : skew < 0.6 ? 'warn' : 'fail',
        `audio/video length differ by ${skew.toFixed(3)}s`);
    }
  }

  /* --- black frames */
  const black = await detectBlack(abs, meta.duration);
  const maxRatio = opts.maxBlackRatio ?? 0.08;
  if (black.ratio > maxRatio) {
    add('black-frames', 'fail', `${(black.ratio * 100).toFixed(1)}% of the video is black`, black.ranges.slice(0, 5));
  } else if (black.ranges.length) {
    add('black-frames', 'warn', `${black.ranges.length} black stretch(es), ${(black.ratio * 100).toFixed(1)}%`, black.ranges.slice(0, 5));
  } else {
    add('black-frames', 'pass', 'none');
  }
  // A black FIRST frame is its own problem: it is what a thumbnail picks up.
  if (black.ranges.some(r => r.start < 0.15)) {
    add('black-first-frame', 'warn', 'the video opens on black, which will be the thumbnail');
  }

  /* --- audio levels */
  if (meta.hasAudio) {
    const levels = await audioLevels(abs);
    if (levels.max !== null) {
      if (levels.max >= -0.1) add('audio-clipping', 'fail', `peaks at ${levels.max} dBFS — clipping`);
      else if (levels.max > -1) add('audio-clipping', 'warn', `peaks at ${levels.max} dBFS, very close to full scale`);
      else add('audio-clipping', 'pass', `peak ${levels.max} dBFS`);

      if (levels.mean !== null) {
        if (levels.mean < -45) add('audio-level', 'fail', `mean level ${levels.mean} dBFS — effectively silent`);
        else if (levels.mean < -32) add('audio-level', 'warn', `mean level ${levels.mean} dBFS is very quiet`);
        else add('audio-level', 'pass', `mean ${levels.mean} dBFS`);
      }
    }
  }

  /* --- captions inside the safe area */
  if (opts.captionsAss && fs.existsSync(opts.captionsAss)) {
    const c = checkCaptionBounds(opts.captionsAss, meta);
    add('caption-bounds', c.ok ? 'pass' : 'warn', c.message, c.detail);
  }

  return finish(abs, checks, meta, opts);
}

/* ------------------------------------------------------------- detectors */

async function detectBlack(file, duration) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-i', file,
    '-vf', 'blackdetect=d=0.12:pic_th=0.98:pix_th=0.10',
    '-an', '-f', 'null', '-',
  ], { timeoutMs: 900000 });

  const ranges = [];
  for (const m of stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)) {
    ranges.push({ start: Number(m[1]), end: Number(m[2]), duration: round(Number(m[2]) - Number(m[1])) });
  }
  const total = ranges.reduce((s, r) => s + (r.end - r.start), 0);
  return { ranges, total: round(total), ratio: duration ? round(total / duration, 4) : 0 };
}

async function audioLevels(file) {
  try {
    const { stderr } = await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'info', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-',
    ], { timeoutMs: 600000 });
    const max = /max_volume:\s*(-?[\d.]+)/.exec(stderr);
    const mean = /mean_volume:\s*(-?[\d.]+)/.exec(stderr);
    return { max: max ? Number(max[1]) : null, mean: mean ? Number(mean[1]) : null };
  } catch {
    return { max: null, mean: null };
  }
}

/**
 * Read the .ass and check nothing is positioned outside the frame.
 * Cheap structural check — it cannot know how wide the rendered text is, but it
 * does catch a margin or PlayRes that does not match the video, which is the
 * usual cause of captions sitting off-screen.
 */
export function checkCaptionBounds(assFile, meta) {
  const text = fs.readFileSync(assFile, 'utf8');
  const resX = Number(/PlayResX:\s*(\d+)/.exec(text)?.[1]);
  const resY = Number(/PlayResY:\s*(\d+)/.exec(text)?.[1]);

  if (!resX || !resY) return { ok: false, message: 'the subtitle file declares no PlayRes' };
  if (resX !== meta.width || resY !== meta.height) {
    return {
      ok: false,
      message: `subtitle PlayRes ${resX}x${resY} does not match the video ${meta.width}x${meta.height}; libass will rescale everything`,
    };
  }

  const style = /^Style:\s*([^\n]+)$/m.exec(text);
  if (style) {
    const f = style[1].split(',');
    const fontSize = Number(f[2]);
    const marginV = Number(f[21]);
    if (Number.isFinite(fontSize) && Number.isFinite(marginV)) {
      // Two lines of text plus its margin must fit inside the frame.
      const needed = marginV + fontSize * 2.4;
      if (needed > resY) {
        return { ok: false, message: `captions need ~${Math.round(needed)}px but the frame is ${resY}px tall`, detail: { fontSize, marginV } };
      }
      return { ok: true, message: `font ${fontSize}px, margin ${marginV}px — fits`, detail: { fontSize, marginV } };
    }
  }
  return { ok: true, message: 'PlayRes matches the video' };
}

function finish(abs, checks, meta, opts) {
  const failed = checks.filter(c => c.status === 'fail');
  const warned = checks.filter(c => c.status === 'warn');

  const result = {
    file: relToRoot(abs),
    path: abs,
    passed: failed.length === 0,
    checks,
    checkCount: checks.length,
    failures: failed.map(c => `${c.name}: ${c.message}`),
    warnings: warned.map(c => `${c.name}: ${c.message}`),
    failureCount: failed.length,
    warningCount: warned.length,
    duration: meta?.duration ?? null,
    width: meta?.width ?? null,
    height: meta?.height ?? null,
    fps: meta?.fps ?? null,
    hasAudio: meta?.hasAudio ?? null,
    sizeBytes: meta?.sizeBytes ?? null,
  };

  const out = prepareOutput(
    opts.out || path.join(ensureDir(DIR.output), `${slug(abs)}.qa.json`)
  );
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  result.report = relToRoot(out);

  for (const w of warned) log.warn(`${w.name}: ${w.message}`);
  if (failed.length && opts.strict !== false) {
    throw new VeError(
      `QA failed with ${failed.length} problem(s):\n${failed.map(c => `  - ${c.name}: ${c.message}`).join('\n')}`,
      { code: EXIT.VALIDATION, details: result }
    );
  }
  return result;
}

const round = (n, p = 3) => Math.round(n * 10 ** p) / 10 ** p;

export const tool = {
  name: 'qa-video',
  summary: 'Validate a finished render: streams, geometry, duration, black frames, audio.',
  args: {
    input: { positional: 0, required: true, help: 'Rendered video to check' },
    expectDuration: { type: 'number', help: 'Expected duration in seconds' },
    expectWidth: { type: 'number', help: 'Expected width' },
    expectHeight: { type: 'number', help: 'Expected height' },
    expectFps: { type: 'number', help: 'Expected frame rate' },
    durationTolerance: { type: 'number', help: 'Allowed duration drift (default 3%)' },
    maxBlackRatio: { type: 'number', default: 0.08, help: 'Fail above this fraction of black frames' },
    requireAudio: { type: 'bool', default: true, help: 'Treat a missing audio track as a failure' },
    captionsAss: { type: 'string', help: 'Subtitle file to bounds-check against the frame' },
    strict: { type: 'bool', default: true, help: 'Exit non-zero when a check fails' },
    out: { type: 'string', help: 'Where to write the QA report JSON' },
  },
  examples: [
    've qa-video output/final.mp4',
    've qa-video output/final.mp4 --expect-width 1080 --expect-height 1920 --expect-duration 19.2',
    've qa-video output/final.mp4 --no-strict | jq .warnings',
  ],
  run: opts => qaVideo(opts.input, opts),
  pretty: r => `${r.passed ? 'PASS' : 'FAIL'} — ${r.checkCount} checks, ` +
    `${r.failureCount} failure(s), ${r.warningCount} warning(s) -> ${r.report}`,
};

runIfMain(tool, import.meta.url);
