// captions — turn word-level timestamps into styled, animated subtitles.
//
// Renders through libass (ASS format), not Remotion. ASS already gives
// per-word colour, scaling, outline, shadow, positioning and time-based
// transforms, and this FFmpeg build renders it natively — so phases 1-4 get
// good captions with no extra dependency. Remotion earns its place in phase 5
// for things ASS genuinely cannot do.
//
// Sizes are expressed as FRACTIONS OF FRAME HEIGHT, never pixels, so one style
// preset works for 1080x1920, 1920x1080 and 720p alike.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, encodeArgs, escapeFilterPath } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { buildAss, assEscape, assColor, alignmentFor, tags, fad, scale, t } from '../lib/ass.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { transcribe, flattenWords } from './transcribe.mjs';

/**
 * Style presets. Every size is a fraction of frame height.
 * `wordByWord` means one subtitle event per word (active word highlighted);
 * otherwise the whole cue appears at once.
 */
export const STYLES = {
  clean: {
    font: 'Arial', fontSizeRatio: 0.045, bold: true,
    primaryColor: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', backOpacity: 0.5,
    outlineRatio: 0.0035, shadowRatio: 0.002,
    position: 'bottom-center', marginVRatio: 0.10,
    maxWords: 7, wordByWord: false, fadeMs: 120, uppercase: false,
    highlightColor: '#FFD400',
  },
  minimal: {
    font: 'Arial', fontSizeRatio: 0.032, bold: false,
    primaryColor: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', backOpacity: 0.35,
    outlineRatio: 0.002, shadowRatio: 0.0,
    position: 'bottom-center', marginVRatio: 0.07,
    maxWords: 9, wordByWord: false, fadeMs: 100, uppercase: false,
    highlightColor: '#9AD5FF',
  },
  viral: {
    font: 'Arial Black', fontSizeRatio: 0.058, bold: true,
    primaryColor: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', backOpacity: 0.6,
    outlineRatio: 0.006, shadowRatio: 0.003,
    position: 'center', marginVRatio: 0.0,
    maxWords: 4, wordByWord: true, popScale: 116, fadeMs: 60, uppercase: true,
    highlightColor: '#FFE04D',
  },
  bold: {
    font: 'Impact', fontSizeRatio: 0.07, bold: true,
    primaryColor: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', backOpacity: 0.7,
    outlineRatio: 0.008, shadowRatio: 0.004,
    position: 'bottom-center', marginVRatio: 0.14,
    maxWords: 3, wordByWord: true, popScale: 112, fadeMs: 50, uppercase: true,
    highlightColor: '#FF4D4D',
  },
  karaoke: {
    font: 'Arial', fontSizeRatio: 0.05, bold: true,
    // \k fills from SecondaryColour to PrimaryColour as each word is spoken.
    primaryColor: '#FFE04D', secondaryColor: '#FFFFFF',
    outlineColor: '#000000', backColor: '#000000', backOpacity: 0.6,
    outlineRatio: 0.005, shadowRatio: 0.002,
    position: 'bottom-center', marginVRatio: 0.12,
    maxWords: 6, wordByWord: false, karaoke: true, fadeMs: 100, uppercase: false,
    highlightColor: '#FF6BD6',
  },
};

/* ------------------------------------------------------------- cue building */

/**
 * Group words into caption cues.
 * Breaks on: the word limit, a long pause, or sentence-ending punctuation —
 * so a cue never straddles two sentences just to fill its word quota.
 */
export function buildCues(words, { maxWords = 4, maxChars = 42, gapBreak = 0.6 } = {}) {
  const cues = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    cues.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      words: current,
      text: joinWords(current),
    });
    current = [];
  };

  for (const [i, w] of words.entries()) {
    const prev = words[i - 1];
    const gap = prev ? w.start - prev.end : 0;
    const chars = current.reduce((n, x) => n + x.word.length + 1, 0);

    if (current.length && (gap >= gapBreak || chars + w.word.length > maxChars)) flush();
    current.push(w);

    if (current.length >= maxWords) flush();
    else if (/[.!?…]$/.test(w.word)) flush();          // end of a sentence
    else if (/[,;:]$/.test(w.word) && current.length >= maxWords - 1) flush();
  }
  flush();

  // A cue must be on screen long enough to read.
  return cues.map(c => ({ ...c, end: Math.max(c.end, c.start + 0.35) }));
}

/** Case-insensitive, accent-insensitive keyword matcher. */
export function makeKeywordMatcher(keywords = []) {
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s]/gu, '');
  const set = new Set();
  const phrases = [];
  for (const k of keywords) {
    const n = norm(typeof k === 'string' ? k : k.text);
    if (!n) continue;
    if (n.includes(' ')) phrases.push(n);
    else set.add(n);
  }
  return {
    matches(word, cueText) {
      const w = norm(word);
      if (set.has(w)) return true;
      if (!phrases.length) return false;
      const c = norm(cueText);
      return phrases.some(p => p.includes(w) && c.includes(p));
    },
    size: set.size + phrases.length,
  };
}

/**
 * Join word tokens back into readable text.
 *
 * Whisper marks word separation with a LEADING SPACE on each token, so
 * "bem-vindo" arrives as ["bem", "-vindo"] with no space on the second. Joining
 * everything with " " turns that into "bem -vindo". `spaceBefore` carries the
 * distinction; for transcripts produced before that field existed, fall back to
 * a punctuation heuristic.
 */
export function joinWords(words, render = w => w.word) {
  return words.map((w, i) => {
    if (i === 0) return render(w, i);
    const space = w.spaceBefore ?? !/^[-'’.,;:!?)\]}%]/.test(w.word);
    return (space ? ' ' : '') + render(w, i);
  }).join('');
}

/* --------------------------------------------------------------- rendering */

/** Build the .ass document for a set of cues. */
export function renderAss(cues, { width, height, style, keywords = [] }) {
  const s = style;
  const px = r => r * height;
  const matcher = makeKeywordMatcher(keywords);

  const assStyle = {
    name: 'Caption',
    font: s.font,
    fontSize: px(s.fontSizeRatio),
    primaryColor: s.primaryColor,
    secondaryColor: s.secondaryColor ?? s.primaryColor,
    outlineColor: s.outlineColor,
    backColor: s.backColor,
    backOpacity: s.backOpacity,
    outline: Math.max(1, px(s.outlineRatio)),
    shadow: px(s.shadowRatio),
    bold: s.bold,
    italic: false,
    alignment: alignmentFor(s.position),
    marginL: Math.round(width * 0.06),
    marginR: Math.round(width * 0.06),
    marginV: Math.round(px(s.marginVRatio)),
  };

  const events = [];
  const cased = w => (s.uppercase ? w.toUpperCase() : w);

  for (const cue of cues) {
    if (s.karaoke) {
      // Native \k: each word carries its own duration in centiseconds, and
      // libass fills it from SecondaryColour to PrimaryColour as it is spoken.
      const body = joinWords(cue.words, w => {
        const cs = Math.max(1, Math.round((w.end - w.start) * 100));
        const hl = matcher.matches(w.word, cue.text) ? `\\c${assColor(s.highlightColor)}` : '';
        return `{\\k${cs}${hl}}${assEscape(cased(w.word))}`;
      });
      events.push({
        start: cue.start, end: cue.end, style: 'Caption',
        text: `${tags(fad(s.fadeMs, s.fadeMs))}${body}`,
      });
      continue;
    }

    if (s.wordByWord) {
      // One event per word: the whole cue is shown, with the spoken word
      // recoloured and popped. This is the look most short-form editing uses.
      cue.words.forEach((active, i) => {
        const start = active.start;
        const end = i === cue.words.length - 1 ? cue.end : cue.words[i + 1].start;
        if (end <= start) return;

        const text = joinWords(cue.words, (w, j) => {
          const body = assEscape(cased(w.word));
          if (j !== i) return body;
          const colour = matcher.matches(w.word, cue.text) ? s.highlightColor : (s.activeColor ?? s.highlightColor);
          const pop = s.popScale
            ? `${scale(s.popScale)}${t(0, 90, scale(100))}`
            : '';
          return `${tags(`\\c${assColor(colour)}`, pop)}${body}{\\r}`;
        });

        events.push({ start, end, style: 'Caption', text: i === 0 ? `${tags(fad(s.fadeMs, 0))}${text}` : text });
      });
      continue;
    }

    // Whole cue at once, with keyword words recoloured in place.
    const text = joinWords(cue.words, w => {
      const body = assEscape(cased(w.word));
      return matcher.matches(w.word, cue.text)
        ? `${tags(`\\c${assColor(s.highlightColor)}`)}${body}{\\r}`
        : body;
    });
    events.push({ start: cue.start, end: cue.end, style: 'Caption', text: `${tags(fad(s.fadeMs, s.fadeMs))}${text}` });
  }

  return buildAss({ width, height, styles: [assStyle], events });
}

/**
 * @param {string} input
 * @param {{style?:string, transcript?:string, maxWords?:number, position?:string,
 *          fontSize?:number, keywords?:string[]|string, burn?:boolean, out?:string,
 *          assOut?:string, language?:string, prompt?:string, font?:string,
 *          uppercase?:boolean, quality?:string, hw?:string}} opts
 */
export async function captions(input, opts = {}) {
  const styleName = opts.style || 'clean';
  const preset = STYLES[styleName];
  if (!preset) throw usageError(`Unknown caption style "${styleName}"`, `Use: ${Object.keys(STYLES).join(', ')}`);

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) throw inputError(`${relToRoot(abs)} has no video track`);

  // Per-call overrides on top of the preset.
  const style = {
    ...preset,
    ...(opts.font ? { font: opts.font } : {}),
    ...(opts.position ? { position: opts.position } : {}),
    ...(opts.fontSize ? { fontSizeRatio: opts.fontSize } : {}),
    ...(opts.maxWords ? { maxWords: opts.maxWords } : {}),
    ...(opts.uppercase !== undefined ? { uppercase: opts.uppercase } : {}),
    ...(opts.marginV !== undefined ? { marginVRatio: opts.marginV } : {}),
  };

  const tr = await loadTranscript(abs, opts);
  const words = flattenWords(tr);
  if (!words.length) {
    throw validationError('the transcript has no word-level timestamps', {
      hint: 'captions need word timings; re-run transcribe on this source',
    });
  }

  const cues = buildCues(words, {
    maxWords: style.maxWords,
    maxChars: opts.maxChars ?? 42,
    gapBreak: opts.gapBreak ?? 0.6,
  });

  const keywords = await loadKeywords(opts);
  const assText = renderAss(cues, { width: meta.width, height: meta.height, style, keywords });

  const assPath = prepareOutput(
    opts.assOut || path.join(ensureDir(path.join(DIR.cache, 'captions')), `${slug(abs)}-${styleName}.ass`)
  );
  fs.writeFileSync(assPath, assText, 'utf8');

  const result = {
    source: relToRoot(abs),
    style: styleName,
    ass: relToRoot(assPath),
    assPath,
    width: meta.width,
    height: meta.height,
    fontSizePx: Math.round(style.fontSizeRatio * meta.height),
    position: style.position,
    cueCount: cues.length,
    wordCount: words.length,
    keywordCount: keywords.length,
    wordByWord: Boolean(style.wordByWord),
    karaoke: Boolean(style.karaoke),
    language: tr.language,
    cues: cues.map(c => ({ start: round(c.start), end: round(c.end), text: c.text })),
  };

  if (!opts.burn) return result;

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-captioned.mp4`));
  const { args: enc } = await encodeArgs({ quality: opts.quality || 'final', hw: opts.hw || 'auto' });
  const encNoVf = stripVf(enc);

  log.info(`burning ${cues.length} cues (${styleName}) into ${meta.width}x${meta.height}`);

  await ffmpeg([
    '-y', '-i', abs,
    '-vf', `ass=filename='${escapeFilterPath(assPath)}'`,
    ...(meta.hasAudio ? ['-map', '0:v', '-map', '0:a', '-c:a', 'aac', '-b:a', '192k'] : ['-map', '0:v', '-an']),
    ...encNoVf,
    out,
  ], { label: 'captions', totalSec: meta.duration });

  const got = await probeVideo(out);
  if (got.width !== meta.width || got.height !== meta.height) {
    throw validationError(`burning captions changed the frame size to ${got.width}x${got.height}`);
  }

  return { ...result, output: relToRoot(out), path: out, duration: got.duration, sizeBytes: got.sizeBytes };
}

async function loadTranscript(abs, opts) {
  if (opts.transcript) {
    const p = resolveInput(opts.transcript, 'transcript');
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { throw inputError(`Could not parse transcript: ${relToRoot(p)}`, e.message); }
  }
  return transcribe(abs, { language: opts.language, prompt: opts.prompt });
}

async function loadKeywords(opts) {
  if (!opts.keywords) return [];
  if (Array.isArray(opts.keywords)) return opts.keywords;
  const raw = String(opts.keywords);
  // A path to a keywords JSON, or a plain comma-separated list.
  if (raw.endsWith('.json') && fs.existsSync(raw)) {
    const parsed = JSON.parse(fs.readFileSync(raw, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.keywords || [];
    return list.map(k => (typeof k === 'string' ? k : k.text)).filter(Boolean);
  }
  return raw.split(',').map(s => s.trim()).filter(Boolean);
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
  name: 'captions',
  summary: 'Generate styled, word-timed captions (.ass), and optionally burn them in.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    style: { type: 'enum', values: Object.keys(STYLES), default: 'clean', help: 'Caption style preset' },
    burn: { type: 'bool', default: false, help: 'Render the captions into the video' },
    transcript: { type: 'string', help: 'Existing transcript JSON (default: transcribe, cached)' },
    language: { type: 'string', help: 'Language hint for transcription' },
    prompt: { type: 'string', help: 'Vocabulary prompt for transcription' },
    keywords: { type: 'string', help: 'Words to highlight: comma list, or a keywords .json' },
    maxWords: { type: 'number', help: 'Words per caption cue (overrides the preset)' },
    maxChars: { type: 'number', default: 42, help: 'Character limit per cue' },
    gapBreak: { type: 'number', default: 0.6, help: 'Split cues on pauses longer than this' },
    position: { type: 'string', help: 'bottom-center, center, top-center, ...' },
    fontSize: { type: 'number', help: 'Font size as a fraction of frame height, e.g. 0.05' },
    marginV: { type: 'number', help: 'Vertical margin as a fraction of frame height' },
    font: { type: 'string', help: 'Font family name' },
    uppercase: { type: 'bool', help: 'Force upper case' },
    out: { type: 'string', help: 'Output video path (with --burn)' },
    assOut: { type: 'string', help: 'Where to write the .ass file' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've captions raw/test.mp4 --language pt',
    've captions raw/test.mp4 --style viral --burn --language pt',
    've captions raw/test.mp4 --style karaoke --burn --keywords "Claude Code,npm"',
  ],
  run: opts => captions(opts.input, opts),
  pretty: r => `${r.cueCount} cues, ${r.wordCount} words (${r.style}, ${r.fontSizePx}px) -> ` +
    `${r.output || r.ass}`,
};

runIfMain(tool, import.meta.url);
