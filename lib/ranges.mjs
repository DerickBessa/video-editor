// Time-range algebra. Cutting, silence removal, zooms, B-roll and overlays all
// reduce to the same [start, end] interval maths, so it lives in one place and
// is unit-tested independently of ffmpeg.
//
// Convention everywhere in this project: seconds as floats, half-open [start, end).
import { usageError } from './errors.mjs';

/**
 * Accepts any of:
 *   "0-5.2,6.1-13.4"              CLI string
 *   [[0, 5.2], [6.1, 13.4]]       pair array
 *   [{start: 0, end: 5.2}, ...]   object array
 * @returns {{start:number,end:number}[]}
 */
export function parseRanges(input, label = 'ranges') {
  if (input == null) return [];
  const raw = typeof input === 'string' ? splitString(input, label) : input;
  if (!Array.isArray(raw)) throw usageError(`${label} must be a list of ranges`);

  return raw.map((r, i) => {
    let start, end;
    if (Array.isArray(r)) { [start, end] = r; }
    else if (r && typeof r === 'object') { start = r.start; end = r.end; }
    else throw usageError(`${label}[${i}] is not a range`);

    start = Number(start); end = Number(end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw usageError(`${label}[${i}] has non-numeric bounds`);
    }
    return { start, end };
  });
}

function splitString(s, label) {
  return s.split(',').map(part => part.trim()).filter(Boolean).map(part => {
    // Support "1.5-3.0" and "1.5:3.0"; a leading minus is never valid for time.
    const m = /^(\d*\.?\d+)\s*[-:]\s*(\d*\.?\d+)$/.exec(part);
    if (!m) throw usageError(`Cannot parse ${label} segment "${part}"`, 'Expected START-END, e.g. "0-5.2,6.1-13.4".');
    return { start: Number(m[1]), end: Number(m[2]) };
  });
}

/**
 * Clamp, sort, drop degenerate ranges and merge ones that touch or overlap.
 * @param {{start:number,end:number}[]} ranges
 * @param {{duration?:number, minDuration?:number, merge?:boolean, gap?:number}} opts
 *   gap: ranges separated by less than this are merged (default 0 = only touching)
 */
export function normalize(ranges, opts = {}) {
  const { duration, minDuration = 0, merge = true, gap = 0 } = opts;

  let out = ranges
    .map(r => ({
      start: Math.max(0, duration !== undefined ? Math.min(r.start, duration) : r.start),
      end: duration !== undefined ? Math.min(r.end, duration) : r.end,
    }))
    .filter(r => r.end - r.start > Math.max(minDuration, 1e-6))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (!merge) return out;

  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end <= gap) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** Complement of `ranges` within [0, duration]. remove-ranges -> keep-ranges. */
export function invert(ranges, duration, { minDuration = 0 } = {}) {
  const src = normalize(ranges, { duration });
  const out = [];
  let cursor = 0;
  for (const r of src) {
    if (r.start - cursor > 1e-6) out.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (duration - cursor > 1e-6) out.push({ start: cursor, end: duration });
  return out.filter(r => r.end - r.start > Math.max(minDuration, 1e-6));
}

/** Grow each range outwards, then re-merge. Used for cut padding. */
export function pad(ranges, before = 0, after = 0, { duration } = {}) {
  return normalize(
    ranges.map(r => ({ start: r.start - before, end: r.end + after })),
    { duration }
  );
}

/** Shrink each range inwards. Used to keep breath/padding when REMOVING silence. */
export function shrink(ranges, before = 0, after = 0, { minDuration = 0 } = {}) {
  return ranges
    .map(r => ({ start: r.start + before, end: r.end - after }))
    .filter(r => r.end - r.start > Math.max(minDuration, 1e-6));
}

export const totalDuration = ranges => ranges.reduce((s, r) => s + (r.end - r.start), 0);

/**
 * Structural validation with human-readable problems, for the edit-plan validator.
 * @returns {string[]} list of problems; empty means valid
 */
export function validate(ranges, { duration, label = 'range' } = {}) {
  const problems = [];
  ranges.forEach((r, i) => {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) problems.push(`${label}[${i}]: non-numeric bounds`);
    else if (r.start < 0) problems.push(`${label}[${i}]: negative start (${r.start})`);
    else if (r.end <= r.start) problems.push(`${label}[${i}]: end (${r.end}) must be after start (${r.start})`);
    else if (duration !== undefined && r.start >= duration) {
      problems.push(`${label}[${i}]: start ${r.start}s is beyond the ${duration}s source`);
    } else if (duration !== undefined && r.end > duration + 0.05) {
      problems.push(`${label}[${i}]: end ${r.end}s exceeds the ${duration}s source`);
    }
  });
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end - 1e-6) {
      problems.push(`${label}: overlapping segments ${fmt(sorted[i - 1])} and ${fmt(sorted[i])}`);
    }
  }
  return problems;
}

/** Map a timestamp in the SOURCE timeline to its position in the CUT timeline. */
export function mapToCut(t, keep) {
  let acc = 0;
  for (const r of keep) {
    if (t < r.start) return acc;            // fell inside a removed gap
    if (t <= r.end) return acc + (t - r.start);
    acc += r.end - r.start;
  }
  return acc;
}

export const fmt = r => `${r.start.toFixed(2)}-${r.end.toFixed(2)}`;

/** "00:01:04.20" for human-facing reasoning logs. */
export function timecode(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = (s % 60).toFixed(2).padStart(5, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${String(m).padStart(2, '0')}:${rest}`;
}
