// remove-fillers — cut hesitations and stutters, conservatively.
//
// The brief is explicit that naturalness beats thoroughness, so nothing is
// removed merely for appearing in a word list. Every candidate must clear a
// confidence threshold built from CONTEXT, and the levels are:
//
//   off         nothing is removed
//   safe        non-lexical hesitations only ("ahn", "uhm", "éé") plus exact
//               stutters ("o o terminal"). These carry no meaning in any
//               reading, so removing them cannot change what was said.
//   aggressive  additionally discourse markers ("tipo", "né", "então",
//               "basically") — but ONLY where context says they are filler.
//
// Why context matters: "então" is a genuine connective ("então eu fiz X") far
// more often than it is filler. Removing it on sight would mangle the meaning.
// A discourse marker is only treated as filler when it is isolated by pauses,
// repeated, or sitting mid-clause where it carries no syntactic weight — never
// when it opens a sentence.
import fs from 'node:fs';
import path from 'node:path';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { normalize as normRanges, invert, totalDuration, timecode } from '../lib/ranges.mjs';
import { usageError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { transcribe, flattenWords } from './transcribe.mjs';
import { cutVideo } from './cut-video.mjs';

export const LEVELS = ['off', 'safe', 'aggressive'];

/** Non-lexical hesitation sounds. These never carry meaning. */
export const HESITATIONS = {
  pt: ['ahn', 'ahnn', 'anh', 'hum', 'hmm', 'hm', 'ehh', 'eh', 'ee', 'aa', 'ah', 'uh', 'uhm', 'um'],
  en: ['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'hmm', 'hm', 'ah', 'eh', 'mm'],
};

/** Discourse markers: real words that are SOMETIMES filler. Context decides. */
export const DISCOURSE = {
  pt: ['tipo', 'ne', 'entao', 'basicamente', 'assim', 'sabe', 'digamos', 'enfim', 'ta', 'certo'],
  en: ['like', 'basically', 'actually', 'literally', 'right', 'okay', 'anyway', 'well'],
};


/**
 * Ordinary short words that must never be mistaken for a hesitation, even when
 * the recogniser is unsure of them. Only short tokens are ever tested against
 * this, so it does not need to be a full dictionary.
 */
export const COMMON_SHORT = new Set(`
a o e as os um uma de do da em no na por com sem sob ao aos das dos que se ja ao
eu tu ele ela nos vos me te lhe meu seu sua dele dela isto isso aqui ali la
ser sou es e sao foi era tem tinha vai vou vem ver diz faz pode deve quer sabe
mais mas nao sim ate so tao bem mal ora pois logo entre depois antes hoje ontem
dois tres seis dez cem mil ano mes dia hora vez tudo nada algo cada
the a an of to in on at for by is are was were be am do did has had can may
we he it its my your our his her you they them this that these those not no yes
one two six ten out up off now new old own way day get put see say too very
`.trim().split(/\s+/));

const norm = s => String(s)
  .toLowerCase()
  .normalize('NFD').replace(/\p{M}/gu, '')
  .replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Find filler candidates and score how confident we are that each is filler.
 * Pure function over words, so it is unit-testable without any media.
 *
 * @returns {Array<{index:number,text:string,start:number,end:number,kind:string,confidence:number,reasons:string[]}>}
 */
export function findFillers(words, { language = 'pt', level = 'safe', extra = [], protect = [] } = {}) {
  if (level === 'off') return [];

  const lang = language && HESITATIONS[language] ? language : 'pt';
  const hesitations = new Set([...HESITATIONS[lang], ...HESITATIONS.en]);
  const discourse = new Set([...DISCOURSE[lang], ...DISCOURSE.en]);
  const extraSet = new Set(extra.map(norm));
  // Words the caller has declared meaningful — never removable, whatever the
  // heuristics think. Multi-word entries are split so "Claude Code" protects both.
  const protectSet = new Set(
    protect.flatMap(x => String(x).split(/[\s,]+/)).map(norm).filter(Boolean)
  );

  const out = [];

  for (const [i, w] of words.entries()) {
    const n = norm(w.word);
    if (!n) continue;

    const prev = words[i - 1];
    const next = words[i + 1];
    const gapBefore = prev ? w.start - prev.end : 1;
    const gapAfter = next ? next.start - w.end : 1;
    const startsSentence = !prev || /[.!?…]$/.test(prev.word);
    const reasons = [];

    // --- exact stutter: the same word twice in a row, close together.
    if (prev && norm(prev.word) === n && w.start - prev.end < 0.6 && n.length <= 12) {
      out.push({
        index: i - 1, text: prev.word, start: prev.start, end: prev.end,
        kind: 'stutter', confidence: 0.95,
        reasons: [`repeated immediately as "${w.word}"`],
      });
      // The repeat itself is kept; only the first utterance goes.
    }

    if (extraSet.has(n)) {
      out.push({ index: i, text: w.word, start: w.start, end: w.end, kind: 'custom', confidence: 1, reasons: ['user-specified'] });
      continue;
    }

    // --- hesitations Whisper did not spell as a known filler.
    //
    // Whisper is trained to produce clean, readable text, so a spoken "ahn"
    // often comes back as an invented low-confidence token instead ("eitn,"
    // at probability 0.45 in the test fixture). Matching the word list alone
    // therefore misses most real hesitations. A short, low-confidence token
    // that is not an ordinary short word, and that sits in a gap, is almost
    // certainly the model guessing at a noise.
    //
    // Two guards, both learned from a real false positive: this heuristic
    // deleted "Code" out of "Claude Code", because Whisper reported that token
    // at probability 0.13. A rare proper noun is exactly the kind of word the
    // recogniser is least sure about AND the kind you least want removed.
    //   - capitalised tokens are proper nouns, never hesitations
    //   - anything in `protect` (the vocabulary prompt, style keywords) is off
    //     limits: the user has already said it matters
    const capitalised = /^\p{Lu}/u.test(w.word.replace(/^[^\p{L}]+/u, ''));
    if (!hesitations.has(n) && !discourse.has(n)
        && n.length >= 2 && n.length <= 5
        && (w.probability ?? 1) < 0.55
        && !COMMON_SHORT.has(n)
        && !protectSet.has(n)
        && !capitalised
        && /^\p{L}+$/u.test(n)) {
      const isolated = gapBefore > 0.15 || gapAfter > 0.15 || /[,]$/.test(w.word);
      const confidence = isolated ? 0.9 : 0.7;
      out.push({
        index: i, text: w.word, start: w.start, end: w.end,
        kind: 'hesitation', confidence,
        reasons: [
          `unrecognisable short token (p=${(w.probability ?? 1).toFixed(2)})`,
          ...(isolated ? ['isolated by pauses'] : []),
        ],
      });
      continue;
    }

    if (hesitations.has(n) && !protectSet.has(n)) {
      // A hesitation is filler in every reading. Small confidence bonus when
      // it also sits in a gap, which is the classic thinking-noise pattern.
      let confidence = 0.9;
      if (gapBefore > 0.2 || gapAfter > 0.2) { confidence = 0.97; reasons.push('isolated by pauses'); }
      reasons.unshift('non-lexical hesitation');
      out.push({ index: i, text: w.word, start: w.start, end: w.end, kind: 'hesitation', confidence, reasons });
      continue;
    }

    if (level === 'aggressive' && discourse.has(n)) {
      // Start from LOW confidence and require evidence to raise it.
      let confidence = 0.25;

      if (startsSentence) {
        // "Então, vamos começar" — this is a connective doing real work.
        continue;
      }
      if (gapBefore > 0.25 && gapAfter > 0.25) { confidence += 0.45; reasons.push('isolated by pauses on both sides'); }
      else if (gapAfter > 0.35) { confidence += 0.25; reasons.push('followed by a pause'); }

      if (next && norm(next.word) === n) { confidence += 0.3; reasons.push('repeated'); }
      if ((w.probability ?? 1) < 0.5) { confidence += 0.1; reasons.push('low recognition confidence'); }

      // A comma right after is the transcriber hearing it as an aside.
      if (/[,]$/.test(w.word)) { confidence += 0.1; reasons.push('transcribed as an aside'); }

      if (confidence >= 0.5) {
        reasons.unshift('discourse marker in filler position');
        out.push({ index: i, text: w.word, start: w.start, end: w.end, kind: 'discourse', confidence: Math.min(1, confidence), reasons });
      }
    }
  }

  // A word can trip more than one rule (a repeated "tipo" is both a stutter and
  // a discourse marker). Keep the most confident finding per word so the report
  // and the counts describe one decision per word.
  const best = new Map();
  for (const f of out) {
    const prior = best.get(f.index);
    if (!prior || f.confidence > prior.confidence) best.set(f.index, f);
  }
  return [...best.values()].sort((a, b) => a.start - b.start);
}

/**
 * @param {string} input
 * @param {{level?:string, language?:string, transcript?:string, extra?:string,
 *          minConfidence?:number, padding?:number, dryRun?:boolean, out?:string}} opts
 */
export async function removeFillers(input, opts = {}) {
  const level = opts.level || 'safe';
  if (!LEVELS.includes(level)) throw usageError(`Unknown level "${level}"`, `Use: ${LEVELS.join(', ')}`);

  const padding = opts.padding ?? 0.03;
  const minConfidence = opts.minConfidence ?? (level === 'aggressive' ? 0.5 : 0.85);

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  const tr = await loadTranscript(abs, opts);
  const words = flattenWords(tr);
  if (!words.length) {
    throw validationError('the transcript has no word-level timestamps', {
      hint: 'filler removal cuts by word timing; re-run transcribe',
    });
  }

  const extra = opts.extra ? String(opts.extra).split(',').map(s => s.trim()).filter(Boolean) : [];
  const found = findFillers(words, { language: opts.language || tr.language, level, extra });
  const accepted = found.filter(f => f.confidence >= minConfidence);

  // Grow each removal slightly so the cut does not clip the following word's
  // attack, then merge any that now touch.
  const remove = normRanges(
    accepted.map(f => ({ start: Math.max(0, f.start - padding), end: f.end + padding })),
    { duration: meta.duration, gap: 0.05 }
  );

  const keep = invert(remove, meta.duration, { minDuration: 0.05 });
  const removedDuration = totalDuration(remove);

  const summary = {
    source: relToRoot(abs),
    level,
    language: opts.language || tr.language,
    minConfidence,
    wordCount: words.length,
    candidates: found.length,
    removedCount: accepted.length,
    rejectedCount: found.length - accepted.length,
    removedDuration: round(removedDuration),
    sourceDuration: meta.duration,
    byKind: countBy(accepted, f => f.kind),
    fillers: accepted.map(f => ({
      text: f.text, start: round(f.start), end: round(f.end),
      kind: f.kind, confidence: round(f.confidence), reasons: f.reasons,
    })),
    rejected: found.filter(f => f.confidence < minConfidence).map(f => ({
      text: f.text, start: round(f.start), confidence: round(f.confidence), reasons: f.reasons,
    })),
    remove: remove.map(r => ({ start: round(r.start), end: round(r.end) })),
  };

  if (opts.dryRun || !accepted.length) {
    if (!accepted.length) log.info('no fillers passed the confidence threshold — nothing to cut');
    return { ...summary, dryRun: Boolean(opts.dryRun), skipped: !accepted.length };
  }

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-nofillers.mp4`));
  const cut = await cutVideo(abs, {
    keep, out, quality: opts.quality, hw: opts.hw, minSegment: 0,
  });

  return {
    ...summary,
    output: relToRoot(out),
    path: out,
    actualDuration: cut.actualDuration,
    renderMs: cut.renderMs,
  };
}

/** Human-readable decision list for the reasoning log. */
export function explain(summary) {
  return summary.fillers
    .map(f => `${timecode(f.start)}  removed "${f.text}" (${f.kind}, ${Math.round(f.confidence * 100)}%) — ${f.reasons.join('; ')}`)
    .join('\n');
}

function countBy(list, fn) {
  const out = {};
  for (const x of list) out[fn(x)] = (out[fn(x)] || 0) + 1;
  return out;
}

async function loadTranscript(abs, opts) {
  if (opts.transcript) {
    const p = resolveInput(opts.transcript, 'transcript');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return transcribe(abs, { language: opts.language, prompt: opts.prompt });
}

const round = n => Math.round(n * 1000) / 1000;

export const tool = {
  name: 'remove-fillers',
  summary: 'Remove hesitations and stutters, conservatively, using word timings.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    level: { type: 'enum', values: LEVELS, default: 'safe', help: 'off | safe (hesitations+stutters) | aggressive (adds discourse markers)' },
    language: { type: 'string', help: 'Language of the filler lists (default: detected)' },
    transcript: { type: 'string', help: 'Existing transcript JSON' },
    prompt: { type: 'string', help: 'Vocabulary prompt for transcription' },
    extra: { type: 'string', help: 'Extra words to always treat as filler (comma-separated)' },
    minConfidence: { type: 'number', help: 'Confidence floor (default 0.85 safe, 0.5 aggressive)' },
    padding: { type: 'number', default: 0.03, help: 'Seconds of padding around each removal' },
    dryRun: { type: 'bool', default: false, help: 'Report what would be removed without rendering' },
    out: { type: 'string', help: 'Output path' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've remove-fillers raw/test.mp4 --dry-run',
    've remove-fillers raw/test.mp4 --level aggressive --language pt',
    've remove-fillers raw/test.mp4 --extra "beleza,pronto"',
  ],
  run: opts => removeFillers(opts.input, opts),
  pretty: r => `${r.removedCount} filler(s) removed, ${r.rejectedCount} rejected as too risky, ` +
    `${r.removedDuration}s${r.output ? ` -> ${r.output}` : ' (dry run)'}`,
};

runIfMain(tool, import.meta.url);
