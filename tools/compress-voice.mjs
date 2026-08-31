// compress-voice — even out speech level so quiet words stay audible.
//
// Loudness normalisation (`normalize-audio`) sets the AVERAGE level of a whole
// file. Compression is a different job: it narrows the gap between the loudest
// and quietest moments WITHIN the file, which is what makes a voice sit
// comfortably on a phone speaker in a noisy room.
//
// Order matters and is fixed here: high-pass, then de-ess, then compress, then
// make-up gain, then a limiter. Compressing before the high-pass would let
// rumble trigger gain reduction on every breath.
//
// Presets are expressed as intent, because ratio/threshold/attack numbers only
// mean something to people who already know what they want.
import path from 'node:path';
import { ffmpeg, listFilters } from '../lib/ffmpeg.mjs';
import { run } from '../lib/proc.mjs';
import { FFMPEG } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { inputError, usageError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

/**
 * acompressor takes threshold as a LINEAR ratio (0..1), not dB, which is a
 * common source of silently wrong settings. 0.089 ~= -21 dBFS.
 */
export const PRESETS = {
  light: {
    description: 'Gentle levelling. Keeps most of the natural dynamics.',
    threshold: 0.125, ratio: 2.5, attack: 20, release: 250, makeup: 1.6,
  },
  voice: {
    description: 'Standard spoken-word compression. The default.',
    threshold: 0.089, ratio: 4, attack: 12, release: 200, makeup: 2.2,
  },
  broadcast: {
    description: 'Tight and forward. Consistent on small speakers, less natural.',
    threshold: 0.063, ratio: 6, attack: 6, release: 150, makeup: 3.0,
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);

/** Peak, mean, and the gap between them — the thing compression actually changes. */
export async function measureDynamics(file) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-i', file,
    '-af', 'volumedetect', '-vn', '-f', 'null', '-',
  ], { timeoutMs: 600000 });
  const mean = Number(/mean_volume:\s*(-?[\d.]+)/.exec(stderr)?.[1]);
  const max = Number(/max_volume:\s*(-?[\d.]+)/.exec(stderr)?.[1]);
  return {
    mean: Number.isFinite(mean) ? mean : null,
    peak: Number.isFinite(max) ? max : null,
    // Crest factor: how far the peaks sit above the average. Compression
    // reduces it; that is the measurable definition of "more even".
    crest: Number.isFinite(mean) && Number.isFinite(max) ? round(max - mean) : null,
  };
}

/**
 * @param {string} input
 * @param {{preset?:string, threshold?:number, ratio?:number, attack?:number, release?:number,
 *          makeup?:number, deEss?:boolean, highpass?:number, limit?:number, out?:string}} opts
 */
export async function compressVoice(input, opts = {}) {
  const presetName = opts.preset || 'voice';
  const preset = PRESETS[presetName];
  if (!preset) throw usageError(`Unknown preset "${presetName}"`, `Use: ${PRESET_NAMES.join(', ')}`);

  const abs = resolveInput(input, 'media');
  const meta = await probeVideo(abs);
  if (!meta.hasAudio) throw inputError(`${relToRoot(abs)} has no audio track`);

  const filters = await listFilters();
  if (!filters.has('acompressor')) throw inputError('this ffmpeg build has no acompressor filter');

  const cfg = {
    threshold: opts.threshold ?? preset.threshold,
    ratio: opts.ratio ?? preset.ratio,
    attack: opts.attack ?? preset.attack,
    release: opts.release ?? preset.release,
    makeup: opts.makeup ?? preset.makeup,
  };
  const highpass = opts.highpass ?? 80;
  const limit = opts.limit ?? 0.95;

  const chain = [];
  if (highpass > 0) chain.push(`highpass=f=${highpass}`);
  if (opts.deEss) {
    // Sibilance lives around 5-8 kHz; a narrow dip there costs nothing else.
    chain.push('equalizer=f=6500:width_type=h:width=2000:g=-4');
  }
  chain.push(
    `acompressor=threshold=${cfg.threshold}:ratio=${cfg.ratio}:attack=${cfg.attack}` +
    `:release=${cfg.release}:makeup=${cfg.makeup}:knee=4`
  );
  // A limiter after make-up gain is not optional: make-up can push peaks past
  // full scale, and clipping is worse than any amount of compression.
  if (filters.has('alimiter')) chain.push(`alimiter=limit=${limit}:level=disabled`);

  const before = await measureDynamics(abs);
  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-compressed${path.extname(abs) || '.mp4'}`));

  await ffmpeg([
    '-y', '-i', abs,
    '-af', chain.join(','),
    ...(meta.hasVideo ? ['-c:v', 'copy'] : []),
    '-c:a', 'aac', '-b:a', opts.bitrate || '192k',
    out,
  ], { label: 'compress-voice', totalSec: meta.duration });

  const after = await measureDynamics(out);
  const got = await probeVideo(out);

  if (after.peak !== null && after.peak > -0.1) {
    throw validationError(`compression pushed the signal into clipping (peak ${after.peak} dBFS)`,
      { before, after, hint: 'Lower --makeup or --limit.' });
  }

  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    preset: presetName,
    settings: cfg,
    deEss: Boolean(opts.deEss),
    highpass,
    before,
    after,
    crestReductionDb: before.crest !== null && after.crest !== null ? round(before.crest - after.crest) : null,
    duration: got.duration,
    hasVideo: got.hasVideo,
    sizeBytes: got.sizeBytes,
  };
}

const round = (n, p = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : null);

export const tool = {
  name: 'compress-voice',
  summary: 'Even out speech dynamics so quiet words stay audible.',
  args: {
    input: { positional: 0, required: true, help: 'Source video or audio' },
    preset: { type: 'enum', values: PRESET_NAMES, default: 'voice', help: 'light | voice | broadcast' },
    threshold: { type: 'number', help: 'Override threshold as a LINEAR ratio (0.089 ~= -21 dBFS)' },
    ratio: { type: 'number', help: 'Override compression ratio' },
    attack: { type: 'number', help: 'Attack in ms' },
    release: { type: 'number', help: 'Release in ms' },
    makeup: { type: 'number', help: 'Make-up gain' },
    deEss: { type: 'bool', default: false, help: 'Dip sibilance around 6.5 kHz' },
    highpass: { type: 'number', default: 80, help: 'High-pass cutoff in Hz; 0 disables' },
    limit: { type: 'number', default: 0.95, help: 'Output limiter ceiling (linear)' },
    bitrate: { type: 'string', default: '192k', help: 'Output AAC bitrate' },
    out: { type: 'string', help: 'Output path' },
  },
  examples: [
    've compress-voice raw/test.mp4',
    've compress-voice raw/test.mp4 --preset broadcast --de-ess',
  ],
  run: opts => compressVoice(opts.input, opts),
  pretty: r => `${r.preset}: crest ${r.before.crest} -> ${r.after.crest} dB ` +
    `(${r.crestReductionDb} dB more even), peak ${r.after.peak} dBFS -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
