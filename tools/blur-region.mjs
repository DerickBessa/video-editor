// blur-region — obscure part of the picture: passwords, emails, keys, faces.
//
// This is a PRIVACY tool, so it is built to fail safe:
//   - regions are given as FRACTIONS of the frame, so they cannot silently
//     land somewhere else when the resolution changes
//   - the default blur strength is strong enough that text is unrecoverable,
//     not merely fuzzy
//   - `--mode pixelate` is offered because heavy blur on small text can
//     sometimes be partly reversed, while a coarse mosaic cannot
//   - a region is CLAMPED into the frame rather than silently dropped, so
//     "blur the bottom-right corner" never quietly protects nothing
//
// Face mode reuses the same detector as smart-crop. Faces are padded outwards,
// because a box that exactly fits a detection box leaves the chin and hairline
// visible.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, encodeArgs } from '../lib/ffmpeg.mjs';
import { runPython } from '../lib/python.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { YUNET_MODEL } from './smart-crop.mjs';

export const MODES = ['blur', 'pixelate', 'black'];

/**
 * Accepts:
 *   "0.6,0.7,0.35,0.2"                     x,y,w,h as fractions, whole video
 *   "0.6,0.7,0.35,0.2@4-9"                 ... only between 4s and 9s
 *   [{x,y,w,h,start,end}]
 */
export function parseRegions(raw) {
  if (raw == null) return [];
  let list = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('[') || s.startsWith('{')) {
      const j = JSON.parse(s);
      list = Array.isArray(j) ? j : j.regions || [];
    } else {
      list = s.split(';').map(part => {
        const m = /^([\d.]+),([\d.]+),([\d.]+),([\d.]+)(?:@([\d.]+)-([\d.]+))?$/.exec(part.trim());
        if (!m) {
          throw usageError(`Could not parse region "${part}"`,
            'Use X,Y,W,H as fractions (0..1), optionally @START-END, e.g. "0.6,0.7,0.35,0.2@4-9".');
        }
        return {
          x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]),
          ...(m[5] !== undefined ? { start: Number(m[5]), end: Number(m[6]) } : {}),
        };
      });
    }
  }
  if (!Array.isArray(list)) list = [list];

  return list.map((r, i) => {
    for (const k of ['x', 'y', 'w', 'h']) {
      if (!Number.isFinite(Number(r[k]))) throw usageError(`regions[${i}]: ${k} must be a number`);
    }
    if (Number(r.w) <= 0 || Number(r.h) <= 0) throw usageError(`regions[${i}]: width and height must be positive`);
    return {
      x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h),
      start: r.start === undefined ? null : Number(r.start),
      end: r.end === undefined ? null : Number(r.end),
      reason: r.reason,
    };
  });
}

/** Fractions -> pixels, clamped inside the frame and made even for yuv420p. */
export function toPixels(region, width, height) {
  let x = Math.round(region.x * width);
  let y = Math.round(region.y * height);
  let w = Math.round(region.w * width);
  let h = Math.round(region.h * height);

  // Clamp rather than reject: a region hanging off the edge still needs to
  // cover the part that IS on screen.
  x = Math.max(0, Math.min(width - 2, x));
  y = Math.max(0, Math.min(height - 2, y));
  w = Math.max(2, Math.min(width - x, w));
  h = Math.max(2, Math.min(height - y, h));

  return { x: x & ~1, y: y & ~1, w: w & ~1, h: h & ~1 };
}

/**
 * @param {string} input
 * @param {{regions?:*, faces?:boolean, mode?:string, strength?:number, padding?:number,
 *          plan?:string, out?:string, quality?:string, hw?:string}} opts
 */
export async function blurRegion(input, opts = {}) {
  const mode = opts.mode || 'blur';
  if (!MODES.includes(mode)) throw usageError(`Unknown mode "${mode}"`, `Use: ${MODES.join(', ')}`);

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) throw inputError(`${relToRoot(abs)} has no video track`);

  let raw = opts.regions;
  if (opts.plan) {
    const plan = JSON.parse(fs.readFileSync(resolveInput(opts.plan, 'plan'), 'utf8'));
    raw = raw ?? plan.blur ?? plan.regions;
  }

  let regions = parseRegions(raw);
  let faceInfo = null;

  if (opts.faces) {
    faceInfo = await detectFaceRegions(abs, opts, meta);
    regions = [...regions, ...faceInfo.regions];
  }

  if (!regions.length) {
    throw usageError('No regions to blur',
      'Use --regions "0.6,0.7,0.35,0.2", or --faces to blur detected faces.');
  }

  // Blur strength scales with the frame, so the same setting protects equally
  // on 720p and 4K.
  const strength = opts.strength ?? 1;
  const sigma = Math.max(4, Math.round(meta.height * 0.035 * strength));
  const mosaic = Math.max(6, Math.round(meta.height * 0.02 * strength));

  const parts = [];
  let base = '[0:v]';

  regions.forEach((r, i) => {
    const px = toPixels(r, meta.width, meta.height);
    const region = `${px.w}:${px.h}:${px.x}:${px.y}`;
    const outLbl = i === regions.length - 1 ? '[vout]' : `[b${i}]`;

    let effect;
    if (mode === 'pixelate') {
      // Down then up with nearest neighbour: a true mosaic, not a soft blur.
      const cw = Math.max(2, Math.round(px.w / mosaic)) & ~1;
      const ch = Math.max(2, Math.round(px.h / mosaic)) & ~1;
      effect = `scale=${cw}:${ch}:flags=neighbor,scale=${px.w}:${px.h}:flags=neighbor`;
    } else if (mode === 'black') {
      effect = `drawbox=x=0:y=0:w=${px.w}:h=${px.h}:color=black@1:t=fill`;
    } else {
      // Two passes of gblur beat one strong pass: the result is closer to a
      // true Gaussian, which is what makes text unrecoverable.
      effect = `gblur=sigma=${sigma}:steps=3,gblur=sigma=${Math.round(sigma / 2)}:steps=2`;
    }

    parts.push(`${base}crop=${region},${effect}[r${i}]`);
    const enable = r.start !== null && r.end !== null
      ? `:enable='between(t,${r.start},${r.end})'`
      : '';
    parts.push(`${base}[r${i}]overlay=${px.x}:${px.y}${enable}${outLbl}`);
    base = outLbl;
  });

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-blurred.mp4`));
  const { args: enc } = await encodeArgs({ quality: opts.quality || 'final', hw: opts.hw || 'auto' });

  log.info(`${mode} over ${regions.length} region(s)${opts.faces ? ` (${faceInfo.regions.length} from faces)` : ''}`);

  await ffmpeg([
    '-y', '-i', abs,
    '-filter_complex', parts.join(';'),
    '-map', '[vout]',
    ...(meta.hasAudio ? ['-map', '0:a', '-c:a', 'copy'] : ['-an']),
    ...stripVf(enc),
    out,
  ], { label: 'blur-region', totalSec: meta.duration });

  const got = await probeVideo(out);
  if (got.width !== meta.width || got.height !== meta.height) {
    throw validationError(`blurring changed the frame size to ${got.width}x${got.height}`);
  }

  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    mode,
    strength,
    sigma: mode === 'blur' ? sigma : null,
    mosaic: mode === 'pixelate' ? mosaic : null,
    regionCount: regions.length,
    regions: regions.map(r => ({
      ...toPixels(r, meta.width, meta.height),
      fractions: { x: r.x, y: r.y, w: r.w, h: r.h },
      start: r.start, end: r.end, reason: r.reason,
    })),
    faceDetection: faceInfo ? { coverage: faceInfo.coverage, samples: faceInfo.samples } : null,
    width: got.width,
    height: got.height,
    duration: got.duration,
    sizeBytes: got.sizeBytes,
  };
}

/**
 * Turn face detections into ONE covering region per face cluster.
 *
 * A per-frame moving box would be ideal, but a box that follows a detection
 * and briefly loses it exposes the face on exactly the frames that matter. For
 * a privacy tool, a static box covering everywhere the face went is the safe
 * choice, and that is what this does.
 */
async function detectFaceRegions(abs, opts, meta) {
  const model = path.join(DIR.models, YUNET_MODEL);
  if (!fs.existsSync(model)) {
    throw inputError(`face model not found: ${relToRoot(model)}`,
      'Download face_detection_yunet_2023mar.onnx from https://github.com/opencv/opencv_zoo into models/');
  }

  const det = await runPython('detect_faces.py', [
    '--video', abs, '--model', model,
    '--fps', String(opts.sampleFps ?? 4),
    '--score', String(opts.score ?? 0.5),
  ], { label: 'detect-faces', timeoutMs: 0, onLog: line => log.debug(line) });

  const pad = opts.padding ?? 0.35;
  const boxes = [];
  for (const s of det.samples || []) {
    for (const f of s.faces || []) boxes.push(f);
  }
  if (!boxes.length) {
    log.warn('no faces detected — nothing will be blurred from --faces');
    return { regions: [], coverage: det.coverage, samples: det.sampleCount };
  }

  // Single covering box over every detection, padded outwards.
  const x0 = Math.min(...boxes.map(b => b.x));
  const y0 = Math.min(...boxes.map(b => b.y));
  const x1 = Math.max(...boxes.map(b => b.x + b.w));
  const y1 = Math.max(...boxes.map(b => b.y + b.h));
  const padX = (x1 - x0) * pad;
  const padY = (y1 - y0) * pad;

  return {
    regions: [{
      x: Math.max(0, (x0 - padX) / meta.width),
      y: Math.max(0, (y0 - padY) / meta.height),
      w: Math.min(1, (x1 - x0 + padX * 2) / meta.width),
      h: Math.min(1, (y1 - y0 + padY * 2) / meta.height),
      start: null, end: null,
      reason: `covers ${boxes.length} face detection(s)`,
    }],
    coverage: det.coverage,
    samples: det.sampleCount,
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
  name: 'blur-region',
  summary: 'Obscure part of the frame — passwords, emails, faces — irreversibly.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    regions: { type: 'string', help: '"X,Y,W,H" as fractions, optionally "@START-END"; ; separates several' },
    faces: { type: 'bool', default: false, help: 'Also cover every detected face' },
    mode: { type: 'enum', values: MODES, default: 'blur', help: 'blur | pixelate | black' },
    strength: { type: 'number', default: 1, help: 'Multiplier on blur sigma / mosaic size' },
    padding: { type: 'number', default: 0.35, help: 'Extra margin around detected faces' },
    sampleFps: { type: 'number', default: 4, help: 'Face detection sampling rate' },
    score: { type: 'number', default: 0.5, help: 'Face detection threshold (lower is safer here)' },
    plan: { type: 'string', help: 'JSON file containing {blur:[...]}' },
    out: { type: 'string', help: 'Output path' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've blur-region raw/demo.mp4 --regions "0.55,0.72,0.4,0.12"',
    've blur-region raw/demo.mp4 --regions "0.1,0.1,0.3,0.1@4-9" --mode pixelate',
    've blur-region raw/interview.mp4 --faces --mode pixelate',
  ],
  run: opts => blurRegion(opts.input, opts),
  pretty: r => `${r.mode} over ${r.regionCount} region(s) -> ${r.output}  ${r.width}x${r.height}`,
};

runIfMain(tool, import.meta.url);
