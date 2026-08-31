// The edit plan: one JSON document describing an entire edit.
//
// THE CENTRAL DESIGN DECISION — every timestamp in a plan is in SOURCE time.
//
// Cutting happens first in the render pipeline, so by the time a zoom is
// applied the timeline has already shifted. Storing zoom times in the post-cut
// timeline would be the easy implementation and a terrible interface: every
// time a cut changed, every other event would silently point at the wrong
// moment, and a human could never reason about it. Instead the plan is written
// entirely in the original recording's time, and `toCutTimeline()` remaps it at
// render time using ranges.mapToCut. That is what lets a later instruction like
// "remove the zoom at 17 seconds" mean the obvious thing.
//
// Consequence to remember: an event that sits inside a REMOVED range no longer
// exists in the output. Such events are dropped and reported, never silently
// slid to a neighbouring moment.
import fs from 'node:fs';
import path from 'node:path';
import { parseRanges, normalize, invert, mapToCut, totalDuration, validate as validateRanges } from './ranges.mjs';
import { configHash } from './hash.mjs';

export const PLAN_VERSION = 1;

/** Every stage the renderer knows, in the ONLY order that is correct. */
export const STAGES = [
  'cuts',        // first: everything downstream lives in the cut timeline
  'speed',       // retime before geometry so zoom/caption timing follows
  'crop',        // set the final frame size before anything is drawn on it
  'zoom',        // operates on the final geometry
  'overlays',    // drawn onto the final geometry
  'captions',    // burned last so text is never rescaled or cropped
  'audio',       // loudness after all cutting and retiming
  'sfx',         // mixed on top of the finished audio
];

export function emptyPlan(source = '') {
  return {
    version: PLAN_VERSION,
    source,
    style: 'clean',
    output: { path: null, resolution: null, fps: null },
    cuts: { keep: null, remove: [], silences: [], fillers: [] },
    speed: [],
    crop: null,
    zooms: [],
    captions: { enabled: false },
    overlays: [],
    sfx: [],
    audio: { normalize: false },
    transitions: [],
    meta: { createdAt: new Date().toISOString(), notes: [] },
  };
}

/** Read a plan from disk with a clear error on malformed JSON. */
export function loadPlan(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${e.message}`);
  }
}

/**
 * Fill in defaults and coerce loose shapes into strict ones, so the renderer
 * and the validator both see exactly one representation.
 */
export function normalizePlan(plan, { duration } = {}) {
  const p = { ...emptyPlan(plan.source), ...plan };
  p.version = p.version ?? PLAN_VERSION;
  p.output = { path: null, resolution: null, fps: null, ...(plan.output || {}) };
  p.cuts = { keep: null, remove: [], silences: [], fillers: [], ...(plan.cuts || {}) };
  p.captions = { enabled: false, ...(plan.captions || {}) };
  p.audio = { normalize: false, ...(plan.audio || {}) };
  p.meta = { createdAt: new Date().toISOString(), notes: [], ...(plan.meta || {}) };

  // Merge every source of removals into one list. silences and fillers are
  // kept separate in the document so the reasoning log can say WHY each cut
  // happened, but the renderer only cares about the union.
  const removals = [
    ...parseRanges(p.cuts.remove || [], 'cuts.remove'),
    ...parseRanges(p.cuts.silences || [], 'cuts.silences'),
    ...parseRanges(p.cuts.fillers || [], 'cuts.fillers'),
  ];

  if (p.cuts.keep) {
    p.keepRanges = normalize(parseRanges(p.cuts.keep, 'cuts.keep'), { duration });
  } else if (removals.length) {
    p.keepRanges = invert(normalize(removals, { duration }), duration ?? Infinity, { minDuration: 0.05 });
  } else {
    p.keepRanges = duration ? [{ start: 0, end: duration }] : null;
  }

  p.removeRanges = normalize(removals, { duration });
  p.zooms = (p.zooms || []).map(z => ({ mode: 'smooth', scale: 1.1, x: 0.5, y: 0.5, ...z }));
  p.speed = (p.speed || []).map(s => ({ rate: 1, ...s }));
  p.sfx = (p.sfx || []).map(s => ({ volume: 0.4, priority: 0.5, ...s }));
  p.overlays = p.overlays || [];
  return p;
}

/**
 * Structural validation. Returns a list of human-readable problems; empty means
 * the plan is renderable. Deliberately returns ALL problems rather than
 * throwing on the first, so one run tells you everything that is wrong.
 *
 * @param {object} plan
 * @param {{duration?:number, width?:number, height?:number, root?:string, hasAudio?:boolean}} ctx
 */
export function validatePlan(plan, ctx = {}) {
  const problems = [];
  const warnings = [];
  const { duration, root = process.cwd(), hasAudio } = ctx;

  const err = m => problems.push(m);
  const warn = m => warnings.push(m);

  if (plan.version !== PLAN_VERSION) {
    warn(`plan version ${plan.version} does not match the current ${PLAN_VERSION}`);
  }
  if (!plan.source) err('source is required');
  else if (!fs.existsSync(path.resolve(root, plan.source))) err(`source not found: ${plan.source}`);

  const p = normalizePlan(plan, { duration });

  // --- cuts
  for (const [name, ranges] of [['cuts.keep', p.keepRanges], ['cuts.remove', p.removeRanges]]) {
    if (!ranges) continue;
    for (const problem of validateRanges(ranges, { duration, label: name })) err(problem);
  }
  if (p.keepRanges && !p.keepRanges.length) err('cuts remove the entire video — nothing would be left');
  if (p.keepRanges && duration && totalDuration(p.keepRanges) < 0.2) {
    err(`cuts leave only ${totalDuration(p.keepRanges).toFixed(2)}s of video`);
  }

  // --- speed
  p.speed.forEach((s, i) => {
    if (!Number.isFinite(s.rate) || s.rate <= 0) err(`speed[${i}]: rate must be positive`);
    else if (s.rate < 0.1 || s.rate > 10) err(`speed[${i}]: rate ${s.rate} is outside the supported 0.1..10 range`);
    if (s.start !== undefined && s.end !== undefined && s.end <= s.start) {
      err(`speed[${i}]: end (${s.end}) must be after start (${s.start})`);
    }
  });
  if (p.speed.length > 1) warn('multiple speed ranges are not yet supported; only the first is applied');

  // --- zooms
  p.zooms.forEach((z, i) => {
    if (!Number.isFinite(z.start) || !Number.isFinite(z.end)) err(`zooms[${i}]: start and end must be numbers`);
    else if (z.end <= z.start) err(`zooms[${i}]: end (${z.end}) must be after start (${z.start})`);
    else if (z.start < 0) err(`zooms[${i}]: negative start (${z.start})`);
    else if (duration && z.start >= duration) err(`zooms[${i}]: starts at ${z.start}s, beyond the ${duration}s source`);
    if (!Number.isFinite(z.scale) || z.scale <= 0) err(`zooms[${i}]: scale must be positive`);
    else if (z.scale > 3) warn(`zooms[${i}]: scale ${z.scale} is extreme and will look artificial`);
    if (z.x !== undefined && (z.x < 0 || z.x > 1)) err(`zooms[${i}]: x must be between 0 and 1`);
    if (z.y !== undefined && (z.y < 0 || z.y > 1)) err(`zooms[${i}]: y must be between 0 and 1`);
  });
  const sortedZooms = [...p.zooms].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sortedZooms.length; i++) {
    if (sortedZooms[i].start < sortedZooms[i - 1].end - 1e-6) {
      err(`zooms overlap: ${fmtRange(sortedZooms[i - 1])} and ${fmtRange(sortedZooms[i])}`);
    }
  }

  // --- crop
  if (p.crop) {
    if (p.crop.mode && !['static', 'smart', 'contain'].includes(p.crop.mode)) {
      err(`crop.mode "${p.crop.mode}" is not one of: static, smart, contain`);
    }
    if (p.crop.aspect && !/^\d+(\.\d+)?\s*[:x/]\s*\d+(\.\d+)?$/.test(String(p.crop.aspect))) {
      err(`crop.aspect "${p.crop.aspect}" should look like 9:16`);
    }
  }

  // --- output
  if (p.output.resolution && !/^\d+x\d+$/.test(p.output.resolution)) {
    err(`output.resolution "${p.output.resolution}" should look like 1080x1920`);
  }
  if (p.output.fps !== null && p.output.fps !== undefined) {
    if (!Number.isFinite(p.output.fps) || p.output.fps <= 0 || p.output.fps > 240) {
      err(`output.fps ${p.output.fps} is not a sensible frame rate`);
    }
  }
  if (p.output.path) {
    const abs = path.resolve(root, p.output.path);
    const rel = path.relative(path.resolve(root, 'raw'), abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      err(`output.path is inside raw/, which is read-only: ${p.output.path}`);
    }
  }

  // --- sfx (assets must exist BEFORE a long render starts)
  p.sfx.forEach((s, i) => {
    const t = s.timestamp ?? s.time;
    if (!Number.isFinite(t) || t < 0) err(`sfx[${i}]: invalid timestamp`);
    else if (duration && t >= duration) err(`sfx[${i}]: timestamp ${t}s is beyond the ${duration}s source`);
    if (!s.sound) err(`sfx[${i}]: no sound named`);
    else {
      const file = s.sound.includes('/') || s.sound.includes('\\')
        ? path.resolve(root, s.sound)
        : path.resolve(root, 'assets', 'sfx', /\.\w+$/.test(s.sound) ? s.sound : `${s.sound}.wav`);
      if (!fs.existsSync(file)) err(`sfx[${i}]: sound file not found: ${path.relative(root, file)}`);
    }
    if (s.volume !== undefined && (s.volume < 0 || s.volume > 4)) err(`sfx[${i}]: volume ${s.volume} out of range`);
  });

  // --- overlays
  p.overlays.forEach((o, i) => {
    if (!o.asset) err(`overlays[${i}]: no asset`);
    else if (!fs.existsSync(path.resolve(root, o.asset))) err(`overlays[${i}]: asset not found: ${o.asset}`);
    if (o.end !== undefined && o.start !== undefined && o.end <= o.start) {
      err(`overlays[${i}]: end must be after start`);
    }
  });

  // --- audio
  if (p.audio.normalize && hasAudio === false) {
    err('audio.normalize is set but the source has no audio track');
  }
  if (p.captions.enabled && hasAudio === false) {
    err('captions are enabled but the source has no audio to transcribe');
  }
  if (p.audio.targetLufs !== undefined && (p.audio.targetLufs < -70 || p.audio.targetLufs > -5)) {
    err(`audio.targetLufs ${p.audio.targetLufs} is outside the -70..-5 range loudnorm accepts`);
  }

  // --- events that a cut would delete entirely
  if (p.keepRanges && p.removeRanges.length) {
    const dead = [];
    for (const [i, z] of p.zooms.entries()) {
      if (isRemoved(z.start, p.keepRanges) && isRemoved(z.end, p.keepRanges)) dead.push(`zooms[${i}] ${fmtRange(z)}`);
    }
    for (const [i, s] of p.sfx.entries()) {
      const t = s.timestamp ?? s.time;
      if (isRemoved(t, p.keepRanges)) dead.push(`sfx[${i}] at ${t}s`);
    }
    if (dead.length) warn(`these events sit entirely inside removed footage and will be dropped: ${dead.join(', ')}`);
  }

  return { valid: problems.length === 0, problems, warnings };
}

const isRemoved = (t, keep) => !keep.some(r => t >= r.start - 1e-6 && t <= r.end + 1e-6);
const fmtRange = r => `${Number(r.start).toFixed(2)}-${Number(r.end).toFixed(2)}`;

/**
 * Rewrite a plan's SOURCE-time events into the post-cut timeline.
 * Events wholly inside removed footage are dropped and listed.
 */
export function toCutTimeline(plan, { duration } = {}) {
  const p = normalizePlan(plan, { duration });
  const keep = p.keepRanges || [{ start: 0, end: duration ?? 0 }];
  const dropped = [];

  const zooms = [];
  for (const [i, z] of p.zooms.entries()) {
    if (isRemoved(z.start, keep) && isRemoved(z.end, keep)) {
      dropped.push({ kind: 'zoom', index: i, reason: 'inside removed footage' });
      continue;
    }
    const start = mapToCut(z.start, keep);
    const end = mapToCut(z.end, keep);
    if (end - start < 0.1) {
      dropped.push({ kind: 'zoom', index: i, reason: 'cut down to less than 0.1s' });
      continue;
    }
    zooms.push({ ...z, start: round(start), end: round(end), sourceStart: z.start, sourceEnd: z.end });
  }

  const sfx = [];
  for (const [i, s] of p.sfx.entries()) {
    const t = s.timestamp ?? s.time;
    if (isRemoved(t, keep)) {
      dropped.push({ kind: 'sfx', index: i, reason: 'inside removed footage' });
      continue;
    }
    sfx.push({ ...s, timestamp: round(mapToCut(t, keep)), sourceTimestamp: t });
  }

  const overlays = [];
  for (const [i, o] of p.overlays.entries()) {
    if (o.start !== undefined && isRemoved(o.start, keep) && isRemoved(o.end ?? o.start, keep)) {
      dropped.push({ kind: 'overlay', index: i, reason: 'inside removed footage' });
      continue;
    }
    overlays.push({
      ...o,
      ...(o.start !== undefined ? { start: round(mapToCut(o.start, keep)) } : {}),
      ...(o.end !== undefined ? { end: round(mapToCut(o.end, keep)) } : {}),
    });
  }

  return { ...p, zooms, sfx, overlays, cutDuration: round(totalDuration(keep)), dropped };
}

const round = n => Math.round(n * 1000) / 1000;

/** Stable identity for caching a render stage. */
export function stageHash(plan, stage, extra = {}) {
  return configHash({ stage, ...extra, ...pickStage(plan, stage) });
}

function pickStage(plan, stage) {
  switch (stage) {
    case 'cuts': return { keep: plan.keepRanges };
    case 'speed': return { speed: plan.speed };
    case 'crop': return { crop: plan.crop, output: plan.output };
    case 'zoom': return { zooms: plan.zooms };
    case 'overlays': return { overlays: plan.overlays };
    case 'captions': return { captions: plan.captions };
    case 'audio': return { audio: plan.audio };
    case 'sfx': return { sfx: plan.sfx };
    default: return {};
  }
}

/** Which stages actually have work to do. */
export function activeStages(plan, { sourceDuration } = {}) {
  const active = [];
  const keep = plan.keepRanges;
  const cutsDoSomething = keep && sourceDuration
    ? Math.abs(totalDuration(keep) - sourceDuration) > 0.05 || keep.length > 1
    : Boolean(plan.removeRanges?.length);

  if (cutsDoSomething) active.push('cuts');
  if (plan.speed?.length && plan.speed.some(s => Math.abs(s.rate - 1) > 1e-6)) active.push('speed');
  if (plan.crop) active.push('crop');
  if (plan.zooms?.length) active.push('zoom');
  if (plan.overlays?.length) active.push('overlays');
  if (plan.captions?.enabled) active.push('captions');
  if (plan.audio?.normalize || plan.audio?.denoise) active.push('audio');
  if (plan.sfx?.length) active.push('sfx');
  return active;
}
