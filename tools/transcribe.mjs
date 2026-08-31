// transcribe — speech to text with word-level timestamps.
//
// Backend: faster-whisper (CTranslate2) via pysrc/transcribe.py.
// FFmpeg's built-in `whisper` filter was evaluated first and rejected — it has
// no word timestamps, snaps segment times to its 10s processing window, and
// dropped an entire sentence at a chunk boundary. See ROADMAP.md.
//
// Transcription is by far the most expensive step in the pipeline, so results
// are cached on (audio content + every setting that changes the output). An
// unchanged video is never transcribed twice.
import fs from 'node:fs';
import path from 'node:path';
import { runPython, hasVenv } from '../lib/python.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { cacheKey } from '../lib/hash.mjs';
import { validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { extractAudio } from './extract-audio.mjs';

export const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'];

/**
 * @param {string} input video or audio file
 * @param {{model?:string, language?:string, device?:'auto'|'cuda'|'cpu', beamSize?:number,
 *          vad?:boolean, prompt?:string, out?:string, force?:boolean}} opts
 */
export async function transcribe(input, opts = {}) {
  const {
    model = 'small',
    language,
    device = 'auto',
    beamSize = 5,
    vad = false,
    prompt,
    force = false,
  } = opts;

  const abs = resolveInput(input, 'media');
  const meta = await probeVideo(abs);
  if (!meta.hasAudio) {
    throw validationError(`${relToRoot(abs)} has no audio track to transcribe`, { file: relToRoot(abs) });
  }

  // Whisper wants 16 kHz mono; extract-audio already caches exactly that.
  const audio = await extractAudio(abs, {});

  // `device` is deliberately NOT part of the key: CPU and GPU produce the same
  // text, so a GPU run should reuse a CPU-cached result and vice versa.
  const settings = { model, language: language ?? 'auto', beamSize, vad, prompt: prompt ?? null };
  const key = cacheKey(abs, settings);

  const cacheFile = path.join(ensureDir(path.join(DIR.cache, 'transcripts')), `${slug(abs)}-${key}.json`);
  const out = prepareOutput(opts.out || path.join(ensureDir(DIR.transcripts), `${slug(abs)}.json`));

  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      log.debug(`transcribe: cache hit ${relToRoot(cacheFile)}`);
      fs.writeFileSync(out, JSON.stringify(cached, null, 2));
      return shape(cached, { abs, out, cacheFile, key, cached: true, settings });
    } catch {
      log.warn('cached transcript was unreadable; re-transcribing');
    }
  }

  const args = [
    '--audio', audio.path,
    '--model', model,
    '--device', device,
    '--beam-size', String(beamSize),
    '--model-dir', ensureDir(DIR.models),
  ];
  if (language) args.push('--language', language);
  if (vad) args.push('--vad');
  if (prompt) args.push('--initial-prompt', prompt);

  const result = await runPython('transcribe.py', args, {
    label: 'transcribe',
    timeoutMs: 0,
    onLog: line => {
      if (line.startsWith('[warn]') || line.startsWith('[error]')) log.warn(line.replace(/^\[\w+\]\s*/, ''));
      else log.debug(line);
    },
  });

  if (!Array.isArray(result.segments)) {
    throw validationError('transcription returned no segments array', { result });
  }
  // Word timestamps are the entire reason this backend was chosen; if they are
  // missing, downstream captions and keyword highlighting would silently break.
  if (result.segments.length && !result.segments.some(s => s.words?.length)) {
    throw validationError('transcription returned segments but no word-level timestamps', {
      segmentCount: result.segments.length,
    });
  }

  fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  fs.writeFileSync(out, JSON.stringify(result, null, 2));

  return shape(result, { abs, out, cacheFile, key, cached: false, settings });
}

function shape(r, { abs, out, cacheFile, key, cached }) {
  return {
    source: relToRoot(abs),
    transcript: relToRoot(out),
    path: out,
    cached,
    cacheKey: key,
    cacheFile: relToRoot(cacheFile),
    language: r.language,
    languageProbability: r.languageProbability,
    duration: r.duration,
    model: r.model,
    device: r.device,
    computeType: r.computeType,
    segmentCount: r.segmentCount ?? r.segments.length,
    wordCount: r.wordCount ?? r.segments.reduce((n, s) => n + (s.words?.length || 0), 0),
    text: r.text,
    segments: r.segments,
    loadMs: r.loadMs,
    transcribeMs: r.transcribeMs,
    realtimeFactor: r.transcribeMs ? Math.round((r.duration / (r.transcribeMs / 1000)) * 10) / 10 : null,
  };
}

/** Convenience for other tools: flat word list with segment ids attached. */
export function flattenWords(transcript) {
  const words = [];
  for (const seg of transcript.segments || []) {
    for (const w of seg.words || []) words.push({ ...w, segment: seg.id });
  }
  return words;
}

export const tool = {
  name: 'transcribe',
  summary: 'Speech to text with word-level timestamps (faster-whisper).',
  args: {
    input: { positional: 0, required: true, help: 'Source video or audio file' },
    model: { type: 'enum', values: MODELS, default: 'small', help: 'Whisper model size' },
    language: { type: 'string', help: 'ISO code such as pt or en (default: auto-detect)' },
    device: { type: 'enum', values: ['auto', 'cuda', 'cpu'], default: 'auto', help: 'auto falls back to CPU if the GPU path fails' },
    beamSize: { type: 'number', default: 5, help: 'Beam search width' },
    vad: { type: 'bool', default: false, help: 'Silero VAD pre-filter (drops non-speech before decoding)' },
    prompt: { type: 'string', help: 'Initial prompt: bias vocabulary, e.g. product or tool names' },
    out: { type: 'string', help: 'Output path (default: transcripts/<name>.json)' },
    force: { type: 'bool', default: false, help: 'Ignore the cache and re-transcribe' },
  },
  examples: [
    've transcribe raw/test.mp4 --language pt',
    've transcribe raw/test.mp4 --model medium --prompt "Claude Code, npm, Docker"',
    've transcribe raw/test.mp4 | jq -r ".segments[].text"',
  ],
  run: opts => transcribe(opts.input, opts),
  pretty: r => `${r.cached ? 'cached' : `${r.device} ${r.realtimeFactor}x realtime`}  ` +
    `${r.segmentCount} segments, ${r.wordCount} words, lang=${r.language}  -> ${r.transcript}`,
};

runIfMain(tool, import.meta.url);
