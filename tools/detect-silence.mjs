// detect-silence — find the quiet stretches in a video's audio.
//
// Two detectors, one normalised output shape:
//
//   rms   (default) ffmpeg's `silencedetect`. Threshold is an absolute dBFS
//         level. Fast, deterministic, no dependencies. Struggles when the
//         recording has a constant noise floor above the threshold.
//
//   auto  Measures the actual noise floor first (via `volumedetect`) and sets
//         the threshold relative to it. Handles quiet or noisy recordings that
//         a fixed dBFS number gets wrong in opposite directions.
//
// Padding semantics matter and are easy to get backwards. `paddingBefore` /
// `paddingAfter` SHRINK each detected silence, leaving breathing room around
// speech so that removing the silence does not clip the start of a word.
import path from 'node:path';
import fs from 'node:fs';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { normalize, invert, shrink, totalDuration } from '../lib/ranges.mjs';
import { cacheKey } from '../lib/hash.mjs';
import { inputError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { extractAudio } from './extract-audio.mjs';

/**
 * @param {string} input
 * @param {{threshold?:number, minDuration?:number, paddingBefore?:number, paddingAfter?:number,
 *          method?:'rms'|'auto', out?:string, force?:boolean}} opts
 */
export async function detectSilence(input, opts = {}) {
  const {
    minDuration = 0.35,
    paddingBefore = 0.08,
    paddingAfter = 0.12,
    method = 'rms',
    force = false,
  } = opts;

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasAudio) {
    throw inputError(`${relToRoot(abs)} has no audio track`, 'Silence detection needs an audio stream.');
  }

  // Work from the cached 16 kHz mono WAV: consistent input for the detector and
  // far cheaper than decoding the video again on every re-run.
  const audio = await extractAudio(abs, {});

  let threshold = opts.threshold;
  let noiseFloor = null;
  if (method === 'auto' || threshold === undefined) {
    noiseFloor = await measureNoiseFloor(audio.path);
    if (threshold === undefined) {
      // The threshold must sit well BELOW the average signal level, not near it.
      // mean_volume is the RMS of the whole file (speech included), so silence
      // is roughly 12 dB under it. The clamp stops a pathological measurement
      // from producing a threshold that marks everything, or nothing, as quiet.
      threshold = method === 'auto'
        ? round(clamp(noiseFloor.meanVolume - 12, -60, -20))
        : -35;
    }
  }

  const settings = { threshold, minDuration, method };
  const key = cacheKey(abs, settings);

  const raw = await runSilenceDetect(audio.path, threshold, minDuration);

  // Clip to the real duration and drop anything that rounding made degenerate.
  const detected = normalize(raw, { duration: meta.duration, minDuration: 0 });

  // Apply padding, then re-apply the minimum: a 0.4s silence with 0.2s of total
  // padding is only 0.2s of genuinely removable quiet.
  const padded = shrink(detected, paddingBefore, paddingAfter, { minDuration });

  const speech = invert(padded, meta.duration, { minDuration: 0.05 });

  const result = {
    source: relToRoot(abs),
    method,
    threshold,
    minDuration,
    paddingBefore,
    paddingAfter,
    noiseFloor,
    duration: meta.duration,
    silences: padded.map(r => ({ start: round(r.start), end: round(r.end), duration: round(r.end - r.start) })),
    speech: speech.map(r => ({ start: round(r.start), end: round(r.end), duration: round(r.end - r.start) })),
    silenceCount: padded.length,
    silenceTotal: round(totalDuration(padded)),
    speechTotal: round(totalDuration(speech)),
    silenceRatio: meta.duration ? round(totalDuration(padded) / meta.duration) : 0,
    rawSilenceCount: detected.length,
    cacheKey: key,
  };

  const out = opts.out ?? path.join(ensureDir(path.join(DIR.cache, 'silence')), `${slug(abs)}-${key}.json`);
  const outPath = prepareOutput(out);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  result.output = relToRoot(outPath);
  result.path = outPath;

  return result;
}

/** Parse ffmpeg's silencedetect log lines into ranges. */
async function runSilenceDetect(audioPath, thresholdDb, minDuration) {
  // silencedetect reports on stderr at INFO level; the shared wrapper defaults
  // to -loglevel error, so it must be raised here or nothing is ever detected.
  const { stderr } = await ffmpeg([
    '-loglevel', 'info',
    '-i', audioPath,
    '-af', `silencedetect=noise=${thresholdDb}dB:d=${minDuration}`,
    '-f', 'null', '-',
  ], { label: 'silencedetect', timeoutMs: 600000 });

  const ranges = [];
  let pendingStart = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) { pendingStart = Number(s[1]); continue; }
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && pendingStart !== null) {
      ranges.push({ start: Math.max(0, pendingStart), end: Number(e[1]) });
      pendingStart = null;
    }
  }
  // A silence that runs to the end of file never emits silence_end.
  if (pendingStart !== null) ranges.push({ start: Math.max(0, pendingStart), end: Infinity });
  return ranges;
}

/** Mean/peak volume in dBFS, used to place an adaptive threshold. */
async function measureNoiseFloor(audioPath) {
  const { stderr } = await ffmpeg(['-loglevel', 'info', '-i', audioPath, '-af', 'volumedetect', '-f', 'null', '-'],
    { label: 'volumedetect', timeoutMs: 600000 });
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  const max = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  return {
    meanVolume: mean ? Number(mean[1]) : null,
    maxVolume: max ? Number(max[1]) : null,
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = n => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n);

export const tool = {
  name: 'detect-silence',
  summary: 'Find silent stretches and their complementary speech regions.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    threshold: { type: 'number', help: 'Silence threshold in dBFS (default -35, or adaptive with --method auto)' },
    minDuration: { type: 'number', default: 0.35, help: 'Ignore silences shorter than this (seconds)' },
    paddingBefore: { type: 'number', default: 0.08, help: 'Keep this much silence before speech resumes' },
    paddingAfter: { type: 'number', default: 0.12, help: 'Keep this much silence after speech ends' },
    method: { type: 'enum', values: ['rms', 'auto'], default: 'rms', help: 'rms = fixed dBFS; auto = relative to measured noise floor' },
    out: { type: 'string', help: 'Where to write the JSON (default: cache/silence/)' },
    force: { type: 'bool', default: false, help: 'Ignore cached audio extraction' },
  },
  examples: [
    've detect-silence raw/test.mp4',
    've detect-silence raw/test.mp4 --method auto --min-duration 0.5',
    've detect-silence raw/test.mp4 | jq ".silences[]"',
  ],
  run: opts => detectSilence(opts.input, opts),
  pretty: r => `${r.silenceCount} silence(s), ${r.silenceTotal}s of ${r.duration}s ` +
    `(${Math.round(r.silenceRatio * 100)}%) at ${r.threshold}dB -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
