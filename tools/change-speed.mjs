// change-speed — retime video and audio together.
//
// Video: setpts=PTS/rate. Audio needs more care, because there are two
// different things people mean by "speed up":
//
//   preservePitch (default)  atempo — time-stretch, voice keeps its pitch.
//                            This is what you want for talking-head content.
//   preservePitch=false      asetrate — resample, so pitch rises with speed
//                            (the classic chipmunk effect).
//
// atempo accepts 0.5..100 in this build, so only slow-downs below 0.5x need
// chaining. rubberband is offered as an alternative stretcher: better quality
// on music and extreme ratios, noticeably slower.
import path from 'node:path';
import { ffmpeg, encodeArgs, listFilters } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

const MIN_RATE = 0.1;
const MAX_RATE = 10;

/**
 * atempo is limited to >= 0.5 per instance, so a 0.25x slow-down becomes
 * atempo=0.5,atempo=0.5. Returns the factors to chain.
 */
export function atempoChain(rate) {
  const out = [];
  let remaining = rate;
  while (remaining < 0.5 - 1e-9) {
    out.push(0.5);
    remaining /= 0.5;
  }
  while (remaining > 100 + 1e-9) {
    out.push(100);
    remaining /= 100;
  }
  if (Math.abs(remaining - 1) > 1e-9) out.push(remaining);
  return out.length ? out : [1];
}

/**
 * @param {string} input
 * @param {{rate?:number, preservePitch?:boolean, stretcher?:'atempo'|'rubberband',
 *          range?:string, out?:string, quality?:string, hw?:string}} opts
 */
export async function changeSpeed(input, opts = {}) {
  const rate = Number(opts.rate ?? 1);
  const preservePitch = opts.preservePitch !== false;
  const stretcher = opts.stretcher || 'atempo';

  if (!Number.isFinite(rate) || rate <= 0) throw usageError('--rate must be a positive number');
  if (rate < MIN_RATE || rate > MAX_RATE) {
    throw usageError(`--rate ${rate} is outside the supported ${MIN_RATE}x..${MAX_RATE}x range`);
  }
  if (Math.abs(rate - 1) < 1e-6) throw usageError('--rate 1 would do nothing');

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);

  if (stretcher === 'rubberband' && !(await listFilters()).has('rubberband')) {
    throw inputError('this ffmpeg build has no rubberband filter', 'Use --stretcher atempo.');
  }

  const filters = [];
  const vLabel = '[vout]';
  filters.push(`[0:v]setpts=PTS/${rate},fps=${meta.fps || 30}${vLabel}`);

  let aLabel = null;
  if (meta.hasAudio) {
    aLabel = '[aout]';
    filters.push(`[0:a]${audioFilter(rate, preservePitch, stretcher, meta)}${aLabel}`);
  }

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-${String(rate).replace('.', '_')}x.mp4`));
  const { args: enc } = await encodeArgs({ quality: opts.quality || 'final', hw: opts.hw || 'auto' });
  const encNoVf = stripVf(enc);

  const expected = meta.duration / rate;
  log.info(`speed ${rate}x: ${meta.duration}s -> ${expected.toFixed(2)}s (pitch ${preservePitch ? 'preserved' : 'shifted'})`);

  await ffmpeg([
    '-y', '-i', abs,
    '-filter_complex', filters.join(';'),
    '-map', vLabel,
    ...(aLabel ? ['-map', aLabel] : ['-an']),
    ...encNoVf,
    out,
  ], { label: 'change-speed', totalSec: expected });

  const got = await probeVideo(out);
  // A frame or two of slack; anything more means the retime did not apply.
  const tolerance = Math.max(0.25, expected * 0.02);
  if (Math.abs(got.duration - expected) > tolerance) {
    throw validationError(
      `speed change produced ${got.duration}s, expected ${expected.toFixed(2)}s`,
      { rate, sourceDuration: meta.duration, tolerance }
    );
  }

  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    rate,
    preservePitch,
    stretcher: meta.hasAudio ? (preservePitch ? stretcher : 'asetrate') : null,
    sourceDuration: meta.duration,
    expectedDuration: round(expected),
    duration: got.duration,
    drift: round(got.duration - expected),
    width: got.width,
    height: got.height,
    fps: got.fps,
    hasAudio: got.hasAudio,
    sampleRate: got.sampleRate,
    sizeBytes: got.sizeBytes,
  };
}

function audioFilter(rate, preservePitch, stretcher, meta) {
  if (!preservePitch) {
    // Resample the timeline: pitch rides along with speed. aresample restores
    // the nominal rate afterwards so the container stays sane.
    const sr = meta.sampleRate || 48000;
    return `asetrate=${Math.round(sr * rate)},aresample=${sr},asetpts=N/SR/TB`;
  }
  if (stretcher === 'rubberband') return `rubberband=tempo=${rate}:pitchq=quality`;
  return atempoChain(rate).map(t => `atempo=${round(t, 6)}`).join(',');
}

function stripVf(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-vf') { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

const round = (n, p = 3) => Math.round(n * 10 ** p) / 10 ** p;

export const tool = {
  name: 'change-speed',
  summary: 'Speed up or slow down video and audio, keeping them in sync.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    rate: { type: 'number', required: true, help: 'Speed multiplier: 0.5 = half speed, 2 = double' },
    preservePitch: { type: 'bool', default: true, help: 'Keep voice pitch natural (off = chipmunk effect)' },
    stretcher: { type: 'enum', values: ['atempo', 'rubberband'], default: 'atempo', help: 'Time-stretch algorithm' },
    out: { type: 'string', help: 'Output path' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've change-speed raw/test.mp4 --rate 1.25',
    've change-speed raw/test.mp4 --rate 0.5 --stretcher rubberband',
    've change-speed raw/test.mp4 --rate 2 --no-preserve-pitch',
  ],
  run: opts => changeSpeed(opts.input, opts),
  pretty: r => `${r.rate}x  ${r.sourceDuration}s -> ${r.duration}s ` +
    `(${r.stretcher || 'no audio'}, drift ${r.drift}s) -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
