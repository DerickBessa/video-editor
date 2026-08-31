// extract-audio — pull a speech-processing-ready audio track out of a video.
//
// Default is 16 kHz mono signed 16-bit PCM WAV: exactly what Whisper, Silero
// VAD and webrtcvad all expect internally. Feeding them anything else just
// makes them resample it again, slower.
//
// Results are cached by (file fingerprint + settings) so re-running the
// pipeline on an unchanged video never re-decodes it.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { cacheKey } from '../lib/hash.mjs';
import { inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

/**
 * @param {string} input
 * @param {{out?:string, sampleRate?:number, channels?:number, format?:'wav'|'flac'|'mp3',
 *          start?:number, end?:number, normalize?:boolean, force?:boolean}} opts
 */
export async function extractAudio(input, opts = {}) {
  const {
    sampleRate = 16000,
    channels = 1,
    format = 'wav',
    start,
    end,
    normalize = false,
    force = false,
  } = opts;

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);

  if (!meta.hasAudio) {
    throw inputError(
      `${relToRoot(abs)} has no audio track`,
      'Nothing to extract. Check the source file, or skip audio steps for this input.'
    );
  }

  const settings = { sampleRate, channels, format, start, end, normalize };
  const key = cacheKey(abs, settings);
  const out = opts.out
    ? prepareOutput(opts.out)
    : path.join(ensureDir(path.join(DIR.cache, 'audio')), `${slug(abs)}-${key}.${format}`);

  if (!force && fs.existsSync(out) && fs.statSync(out).size > 1000) {
    log.debug(`extract-audio: cache hit ${relToRoot(out)}`);
    return await describe(out, { abs, meta, key, cached: true, settings });
  }

  // Seeking BEFORE -i is the fast path, and it is frame-accurate enough for
  // audio-only output. Because that resets output timestamps to zero, the
  // window length must be expressed as -t (a duration), not -to (a timestamp).
  const args = ['-y'];
  if (start !== undefined) args.push('-ss', String(start));
  args.push('-i', abs);
  if (end !== undefined) {
    const span = end - (start ?? 0);
    if (span <= 0) throw inputError(`--end (${end}) must be greater than --start (${start ?? 0})`);
    args.push('-t', String(span));
  }

  const filters = [];
  if (normalize) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');

  args.push('-vn', '-sn', '-dn', '-map', '0:a:0');
  if (filters.length) args.push('-af', filters.join(','));
  args.push('-ac', String(channels), '-ar', String(sampleRate));

  if (format === 'wav') args.push('-c:a', 'pcm_s16le');
  else if (format === 'flac') args.push('-c:a', 'flac', '-compression_level', '5');
  else if (format === 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', '2');

  args.push(out);

  await ffmpeg(args, { label: 'extract-audio', totalSec: meta.duration });

  if (!fs.existsSync(out) || fs.statSync(out).size < 100) {
    throw validationError('extract-audio produced no usable output', { out });
  }
  return await describe(out, { abs, meta, key, cached: false, settings });
}

async function describe(out, { abs, meta, key, cached, settings }) {
  const got = await probeVideo(out);
  // Independent check: the file we just wrote must really carry the format we asked for.
  if (got.sampleRate !== settings.sampleRate || got.channels !== settings.channels) {
    throw validationError('extracted audio does not match requested format', {
      wanted: { sampleRate: settings.sampleRate, channels: settings.channels },
      got: { sampleRate: got.sampleRate, channels: got.channels },
    });
  }
  return {
    source: relToRoot(abs),
    audio: relToRoot(out),
    path: out,
    cached,
    cacheKey: key,
    duration: got.duration,
    sampleRate: got.sampleRate,
    channels: got.channels,
    codec: got.audioCodec,
    sizeBytes: got.sizeBytes,
    sourceDuration: meta.duration,
  };
}

export const tool = {
  name: 'extract-audio',
  summary: 'Extract a speech-ready audio track (default 16 kHz mono PCM WAV).',
  args: {
    input: { positional: 0, required: true, help: 'Source video file' },
    out: { type: 'string', help: 'Output path (default: cached file under cache/audio/)' },
    sampleRate: { type: 'number', default: 16000, help: 'Target sample rate in Hz' },
    channels: { type: 'number', default: 1, help: 'Channel count (1 = mono, best for ASR)' },
    format: { type: 'enum', values: ['wav', 'flac', 'mp3'], default: 'wav', help: 'Output audio format' },
    start: { type: 'number', help: 'Start offset in seconds' },
    end: { type: 'number', help: 'End offset in seconds' },
    normalize: { type: 'bool', default: false, help: 'Apply EBU R128 loudness normalisation' },
    force: { type: 'bool', default: false, help: 'Ignore the cache and re-extract' },
  },
  examples: [
    've extract-audio raw/test.mp4',
    've extract-audio raw/test.mp4 --out temp/voice.wav --sample-rate 48000 --channels 2',
  ],
  run: opts => extractAudio(opts.input, opts),
  pretty: r => `${r.cached ? 'cached' : 'wrote'} ${r.audio}  ${r.sampleRate}Hz ${r.channels}ch  ` +
    `${r.duration}s  ${(r.sizeBytes / 1048576).toFixed(2)}MB`,
};

runIfMain(tool, import.meta.url);
