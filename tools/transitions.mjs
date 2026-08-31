// transitions — join clips, or soften a cut point inside one video.
//
// The brief's rule is followed literally: **a hard cut is the default and this
// tool is not it.** Nothing here runs unless asked for. Short-form video is
// almost always better with hard cuts, and a transition used because it exists
// is a tell.
//
// Two modes, because "transition" means two different things:
//
//   join   put N clips together with a transition between each pair. Uses
//          `xfade`, which handles the overlap and the timing properly.
//   at     apply a transition AT points inside a single video — typically the
//          cut points that `cut-video` already produced. A dip to black is the
//          one that reads as intentional; the rest are usually noise.
//
// `xfade` has a trap: it needs both inputs to share resolution, pixel format
// AND frame rate, and it fails with an unhelpful error when they do not. Every
// input is normalised first.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, encodeArgs } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

/** xfade transition names, grouped by what they read as. */
export const JOIN_TYPES = {
  crossfade: 'fade',
  dissolve: 'dissolve',
  fadeblack: 'fadeblack',
  fadewhite: 'fadewhite',
  'slide-left': 'slideleft',
  'slide-right': 'slideright',
  'slide-up': 'slideup',
  'slide-down': 'slidedown',
  'wipe-left': 'wipeleft',
  'wipe-right': 'wiperight',
  circle: 'circleopen',
  zoom: 'zoomin',
  blur: 'fadegrays',
  pixelize: 'pixelize',
};

/** Transitions that can be applied at a point inside one continuous video. */
export const AT_TYPES = ['dip-black', 'dip-white', 'flash'];

export const TYPES = [...Object.keys(JOIN_TYPES), ...AT_TYPES];

/* --------------------------------------------------------------- join mode */

/**
 * @param {string[]} clips
 * @param {{type?:string, duration?:number, out?:string, quality?:string, hw?:string}} opts
 */
export async function joinWithTransitions(clips, opts = {}) {
  const type = opts.type || 'crossfade';
  const xfade = JOIN_TYPES[type];
  if (!xfade) {
    throw usageError(`"${type}" is not a join transition`,
      `Use one of: ${Object.keys(JOIN_TYPES).join(', ')}`);
  }
  const duration = opts.duration ?? 0.5;
  if (duration <= 0) throw usageError('--duration must be positive');

  if (clips.length < 2) throw usageError('joining needs at least two clips');

  const metas = [];
  for (const [i, c] of clips.entries()) {
    const abs = resolveInput(c, `clips[${i}]`);
    const m = await probeVideo(abs);
    if (!m.hasVideo) throw inputError(`clips[${i}] has no video track: ${relToRoot(abs)}`);
    if (m.duration <= duration) {
      throw usageError(
        `clips[${i}] is ${m.duration}s but the transition is ${duration}s`,
        'Each clip must be longer than the transition it takes part in.'
      );
    }
    metas.push({ ...m, path: abs });
  }

  // Target geometry comes from the first clip; everything is conformed to it,
  // because xfade silently refuses mismatched inputs.
  const W = metas[0].width;
  const H = metas[0].height;
  const FPS = Math.round(metas[0].fps || 30);
  const anyAudio = metas.some(m => m.hasAudio);

  const parts = [];
  metas.forEach((m, i) => {
    parts.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v${i}]`
    );
    if (anyAudio) {
      parts.push(m.hasAudio
        ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=end=${m.duration},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });

  // Each xfade offset is measured on the ACCUMULATED timeline, and every
  // transition overlaps the clips by `duration`, so the running total has to
  // subtract it each time. Getting this wrong is the classic xfade bug.
  let vPrev = '[v0]';
  let aPrev = '[a0]';
  let offset = metas[0].duration - duration;

  for (let i = 1; i < metas.length; i++) {
    const vOut = i === metas.length - 1 ? '[vout]' : `[vx${i}]`;
    parts.push(`${vPrev}[v${i}]xfade=transition=${xfade}:duration=${duration}:offset=${offset.toFixed(4)}${vOut}`);
    vPrev = vOut;

    if (anyAudio) {
      const aOut = i === metas.length - 1 ? '[aout]' : `[ax${i}]`;
      parts.push(`${aPrev}[a${i}]acrossfade=d=${duration}:c1=tri:c2=tri${aOut}`);
      aPrev = aOut;
    }
    offset += metas[i].duration - duration;
  }

  const expected = metas.reduce((s, m) => s + m.duration, 0) - duration * (metas.length - 1);
  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(metas[0].path)}-joined.mp4`));
  const { args: enc } = await encodeArgs({ quality: opts.quality || 'final', hw: opts.hw || 'auto' });

  log.info(`joining ${clips.length} clips with ${type} (${duration}s) -> ~${expected.toFixed(2)}s`);

  await ffmpeg([
    '-y',
    ...metas.flatMap(m => ['-i', m.path]),
    '-filter_complex', parts.join(';'),
    '-map', '[vout]',
    ...(anyAudio ? ['-map', '[aout]', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    ...stripVf(enc),
    out,
  ], { label: 'transitions(join)', totalSec: expected });

  const got = await probeVideo(out);
  if (Math.abs(got.duration - expected) > Math.max(0.5, expected * 0.05)) {
    throw validationError(`join produced ${got.duration}s, expected ${expected.toFixed(2)}s`,
      { clips: metas.map(m => m.duration), duration });
  }

  return {
    mode: 'join',
    clips: metas.map(m => relToRoot(m.path)),
    clipCount: metas.length,
    output: relToRoot(out),
    path: out,
    type,
    transitionDuration: duration,
    expectedDuration: round(expected),
    duration: got.duration,
    width: got.width,
    height: got.height,
    hasAudio: got.hasAudio,
    sizeBytes: got.sizeBytes,
  };
}

/* ----------------------------------------------------------------- at mode */

/**
 * Apply a transition at points INSIDE one video. Duration is unchanged — this
 * dips or flashes across the cut rather than inserting anything.
 */
export async function transitionsAt(input, opts = {}) {
  const type = opts.type || 'dip-black';
  if (!AT_TYPES.includes(type)) {
    throw usageError(`"${type}" cannot be applied inside a single video`,
      `Use one of: ${AT_TYPES.join(', ')} — or --clips to join separate files.`);
  }

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  const duration = opts.duration ?? 0.3;

  const points = String(opts.at).split(',').map(s => Number(s.trim())).filter(Number.isFinite);
  if (!points.length) throw usageError('--at needs at least one timestamp');
  for (const t of points) {
    if (t <= 0 || t >= meta.duration) {
      throw usageError(`transition point ${t}s is outside the ${meta.duration}s video`);
    }
  }

  const half = duration / 2;
  const colour = type === 'dip-white' || type === 'flash' ? 'white' : 'black';
  const filters = [];

  // `enable` is not optional here. `fade=t=out` HOLDS its final state for the
  // rest of the stream, so an un-gated fade-out followed by a fade-in leaves
  // the fade-in receiving solid black and passing it straight through — the
  // whole video after the first dip comes out black (measured: YAVG 16 from
  // the dip to the end). Gating each fade to its own window makes the filter
  // pass frames through untouched outside it.
  for (const t of points) {
    const outStart = Math.max(0, t - half);
    const inEnd = Math.min(meta.duration, t + half);
    filters.push(
      `fade=t=out:st=${outStart.toFixed(3)}:d=${half.toFixed(3)}:color=${colour}` +
      `:enable='between(t,${outStart.toFixed(3)},${t.toFixed(3)})'`
    );
    filters.push(
      `fade=t=in:st=${t.toFixed(3)}:d=${half.toFixed(3)}:color=${colour}` +
      `:enable='between(t,${t.toFixed(3)},${inEnd.toFixed(3)})'`
    );
  }

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-transitions.mp4`));
  const { args: enc } = await encodeArgs({ quality: opts.quality || 'final', hw: opts.hw || 'auto' });

  log.info(`${type} at ${points.length} point(s), ${duration}s each`);

  await ffmpeg([
    '-y', '-i', abs,
    '-vf', filters.join(','),
    ...(meta.hasAudio ? ['-map', '0:v', '-map', '0:a', '-c:a', 'copy'] : ['-map', '0:v', '-an']),
    ...stripVf(enc),
    out,
  ], { label: 'transitions(at)', totalSec: meta.duration });

  const got = await probeVideo(out);
  if (Math.abs(got.duration - meta.duration) > 0.3) {
    throw validationError(`applying transitions changed the duration: ${got.duration}s vs ${meta.duration}s`);
  }

  return {
    mode: 'at',
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    type,
    points,
    pointCount: points.length,
    transitionDuration: duration,
    duration: got.duration,
    width: got.width,
    height: got.height,
    hasAudio: got.hasAudio,
    sizeBytes: got.sizeBytes,
  };
}

export async function transitions(input, opts = {}) {
  if (opts.clips) {
    const list = Array.isArray(opts.clips) ? opts.clips : String(opts.clips).split(',').map(s => s.trim());
    return joinWithTransitions(input ? [input, ...list] : list, opts);
  }
  if (!input) throw usageError('Give a video (with --at) or --clips to join');
  return transitionsAt(input, opts);
}

function stripVf(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-vf') { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

const round = n => Math.round(n * 1000) / 1000;

export const tool = {
  name: 'transitions',
  summary: 'Join clips with a transition, or dip/flash at cut points. Hard cut stays the default.',
  args: {
    input: { positional: 0, help: 'Source video (for --at), or the first clip (with --clips)' },
    clips: { type: 'string', help: 'Further clips to join, comma-separated' },
    at: { type: 'string', help: 'Timestamps to apply a transition at, comma-separated' },
    type: { type: 'enum', values: TYPES, default: 'crossfade', help: 'Transition style' },
    duration: { type: 'number', default: 0.5, help: 'Transition length in seconds' },
    out: { type: 'string', help: 'Output path' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've transitions a.mp4 --clips b.mp4,c.mp4 --type crossfade --duration 0.5',
    've transitions output/cut.mp4 --at 5.2,13.4 --type dip-black --duration 0.3',
  ],
  run: opts => transitions(opts.input, opts),
  pretty: r => r.mode === 'join'
    ? `joined ${r.clipCount} clips with ${r.type} (${r.transitionDuration}s) -> ${r.output} ${r.duration}s`
    : `${r.type} at ${r.pointCount} point(s) -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
