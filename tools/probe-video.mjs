// probe-video — normalise ffprobe's sprawling output into the one flat shape
// every other tool in this project consumes.
//
// Note on width/height: these are DISPLAY dimensions, i.e. rotation already
// applied. Phone footage is routinely stored as 1920x1080 with rotation=-90;
// downstream crop/scale/caption maths must see 1080x1920 or it silently
// produces sideways video. Coded dimensions stay available as codedWidth/Height.
import { ffprobeJson } from '../lib/ffmpeg.mjs';
import { resolveInput, relToRoot } from '../lib/paths.mjs';
import { inputError } from '../lib/errors.mjs';
import { runIfMain } from '../lib/cli.mjs';

/** "30000/1001" -> 29.97 ; "0/0" -> null */
export function parseRate(r) {
  if (!r || typeof r !== 'string') return null;
  const [n, d] = r.split('/').map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n === 0) return null;
  return Math.round((n / d) * 1000) / 1000;
}

/** Rotation in degrees, normalised to 0/90/180/270. */
export function parseRotation(stream) {
  const side = stream?.side_data_list?.find(s => s.rotation !== undefined)?.rotation;
  const tag = stream?.tags?.rotate;
  const raw = Number(side ?? tag ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return ((Math.round(raw) % 360) + 360) % 360;
}

export async function probeVideo(file) {
  const abs = resolveInput(file, 'video');
  const j = await ffprobeJson(abs);

  const streams = j.streams || [];
  const v = streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = streams.find(s => s.codec_type === 'audio');

  if (!v && !a) {
    throw inputError(`No audio or video streams found in ${relToRoot(abs)}`,
      'ffprobe read the file but it contains no decodable media streams.');
  }

  const rotation = v ? parseRotation(v) : 0;
  const swapped = rotation === 90 || rotation === 270;
  const codedWidth = v ? Number(v.width) || 0 : 0;
  const codedHeight = v ? Number(v.height) || 0 : 0;

  const fps = v ? (parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate) ?? 0) : 0;
  const duration = Number(j.format?.duration)
    || Number(v?.duration) || Number(a?.duration) || 0;

  return {
    file: relToRoot(abs),
    path: abs,

    duration: round(duration, 3),
    width: swapped ? codedHeight : codedWidth,
    height: swapped ? codedWidth : codedHeight,
    fps,
    codec: v?.codec_name || '',
    audioCodec: a?.codec_name || '',
    sampleRate: a ? Number(a.sample_rate) || 0 : 0,
    channels: a ? Number(a.channels) || 0 : 0,
    bitrate: Number(j.format?.bit_rate) || 0,

    // Extras the editing layers need.
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    rotation,
    codedWidth,
    codedHeight,
    aspect: codedWidth && codedHeight
      ? round((swapped ? codedHeight / codedWidth : codedWidth / codedHeight), 4)
      : 0,
    orientation: orientationOf(swapped ? codedHeight : codedWidth, swapped ? codedWidth : codedHeight),
    pixFmt: v?.pix_fmt || '',
    profile: v?.profile || '',
    frames: Number(v?.nb_frames) || (fps && duration ? Math.round(fps * duration) : 0),
    videoBitrate: Number(v?.bit_rate) || 0,
    audioBitrate: Number(a?.bit_rate) || 0,
    container: j.format?.format_name || '',
    sizeBytes: Number(j.format?.size) || 0,
    streamCount: streams.length,
  };
}

function orientationOf(w, h) {
  if (!w || !h) return 'unknown';
  if (w === h) return 'square';
  return w > h ? 'landscape' : 'portrait';
}

const round = (n, p) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : 0);

export const tool = {
  name: 'probe-video',
  summary: 'Read technical metadata from a media file (duration, size, fps, codecs).',
  args: {
    input: { positional: 0, required: true, help: 'Path to the video or audio file' },
  },
  examples: [
    've probe-video raw/test.mp4',
    've probe-video raw/test.mp4 | jq .duration',
  ],
  run: opts => probeVideo(opts.input),
  pretty: r => `${r.file}  ${r.width}x${r.height} @${r.fps}fps  ${r.duration}s  ` +
    `${r.codec || 'no-video'}/${r.audioCodec || 'no-audio'}  ${(r.sizeBytes / 1048576).toFixed(1)}MB`,
};

runIfMain(tool, import.meta.url);
