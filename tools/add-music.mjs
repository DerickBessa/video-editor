// add-music — lay a music bed under the voice, and get out of its way.
//
// The brief is unambiguous: music must never compete with speech. So ducking
// is ON by default and implemented properly, with the VOICE as the sidechain
// key, not with a static volume guess:
//
//   [music][voice] sidechaincompress
//
// Static-volume music is the common shortcut and it is wrong in both
// directions — inaudible under loud passages, and covering the quiet ones.
// `duck-music` exists as its own tool for footage that already has a music bed
// mixed in at the wrong level.
//
// Music is also looped or trimmed to the video, faded in and out, and
// (optionally) high-passed so it sits under the voice rather than in front of
// it.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { run } from '../lib/proc.mjs';
import { FFMPEG } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { inputError, usageError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

export const MUSIC_DIR = () => path.join(DIR.assets, 'music');

export function listMusic() {
  const dir = MUSIC_DIR();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /\.(wav|mp3|flac|m4a|ogg|aac)$/i.test(f)).sort();
}

/** Ducking presets, as (threshold, ratio, release) triples. */
export const DUCK = {
  gentle: { threshold: 0.06, ratio: 4, attack: 20, release: 400 },
  normal: { threshold: 0.04, ratio: 8, attack: 12, release: 300 },
  hard: { threshold: 0.02, ratio: 14, attack: 5, release: 200 },
};

async function meanLevel(file, extra = []) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', ...extra, '-i', file,
    '-af', 'volumedetect', '-vn', '-f', 'null', '-',
  ], { timeoutMs: 600000 });
  const m = /mean_volume:\s*(-?[\d.]+)/.exec(stderr);
  return m ? Number(m[1]) : null;
}

/**
 * @param {string} input
 * @param {{music?:string, volume?:number, duck?:boolean, duckStrength?:string,
 *          fadeIn?:number, fadeOut?:number, highpass?:number, start?:number, out?:string}} opts
 */
export async function addMusic(input, opts = {}) {
  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);

  if (!opts.music) {
    const available = listMusic();
    throw usageError('No music track given',
      available.length
        ? `Use --music with one of: ${available.map(f => f.replace(/\.\w+$/, '')).join(', ')}`
        : `Put a track in ${relToRoot(MUSIC_DIR())}/ and pass --music <name>.`);
  }

  const musicFile = resolveMusic(opts.music);
  const musicMeta = await probeVideo(musicFile);
  if (!musicMeta.hasAudio) throw inputError(`${relToRoot(musicFile)} has no audio`);

  const volume = opts.volume ?? 0.12;         // music beds live around -18 dB
  const duck = opts.duck !== false && meta.hasAudio;
  const duckPreset = DUCK[opts.duckStrength || 'normal'] || DUCK.normal;
  const fadeIn = opts.fadeIn ?? 1.5;
  const fadeOut = opts.fadeOut ?? 2.5;
  const highpass = opts.highpass ?? 0;
  const start = opts.start ?? 0;

  if (volume < 0 || volume > 2) throw usageError(`--volume ${volume} is outside 0..2`);
  if (start >= meta.duration) throw usageError(`--start ${start}s is beyond the ${meta.duration}s video`);

  const musicDuration = meta.duration - start;
  const fadeOutStart = Math.max(0, musicDuration - fadeOut);

  const parts = [];
  // -stream_loop on the input handles a track shorter than the video; atrim
  // caps a longer one. Together they always yield exactly the right length.
  const musicChain = [
    `atrim=0:${musicDuration.toFixed(3)}`,
    'asetpts=N/SR/TB',
    ...(highpass > 0 ? [`highpass=f=${highpass}`] : []),
    `volume=${volume.toFixed(3)}`,
    ...(fadeIn > 0 ? [`afade=t=in:st=0:d=${fadeIn}`] : []),
    ...(fadeOut > 0 ? [`afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut}`] : []),
    ...(start > 0 ? [`adelay=${Math.round(start * 1000)}:all=1`] : []),
    'aresample=48000',
  ].join(',');
  parts.push(`[1:a]${musicChain}[music]`);

  let audioLabel;
  if (!meta.hasAudio) {
    parts.push(`[music]apad=whole_dur=${meta.duration.toFixed(3)},atrim=end=${meta.duration.toFixed(3)}[aout]`);
    audioLabel = '[aout]';
  } else {
    if (duck) {
      // Split only when ducking actually needs a second copy. Producing an
      // unused label is not harmless: ffmpeg refuses the whole graph with
      // "Filter 'anull:default' has output 0 (unused) unconnected".
      parts.push(`[0:a]aresample=48000,asplit=2[voice][key]`);
      // The VOICE is the key; the MUSIC is what gets compressed.
      parts.push(
        `[music][key]sidechaincompress=threshold=${duckPreset.threshold}:ratio=${duckPreset.ratio}` +
        `:attack=${duckPreset.attack}:release=${duckPreset.release}:makeup=1[ducked]`
      );
      parts.push(`[voice][ducked]amix=inputs=2:normalize=0:dropout_transition=0[amixed]`);
    } else {
      parts.push(`[0:a]aresample=48000[voice]`);
      parts.push(`[voice][music]amix=inputs=2:normalize=0:dropout_transition=0[amixed]`);
    }
    parts.push(`[amixed]apad=whole_dur=${meta.duration.toFixed(3)},atrim=end=${meta.duration.toFixed(3)},asetpts=N/SR/TB[aout]`);
    audioLabel = '[aout]';
  }

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-music.mp4`));

  log.info(`music: ${path.basename(musicFile)} at ${volume}${duck ? `, ducked (${opts.duckStrength || 'normal'})` : ', NOT ducked'}`);

  await ffmpeg([
    '-y', '-i', abs,
    '-stream_loop', '-1', '-i', musicFile,
    '-filter_complex', parts.join(';'),
    '-map', '0:v', '-c:v', 'copy',
    '-map', audioLabel, '-c:a', 'aac', '-b:a', opts.bitrate || '192k',
    ...(audioLabel !== '[aout]' ? [] : []),
    '-t', String(meta.duration),
    out,
  ], { label: 'add-music', totalSec: meta.duration });

  const got = await probeVideo(out);
  if (!got.hasAudio) throw validationError('add-music produced a file with no audio');
  if (Math.abs(got.duration - meta.duration) > 0.4) {
    throw validationError(`add-music changed the duration: ${got.duration}s vs ${meta.duration}s`);
  }

  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    music: relToRoot(musicFile),
    musicDuration: musicMeta.duration,
    looped: musicMeta.duration < musicDuration,
    volume,
    ducked: duck,
    duckStrength: duck ? (opts.duckStrength || 'normal') : null,
    fadeIn,
    fadeOut,
    highpass,
    start,
    duration: got.duration,
    hasAudio: got.hasAudio,
    sizeBytes: got.sizeBytes,
  };
}

function resolveMusic(name) {
  if (name.includes('/') || name.includes('\\')) return resolveInput(name, 'music');
  const dir = MUSIC_DIR();
  const available = listMusic();
  const withExt = /\.\w+$/.test(name) ? name : null;

  if (withExt) {
    const p = path.join(dir, withExt);
    if (fs.existsSync(p)) return p;
  } else {
    const hit = available.find(f => f.replace(/\.\w+$/, '').toLowerCase() === name.toLowerCase());
    if (hit) return path.join(dir, hit);
  }
  throw inputError(`music "${name}" not found in ${relToRoot(dir)}`,
    available.length
      ? `Available: ${available.map(f => f.replace(/\.\w+$/, '')).join(', ')}`
      : 'The music folder is empty. Add a .wav or .mp3 there first.');
}

export const tool = {
  name: 'add-music',
  summary: 'Lay a music bed under the video, ducked under speech by default.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    music: { type: 'string', help: 'Track name from assets/music/, or a path' },
    volume: { type: 'number', default: 0.12, help: 'Music level, 0..2' },
    duck: { type: 'bool', default: true, help: 'Duck the music under speech (sidechained to the voice)' },
    duckStrength: { type: 'enum', values: Object.keys(DUCK), default: 'normal', help: 'How far the music drops' },
    fadeIn: { type: 'number', default: 1.5, help: 'Fade-in seconds' },
    fadeOut: { type: 'number', default: 2.5, help: 'Fade-out seconds' },
    highpass: { type: 'number', default: 0, help: 'High-pass the music so it sits under the voice' },
    start: { type: 'number', default: 0, help: 'Delay the music by this many seconds' },
    bitrate: { type: 'string', default: '192k', help: 'Output AAC bitrate' },
    out: { type: 'string', help: 'Output path' },
  },
  examples: [
    've add-music raw/test.mp4 --music lofi',
    've add-music raw/test.mp4 --music lofi --volume 0.08 --duck-strength hard',
    've add-music raw/test.mp4 --music assets/music/bed.wav --no-duck',
  ],
  run: opts => addMusic(opts.input, opts),
  pretty: r => `${path.basename(r.music)} at ${r.volume}` +
    `${r.ducked ? ` (ducked: ${r.duckStrength})` : ' (NOT ducked)'}` +
    `${r.looped ? ', looped' : ''} -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
