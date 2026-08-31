// freeze-frame — hold a single frame, extending the video.
//
// Used to let a punchline land, or to give a viewer time to read something on
// screen. The video gets LONGER by exactly the hold duration; everything after
// the freeze shifts later.
//
// Audio is the part people get wrong. Three options, and the default is the
// only one that is always safe:
//   silence  (default) insert silence for the hold. Nothing is lost.
//   hold     freeze the audio too — in practice a click, since a single audio
//            frame repeated is not a sustained sound. Offered, not recommended.
//   continue let the audio run underneath the frozen picture. Good for music
//            beds, but it desynchronises speech from the picture afterwards.
import path from 'node:path';
import fs from 'node:fs';
import { ffmpeg, encodeArgs } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

export const AUDIO_MODES = ['silence', 'hold', 'continue'];

export function parseFreezes(raw) {
  if (raw == null) return [];
  let list = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('[') || s.startsWith('{')) {
      const j = JSON.parse(s);
      list = Array.isArray(j) ? j : j.freezes || [];
    } else {
      // "8.4:1.2" = freeze at 8.4s for 1.2s
      list = s.split(',').map(part => {
        const m = /^(\d*\.?\d+)\s*:\s*(\d*\.?\d+)$/.exec(part.trim());
        if (!m) throw usageError(`Could not parse freeze "${part}"`, 'Use TIMESTAMP:DURATION, e.g. "8.4:1.2".');
        return { timestamp: Number(m[1]), duration: Number(m[2]) };
      });
    }
  }
  if (!Array.isArray(list)) list = [list];
  return list.map((f, i) => {
    const timestamp = Number(f.timestamp ?? f.at ?? f.start);
    const duration = Number(f.duration ?? f.hold);
    if (!Number.isFinite(timestamp) || timestamp < 0) throw usageError(`freezes[${i}]: invalid timestamp`);
    if (!Number.isFinite(duration) || duration <= 0) throw usageError(`freezes[${i}]: duration must be positive`);
    if (duration > 30) throw usageError(`freezes[${i}]: a ${duration}s freeze is almost certainly a mistake`);
    return { timestamp, duration, reason: f.reason };
  }).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * @param {string} input
 * @param {{freezes?:*, plan?:string, audio?:string, out?:string, quality?:string, hw?:string}} opts
 */
export async function freezeFrame(input, opts = {}) {
  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) throw inputError(`${relToRoot(abs)} has no video track`);

  const audioMode = opts.audio || 'silence';
  if (!AUDIO_MODES.includes(audioMode)) {
    throw usageError(`Unknown audio mode "${audioMode}"`, `Use: ${AUDIO_MODES.join(', ')}`);
  }

  let raw = opts.freezes;
  if (opts.plan) {
    const plan = JSON.parse(fs.readFileSync(resolveInput(opts.plan, 'plan'), 'utf8'));
    raw = raw ?? plan.freezes;
  }

  const freezes = parseFreezes(raw);
  if (!freezes.length) throw usageError('No freezes given', 'Use --freezes "8.4:1.2" or --plan plan.json');

  for (const [i, f] of freezes.entries()) {
    if (f.timestamp >= meta.duration) {
      throw usageError(`freezes[${i}]: ${f.timestamp}s is beyond the ${meta.duration}s source`);
    }
    // parseFreezes already sorts, so out-of-order input is accepted and
    // normalised. What is genuinely ambiguous is two freezes at the same
    // instant, which cannot both be honoured.
    if (i > 0 && Math.abs(f.timestamp - freezes[i - 1].timestamp) < 1e-6) {
      throw usageError(`two freezes both requested at ${f.timestamp}s`);
    }
  }

  const fps = meta.fps || 30;
  const frameDur = 1 / fps;
  const hasAudio = meta.hasAudio && audioMode !== 'continue';

  // Build alternating segments: video up to the freeze, the held frame,
  // video after it, and so on.
  const parts = [];
  const vLabels = [];
  const aLabels = [];
  let cursor = 0;

  freezes.forEach((f, i) => {
    const segIn = `[0:v]trim=start=${cursor}:end=${f.timestamp},setpts=PTS-STARTPTS[v${i}a]`;
    parts.push(segIn);
    vLabels.push(`[v${i}a]`);

    // A single frame, looped for the hold. `loop` counts FRAMES, so the frame
    // count is the hold duration times the frame rate.
    const frames = Math.max(1, Math.round(f.duration * fps));
    parts.push(
      `[0:v]trim=start=${f.timestamp}:end=${(f.timestamp + frameDur * 1.5).toFixed(5)},setpts=PTS-STARTPTS,` +
      `loop=loop=${frames}:size=1:start=0,setpts=N/${fps}/TB,trim=end=${f.duration}[v${i}f]`
    );
    vLabels.push(`[v${i}f]`);

    if (hasAudio) {
      parts.push(`[0:a]atrim=start=${cursor}:end=${f.timestamp},asetpts=PTS-STARTPTS[a${i}a]`);
      aLabels.push(`[a${i}a]`);
      if (audioMode === 'silence') {
        parts.push(`anullsrc=r=48000:cl=stereo,atrim=end=${f.duration},asetpts=PTS-STARTPTS[a${i}f]`);
      } else {
        // 'hold': repeat a slice of audio. Included for completeness; it
        // usually sounds worse than silence.
        parts.push(
          `[0:a]atrim=start=${f.timestamp}:end=${(f.timestamp + 0.05).toFixed(3)},asetpts=PTS-STARTPTS,` +
          `aloop=loop=-1:size=2400,atrim=end=${f.duration},asetpts=PTS-STARTPTS,volume=0.3[a${i}f]`
        );
      }
      aLabels.push(`[a${i}f]`);
    }
    cursor = f.timestamp;
  });

  parts.push(`[0:v]trim=start=${cursor},setpts=PTS-STARTPTS[vlast]`);
  vLabels.push('[vlast]');
  if (hasAudio) {
    parts.push(`[0:a]atrim=start=${cursor},asetpts=PTS-STARTPTS[alast]`);
    aLabels.push('[alast]');
  }

  parts.push(`${vLabels.join('')}concat=n=${vLabels.length}:v=1:a=0[vout]`);
  if (hasAudio) parts.push(`${aLabels.join('')}concat=n=${aLabels.length}:v=0:a=1[aout]`);

  const totalHold = freezes.reduce((s, f) => s + f.duration, 0);
  const expected = meta.duration + totalHold;

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-freeze.mp4`));
  const { args: enc } = await encodeArgs({ quality: opts.quality || 'final', hw: opts.hw || 'auto' });

  log.info(`${freezes.length} freeze(s), holding ${totalHold.toFixed(2)}s (audio: ${audioMode})`);

  const args = [
    '-y', '-i', abs,
    '-filter_complex', parts.join(';'),
    '-map', '[vout]',
  ];
  if (hasAudio) args.push('-map', '[aout]');
  else if (meta.hasAudio && audioMode === 'continue') args.push('-map', '0:a');
  else args.push('-an');
  args.push(...stripVf(enc), out);

  await ffmpeg(args, { label: 'freeze-frame', totalSec: expected });

  const got = await probeVideo(out);
  const tolerance = Math.max(0.3, expected * 0.03);
  if (audioMode !== 'continue' && Math.abs(got.duration - expected) > tolerance) {
    throw validationError(
      `freeze produced ${got.duration}s, expected ${expected.toFixed(2)}s`,
      { sourceDuration: meta.duration, totalHold }
    );
  }

  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    freezes: freezes.map(f => ({ timestamp: f.timestamp, duration: f.duration, reason: f.reason })),
    freezeCount: freezes.length,
    audioMode,
    totalHold: round(totalHold),
    sourceDuration: meta.duration,
    expectedDuration: round(expected),
    duration: got.duration,
    width: got.width,
    height: got.height,
    hasAudio: got.hasAudio,
    sizeBytes: got.sizeBytes,
  };
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
  name: 'freeze-frame',
  summary: 'Hold a frame for a moment, extending the video.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    freezes: { type: 'string', help: '"8.4:1.2" (at:duration), or a JSON array' },
    plan: { type: 'string', help: 'JSON file containing {freezes:[...]}' },
    audio: { type: 'enum', values: AUDIO_MODES, default: 'silence', help: 'What the audio does during the hold' },
    out: { type: 'string', help: 'Output path' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've freeze-frame raw/test.mp4 --freezes "8.4:1.2"',
    've freeze-frame raw/test.mp4 --freezes "3:0.6,11:1.5" --audio silence',
  ],
  run: opts => freezeFrame(opts.input, opts),
  pretty: r => `${r.freezeCount} freeze(s), +${r.totalHold}s  ` +
    `${r.sourceDuration}s -> ${r.duration}s -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
