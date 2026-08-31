// smart-crop — reframe to a new aspect ratio while keeping the subject in shot.
//
// The detector is the easy part. The hard part is that a raw per-frame face
// position makes an UNWATCHABLE crop: detection boxes jitter by a few pixels
// every frame, faces drop out for a frame or two, and a second face entering
// shot yanks the frame sideways. So the track goes through four stages:
//
//   1. pick     one subject per sample — the largest face, with hysteresis so
//               a marginally bigger second face cannot steal the shot
//   2. fill     hold the last known position through gaps (blinks, turns away)
//   3. smooth   exponential moving average, so the camera glides
//   4. deadzone ignore movement under a threshold, so a still subject gives a
//               perfectly still frame rather than a slow drift
//
// Rendering uses `sendcmd` to drive crop's x/y at timestamps. crop's x/y
// expressions are per-frame evaluable (flag `T`), so this is a single pass with
// no filtergraph gymnastics; w/h stay fixed, which crop requires.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, encodeArgs, escapeFilterPath } from '../lib/ffmpeg.mjs';
import { runPython } from '../lib/python.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { cropRect, parseAspect, parseResolution } from './crop-video.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

export const YUNET_MODEL = 'face_detection_yunet.onnx';

/* --------------------------------------------------------------- tracking */

/**
 * Choose one subject per sample.
 * `stickiness` is hysteresis: a newly-largest face must beat the current
 * subject by this factor before the shot follows it, which stops the frame
 * ping-ponging between two similarly sized faces.
 */
export function pickSubject(samples, { stickiness = 1.35 } = {}) {
  let current = null;   // {cx, cy, area}
  return samples.map(s => {
    const faces = s.faces || [];
    if (!faces.length) return { t: s.t, cx: null, cy: null, area: 0, faces: 0 };

    let chosen;
    if (!current) {
      chosen = faces.reduce((a, b) => (b.area > a.area ? b : a));
    } else {
      // Prefer whichever face is closest to the one we were already following.
      const near = faces
        .map(f => ({ f, d: Math.hypot(f.cx - current.cx, f.cy - current.cy) }))
        .sort((a, b) => a.d - b.d)[0].f;
      const biggest = faces.reduce((a, b) => (b.area > a.area ? b : a));
      chosen = biggest.area > near.area * stickiness ? biggest : near;
    }
    current = { cx: chosen.cx, cy: chosen.cy, area: chosen.area };
    return { t: s.t, cx: chosen.cx, cy: chosen.cy, area: chosen.area, faces: faces.length };
  });
}

/** Hold the last known position across gaps; fall back to `fallback` at the head. */
export function fillGaps(track, fallback = { cx: 0.5, cy: 0.5 }) {
  const out = track.map(p => ({ ...p }));
  let last = null;
  for (const p of out) {
    if (p.cx === null) {
      p.cx = last ? last.cx : fallback.cx;
      p.cy = last ? last.cy : fallback.cy;
      p.held = true;
    } else {
      last = p;
      p.held = false;
    }
  }
  // Anything before the first detection should use the FIRST known position,
  // not the centre, or the shot starts wrong and slides.
  const firstReal = out.find(p => !p.held);
  if (firstReal) {
    for (const p of out) {
      if (!p.held) break;
      p.cx = firstReal.cx;
      p.cy = firstReal.cy;
    }
  }
  return out;
}

/**
 * Exponential smoothing plus a deadzone.
 * @param {number} smoothing 0..1 — higher is slower and calmer
 * @param {number} deadzone  normalised distance below which movement is ignored
 */
export function smoothTrack(track, { smoothing = 0.85, deadzone = 0.02, maxStep = 0.06 } = {}) {
  const out = [];
  let cx = track.length ? track[0].cx : 0.5;
  let cy = track.length ? track[0].cy : 0.5;

  for (const p of track) {
    // Deadzone: if the subject barely moved, do not move the camera at all.
    // A camera that drifts constantly is more distracting than a static one.
    const dist = Math.hypot(p.cx - cx, p.cy - cy);
    if (dist > deadzone) {
      let tx = cx + (p.cx - cx) * (1 - smoothing);
      let ty = cy + (p.cy - cy) * (1 - smoothing);
      // Velocity clamp stops a detection glitch throwing the frame across shot.
      const step = Math.hypot(tx - cx, ty - cy);
      if (step > maxStep) {
        const k = maxStep / step;
        tx = cx + (tx - cx) * k;
        ty = cy + (ty - cy) * k;
      }
      cx = tx; cy = ty;
    }
    out.push({ t: p.t, cx: round(cx, 5), cy: round(cy, 5), held: p.held, faces: p.faces });
  }
  return out;
}

/** Emit only the points where the crop actually moves, to keep sendcmd small. */
export function toCommands(track, { width, height, rect, minDelta = 0.5 }) {
  const maxX = width - rect.w;
  const maxY = height - rect.h;
  const px = p => ({
    x: clamp(Math.round(p.cx * width - rect.w / 2), 0, maxX),
    y: clamp(Math.round(p.cy * height - rect.h / 2), 0, maxY),
  });

  const cmds = [];
  let last = null;
  for (const p of track) {
    const { x, y } = px(p);
    if (!last || Math.abs(x - last.x) >= minDelta || Math.abs(y - last.y) >= minDelta) {
      cmds.push({ t: p.t, x, y });
      last = { x, y };
    }
  }
  if (!cmds.length) cmds.push({ t: 0, ...px(track[0] || { cx: 0.5, cy: 0.5 }) });
  if (cmds[0].t > 0) cmds.unshift({ t: 0, x: cmds[0].x, y: cmds[0].y });
  return cmds;
}

/** sendcmd script: `TIME crop x 'N', crop y 'M';` */
export function renderSendcmd(cmds) {
  return cmds.map(c => `${c.t.toFixed(3)} crop x '${c.x}', crop y '${c.y}';`).join('\n') + '\n';
}

/* ------------------------------------------------------------------ tool */

/**
 * @param {string} input
 * @param {{aspect?:string, resolution?:string, smoothing?:number, deadzone?:number,
 *          sampleFps?:number, track?:string, out?:string, quality?:string, hw?:string}} opts
 */
export async function smartCrop(input, opts = {}) {
  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) throw inputError(`${relToRoot(abs)} has no video track`);

  const resolution = parseResolution(opts.resolution);
  const aspect = parseAspect(opts.aspect) ?? (resolution ? resolution.width / resolution.height : 9 / 16);
  const target = resolution || { width: 1080, height: 1920 };

  // The crop window size is fixed; only its position moves.
  const rect = cropRect(meta.width, meta.height, aspect);
  if (rect.w >= meta.width && rect.h >= meta.height) {
    throw usageError(
      `the source is already ${meta.width}x${meta.height}; there is nothing to reframe for this aspect`,
      'Use crop-video with --fit contain if you want padding instead.'
    );
  }

  const detection = opts.track
    ? JSON.parse(fs.readFileSync(resolveInput(opts.track, 'track'), 'utf8'))
    : await detectFaces(abs, opts);

  const picked = pickSubject(detection.samples, { stickiness: opts.stickiness ?? 1.35 });
  const filled = fillGaps(picked);
  const smoothed = smoothTrack(filled, {
    smoothing: opts.smoothing ?? 0.85,
    deadzone: opts.deadzone ?? 0.02,
    maxStep: opts.maxStep ?? 0.06,
  });

  const cmds = toCommands(smoothed, { width: meta.width, height: meta.height, rect });
  const work = ensureDir(path.join(DIR.cache, 'smartcrop'));
  const cmdFile = path.join(work, `${slug(abs)}.sendcmd`);
  fs.writeFileSync(cmdFile, renderSendcmd(cmds));

  const coverage = detection.coverage ?? 0;
  if (coverage < 0.2) {
    log.warn(`faces found in only ${Math.round(coverage * 100)}% of samples — ` +
      `the crop will mostly hold a fixed position. Check the footage, or use crop-video for a static crop.`);
  }

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-vertical.mp4`));
  const { args: enc } = await encodeArgs({ quality: opts.quality || 'final', hw: opts.hw || 'auto' });
  const encNoVf = stripVf(enc);

  // sendcmd drives crop's x/y; w/h are fixed at init, which crop requires.
  const graph =
    `[0:v]sendcmd=f='${escapeFilterPath(cmdFile)}',` +
    `crop=${rect.w}:${rect.h}:${cmds[0].x}:${cmds[0].y},` +
    `scale=${target.width}:${target.height}:flags=lanczos,setsar=1[vout]`;

  log.info(`smart-crop: ${meta.width}x${meta.height} -> ${target.width}x${target.height}, ` +
    `${cmds.length} move(s), ${Math.round(coverage * 100)}% face coverage`);

  await ffmpeg([
    '-y', '-i', abs,
    '-filter_complex', graph,
    '-map', '[vout]',
    ...(meta.hasAudio ? ['-map', '0:a', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    ...encNoVf,
    out,
  ], { label: 'smart-crop', totalSec: meta.duration });

  const got = await probeVideo(out);
  if (got.width !== target.width || got.height !== target.height) {
    throw validationError(`output is ${got.width}x${got.height}, expected ${target.width}x${target.height}`);
  }

  const moved = cmds.length > 1;
  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    width: got.width,
    height: got.height,
    crop: rect,
    sampleCount: detection.sampleCount,
    framesWithFaces: detection.framesWithFaces,
    faceCoverage: round(coverage, 4),
    moveCount: cmds.length,
    tracked: moved && coverage > 0.2,
    commandFile: relToRoot(cmdFile),
    xRange: [Math.min(...cmds.map(c => c.x)), Math.max(...cmds.map(c => c.x))],
    yRange: [Math.min(...cmds.map(c => c.y)), Math.max(...cmds.map(c => c.y))],
    duration: got.duration,
    hasAudio: got.hasAudio,
    sizeBytes: got.sizeBytes,
    track: smoothed,
  };
}

async function detectFaces(abs, opts = {}) {
  const model = path.join(DIR.models, YUNET_MODEL);
  if (!fs.existsSync(model)) {
    throw inputError(`face model not found: ${relToRoot(model)}`,
      'Download face_detection_yunet_2023mar.onnx from https://github.com/opencv/opencv_zoo ' +
      `into ${relToRoot(DIR.models)}/${YUNET_MODEL}`);
  }
  return runPython('detect_faces.py', [
    '--video', abs,
    '--model', model,
    '--fps', String(opts.sampleFps ?? 5),
    '--score', String(opts.score ?? 0.6),
  ], { label: 'detect-faces', timeoutMs: 0, onLog: line => log.debug(line) });
}

function stripVf(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-vf') { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (n, p = 3) => Math.round(n * 10 ** p) / 10 ** p;

export const tool = {
  name: 'smart-crop',
  summary: 'Reframe to vertical (or any aspect) while keeping the subject in frame.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    aspect: { type: 'string', default: '9:16', help: 'Target aspect ratio' },
    resolution: { type: 'string', default: '1080x1920', help: 'Target resolution' },
    smoothing: { type: 'number', default: 0.85, help: '0..1 — higher is calmer and slower to follow' },
    deadzone: { type: 'number', default: 0.02, help: 'Ignore subject movement smaller than this' },
    maxStep: { type: 'number', default: 0.06, help: 'Maximum camera movement per sample' },
    stickiness: { type: 'number', default: 1.35, help: 'How much bigger a rival face must be to steal the shot' },
    sampleFps: { type: 'number', default: 5, help: 'Face detection sampling rate' },
    score: { type: 'number', default: 0.6, help: 'Face detection confidence threshold' },
    track: { type: 'string', help: 'Use a pre-computed detection JSON instead of detecting' },
    out: { type: 'string', help: 'Output path' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've smart-crop raw/podcast.mp4',
    've smart-crop raw/talk.mp4 --aspect 9:16 --resolution 1080x1920 --smoothing 0.9',
    've smart-crop raw/talk.mp4 --deadzone 0 --smoothing 0.6   # follows more closely',
  ],
  run: opts => smartCrop(opts.input, opts),
  pretty: r => `${r.sourceWidth}x${r.sourceHeight} -> ${r.width}x${r.height}  ` +
    `${Math.round(r.faceCoverage * 100)}% face coverage, ${r.moveCount} move(s)` +
    `${r.tracked ? '' : ' (static — no reliable subject)'} -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
