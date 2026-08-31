// cut-video — keep or remove time ranges and concatenate what's left.
//
// A/V SYNC IS THE WHOLE PROBLEM HERE. Two strategies are implemented:
//
//   filter  (default) trim/atrim per segment + the `concat` FILTER.
//           The concat filter aligns audio and video per segment, so drift
//           cannot accumulate across cuts. One decode, one encode, exact
//           boundaries. Cost: an N-way split of the input filtergraph.
//
//   copy    stream-copy each segment and join with the concat DEMUXER.
//           No re-encode, so it is fast, but cuts land on the nearest
//           keyframe — boundaries move by up to a GOP. Preview / rough use.
//
// A `select`-expression variant was tried and rejected: `setpts=N/FRAME_RATE/TB`
// and `asetpts=N/SR/TB` renumber the two streams independently, so per-segment
// rounding (up to one video frame and one audio frame) accumulates into audible
// drift after a few dozen cuts. See docs/ROADMAP.md (FAILED).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ffmpeg, encodeArgs, keyframeTimes } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { parseRanges, normalize, invert, validate, totalDuration, fmt } from '../lib/ranges.mjs';
import { usageError, inputError, validationError, VeError, EXIT } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

/**
 * @param {string} input
 * @param {{keep?:*, remove?:*, plan?:string, out?:string, strategy?:'filter'|'copy',
 *          quality?:'preview'|'final', minSegment?:number, hw?:string}} opts
 */
export async function cutVideo(input, opts = {}) {
  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  const strategy = opts.strategy || 'filter';
  // Sub-frame segments make the concat filter stretch output timestamps
  // (measured: 200 x 0.05s segments produced 11.65s instead of 10.00s).
  // 0.1s is ~3 frames at 30fps — below that it is a glitch, not an edit.
  const minSegment = opts.minSegment ?? 0.1;

  const keep = resolveKeepRanges(opts, meta.duration, minSegment);

  const frameDur = meta.fps ? 1 / meta.fps : 1 / 30;
  const tooShort = keep.filter(r => r.end - r.start < frameDur * 2);
  if (tooShort.length) {
    log.warn(`${tooShort.length} kept segment(s) are shorter than 2 frames; timing may stretch. ` +
      `Consider raising --min-segment.`);
  }

  if (!keep.length) {
    throw usageError('Nothing would be kept — the resulting video would be empty.',
      'Check your --keep / --remove ranges against the source duration.');
  }

  const problems = validate(keep, { duration: meta.duration, label: 'keep' });
  if (problems.length) {
    throw new VeError(`Invalid keep ranges:\n  - ${problems.join('\n  - ')}`, { code: EXIT.VALIDATION });
  }

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-cut.mp4`));

  // Stream copy can only start on a keyframe, so resolve where the cuts will
  // REALLY land before promising a duration.
  let effective = keep;
  let keyframeInfo = null;
  if (strategy === 'copy') {
    const snap = await snapToKeyframes(abs, keep);
    effective = snap.snapped;
    keyframeInfo = {
      keyframeCount: snap.keyframeCount,
      requestedSegments: keep.length,
      maxKeyframeShift: round(snap.maxShift),
    };
    if (snap.maxShift > 0.05) {
      log.warn(`cut points moved up to ${snap.maxShift.toFixed(2)}s earlier to reach a keyframe` +
        (effective.length !== keep.length ? `, collapsing ${keep.length} segments into ${effective.length}` : '') +
        `. Use --strategy filter for frame-accurate cuts.`);
    }
  }

  const expected = totalDuration(effective);
  log.info(`cut: ${effective.length} segment(s), ${expected.toFixed(2)}s of ${meta.duration}s (${strategy})`);

  const started = Date.now();
  if (strategy === 'copy') await cutByCopy(abs, effective, out, meta);
  else await cutByFilter(abs, effective, out, meta, opts);
  const renderMs = Date.now() - started;

  // Verify against the file we actually produced, not against our intentions.
  const got = await probeVideo(out);
  const drift = got.duration - expected;
  // Per-boundary rounding is at most one frame and errors are signed, so the
  // realistic bound grows with sqrt(n), not n. A linear bound is so loose it
  // hides genuine breakage. Stream copy snaps to keyframes, so it needs a GOP.
  const tolerance = strategy === 'copy'
    ? Math.max(1.0, keep.length * 0.5)
    : Math.max(0.2, 1.5 * frameDur * Math.sqrt(keep.length));
  if (Math.abs(drift) > tolerance) {
    throw validationError(
      `Output duration ${got.duration}s differs from the expected ${expected.toFixed(2)}s by ${drift.toFixed(2)}s`,
      { expected, actual: got.duration, tolerance, strategy }
    );
  }

  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    strategy,
    segments: effective.map(r => ({ start: round(r.start), end: round(r.end), duration: round(r.end - r.start) })),
    segmentCount: effective.length,
    ...(keyframeInfo || {}),
    sourceDuration: meta.duration,
    expectedDuration: round(expected),
    actualDuration: got.duration,
    durationDrift: round(drift),
    removedDuration: round(meta.duration - expected),
    width: got.width,
    height: got.height,
    fps: got.fps,
    hasAudio: got.hasAudio,
    sizeBytes: got.sizeBytes,
    renderMs,
  };
}

/** keep / remove / plan -> a single normalised keep list. */
function resolveKeepRanges(opts, duration, minSegment) {
  let keepSrc = opts.keep;
  let removeSrc = opts.remove;

  if (opts.plan) {
    const planPath = resolveInput(opts.plan, 'plan');
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    } catch (cause) {
      throw inputError(`Could not parse plan JSON: ${relToRoot(planPath)}`, cause.message);
    }
    keepSrc = keepSrc ?? plan.keep;
    removeSrc = removeSrc ?? plan.remove ?? plan.silences;
  }

  if (keepSrc == null && removeSrc == null) {
    throw usageError('Provide --keep, --remove, or --plan',
      'e.g. --keep "0-5.2,6.1-13.4"  or  --plan edit-plans/cuts.json');
  }

  if (keepSrc != null) {
    return normalize(parseRanges(keepSrc, 'keep'), { duration, minDuration: minSegment });
  }
  const removeRanges = normalize(parseRanges(removeSrc, 'remove'), { duration });
  return invert(removeRanges, duration, { minDuration: minSegment });
}

/* ------------------------------------------------- strategy: concat filter */

async function cutByFilter(abs, keep, out, meta, opts) {
  const hasAudio = meta.hasAudio;
  const parts = [];
  const labels = [];

  parts.push(`[0:v]split=${keep.length}${keep.map((_, i) => `[vs${i}]`).join('')}`);
  if (hasAudio) parts.push(`[0:a]asplit=${keep.length}${keep.map((_, i) => `[as${i}]`).join('')}`);

  keep.forEach((r, i) => {
    parts.push(`[vs${i}]trim=start=${r.start}:end=${r.end},setpts=PTS-STARTPTS[v${i}]`);
    if (hasAudio) parts.push(`[as${i}]atrim=start=${r.start}:end=${r.end},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(hasAudio ? `[v${i}][a${i}]` : `[v${i}]`);
  });

  parts.push(`${labels.join('')}concat=n=${keep.length}:v=1:a=${hasAudio ? 1 : 0}${hasAudio ? '[vout][aout]' : '[vout]'}`);

  const { args: enc } = await encodeArgs({ quality: opts.quality || 'final', hw: opts.hw || 'auto' });
  const args = [
    '-y', '-i', abs,
    '-filter_complex', parts.join(';'),
    '-map', '[vout]',
    ...(hasAudio ? ['-map', '[aout]'] : ['-an']),
    ...enc,
    out,
  ];
  await ffmpeg(args, { label: 'cut-video(filter)', totalSec: totalDuration(keep) });
}

/* ------------------------------------------------ strategy: concat demuxer */

/**
 * Snap each segment START down to the nearest real keyframe.
 * Without this, ffmpeg silently does the snapping itself and the caller has no
 * idea the cut moved — on a source with an 8s GOP that turned a requested 9s
 * output into 17s. Snapping up front makes the drift visible and reportable.
 */
async function snapToKeyframes(abs, keep) {
  const kf = await keyframeTimes(abs);
  if (!kf.length) {
    log.warn('no keyframes found; copy-strategy boundaries will be unpredictable');
    return { snapped: keep, keyframeCount: 0, maxShift: 0 };
  }

  let maxShift = 0;
  const shifted = keep.map(r => {
    let best = kf[0];
    for (const t of kf) { if (t <= r.start + 1e-6) best = t; else break; }
    maxShift = Math.max(maxShift, r.start - best);
    return { start: best, end: r.end };
  });

  // Snapping can push two segments onto the same keyframe; merging them is the
  // only correct outcome, and the caller is told the count changed.
  const snapped = normalize(shifted, { merge: true });
  return { snapped, keyframeCount: kf.length, maxShift };
}

async function cutByCopy(abs, keep, out, meta) {
  const work = ensureDir(path.join(DIR.temp, `cut-${process.pid}-${Date.now()}`));
  try {
    const files = [];
    for (const [i, r] of keep.entries()) {
      const seg = path.join(work, `seg-${String(i).padStart(4, '0')}${path.extname(abs) || '.mp4'}`);
      await ffmpeg([
        '-y', '-ss', String(r.start), '-i', abs, '-t', String(r.end - r.start),
        '-c', 'copy', '-avoid_negative_ts', 'make_zero', seg,
      ], { label: `cut-video(copy) seg ${i + 1}/${keep.length}` });
      if (fs.existsSync(seg) && fs.statSync(seg).size > 0) files.push(seg);
      else log.warn(`segment ${fmt(r)} produced no data (no keyframe in range?) — skipped`);
    }
    if (!files.length) throw validationError('every segment came out empty', { keep });

    const listFile = path.join(work, 'concat.txt');
    fs.writeFileSync(listFile, files.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', out],
      { label: 'cut-video(copy) concat' });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const round = n => Math.round(n * 1000) / 1000;

export const tool = {
  name: 'cut-video',
  summary: 'Keep or remove time ranges and concatenate the result, preserving A/V sync.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    keep: { type: 'string', help: 'Ranges to KEEP, e.g. "0-5.2,6.1-13.4"' },
    remove: { type: 'string', help: 'Ranges to REMOVE (the complement is kept)' },
    plan: { type: 'string', help: 'JSON file containing {keep:[...]} or {remove:[...]}' },
    out: { type: 'string', help: 'Output path (default: output/<name>-cut.mp4)' },
    strategy: { type: 'enum', values: ['filter', 'copy'], default: 'filter', help: 'filter = exact re-encode; copy = fast, keyframe-aligned' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    minSegment: { type: 'number', default: 0.1, help: 'Drop keep-segments shorter than this (seconds)' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've cut-video raw/test.mp4 --keep "0-5.2,6.1-13.4"',
    've cut-video raw/test.mp4 --remove "5.2-6.1" --out output/tight.mp4',
    've cut-video raw/test.mp4 --plan edit-plans/silences.json --strategy copy',
  ],
  run: opts => cutVideo(opts.input, opts),
  pretty: r => `${r.output}  ${r.segmentCount} seg  ${r.actualDuration}s ` +
    `(cut ${r.removedDuration}s, drift ${r.durationDrift >= 0 ? '+' : ''}${r.durationDrift}s)  ${r.renderMs}ms`,
};

runIfMain(tool, import.meta.url);
