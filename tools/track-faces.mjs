// track-faces — where are the people, and which one is the subject, over time.
//
// This is the analysis layer under `smart-crop` and `blur-region --faces`,
// exposed on its own because the track is useful by itself: to decide whether
// footage is a talking head at all, to find the moment a second person appears,
// or to hand a stable subject position to any other tool.
//
// It reports raw detections AND the smoothed subject track, because they answer
// different questions. Raw tells you what the detector saw; smoothed tells you
// where a camera should point.
//
// SPEAKER identification (who is talking) is deliberately NOT claimed here. It
// needs audio-visual correlation — lip movement against the voice — which this
// does not do. `primarySubject` means "biggest, most persistent face", which is
// a good proxy for a single-presenter video and an explicitly poor one for a
// two-person interview. That limit is reported, not hidden.
import fs from 'node:fs';
import path from 'node:path';
import { runPython } from '../lib/python.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { cacheKey } from '../lib/hash.mjs';
import { inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { pickSubject, fillGaps, smoothTrack, YUNET_MODEL } from './smart-crop.mjs';

/** Describe the footage from the detection pattern alone. */
export function classify(samples, { coverage }) {
  const counts = samples.map(s => (s.faces || []).length);
  const withFaces = counts.filter(c => c > 0);
  const maxFaces = counts.length ? Math.max(...counts) : 0;
  const meanWhenPresent = withFaces.length
    ? withFaces.reduce((a, b) => a + b, 0) / withFaces.length
    : 0;

  // Mean face area, as a fraction of frame, tells close-up from wide.
  const areas = samples.flatMap(s => (s.faces || []).map(f => f.area));
  const meanArea = areas.length ? areas.reduce((a, b) => a + b, 0) / areas.length : 0;

  let kind;
  if (coverage < 0.15) kind = 'no-subject';
  else if (meanWhenPresent >= 1.6) kind = 'multi-person';
  else if (meanArea > 0.05) kind = 'talking-head';
  else kind = 'wide-shot';

  return {
    kind,
    maxSimultaneousFaces: maxFaces,
    meanFacesWhenPresent: round(meanWhenPresent, 2),
    meanFaceArea: round(meanArea, 5),
    // A single-subject assumption is only safe when one face is the norm.
    singleSubject: coverage >= 0.15 && meanWhenPresent < 1.4,
  };
}

/** Moments where the number of visible faces changes — someone entered or left. */
export function findPresenceChanges(samples, minGap = 1.0) {
  const changes = [];
  let last = null;
  for (const s of samples) {
    const n = (s.faces || []).length;
    if (last !== null && n !== last) {
      const prev = changes[changes.length - 1];
      if (!prev || s.t - prev.t >= minGap) {
        changes.push({ t: round(s.t), from: last, to: n, kind: n > last ? 'entered' : 'left' });
      }
    }
    last = n;
  }
  return changes;
}

/**
 * @param {string} input
 * @param {{sampleFps?:number, score?:number, smoothing?:number, deadzone?:number,
 *          out?:string, force?:boolean}} opts
 */
export async function trackFaces(input, opts = {}) {
  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) throw inputError(`${relToRoot(abs)} has no video track`);

  const model = path.join(DIR.models, YUNET_MODEL);
  if (!fs.existsSync(model)) {
    throw inputError(`face model not found: ${relToRoot(model)}`,
      'Download face_detection_yunet_2023mar.onnx from https://github.com/opencv/opencv_zoo into models/');
  }

  const sampleFps = opts.sampleFps ?? 5;
  const score = opts.score ?? 0.6;
  const key = cacheKey(abs, { sampleFps, score });
  const cacheFile = path.join(ensureDir(path.join(DIR.cache, 'faces')), `${slug(abs)}-${key}.json`);

  let detection;
  if (!opts.force && fs.existsSync(cacheFile)) {
    try {
      detection = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      log.debug(`track-faces: cache hit ${relToRoot(cacheFile)}`);
    } catch { detection = null; }
  }
  if (!detection) {
    detection = await runPython('detect_faces.py', [
      '--video', abs, '--model', model, '--fps', String(sampleFps), '--score', String(score),
    ], { label: 'detect-faces', timeoutMs: 0, onLog: line => log.debug(line) });
    fs.writeFileSync(cacheFile, JSON.stringify(detection));
  }

  const samples = detection.samples || [];
  if (!samples.length) throw validationError('face detection returned no samples', { file: relToRoot(abs) });

  const picked = pickSubject(samples, { stickiness: opts.stickiness ?? 1.35 });
  const filled = fillGaps(picked);
  const smoothed = smoothTrack(filled, {
    smoothing: opts.smoothing ?? 0.85,
    deadzone: opts.deadzone ?? 0.02,
    maxStep: opts.maxStep ?? 0.06,
  });

  const shot = classify(samples, { coverage: detection.coverage });
  const presence = findPresenceChanges(samples);

  if (shot.kind === 'no-subject') {
    log.warn(`faces found in only ${Math.round(detection.coverage * 100)}% of samples — ` +
      `this does not look like footage of a person`);
  } else if (!shot.singleSubject) {
    log.warn(`${shot.maxSimultaneousFaces} faces seen at once. The "primary subject" is the ` +
      `largest face, NOT the person speaking — speaker identification is not implemented.`);
  }

  const result = {
    source: relToRoot(abs),
    duration: meta.duration,
    width: detection.width,
    height: detection.height,
    detector: 'yunet',
    sampleRate: detection.sampleRate,
    sampleCount: detection.sampleCount,
    framesWithFaces: detection.framesWithFaces,
    coverage: detection.coverage,
    shot,
    presenceChanges: presence,
    // The camera-ready track: one smoothed position per sample.
    track: smoothed.map(p => ({ t: p.t, cx: p.cx, cy: p.cy, held: p.held, faces: p.faces ?? 0 })),
    // Raw detections, for anything that wants to do its own tracking.
    samples,
    cacheKey: key,
  };

  const out = prepareOutput(opts.out || path.join(ensureDir(path.join(DIR.cache, 'faces')), `${slug(abs)}-track.json`));
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  result.output = relToRoot(out);
  result.path = out;
  return result;
}

const round = (n, p = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : n);

export const tool = {
  name: 'track-faces',
  summary: 'Locate faces over time and produce a smoothed subject track.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    sampleFps: { type: 'number', default: 5, help: 'Detection sampling rate' },
    score: { type: 'number', default: 0.6, help: 'Detection confidence threshold' },
    smoothing: { type: 'number', default: 0.85, help: '0..1 — higher is calmer' },
    deadzone: { type: 'number', default: 0.02, help: 'Ignore subject movement below this' },
    maxStep: { type: 'number', default: 0.06, help: 'Maximum track movement per sample' },
    stickiness: { type: 'number', default: 1.35, help: 'How much bigger a rival face must be to take over' },
    out: { type: 'string', help: 'Output JSON path' },
    force: { type: 'bool', default: false, help: 'Re-detect instead of using the cache' },
  },
  examples: [
    've track-faces raw/podcast.mp4',
    've track-faces raw/talk.mp4 --sample-fps 10 | jq .shot',
    've smart-crop raw/talk.mp4 --track cache/faces/talk-track.json',
  ],
  run: opts => trackFaces(opts.input, opts),
  pretty: r => `${r.shot.kind}, ${Math.round(r.coverage * 100)}% coverage, ` +
    `max ${r.shot.maxSimultaneousFaces} face(s), ${r.presenceChanges.length} presence change(s) -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
