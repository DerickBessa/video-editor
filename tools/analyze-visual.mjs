// analyze-visual — a compact, machine-readable description of what the picture
// is doing over time.
//
// The point is to give the decision layer something to reason about without
// making it watch the video: at 12.4s there is one face, centred, motion is
// low, this looks like a talking head. That is enough to decide where a zoom
// helps, where B-roll would cover a static stretch, and where a cut would land
// mid-gesture.
//
// Everything here is measured, and every measurement is cheap:
//   motion    mean absolute frame-to-frame difference, from ffmpeg's
//             `signalstats` YDIF. No optical flow, no model.
//   brightness / contrast   from the same pass.
//   faces     from track-faces, if a model is available. Optional: the tool
//             degrades to motion-only rather than failing.
//   scenes    from detect-scenes, to mark shot boundaries.
//
// It deliberately does NOT try to name objects. That would need a detector
// whose vocabulary would not match this project's needs, and the brief says
// not to complicate it gratuitously.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/proc.mjs';
import { FFMPEG } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { detectScenes } from './detect-scenes.mjs';
import { trackFaces } from './track-faces.mjs';

/**
 * Per-frame signal statistics in one decoding pass.
 * YDIF is the mean absolute difference from the previous frame — a direct,
 * cheap motion measure that needs no model.
 */
export async function measureMotion(file, { sampleFps = 2 } = {}) {
  const res = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-i', file,
    '-vf', `fps=${sampleFps},signalstats,metadata=print:file=-`,
    '-an', '-f', 'null', '-',
  ], { timeoutMs: 1800000 });

  const text = `${res.stdout}\n${res.stderr}`;
  const frames = [];
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    const head = /^frame:(\d+)\s+pts:\d+\s+pts_time:([\d.]+)/.exec(line);
    if (head) {
      if (current) frames.push(current);
      current = { index: Number(head[1]), t: Number(head[2]) };
      continue;
    }
    if (!current) continue;
    const kv = /^lavfi\.signalstats\.(\w+)=(-?[\d.]+)/.exec(line);
    if (kv) current[kv[1]] = Number(kv[2]);
  }
  if (current) frames.push(current);
  return frames;
}

/** Motion bands. Thresholds are on YDIF, which is 0..255. */
export function motionLabel(ydif) {
  if (!Number.isFinite(ydif)) return 'unknown';
  if (ydif < 2) return 'static';
  if (ydif < 8) return 'low';
  if (ydif < 20) return 'medium';
  return 'high';
}

export function facePositionLabel(cx, cy) {
  if (cx === null || cx === undefined) return null;
  const h = cx < 0.38 ? 'left' : cx > 0.62 ? 'right' : 'center';
  const v = cy < 0.38 ? 'top' : cy > 0.62 ? 'bottom' : 'middle';
  return v === 'middle' ? h : `${v}-${h}`;
}

/**
 * @param {string} input
 * @param {{sampleFps?:number, faces?:boolean, scenes?:boolean, out?:string}} opts
 */
export async function analyzeVisual(input, opts = {}) {
  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) throw inputError(`${relToRoot(abs)} has no video track`);

  const sampleFps = opts.sampleFps ?? 2;

  const frames = await measureMotion(abs, { sampleFps });
  if (!frames.length) throw validationError('no frames could be measured', { file: relToRoot(abs) });

  // Faces are optional: without a model this still produces a useful report.
  let faceTrack = null;
  if (opts.faces !== false) {
    try {
      faceTrack = await trackFaces(abs, { sampleFps: Math.min(5, Math.max(1, sampleFps)) });
    } catch (e) {
      log.warn(`face analysis unavailable (${e.message}); continuing without it`);
    }
  }

  let scenes = null;
  if (opts.scenes !== false) {
    scenes = await detectScenes(abs, {}).catch(() => null);
  }

  const faceAt = t => {
    if (!faceTrack) return null;
    let best = null;
    for (const p of faceTrack.track) {
      if (best === null || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    }
    return best;
  };
  const sceneAt = t => scenes?.scenes.find(s => t >= s.start && t < s.end) ?? null;

  const timeline = frames.map(f => {
    const face = faceAt(f.t);
    const scene = sceneAt(f.t);
    return {
      timestamp: round(f.t),
      motion: motionLabel(f.YDIF),
      motionValue: round(f.YDIF ?? 0, 2),
      brightness: round(f.YAVG ?? 0, 1),
      contrast: round((f.YHIGH ?? 0) - (f.YLOW ?? 0), 1),
      people: face ? face.faces : null,
      faceDetected: face ? face.faces > 0 : null,
      facePosition: face && face.faces > 0 ? facePositionLabel(face.cx, face.cy) : null,
      faceX: face && face.faces > 0 ? face.cx : null,
      faceY: face && face.faces > 0 ? face.cy : null,
      scene: scene ? scene.id : null,
    };
  });

  // Stretches where nothing visually changes are exactly where B-roll, a zoom
  // or a cut earns its place, so they are surfaced explicitly.
  const staticRuns = [];
  let runStart = null;
  for (const [i, row] of timeline.entries()) {
    const isStatic = row.motionValue < 3;
    if (isStatic && runStart === null) runStart = row.timestamp;
    if ((!isStatic || i === timeline.length - 1) && runStart !== null) {
      const end = row.timestamp;
      if (end - runStart >= (opts.staticSeconds ?? 3)) {
        staticRuns.push({ start: runStart, end: round(end), duration: round(end - runStart) });
      }
      runStart = null;
    }
  }

  const motions = timeline.map(r => r.motionValue).filter(Number.isFinite);
  const summary = {
    dominantMotion: motionLabel(median(motions)),
    medianMotion: round(median(motions), 2),
    peakMotion: round(Math.max(...motions, 0), 2),
    meanBrightness: round(mean(timeline.map(r => r.brightness)), 1),
    faceCoverage: faceTrack ? faceTrack.coverage : null,
    shot: faceTrack ? faceTrack.shot.kind : null,
    sceneCount: scenes?.sceneCount ?? null,
    staticStretches: staticRuns.length,
    longestStatic: staticRuns.length ? Math.max(...staticRuns.map(r => r.duration)) : 0,
  };

  const result = {
    source: relToRoot(abs),
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    orientation: meta.orientation,
    sampleFps,
    sampleCount: timeline.length,
    summary,
    staticRuns,
    presenceChanges: faceTrack?.presenceChanges ?? [],
    cuts: scenes?.cuts ?? [],
    timeline,
  };

  const out = prepareOutput(
    opts.out || path.join(ensureDir(path.join(DIR.cache, 'visual')), `${slug(abs)}-visual.json`)
  );
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  result.output = relToRoot(out);
  result.path = out;
  return result;
}

const median = xs => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n, p = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : n);

export const tool = {
  name: 'analyze-visual',
  summary: 'Summarise what the picture is doing over time: motion, faces, scenes, static stretches.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    sampleFps: { type: 'number', default: 2, help: 'Samples per second' },
    faces: { type: 'bool', default: true, help: 'Include face analysis (needs the YuNet model)' },
    scenes: { type: 'bool', default: true, help: 'Include scene boundaries' },
    staticSeconds: { type: 'number', default: 3, help: 'Report static stretches longer than this' },
    out: { type: 'string', help: 'Output JSON path' },
  },
  examples: [
    've analyze-visual raw/test.mp4',
    've analyze-visual raw/test.mp4 --no-faces --sample-fps 1',
    've analyze-visual raw/test.mp4 | jq ".staticRuns"',
  ],
  run: opts => analyzeVisual(opts.input, opts),
  pretty: r => `${r.summary.dominantMotion} motion, ${r.summary.shot || 'no face data'}, ` +
    `${r.summary.sceneCount ?? '?'} scene(s), ${r.summary.staticStretches} static stretch(es) -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
