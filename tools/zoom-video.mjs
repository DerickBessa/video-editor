// zoom-video — timed, eased zoom/punch moves.
//
// Backend: ffmpeg `zoompan`. `crop` was the more elegant candidate, but in
// ffmpeg 8 crop's w/h expressions are evaluated once at init (only x/y are
// per-frame), so crop can pan but cannot zoom.
//
// zoompan has three traps, all of which bite silently:
//   d   defaults to 90, holding every input frame for 90 output frames
//   s   defaults to hd720, quietly resizing the video
//   fps defaults to 25, quietly changing the frame rate
// All three are set explicitly here from the source's own properties.
//
// EASING. A linear ramp reads as mechanical, and a step reads as a glitch.
// Every move uses smoothstep (3x^2-2x^3), whose first derivative is zero at
// both ends, so the move starts and stops without a visible jerk.
import path from 'node:path';
import fs from 'node:fs';
import { ffmpeg, encodeArgs } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

export const MODES = ['smooth', 'punch', 'linear'];

/**
 * @typedef {Object} ZoomEvent
 * @property {number} start
 * @property {number} end
 * @property {number} [scale]   1.0 = no zoom; 1.12 = 12% in
 * @property {'smooth'|'punch'|'linear'} [mode]
 * @property {number} [x]       focal point 0..1 across the frame (default 0.5)
 * @property {number} [y]       focal point 0..1 down the frame (default 0.5)
 * @property {number} [ramp]    seconds to reach full zoom (default: mode-dependent)
 * @property {string} [reason]  free text, carried into the reasoning log
 */

const DEFAULT_RAMP = { smooth: 0.6, linear: 0.6, punch: 0.08 };

export function parseEvents(raw) {
  if (raw == null) return [];
  let list = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try { list = JSON.parse(trimmed); } catch (e) { throw usageError(`Could not parse zoom events JSON: ${e.message}`); }
    } else {
      // Compact CLI form: "5-7@1.12", optionally with a focal point "5-7@1.12:0.3,0.4"
      list = trimmed.split(';').map(part => {
        const m = /^(\d*\.?\d+)\s*-\s*(\d*\.?\d+)\s*@\s*(\d*\.?\d+)(?::(\d*\.?\d+),(\d*\.?\d+))?$/.exec(part.trim());
        if (!m) throw usageError(`Could not parse zoom "${part}"`, 'Use START-END@SCALE[:X,Y], e.g. "5-7@1.12" or "5-7@1.12:0.3,0.4".');
        return {
          start: Number(m[1]), end: Number(m[2]), scale: Number(m[3]),
          ...(m[4] !== undefined ? { x: Number(m[4]), y: Number(m[5]) } : {}),
        };
      });
    }
  }
  if (!Array.isArray(list)) list = [list];
  return list.map((e, i) => normalizeEvent(e, i));
}

function normalizeEvent(e, i) {
  const start = Number(e.start);
  const end = Number(e.end);
  const scale = e.scale === undefined ? 1.1 : Number(e.scale);
  const mode = e.mode || 'smooth';

  if (!Number.isFinite(start) || !Number.isFinite(end)) throw usageError(`zoom[${i}] has non-numeric start/end`);
  if (end <= start) throw usageError(`zoom[${i}]: end (${end}) must be after start (${start})`);
  if (!MODES.includes(mode)) throw usageError(`zoom[${i}]: unknown mode "${mode}"`, `Use: ${MODES.join(', ')}`);
  if (!Number.isFinite(scale) || scale <= 0) throw usageError(`zoom[${i}]: scale must be positive`);

  const x = e.x === undefined ? 0.5 : clamp01(Number(e.x));
  const y = e.y === undefined ? 0.5 : clamp01(Number(e.y));
  const maxRamp = (end - start) / 2;
  const ramp = Math.min(e.ramp ?? DEFAULT_RAMP[mode], maxRamp);

  return { start, end, scale, mode, x, y, ramp, reason: e.reason };
}

const clamp01 = v => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));

/**
 * @param {string} input
 * @param {{events?:*, plan?:string, baseScale?:number, out?:string, quality?:string, hw?:string}} opts
 */
export async function zoomVideo(input, opts = {}) {
  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) throw inputError(`${relToRoot(abs)} has no video track`);

  let raw = opts.events;
  if (opts.plan) {
    const planPath = resolveInput(opts.plan, 'plan');
    let plan;
    try { plan = JSON.parse(fs.readFileSync(planPath, 'utf8')); }
    catch (e) { throw inputError(`Could not parse plan JSON: ${relToRoot(planPath)}`, e.message); }
    raw = raw ?? plan.zooms ?? plan.zoom;
  }

  const events = parseEvents(raw).sort((a, b) => a.start - b.start);
  if (!events.length) throw usageError('No zoom events given', 'Use --events "5-7@1.12" or --plan edit-plans/x.json');

  for (const [i, e] of events.entries()) {
    if (e.end > meta.duration + 0.05) {
      throw usageError(`zoom[${i}] ends at ${e.end}s, beyond the ${meta.duration}s source`);
    }
    if (i > 0 && e.start < events[i - 1].end - 1e-6) {
      throw usageError(`zoom[${i}] overlaps the previous event`,
        'Overlapping zooms would fight each other; merge them into one event.');
    }
  }

  const baseScale = opts.baseScale ?? 1.0;
  const fps = meta.fps || 30;

  const zExpr = buildZoomExpr(events, baseScale);
  const xExpr = buildFocusExpr(events, 'x', baseScale);
  const yExpr = buildFocusExpr(events, 'y', baseScale);

  // Supersampling: zoompan computes its crop origin in whole pixels, so in
  // THEORY a slow off-centre move steps by 1px at a time and 2x-ing the input
  // first should halve that. In PRACTICE this could not be demonstrated:
  // measuring the crop origin frame-by-frame on a slow off-centre zoom gave an
  // identical step histogram with it on and off ({0:91, 2:15, -2:3}), while
  // costing ~21% more render time at 1080p. It does change the output
  // (PSNR 33.6 dB), just not measurably for the better.
  //
  // So it is OFF by default — no paying for an unproven benefit — but kept as
  // an option for footage where stepping is visible in practice.
  // See ROADMAP.md.
  const superSample = opts.superSample ?? false;
  const pre = superSample ? `scale=${meta.width * 2}:${meta.height * 2}:flags=bicubic,` : '';
  const zw = superSample ? meta.width * 2 : meta.width;
  const zh = superSample ? meta.height * 2 : meta.height;

  const graph =
    `[0:v]${pre}zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${zw}x${zh}:fps=${fps}` +
    (superSample ? `,scale=${meta.width}:${meta.height}:flags=lanczos` : '') +
    `,setsar=1[vout]`;

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-zoom.mp4`));
  const { args: enc } = await encodeArgs({ quality: opts.quality || 'final', hw: opts.hw || 'auto' });
  const encNoVf = stripVf(enc);

  log.info(`zoom: ${events.length} event(s), base ${baseScale}x${superSample ? ', 2x supersampled' : ''}`);

  await ffmpeg([
    '-y', '-i', abs,
    '-filter_complex', graph,
    '-map', '[vout]',
    ...(meta.hasAudio ? ['-map', '0:a', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    ...encNoVf,
    out,
  ], { label: 'zoom-video', totalSec: meta.duration });

  const got = await probeVideo(out);
  if (got.width !== meta.width || got.height !== meta.height) {
    throw validationError(`zoom changed the frame size to ${got.width}x${got.height}`,
      { expected: `${meta.width}x${meta.height}` });
  }
  if (Math.abs(got.duration - meta.duration) > 0.3) {
    throw validationError(`zoom changed the duration: ${got.duration}s vs ${meta.duration}s`,
      { hint: 'zoompan d/fps are probably wrong' });
  }

  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    events: events.map(e => ({
      start: e.start, end: e.end, scale: e.scale, mode: e.mode,
      x: e.x, y: e.y, ramp: round(e.ramp), reason: e.reason,
    })),
    eventCount: events.length,
    baseScale,
    superSampled: superSample,
    width: got.width,
    height: got.height,
    fps: got.fps,
    duration: got.duration,
    sourceDuration: meta.duration,
    hasAudio: got.hasAudio,
    sizeBytes: got.sizeBytes,
  };
}

/* ------------------------------------------------------------ expressions */

/**
 * Envelope for one event, in 0..1, as an ffmpeg expression over `it`.
 * smoothstep has zero slope at both ends, so the move eases in and out.
 */
function envelope(e) {
  const { start, end, ramp, mode } = e;

  if (mode === 'punch') {
    // Snap in fast, hold, then ease back out over the tail.
    const outStart = Math.max(start + ramp, end - 0.25);
    return `if(lt(it,${f(start + ramp)}), ${smoothstep(`(it-${f(start)})/${f(ramp)}`)},` +
      ` if(lt(it,${f(outStart)}), 1, ${smoothstep(`(${f(end)}-it)/${f(end - outStart)}`)}))`;
  }

  const inEnd = start + ramp;
  const outStart = end - ramp;
  const rise = mode === 'linear' ? `(it-${f(start)})/${f(ramp)}` : smoothstep(`(it-${f(start)})/${f(ramp)}`);
  const fall = mode === 'linear' ? `(${f(end)}-it)/${f(ramp)}` : smoothstep(`(${f(end)}-it)/${f(ramp)}`);

  return `if(lt(it,${f(inEnd)}), ${rise}, if(lt(it,${f(outStart)}), 1, ${fall}))`;
}

/** clamp(t,0,1) then 3t^2-2t^3 */
const smoothstep = t => {
  const c = `clip(${t},0,1)`;
  return `(${c}*${c}*(3-2*${c}))`;
};

function buildZoomExpr(events, baseScale) {
  // Nested conditionals: events are validated non-overlapping, so at most one
  // is active at any time.
  let expr = f(baseScale);
  for (const e of [...events].reverse()) {
    const delta = e.scale - baseScale;
    expr = `if(between(it,${f(e.start)},${f(e.end)}), ${f(baseScale)}+(${f(delta)})*(${envelope(e)}), ${expr})`;
  }
  return expr;
}

/**
 * zoompan crops a (iw/zoom x ih/zoom) window at (x,y) from the input.
 * To hold a normalised focal point p in the middle of that window:
 *   x = p*iw - (iw/zoom)/2, clamped so the window stays inside the frame.
 */
function buildFocusExpr(events, axis, baseScale) {
  const dim = axis === 'x' ? 'iw' : 'ih';
  const win = `${dim}/zoom`;
  const place = p => `max(0,min(${dim}-${win}, ${f(p)}*${dim}-(${win})/2))`;

  let expr = place(0.5);
  for (const e of [...events].reverse()) {
    const p = axis === 'x' ? e.x : e.y;
    expr = `if(between(it,${f(e.start)},${f(e.end)}), ${place(p)}, ${expr})`;
  }
  return expr;
}

/** Fixed notation: ffmpeg's expression parser does not accept 1e-7. */
const f = n => Number(n).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');

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
  name: 'zoom-video',
  summary: 'Apply timed, eased zoom and punch-in moves.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    events: { type: 'string', help: 'JSON array, or compact "5-7@1.12;12-14@1.2:0.3,0.4"' },
    plan: { type: 'string', help: 'JSON file containing {zooms:[...]}' },
    baseScale: { type: 'number', default: 1.0, help: 'Resting zoom; set >1 so events can zoom OUT' },
    superSample: { type: 'bool', default: false, help: 'Zoom at 2x internally (~21% slower; no measurable gain, see ROADMAP)' },
    out: { type: 'string', help: 'Output path' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've zoom-video raw/test.mp4 --events "5-7@1.12"',
    've zoom-video raw/test.mp4 --events "5-7@1.12;12-14@1.25:0.3,0.4"',
    've zoom-video raw/test.mp4 --plan edit-plans/video.json',
  ],
  run: opts => zoomVideo(opts.input, opts),
  pretty: r => `${r.eventCount} zoom(s) -> ${r.output}  ${r.width}x${r.height} ${r.duration}s` +
    `${r.superSampled ? ' (2x supersampled)' : ''}`,
};

runIfMain(tool, import.meta.url);
