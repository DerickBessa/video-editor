// denoise-audio — reduce steady background noise without hollowing out the voice.
//
// Two engines, both already in this FFmpeg build:
//
//   fft   `afftdn` — spectral subtraction. Predictable, tunable, and good on
//         steady noise (air conditioning, fan, hum, hiss). Over-applied it
//         produces the metallic "underwater" artefact, so the default is
//         deliberately gentle.
//   rnn   `arnndn` — a recurrent network trained for speech. Much better on
//         non-stationary noise (keyboard, traffic), but it needs a .rnnn model
//         file that FFmpeg does not ship, so it is only offered when one is
//         present in models/.
//
// A high-pass is applied first by default: almost nothing useful in speech
// lives below 80 Hz, while rumble, handling noise and plosives all do, and
// removing them before the denoiser gives it an easier problem.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, listFilters } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { run, tail } from '../lib/proc.mjs';
import { FFMPEG } from '../lib/ffmpeg.mjs';
import { inputError, usageError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

export const ENGINES = ['fft', 'rnn'];

/** Overall level, used to report how much the denoiser changed. */
export async function measureNoise(file) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-i', file,
    '-af', 'volumedetect', '-vn', '-f', 'null', '-',
  ], { timeoutMs: 600000 });
  const mean = /mean_volume:\s*(-?[\d.]+)/.exec(stderr);
  const max = /max_volume:\s*(-?[\d.]+)/.exec(stderr);
  return { mean: mean ? Number(mean[1]) : null, max: max ? Number(max[1]) : null };
}

/**
 * Estimate the NOISE FLOOR: the level of the quietest parts of the recording,
 * which is where the noise lives on its own.
 *
 * Measured as the 10th percentile of per-window RMS, in one pass. Validated
 * against a file with a known -40.5 dB hiss floor: this returned -40.4 dB.
 *
 * This matters because `afftdn`'s `nf` is an ESTIMATE OF THE NOISE, not a
 * strength dial. Setting it far below the real floor tells the filter the noise
 * is quieter than it is and it removes almost nothing — measured: nf=-50 on a
 * -40 dB floor removed 2 dB, while nf=-38 removed 12 dB at the same `nr`.
 */
export async function measureNoiseFloor(file) {
  const res = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-i', file,
    '-af', 'astats=metadata=1:reset=12,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-vn', '-f', 'null', '-',
  ], { timeoutMs: 900000 });

  // `ametadata=...:file=-` writes to STDOUT, not to the log. Scanning only
  // stderr silently returned no samples and fell back to a constant floor.
  const levels = [...`${res.stdout}\n${res.stderr}`.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/g)]
    .map(m => Number(m[1]))
    .filter(v => Number.isFinite(v) && v > -120)
    .sort((a, b) => a - b);

  if (!levels.length) return null;
  return {
    floor: round(levels[Math.floor(levels.length * 0.1)], 1),
    quietest: round(levels[0], 1),
    median: round(levels[Math.floor(levels.length / 2)], 1),
    windows: levels.length,
  };
}

/**
 * @param {string} input
 * @param {{engine?:'fft'|'rnn', strength?:number, highpass?:number, model?:string, out?:string}} opts
 */
export async function denoiseAudio(input, opts = {}) {
  const engine = opts.engine || 'fft';
  if (!ENGINES.includes(engine)) throw usageError(`Unknown engine "${engine}"`, `Use: ${ENGINES.join(', ')}`);

  // 0..1 maps onto afftdn's noise-reduction AMOUNT (`nr`), in dB. Full strength
  // is deliberately not 97 dB: past about 30 dB the artefacts cost more than the
  // noise did. The noise FLOOR (`nf`) is measured, never guessed.
  const strength = Math.min(1, Math.max(0, opts.strength ?? 0.5));
  const highpass = opts.highpass ?? 80;

  const abs = resolveInput(input, 'media');
  const meta = await probeVideo(abs);
  if (!meta.hasAudio) throw inputError(`${relToRoot(abs)} has no audio track`);

  // Measure BEFORE building the chain: afftdn's nf comes from this.
  const floorInfo = engine === 'fft' ? await measureNoiseFloor(abs) : null;
  const before = await measureNoise(abs);
  if (floorInfo) log.debug(`noise floor ${floorInfo.floor} dB (median ${floorInfo.median} dB)`);

  const filters = [];
  let chosen = null;
  if (highpass > 0) filters.push(`highpass=f=${highpass}`);

  if (engine === 'rnn') {
    const model = opts.model || findRnnModel();
    if (!model) {
      throw inputError('arnndn needs a .rnnn model, and none was found',
        `Put one in ${relToRoot(DIR.models)}/ (e.g. from the RNNoise models repo), or use --engine fft.`);
    }
    filters.push(`arnndn=m='${model.replace(/\\/g, '/').replace(/:/g, '\\:')}'`);
  } else {
    if (!(await listFilters()).has('afftdn')) {
      throw inputError('this ffmpeg build has no afftdn filter');
    }
    const nr = round(6 + strength * 24, 1);   // how much to remove, 6..30 dB
    // Tell afftdn where the noise actually is. A little ABOVE the measured
    // floor works best; well below it and the filter does almost nothing.
    // Falls back to a sane constant when the measurement fails.
    const measured = opts.noiseFloor ?? floorInfo?.floor;
    const nf = clamp(round((measured ?? -40) + 2, 1), -80, -20);
    // `tn` (noise tracking) is left OFF: on the reference file it re-estimated
    // the floor downwards mid-clip and undid most of the reduction.
    filters.push(`afftdn=nr=${nr}:nf=${nf}`);
    chosen = { nr, nf };
  }

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-denoised${path.extname(abs) || '.mp4'}`));

  await ffmpeg([
    '-y', '-i', abs,
    '-af', filters.join(','),
    ...(meta.hasVideo ? ['-c:v', 'copy'] : []),
    '-c:a', 'aac', '-b:a', opts.bitrate || '192k',
    out,
  ], { label: 'denoise-audio', totalSec: meta.duration });

  const after = await measureNoise(out);
  const got = await probeVideo(out);

  // Removing more than ~12 dB of MEAN level means the voice went with the
  // noise. That is a failure, not a strong setting.
  const meanDrop = before.mean !== null && after.mean !== null ? before.mean - after.mean : 0;
  if (meanDrop > 12) {
    throw validationError(
      `denoising removed ${meanDrop.toFixed(1)} dB of overall level — the voice is being damaged`,
      { before, after, strength, hint: 'Lower --strength.' }
    );
  }

  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    engine,
    strength,
    highpass,
    noiseFloor: floorInfo,
    afftdn: chosen,
    before,
    after,
    meanChangeDb: round(after.mean - before.mean, 2),
    peakChangeDb: round(after.max - before.max, 2),
    duration: got.duration,
    hasVideo: got.hasVideo,
    sizeBytes: got.sizeBytes,
  };
}

function findRnnModel() {
  if (!fs.existsSync(DIR.models)) return null;
  const f = fs.readdirSync(DIR.models).find(x => x.endsWith('.rnnn'));
  return f ? path.join(DIR.models, f) : null;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (n, p = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : null);

export const tool = {
  name: 'denoise-audio',
  summary: 'Reduce background noise, keeping the voice intact.',
  args: {
    input: { positional: 0, required: true, help: 'Source video or audio' },
    engine: { type: 'enum', values: ENGINES, default: 'fft', help: 'fft = afftdn (always available); rnn = arnndn (needs a model)' },
    strength: { type: 'number', default: 0.5, help: '0..1 — higher removes more noise and more voice' },
    highpass: { type: 'number', default: 80, help: 'High-pass cutoff in Hz; 0 disables' },
    model: { type: 'string', help: 'Path to a .rnnn model for --engine rnn' },
    noiseFloor: { type: 'number', help: 'Override the measured noise floor in dBFS' },
    bitrate: { type: 'string', default: '192k', help: 'Output AAC bitrate' },
    out: { type: 'string', help: 'Output path' },
  },
  examples: [
    've denoise-audio raw/test.mp4',
    've denoise-audio raw/test.mp4 --strength 0.8 --highpass 100',
  ],
  run: opts => denoiseAudio(opts.input, opts),
  pretty: r => `${r.engine} denoise at ${r.strength}` +
    `${r.noiseFloor ? ` (floor ${r.noiseFloor.floor} dB -> nf ${r.afftdn.nf}, nr ${r.afftdn.nr})` : ''}` +
    ` — level ${r.meanChangeDb >= 0 ? '+' : ''}${r.meanChangeDb} dB -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
