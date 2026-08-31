// detect-keywords — find the words worth emphasising visually.
//
// This is deliberately a DETERMINISTIC scorer, not an LLM call. Per the project
// philosophy the LLM decides and algorithms detect; a reproducible, testable
// ranking is also something Claude can then override or extend, which is not
// true in reverse. `--extra` merges an externally supplied list (e.g. one
// Claude produced from the transcript) at full importance.
//
// The signals, roughly in order of usefulness:
//
//   emphasis   How long the speaker held the word compared with their own
//              average, plus the silence they left around it. This is the one
//              signal that needs WORD-LEVEL TIMESTAMPS, and it is the closest
//              thing available to "the speaker thought this mattered".
//   rarity     Inverse frequency within this transcript. Common words carry
//              little; a word said once in a five-minute video carries a lot.
//   shape      Proper nouns, ALL-CAPS, camelCase, digits, version strings,
//              and anything matching the technical lexicon.
//   position   Words in the first few seconds tend to be the topic.
//
// Stopwords are filtered first, in Portuguese and English, because otherwise
// "que" and "the" dominate every rarity metric.
import fs from 'node:fs';
import path from 'node:path';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { validationError } from '../lib/errors.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { transcribe, flattenWords } from './transcribe.mjs';

export const STOPWORDS = new Set(`
a as o os um uma uns umas de do da dos das em no na nos nas por para com sem sob sobre
e ou mas que se como quando onde qual quais quem cujo porque pois entao então assim
eu tu ele ela nos nós vos eles elas me te lhe nos vos lhes meu minha seu sua nosso nossa
este esta esse essa aquele aquela isto isso aquilo
ser estar ter haver ir vir fazer poder dever querer dizer ver dar saber
e é sao são foi era sera será tem tinha vai vou vamos ja já mais menos muito pouco
bem mal tambem também so só ate até agora depois antes hoje aqui ali la lá
the a an of to in on at for with without by from as is are was were be been being
and or but if then so that this these those it its he she they we you i me my your
have has had do does did can could should would will shall may might must
not no yes very more less much many just now here there when where what which who
about into over under again once all any both each few other some such only own same
`.trim().split(/\s+/));

/** Words that are almost always worth highlighting in a technical video. */
export const TECH_LEXICON = new Set(`
api apis cli sdk json yaml xml html css sql http https rest graphql websocket
npm npx yarn pnpm node nodejs deno bun docker kubernetes k8s git github gitlab
python javascript typescript rust golang java kotlin swift react vue svelte angular
nextjs remotion ffmpeg whisper claude gpt llm ai ml gpu cpu cuda
terminal shell bash zsh powershell linux windows macos ubuntu
database postgres mysql redis mongodb supabase firebase
deploy deployment build compile install commit branch merge pull push
async await promise callback function class component hook state props
token prompt context model inference embedding vector
`.trim().split(/\s+/));

const normalize = s => String(s)
  .toLowerCase()
  .normalize('NFD').replace(/\p{M}/gu, '')
  .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * Score every word, then keep the best.
 * Exported separately from the tool so it can be unit-tested without ffmpeg.
 */
export function scoreWords(words, opts = {}) {
  const {
    minLength = 3,
    emphasisWeight = 1.0,
    rarityWeight = 1.0,
    shapeWeight = 1.0,
    lexicon = TECH_LEXICON,
    stopwords = STOPWORDS,
  } = opts;

  const clean = words
    .map((w, i) => ({ ...w, index: i, norm: normalize(w.word) }))
    .filter(w => w.norm.length >= minLength && !stopwords.has(w.norm));

  if (!clean.length) return [];

  // Speaking rate baseline: seconds per character, from this speaker only.
  const rates = words
    .map(w => (w.end - w.start) / Math.max(1, w.word.length))
    .filter(r => Number.isFinite(r) && r > 0)
    .sort((a, b) => a - b);
  const medianRate = rates.length ? rates[Math.floor(rates.length / 2)] : 0.06;

  const freq = new Map();
  for (const w of clean) freq.set(w.norm, (freq.get(w.norm) || 0) + 1);
  const maxFreq = Math.max(...freq.values());

  const totalDuration = words.length ? words[words.length - 1].end : 1;

  const scored = clean.map(w => {
    const reasons = [];

    // --- emphasis: held longer than this speaker's own baseline
    const expected = medianRate * Math.max(1, w.word.length);
    const actual = w.end - w.start;
    const stretch = expected > 0 ? actual / expected : 1;
    let emphasis = clamp01((stretch - 1) / 1.2);
    if (emphasis > 0.25) reasons.push(`held ${stretch.toFixed(1)}x longer than usual`);

    // --- emphasis: silence around the word
    //
    // Only UNSTRUCTURED pauses count. Every sentence ends with a pause, so
    // counting those makes the last word of each sentence look emphatic and
    // floods the results with "canal.", "vídeos.", "Olá," and so on. A gap
    // adjacent to sentence-ending punctuation is grammar, not emphasis.
    const prev = words[w.index - 1];
    const next = words[w.index + 1];
    const endsSentence = /[.!?…]$/.test(w.word);
    const followsSentence = prev ? /[.!?…]$/.test(prev.word) : true;

    const gapBefore = prev && !followsSentence ? w.start - prev.end : 0;
    const gapAfter = next && !endsSentence ? next.start - w.end : 0;
    // A pause AFTER a word is the stronger signal: the speaker landed on it
    // and let it sit. A pause before is often just breathing.
    const pause = clamp01((Math.max(gapAfter, gapBefore * 0.6) - 0.12) / 0.5);
    if (pause > 0.3) reasons.push('set off by a pause');
    emphasis = Math.max(emphasis, pause * 0.9);

    // --- rarity within this transcript
    const n = freq.get(w.norm);
    const rarity = 1 - (n - 1) / Math.max(1, maxFreq);
    if (n === 1 && clean.length > 20) reasons.push('said only once');

    // --- shape
    let shape = 0;
    const raw = w.word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (lexicon.has(w.norm)) { shape = Math.max(shape, 1.0); reasons.push('technical term'); }
    if (/^[A-Z][a-z]{2,}/.test(raw) && w.index > 0) { shape = Math.max(shape, 0.7); reasons.push('proper noun'); }
    if (/^[A-Z]{2,}$/.test(raw)) { shape = Math.max(shape, 0.85); reasons.push('acronym'); }
    if (/[a-z][A-Z]/.test(raw)) { shape = Math.max(shape, 0.8); reasons.push('camelCase'); }
    if (/\d/.test(raw)) { shape = Math.max(shape, 0.75); reasons.push('contains a number'); }
    if (raw.length >= 12) shape = Math.max(shape, 0.45);

    // --- position: the opening seconds usually state the topic
    const position = w.start < Math.min(8, totalDuration * 0.15) ? 0.25 : 0;

    // Confidence gates everything: a word Whisper is unsure of should not be
    // shouted on screen.
    const confidence = w.probability ?? 1;

    const raw_score =
      emphasisWeight * emphasis * 0.40 +
      rarityWeight * rarity * 0.20 +
      shapeWeight * shape * 0.35 +
      position * 0.05;

    return {
      text: raw,
      norm: w.norm,
      start: w.start,
      end: w.end,
      importance: round(clamp01(raw_score) * (0.6 + 0.4 * confidence)),
      confidence: round(confidence),
      occurrences: n,
      signals: { emphasis: round(emphasis), rarity: round(rarity), shape: round(shape) },
      reasons,
    };
  });

  return scored.sort((a, b) => b.importance - a.importance || a.start - b.start);
}

const clamp01 = v => Math.min(1, Math.max(0, v));
const round = n => Math.round(n * 1000) / 1000;

/**
 * @param {string} input
 * @param {{transcript?:string, max?:number, minImportance?:number, extra?:string,
 *          perMinute?:number, unique?:boolean, out?:string}} opts
 */
export async function detectKeywords(input, opts = {}) {
  const {
    max = 20,
    minImportance = 0.35,
    unique = true,
  } = opts;

  const abs = resolveInput(input, 'media');
  const tr = await loadTranscript(abs, opts);
  const words = flattenWords(tr);
  if (!words.length) {
    throw validationError('the transcript has no word-level timestamps', {
      hint: 'detect-keywords scores emphasis from word timings; re-run transcribe',
    });
  }

  let scored = scoreWords(words, opts);

  // Anything Claude (or the user) supplied is trusted outright.
  const extra = parseExtra(opts.extra);
  if (extra.length) {
    const extraNorm = new Set(extra.map(normalize));
    let bumped = 0;
    for (const s of scored) {
      if (extraNorm.has(s.norm)) {
        s.importance = 1;
        s.reasons = [...s.reasons, 'externally specified'];
        bumped++;
      }
    }
    // scoreWords already sorted by importance; raising scores after the fact
    // invalidates that order, and the `max` cut below relies on it.
    if (bumped) scored.sort((a, b) => b.importance - a.importance || a.start - b.start);
  }

  let picked = scored.filter(s => s.importance >= minImportance);

  if (unique) {
    // Highlighting the same word eight times is noise, not emphasis.
    const seen = new Set();
    picked = picked.filter(s => (seen.has(s.norm) ? false : (seen.add(s.norm), true)));
  }

  // Density cap: keep the highlights sparse enough to mean something.
  const duration = tr.duration || words[words.length - 1].end || 1;
  const byRate = opts.perMinute ? Math.ceil((duration / 60) * opts.perMinute) : Infinity;
  picked = picked.slice(0, Math.min(max, byRate));
  picked.sort((a, b) => a.start - b.start);

  const result = {
    source: relToRoot(abs),
    language: tr.language,
    duration: round(duration),
    wordCount: words.length,
    candidateCount: scored.length,
    keywordCount: picked.length,
    minImportance,
    perMinute: round((picked.length / duration) * 60),
    keywords: picked.map(k => ({
      text: k.text,
      start: k.start,
      end: k.end,
      importance: k.importance,
      occurrences: k.occurrences,
      reasons: k.reasons,
    })),
  };

  const out = prepareOutput(
    opts.out || path.join(ensureDir(path.join(DIR.cache, 'keywords')), `${slug(abs)}-keywords.json`)
  );
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  result.output = relToRoot(out);
  result.path = out;
  return result;
}

function parseExtra(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  const s = String(v);
  if (s.endsWith('.json') && fs.existsSync(s)) {
    const j = JSON.parse(fs.readFileSync(s, 'utf8'));
    const list = Array.isArray(j) ? j : j.keywords || [];
    return list.map(k => (typeof k === 'string' ? k : k.text)).filter(Boolean);
  }
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

async function loadTranscript(abs, opts) {
  if (opts.transcript) {
    const p = resolveInput(opts.transcript, 'transcript');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return transcribe(abs, { language: opts.language, prompt: opts.prompt });
}

export const tool = {
  name: 'detect-keywords',
  summary: 'Rank the words worth highlighting, using emphasis, rarity and word shape.',
  args: {
    input: { positional: 0, required: true, help: 'Source video or audio' },
    transcript: { type: 'string', help: 'Existing transcript JSON (default: transcribe, cached)' },
    language: { type: 'string', help: 'Language hint for transcription' },
    prompt: { type: 'string', help: 'Vocabulary prompt for transcription' },
    max: { type: 'number', default: 20, help: 'Maximum keywords to return' },
    minImportance: { type: 'number', default: 0.35, help: 'Score floor, 0..1' },
    perMinute: { type: 'number', help: 'Cap the density, e.g. 6 keywords per minute' },
    unique: { type: 'bool', default: true, help: 'Only the best occurrence of each word' },
    extra: { type: 'string', help: 'Always-highlight list: comma-separated, or a .json' },
    out: { type: 'string', help: 'Output JSON path' },
  },
  examples: [
    've detect-keywords raw/test.mp4 --language pt',
    've detect-keywords raw/test.mp4 --per-minute 6 --extra "Claude Code,Docker"',
    've detect-keywords raw/test.mp4 | jq -r ".keywords[].text"',
  ],
  run: opts => detectKeywords(opts.input, opts),
  pretty: r => `${r.keywordCount} keyword(s) from ${r.wordCount} words ` +
    `(${r.perMinute}/min) -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
