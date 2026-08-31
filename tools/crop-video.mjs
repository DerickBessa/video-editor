// crop-video — reframe and resize. The deterministic half of "make it vertical".
//
// Three jobs, one pass:
//   1. crop   pick a region of the source (explicit rect, or derived from a
//             target aspect ratio plus an anchor)
//   2. scale  resize to the target resolution
//   3. pad    when using --fit contain, fill the leftover with black or a
//             blurred copy of the frame
//
// Anchors are expressed as a fraction so `smart-crop` (phase 4) can drive this
// same code with a face-tracked centre instead of a fixed one.
//
// All geometry is computed from DISPLAY dimensions (probe-video applies the
// rotation matrix), because ffmpeg auto-rotates on decode — so by the time the
// crop filter sees a frame, phone footage is already upright.
import path from 'node:path';
import { ffmpeg, encodeArgs } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { usageError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

export const ANCHORS = {
  center: 0.5, top: 0.0, bottom: 1.0, left: 0.0, right: 1.0,
};

/** "9:16" | "9x16" | "0.5625" -> 0.5625 */
export function parseAspect(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const m = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i.exec(s);
  if (m) {
    const [w, h] = [Number(m[1]), Number(m[2])];
    if (!h) throw usageError(`Invalid aspect "${v}": height cannot be zero`);
    return w / h;
  }
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;
  throw usageError(`Could not parse aspect "${v}"`, 'Use W:H (e.g. 9:16) or a decimal ratio.');
}

/** "1080x1920" -> {width, height} */
export function parseResolution(v) {
  if (v == null) return null;
  const m = /^(\d+)\s*[x:]\s*(\d+)$/i.exec(String(v).trim());
  if (!m) throw usageError(`Could not parse resolution "${v}"`, 'Use WIDTHxHEIGHT, e.g. 1080x1920.');
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * Largest rectangle of `targetAspect` that fits inside srcW x srcH,
 * positioned by anchor fractions in 0..1.
 * Exported so smart-crop can reuse the geometry with a moving anchor.
 */
export function cropRect(srcW, srcH, targetAspect, { anchorX = 0.5, anchorY = 0.5 } = {}) {
  let w = srcW;
  let h = Math.round(srcW / targetAspect);
  if (h > srcH) {
    h = srcH;
    w = Math.round(srcH * targetAspect);
  }
  // H.264 needs even dimensions for yuv420p chroma siting.
  w = Math.max(2, w - (w % 2));
  h = Math.max(2, h - (h % 2));

  let x = Math.round((srcW - w) * clamp01(anchorX));
  let y = Math.round((srcH - h) * clamp01(anchorY));
  x = Math.max(0, Math.min(srcW - w, x)) & ~1;
  y = Math.max(0, Math.min(srcH - h, y)) & ~1;
  return { w, h, x, y };
}

const clamp01 = v => Math.min(1, Math.max(0, v));

/**
 * @param {string} input
 * @param {{aspect?:string, resolution?:string, position?:string, anchorX?:number, anchorY?:number,
 *          rect?:string, fit?:'cover'|'contain'|'stretch', background?:'black'|'blur',
 *          out?:string, quality?:string, hw?:string}} opts
 */
export async function cropVideo(input, opts = {}) {
  const { fit = 'cover', background = 'blur', position = 'center' } = opts;

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) throw usageError(`${relToRoot(abs)} has no video track`);

  const resolution = parseResolution(opts.resolution);
  const aspect = parseAspect(opts.aspect) ?? (resolution ? resolution.width / resolution.height : null);

  if (!aspect && !resolution && !opts.rect) {
    throw usageError('Nothing to do: provide --aspect, --resolution or --rect',
      'e.g. --aspect 9:16 --resolution 1080x1920');
  }

  const anchorX = opts.anchorX ?? anchorFor(position, 'x');
  const anchorY = opts.anchorY ?? anchorFor(position, 'y');

  // Work out the source rectangle to take.
  let rect;
  if (opts.rect) {
    rect = parseRect(opts.rect, meta);
  } else if (aspect && fit === 'cover') {
    rect = cropRect(meta.width, meta.height, aspect, { anchorX, anchorY });
  } else {
    rect = { w: meta.width, h: meta.height, x: 0, y: 0 };
  }

  const target = resolution || fitTarget(rect, aspect);
  const filters = buildFilters(rect, target, { fit, background, meta });

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-${target.width}x${target.height}.mp4`));
  const { args: enc } = await encodeArgs({ quality: opts.quality || 'final', hw: opts.hw || 'auto' });

  // encodeArgs may add its own -vf; drop it, this tool owns the video filter chain.
  const encNoVf = stripVf(enc);

  const args = [
    '-y', '-i', abs,
    '-filter_complex', filters.graph,
    '-map', filters.videoLabel,
    ...(meta.hasAudio ? ['-map', '0:a', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    ...encNoVf,
    out,
  ];

  log.info(`crop ${meta.width}x${meta.height} -> take ${rect.w}x${rect.h}@${rect.x},${rect.y} -> ${target.width}x${target.height} (${fit})`);
  await ffmpeg(args, { label: 'crop-video', totalSec: meta.duration });

  const got = await probeVideo(out);
  if (got.width !== target.width || got.height !== target.height) {
    throw validationError(`output is ${got.width}x${got.height}, expected ${target.width}x${target.height}`,
      { wanted: target, got: { width: got.width, height: got.height } });
  }

  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    sourceAspect: meta.aspect,
    crop: rect,
    width: got.width,
    height: got.height,
    aspect: got.aspect,
    fit,
    background: fit === 'contain' ? background : null,
    position,
    anchorX,
    anchorY,
    duration: got.duration,
    hasAudio: got.hasAudio,
    sizeBytes: got.sizeBytes,
  };
}

function buildFilters(rect, target, { fit, background, meta }) {
  const crop = `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`;

  if (fit === 'stretch') {
    return { graph: `[0:v]${crop},scale=${target.width}:${target.height},setsar=1[vout]`, videoLabel: '[vout]' };
  }

  if (fit === 'cover') {
    // The crop already matches the target aspect, so this is a plain resize.
    return {
      graph: `[0:v]${crop},scale=${target.width}:${target.height}:flags=lanczos,setsar=1[vout]`,
      videoLabel: '[vout]',
    };
  }

  // contain: fit the whole frame inside the target and fill the rest.
  const inner = `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease:flags=lanczos`;
  const pad = `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2`;

  if (background === 'black') {
    return {
      graph: `[0:v]${crop},${inner},${pad}:color=black,setsar=1[vout]`,
      videoLabel: '[vout]',
    };
  }

  // Blurred fill: the same frame scaled to COVER, heavily blurred, with the
  // contained frame composited on top. Much better than black bars for Shorts.
  const graph = [
    `[0:v]${crop},split=2[bg][fg]`,
    `[bg]scale=${target.width}:${target.height}:force_original_aspect_ratio=increase:flags=fast_bilinear,` +
      `crop=${target.width}:${target.height},gblur=sigma=25,eq=brightness=-0.12[bgb]`,
    `[fg]${inner}[fgs]`,
    `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[vout]`,
  ].join(';');
  return { graph, videoLabel: '[vout]' };
}

/** Remove any -vf pair from encoder args so we can own the filtergraph. */
function stripVf(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-vf') { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

function anchorFor(position, axis) {
  if (position in ANCHORS) {
    // top/bottom only constrain Y; left/right only constrain X.
    if (['top', 'bottom'].includes(position)) return axis === 'y' ? ANCHORS[position] : 0.5;
    if (['left', 'right'].includes(position)) return axis === 'x' ? ANCHORS[position] : 0.5;
    return 0.5;
  }
  throw usageError(`Unknown position "${position}"`, `Use: ${Object.keys(ANCHORS).join(', ')}`);
}

function parseRect(v, meta) {
  const m = /^(\d+):(\d+):(\d+):(\d+)$/.exec(String(v).trim());
  if (!m) throw usageError(`Could not parse --rect "${v}"`, 'Use W:H:X:Y, e.g. 720:1280:280:0');
  const [w, h, x, y] = m.slice(1).map(Number);
  if (x + w > meta.width || y + h > meta.height) {
    throw usageError(`--rect ${v} does not fit inside the ${meta.width}x${meta.height} source`);
  }
  return { w: w - (w % 2), h: h - (h % 2), x, y };
}

function fitTarget(rect, aspect) {
  if (!aspect) return { width: rect.w, height: rect.h };
  return { width: rect.w, height: rect.h };
}

export const tool = {
  name: 'crop-video',
  summary: 'Crop, resize and change aspect ratio (e.g. 16:9 -> 9:16).',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    aspect: { type: 'string', help: 'Target aspect, e.g. 9:16, 1:1, 16:9' },
    resolution: { type: 'string', help: 'Target resolution, e.g. 1080x1920' },
    position: { type: 'enum', values: Object.keys(ANCHORS), default: 'center', help: 'Where to take the crop from' },
    anchorX: { type: 'number', help: 'Horizontal anchor 0..1 (overrides --position)' },
    anchorY: { type: 'number', help: 'Vertical anchor 0..1 (overrides --position)' },
    rect: { type: 'string', help: 'Explicit crop rectangle W:H:X:Y' },
    fit: { type: 'enum', values: ['cover', 'contain', 'stretch'], default: 'cover', help: 'cover crops; contain letterboxes; stretch distorts' },
    background: { type: 'enum', values: ['blur', 'black'], default: 'blur', help: 'Fill for --fit contain' },
    out: { type: 'string', help: 'Output path' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've crop-video raw/test.mp4 --aspect 9:16 --resolution 1080x1920',
    've crop-video raw/test.mp4 --aspect 9:16 --position left',
    've crop-video raw/test.mp4 --resolution 1080x1920 --fit contain --background blur',
    've crop-video raw/test.mp4 --rect 720:1280:280:0',
  ],
  run: opts => cropVideo(opts.input, opts),
  pretty: r => `${r.sourceWidth}x${r.sourceHeight} -> ${r.width}x${r.height} (${r.fit}` +
    `${r.background ? `/${r.background}` : ''}, ${r.position}) -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
