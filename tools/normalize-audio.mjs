// normalize-audio — EBU R128 loudness normalisation, two-pass.
//
// Why two passes. Single-pass `loudnorm` works in a streaming, look-ahead
// fashion: it cannot know the file's overall loudness while it is still
// reading it, so it adapts as it goes and typically lands 1-2 LU off target,
// with audible level drift across the file. Measuring first, then applying
// with `measured_*`, makes the correction a single fixed gain and hits the
// target far more accurately. It costs one extra decode pass and no re-encode
// of the video (which is stream-copied).
//
// Targets, for reference:
//   -14 LUFS  Spotify / YouTube music
//   -16 LUFS  podcasts, spoken word, most social video  <- default
//   -23 LUFS  EBU broadcast
import path from 'node:path';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

/**
 * Pass 1: measure. loudnorm prints a JSON block to stderr at info level.
 * @returns {Promise<{input_i:string,input_tp:string,input_lra:string,input_thresh:string,target_offset:string}>}
 */
export async function measureLoudness(file, { targetLufs = -16, truePeak = -1.5, lra = 11 } = {}) {
  const { stderr } = await ffmpeg([
    '-loglevel', 'info', '-i', file,
    '-af', `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${lra}:print_format=json`,
    '-vn', '-f', 'null', '-',
  ], { label: 'loudnorm(measure)', timeoutMs: 0 });

  // The JSON block is the last {...} in the log.
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw validationError('loudnorm did not report measurements', { stderrTail: stderr.slice(-400) });
  }
  try {
    return JSON.parse(stderr.slice(start, end + 1));
  } catch (cause) {
    throw validationError('could not parse loudnorm measurements', { cause: String(cause) });
  }
}

/**
 * @param {string} input
 * @param {{targetLufs?:number, truePeak?:number, lra?:number, denoise?:boolean,
 *          highpass?:number, passes?:1|2, out?:string, bitrate?:string}} opts
 */
export async function normalizeAudio(input, opts = {}) {
  const {
    targetLufs = -16,
    truePeak = -1.5,
    lra = 11,
    denoise = false,
    highpass = 0,
    passes = 2,
    bitrate = '192k',
  } = opts;

  const abs = resolveInput(input, 'media');
  const meta = await probeVideo(abs);
  if (!meta.hasAudio) {
    throw inputError(`${relToRoot(abs)} has no audio track`, 'Nothing to normalise.');
  }

  const pre = [];
  // Rumble, handling noise and plosives all live below ~80 Hz and only eat
  // headroom; removing them before measuring gives a more useful target.
  if (highpass > 0) pre.push(`highpass=f=${highpass}`);
  if (denoise) pre.push('afftdn=nf=-25');

  let measured = null;
  let loudnormArgs = `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${lra}`;

  if (passes === 2) {
    measured = await measureLoudness(abs, { targetLufs, truePeak, lra });
    log.info(`measured: ${measured.input_i} LUFS, peak ${measured.input_tp} dBTP, LRA ${measured.input_lra}`);
    loudnormArgs += `:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
      `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}` +
      `:offset=${measured.target_offset}:linear=true`;
  }

  const chain = [...pre, loudnormArgs, 'aresample=48000'].join(',');
  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-normalized${path.extname(abs) || '.mp4'}`));

  await ffmpeg([
    '-y', '-i', abs,
    '-af', chain,
    // The picture is untouched, so never re-encode it.
    ...(meta.hasVideo ? ['-c:v', 'copy'] : []),
    '-c:a', 'aac', '-b:a', bitrate,
    out,
  ], { label: 'normalize-audio', totalSec: meta.duration });

  // Verify by measuring the RESULT, not by trusting the filter.
  const after = await measureLoudness(out, { targetLufs, truePeak, lra });
  const achieved = Number(after.input_i);
  const error = achieved - targetLufs;

  const got = await probeVideo(out);
  if (Math.abs(error) > 1.5) {
    throw validationError(
      `normalisation landed at ${achieved} LUFS, ${error.toFixed(2)} LU from the ${targetLufs} target`,
      { measured, after, passes }
    );
  }

  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    targetLufs,
    truePeak,
    passes,
    denoise,
    highpass,
    before: measured ? {
      lufs: Number(measured.input_i),
      truePeak: Number(measured.input_tp),
      lra: Number(measured.input_lra),
    } : null,
    after: {
      lufs: achieved,
      truePeak: Number(after.input_tp),
      lra: Number(after.input_lra),
    },
    errorLu: round(error),
    gainApplied: measured ? round(achieved - Number(measured.input_i)) : null,
    duration: got.duration,
    hasVideo: got.hasVideo,
    sizeBytes: got.sizeBytes,
  };
}

const round = n => Math.round(n * 100) / 100;

export const tool = {
  name: 'normalize-audio',
  summary: 'EBU R128 loudness normalisation (two-pass), video stream-copied.',
  args: {
    input: { positional: 0, required: true, help: 'Source video or audio' },
    targetLufs: { type: 'number', default: -16, help: 'Integrated loudness target (-16 for social/podcast)' },
    truePeak: { type: 'number', default: -1.5, help: 'Maximum true peak in dBTP' },
    lra: { type: 'number', default: 11, help: 'Loudness range target' },
    passes: { type: 'number', default: 2, help: '2 = measure then apply (accurate); 1 = streaming (fast)' },
    denoise: { type: 'bool', default: false, help: 'Apply FFT denoise before normalising' },
    highpass: { type: 'number', default: 0, help: 'High-pass cutoff in Hz, e.g. 80 to remove rumble' },
    bitrate: { type: 'string', default: '192k', help: 'Output AAC bitrate' },
    out: { type: 'string', help: 'Output path' },
  },
  examples: [
    've normalize-audio raw/test.mp4',
    've normalize-audio raw/test.mp4 --target-lufs -14 --highpass 80',
    've normalize-audio raw/test.mp4 --denoise --passes 2',
  ],
  run: opts => normalizeAudio(opts.input, opts),
  pretty: r => `${r.before ? `${r.before.lufs} -> ` : ''}${r.after.lufs} LUFS ` +
    `(target ${r.targetLufs}, error ${r.errorLu} LU, peak ${r.after.truePeak} dBTP) -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
