// remove-silence — detect silence, invert it, cut it out.
//
// This is a COMPOSITION, not a new engine: detect-silence finds the gaps and
// cut-video does the cutting. The value it adds is the editorial judgement in
// between — how aggressive to be, and how to avoid clipping speech.
//
// Two protections against cutting into words:
//
//   padding    Always on. Each silence is shrunk by paddingBefore/After, so a
//              cut never lands on the exact instant speech resumes.
//
//   --snap words
//              Uses word-level timestamps from `transcribe` to guarantee no
//              cut falls inside a word. Padding is a heuristic; this is a
//              measurement. Costs one (cached) transcription.
//
// Short surviving speech fragments are MERGED with their neighbour rather than
// dropped: losing a 0.1s word is a worse failure than leaving a 0.4s pause in.
import path from 'node:path';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { normalize, invert, totalDuration, timecode } from '../lib/ranges.mjs';
import { usageError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { detectSilence } from './detect-silence.mjs';
import { transcribe, flattenWords } from './transcribe.mjs';
import { cutVideo } from './cut-video.mjs';

/**
 * Intensity presets. These are editorial opinions, deliberately kept in one
 * visible place rather than scattered through the code.
 */
export const INTENSITY = {
  soft: { minDuration: 0.70, paddingBefore: 0.15, paddingAfter: 0.20 },
  normal: { minDuration: 0.35, paddingBefore: 0.08, paddingAfter: 0.12 },
  aggressive: { minDuration: 0.20, paddingBefore: 0.03, paddingAfter: 0.05 },
};

/**
 * @param {string} input
 * @param {{intensity?:'soft'|'normal'|'aggressive', threshold?:number, method?:'rms'|'auto',
 *          snap?:'off'|'words', language?:string, prompt?:string, minSpeech?:number,
 *          out?:string, quality?:string, hw?:string, dryRun?:boolean}} opts
 */
export async function removeSilence(input, opts = {}) {
  const {
    intensity = 'normal',
    method = 'rms',
    snap = 'off',
    minSpeech = 0.15,
    dryRun = false,
  } = opts;

  const preset = INTENSITY[intensity];
  if (!preset) throw usageError(`Unknown intensity "${intensity}"`, `Use: ${Object.keys(INTENSITY).join(', ')}`);

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);

  const detected = await detectSilence(abs, {
    method,
    threshold: opts.threshold,
    minDuration: opts.minDuration ?? preset.minDuration,
    paddingBefore: opts.paddingBefore ?? preset.paddingBefore,
    paddingAfter: opts.paddingAfter ?? preset.paddingAfter,
  });

  let silences = detected.silences.map(s => ({ start: s.start, end: s.end }));
  let wordProtected = 0;

  if (snap === 'words') {
    const tr = await transcribe(abs, { language: opts.language, prompt: opts.prompt });
    const words = flattenWords(tr);
    const before = silences.length;
    silences = snapOutOfWords(silences, words);
    wordProtected = before - silences.length;
    log.info(`snapped ${silences.length} silence(s) clear of ${words.length} word boundaries`);
  }

  // Re-apply the minimum: shrinking a silence can take it below the threshold,
  // at which point removing it is not worth a cut.
  silences = normalize(silences, { duration: meta.duration, minDuration: opts.minDuration ?? preset.minDuration });

  let keep = invert(silences, meta.duration, { minDuration: 0 });
  const { merged, absorbed } = mergeShortSpeech(keep, minSpeech);
  keep = merged;

  if (!keep.length) {
    throw validationError('removing silence would leave nothing', {
      silenceRatio: detected.silenceRatio,
      hint: 'The threshold is probably too high for this recording; try --method auto.',
    });
  }

  const keptDuration = totalDuration(keep);
  const removedDuration = meta.duration - keptDuration;

  const summary = {
    source: relToRoot(abs),
    intensity,
    method,
    snap,
    threshold: detected.threshold,
    sourceDuration: meta.duration,
    silencesFound: detected.silenceCount,
    silencesRemoved: silences.length,
    silencesKeptForWords: wordProtected,
    shortSpeechAbsorbed: absorbed,
    segments: keep.length,
    keptDuration: round(keptDuration),
    removedDuration: round(removedDuration),
    compression: meta.duration ? round(keptDuration / meta.duration) : 1,
    timeSaved: round(removedDuration),
    keep: keep.map(r => ({ start: round(r.start), end: round(r.end) })),
    removed: silences.map(r => ({ start: round(r.start), end: round(r.end), duration: round(r.end - r.start) })),
  };

  if (dryRun) return { ...summary, dryRun: true };

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-nosilence.mp4`));
  const cut = await cutVideo(abs, {
    keep,
    out,
    quality: opts.quality,
    hw: opts.hw,
    minSegment: 0,   // segment lengths were already decided above
  });

  return {
    ...summary,
    output: relToRoot(out),
    path: out,
    actualDuration: cut.actualDuration,
    durationDrift: cut.durationDrift,
    width: cut.width,
    height: cut.height,
    renderMs: cut.renderMs,
  };
}

/**
 * Pull each silence inwards until it no longer overlaps any word, and drop it
 * if nothing is left. Words come from Whisper's word-level timestamps, so this
 * is a measurement rather than a guess.
 */
export function snapOutOfWords(silences, words, guard = 0.02) {
  const out = [];
  for (const s of silences) {
    let { start, end } = s;

    for (const w of words) {
      if (w.end <= start || w.start >= end) continue;  // no overlap
      if (w.start <= start && w.end >= end) { start = end; break; }  // silence sits inside a word
      if (w.end > start && w.start <= start) start = w.end + guard;  // word overlaps the head
      if (w.start < end && w.end >= end) end = w.start - guard;      // word overlaps the tail
    }
    if (end - start > 1e-6) out.push({ start, end });
  }
  return out;
}

/**
 * Absorb speech fragments shorter than `minSpeech` into the previous segment,
 * which means NOT removing the silence before them. Dropping them instead
 * would delete real audio.
 */
export function mergeShortSpeech(keep, minSpeech) {
  if (!keep.length) return { merged: [], absorbed: 0 };
  const merged = [{ ...keep[0] }];
  let absorbed = 0;

  for (let i = 1; i < keep.length; i++) {
    const seg = keep[i];
    const prev = merged[merged.length - 1];
    if (seg.end - seg.start < minSpeech) {
      prev.end = seg.end;   // swallow the gap and the fragment together
      absorbed++;
    } else {
      merged.push({ ...seg });
    }
  }
  // The very first segment can also be too short to stand alone.
  if (merged.length > 1 && merged[0].end - merged[0].start < minSpeech) {
    merged[1].start = merged[0].start;
    merged.shift();
    absorbed++;
  }
  return { merged, absorbed };
}

/** Human-readable decision list, the seed of the phase-6 reasoning log. */
export function explain(summary) {
  return summary.removed
    .map(r => `${timecode(r.start)}-${timecode(r.end)}  removed ${r.duration.toFixed(2)}s of silence`)
    .join('\n');
}

const round = n => Math.round(n * 1000) / 1000;

export const tool = {
  name: 'remove-silence',
  summary: 'Detect and cut out silent pauses, without clipping speech.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    intensity: { type: 'enum', values: ['soft', 'normal', 'aggressive'], default: 'normal', help: 'How much pause to remove' },
    method: { type: 'enum', values: ['rms', 'auto'], default: 'rms', help: 'Silence detector; auto adapts to the noise floor' },
    threshold: { type: 'number', help: 'Override the silence threshold in dBFS' },
    minDuration: { type: 'number', help: 'Override the minimum silence length' },
    paddingBefore: { type: 'number', help: 'Override the breathing room before speech resumes' },
    paddingAfter: { type: 'number', help: 'Override the breathing room after speech ends' },
    snap: { type: 'enum', values: ['off', 'words'], default: 'off', help: 'words = never cut inside a word (uses transcription)' },
    language: { type: 'string', help: 'Language for --snap words' },
    prompt: { type: 'string', help: 'Vocabulary prompt for --snap words' },
    minSpeech: { type: 'number', default: 0.15, help: 'Absorb speech fragments shorter than this' },
    out: { type: 'string', help: 'Output path (default: output/<name>-nosilence.mp4)' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
    dryRun: { type: 'bool', default: false, help: 'Report what would be cut without rendering' },
  },
  examples: [
    've remove-silence raw/test.mp4',
    've remove-silence raw/test.mp4 --intensity aggressive --snap words --language pt',
    've remove-silence raw/test.mp4 --dry-run | jq ".timeSaved"',
  ],
  run: opts => removeSilence(opts.input, opts),
  pretty: r => `${r.dryRun ? '[dry-run] would remove' : 'removed'} ${r.silencesRemoved} silence(s), ` +
    `${r.timeSaved}s saved (${Math.round((1 - r.compression) * 100)}% shorter)` +
    `${r.output ? ` -> ${r.output}` : ''}`,
};

runIfMain(tool, import.meta.url);
