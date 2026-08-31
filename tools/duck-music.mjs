// duck-music — push one audio track down whenever another one is speaking.
//
// SCOPE, stated honestly: this ducks a SEPARATE track against a voice. It
// cannot duck music that is already mixed into a single audio track, because
// separating them again is source separation, not mixing — no amount of
// compression can do it. Attempting it would duck the voice along with the
// music, which is exactly backwards.
//
// So there are two real inputs:
//   --under <file>     a music/ambience file to place under the video's audio
//   --stream <n>       a second audio STREAM inside the video (common when a
//                      timeline was exported with voice and music separate)
//
// `add-music` is the convenience wrapper that adds a bed AND ducks it in one
// step. This tool is the primitive, for when the bed already exists.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, ffprobeJson } from '../lib/ffmpeg.mjs';
import { run } from '../lib/proc.mjs';
import { FFMPEG } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { DUCK } from './add-music.mjs';

async function levelAt(file, at, dur = 0.8) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-t', String(dur),
    '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-',
  ], { timeoutMs: 300000 });
  const m = /mean_volume:\s*(-?[\d.]+)/.exec(stderr);
  return m ? Number(m[1]) : null;
}

/**
 * @param {string} input
 * @param {{under?:string, stream?:number, strength?:string, musicVolume?:number,
 *          out?:string}} opts
 */
export async function duckMusic(input, opts = {}) {
  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasAudio) throw inputError(`${relToRoot(abs)} has no audio to use as the voice reference`);

  const preset = DUCK[opts.strength || 'normal'] || DUCK.normal;
  const musicVolume = opts.musicVolume ?? 1.0;

  const probe = await ffprobeJson(abs);
  const audioStreams = (probe.streams || []).filter(s => s.codec_type === 'audio');

  let musicSource;
  let inputs;
  let musicRef;

  if (opts.under) {
    const musicFile = resolveInput(opts.under, 'music');
    const musicMeta = await probeVideo(musicFile);
    if (!musicMeta.hasAudio) throw inputError(`${relToRoot(musicFile)} has no audio`);
    musicSource = { kind: 'file', file: relToRoot(musicFile), duration: musicMeta.duration };
    inputs = ['-i', abs, '-stream_loop', '-1', '-i', musicFile];
    musicRef = '[1:a]';
  } else if (opts.stream !== undefined) {
    const n = Number(opts.stream);
    if (!Number.isFinite(n) || n < 1 || n >= audioStreams.length) {
      throw usageError(
        `--stream ${opts.stream} is not a second audio stream in this file`,
        `It has ${audioStreams.length} audio stream(s); stream 0 is the voice, so use 1..${audioStreams.length - 1}.`
      );
    }
    musicSource = { kind: 'stream', index: n, of: audioStreams.length };
    inputs = ['-i', abs];
    musicRef = `[0:a:${n}]`;
  } else {
    throw usageError(
      'Nothing to duck',
      audioStreams.length > 1
        ? `This file has ${audioStreams.length} audio streams — try --stream 1.`
        : 'Give --under <music file>. Music already mixed into a single track cannot be separated out again.'
    );
  }

  const voiceRef = opts.under ? '[0:a]' : '[0:a:0]';

  const parts = [
    `${voiceRef}aresample=48000,asplit=2[voice][key]`,
    `${musicRef}aresample=48000,volume=${musicVolume.toFixed(3)},` +
      `atrim=end=${meta.duration.toFixed(3)},asetpts=N/SR/TB[music]`,
    // Voice is the KEY, music is what gets compressed. Never the reverse.
    `[music][key]sidechaincompress=threshold=${preset.threshold}:ratio=${preset.ratio}` +
      `:attack=${preset.attack}:release=${preset.release}:makeup=1[ducked]`,
    `[voice][ducked]amix=inputs=2:normalize=0:dropout_transition=0[amixed]`,
    `[amixed]apad=whole_dur=${meta.duration.toFixed(3)},atrim=end=${meta.duration.toFixed(3)},asetpts=N/SR/TB[aout]`,
  ];

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-ducked.mp4`));

  log.info(`ducking ${musicSource.kind === 'file' ? path.basename(musicSource.file) : `stream ${musicSource.index}`} ` +
    `under the voice (${opts.strength || 'normal'})`);

  await ffmpeg([
    '-y', ...inputs,
    '-filter_complex', parts.join(';'),
    ...(meta.hasVideo ? ['-map', '0:v', '-c:v', 'copy'] : []),
    '-map', '[aout]', '-c:a', 'aac', '-b:a', opts.bitrate || '192k',
    '-t', String(meta.duration),
    out,
  ], { label: 'duck-music', totalSec: meta.duration });

  const got = await probeVideo(out);
  if (!got.hasAudio) throw validationError('duck-music produced a file with no audio');
  if (Math.abs(got.duration - meta.duration) > 0.4) {
    throw validationError(`duck-music changed the duration: ${got.duration}s vs ${meta.duration}s`);
  }

  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    music: musicSource,
    strength: opts.strength || 'normal',
    settings: preset,
    musicVolume,
    duration: got.duration,
    hasAudio: got.hasAudio,
    hasVideo: got.hasVideo,
    sizeBytes: got.sizeBytes,
  };
}

export const tool = {
  name: 'duck-music',
  summary: 'Duck a separate music track under the voice (sidechained to speech).',
  args: {
    input: { positional: 0, required: true, help: 'Video whose first audio stream is the voice' },
    under: { type: 'string', help: 'Music/ambience file to place under the voice' },
    stream: { type: 'number', help: 'Index of a second audio stream in the video to duck' },
    strength: { type: 'enum', values: Object.keys(DUCK), default: 'normal', help: 'How far the music drops' },
    musicVolume: { type: 'number', default: 1.0, help: 'Gain applied to the music before ducking' },
    bitrate: { type: 'string', default: '192k', help: 'Output AAC bitrate' },
    out: { type: 'string', help: 'Output path' },
  },
  examples: [
    've duck-music output/edit.mp4 --under assets/music/bed.wav',
    've duck-music raw/timeline.mp4 --stream 1 --strength hard',
  ],
  run: opts => duckMusic(opts.input, opts),
  pretty: r => `ducked ${r.music.kind === 'file' ? path.basename(r.music.file) : `stream ${r.music.index}`} ` +
    `(${r.strength}) -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
