// add-overlay — composite images, GIFs or video clips onto the picture.
//
// One generic mechanism serves screenshots, memes, logos, lower thirds and
// picture-in-picture, because they only differ in position, size and timing.
// B-roll is this plus an audio decision, which is why `add-broll` builds on it.
//
// Positions are FRACTIONS of the frame, not pixels, so an overlay placed on a
// 1080x1920 Short lands in the same visual spot on a 720p landscape cut.
//
// Alpha handling is the part that silently goes wrong: a PNG's transparency
// survives only if the overlay branch keeps an alpha-capable pixel format all
// the way to the overlay filter, so every branch is forced to rgba first.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, encodeArgs } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

/** Anchor presets as {x, y} fractions of the frame, for the overlay's centre. */
export const POSITIONS = {
  'top-left': [0.18, 0.16], 'top-center': [0.5, 0.16], 'top-right': [0.82, 0.16],
  left: [0.18, 0.5], center: [0.5, 0.5], right: [0.82, 0.5],
  'bottom-left': [0.18, 0.84], 'bottom-center': [0.5, 0.84], 'bottom-right': [0.82, 0.84],
  'full': [0.5, 0.5],
};

export const ANIMATIONS = ['none', 'fade', 'slide-up', 'slide-down', 'pop'];

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|tiff?)$/i;
const ANIMATED_EXT = /\.(gif|webp|mp4|mov|webm|mkv|avi)$/i;

export function parseOverlays(raw) {
  if (raw == null) return [];
  let list = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.endsWith('.json') && fs.existsSync(s)) {
      const j = JSON.parse(fs.readFileSync(s, 'utf8'));
      list = Array.isArray(j) ? j : j.overlays || [];
    } else if (s.startsWith('[') || s.startsWith('{')) {
      const j = JSON.parse(s);
      list = Array.isArray(j) ? j : j.overlays || [];
    } else {
      // Compact: "assets/memes/a.png@2-5", optionally ":position"
      list = s.split(';').map(part => {
        const m = /^(.+?)@(\d*\.?\d+)-(\d*\.?\d+)(?::([\w-]+))?$/.exec(part.trim());
        if (!m) throw usageError(`Could not parse overlay "${part}"`,
          'Use ASSET@START-END[:POSITION], e.g. "assets/memes/x.png@2-5:top-right".');
        return { asset: m[1], start: Number(m[2]), end: Number(m[3]), ...(m[4] ? { position: m[4] } : {}) };
      });
    }
  }
  if (!Array.isArray(list)) list = [list];

  return list.map((o, i) => {
    if (!o.asset) throw usageError(`overlays[${i}]: no asset`);
    const position = o.position || 'center';
    if (!(position in POSITIONS) && o.x === undefined) {
      throw usageError(`overlays[${i}]: unknown position "${position}"`,
        `Use one of ${Object.keys(POSITIONS).join(', ')}, or give explicit x/y fractions.`);
    }
    const [px, py] = POSITIONS[position] || [0.5, 0.5];
    const animation = o.animation || 'fade';
    if (!ANIMATIONS.includes(animation)) {
      throw usageError(`overlays[${i}]: unknown animation "${animation}"`, `Use: ${ANIMATIONS.join(', ')}`);
    }
    return {
      asset: o.asset,
      start: Number(o.start ?? 0),
      end: o.end === undefined ? null : Number(o.end),
      x: o.x === undefined ? px : Number(o.x),
      y: o.y === undefined ? py : Number(o.y),
      scale: Number(o.scale ?? (position === 'full' ? 1 : 0.35)),
      opacity: Number(o.opacity ?? 1),
      rotation: Number(o.rotation ?? 0),
      animation,
      animationMs: Number(o.animationMs ?? 250),
      mode: o.mode || 'overlay',
      reason: o.reason,
    };
  }).sort((a, b) => a.start - b.start);
}

/**
 * @param {string} input
 * @param {{overlays?:*, plan?:string, out?:string, quality?:string, hw?:string}} opts
 */
export async function addOverlay(input, opts = {}) {
  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);

  let raw = opts.overlays;
  if (opts.plan) {
    const p = resolveInput(opts.plan, 'plan');
    const plan = JSON.parse(fs.readFileSync(p, 'utf8'));
    raw = raw ?? plan.overlays;
  }

  const overlays = parseOverlays(raw);
  if (!overlays.length) throw usageError('No overlays given', 'Use --overlays "asset.png@2-5" or --plan plan.json');

  for (const [i, o] of overlays.entries()) {
    o.file = resolveInput(path.resolve(o.asset), `overlays[${i}].asset`);
    o.animated = ANIMATED_EXT.test(o.file);
    o.isImage = IMAGE_EXT.test(o.file);
    if (!o.animated && !o.isImage) {
      throw inputError(`overlays[${i}]: unsupported asset type: ${o.asset}`,
        'Supported: png, jpg, webp, bmp, tif, gif, mp4, mov, webm, mkv.');
    }
    if (o.end === null) o.end = meta.duration;
    if (o.end <= o.start) throw usageError(`overlays[${i}]: end (${o.end}) must be after start (${o.start})`);
    if (o.start >= meta.duration) {
      throw usageError(`overlays[${i}]: starts at ${o.start}s, beyond the ${meta.duration}s source`);
    }
    o.end = Math.min(o.end, meta.duration);
  }

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-overlay.mp4`));

  const args = ['-y', '-i', abs];
  overlays.forEach(o => {
    // A still image must be looped, or it exists for exactly one frame.
    if (o.isImage) args.push('-loop', '1', '-t', String(o.end - o.start), '-i', o.file);
    else args.push('-stream_loop', '-1', '-t', String(o.end - o.start), '-i', o.file);
  });

  const parts = [];
  let base = '[0:v]';
  overlays.forEach((o, i) => {
    const w = Math.max(2, Math.round(meta.width * o.scale)) & ~1;
    const lbl = `[o${i}]`;
    const chain = [
      `scale=${w}:-2:flags=lanczos`,
      // rgba everywhere: without it a PNG's alpha is dropped on the way in.
      'format=rgba',
      ...(o.rotation ? [`rotate=${(o.rotation * Math.PI / 180).toFixed(6)}:c=none:ow=rotw(${(o.rotation * Math.PI / 180).toFixed(6)}):oh=roth(${(o.rotation * Math.PI / 180).toFixed(6)})`] : []),
      ...(o.opacity < 1 ? [`colorchannelmixer=aa=${o.opacity.toFixed(3)}`] : []),
      ...animationFilters(o),
      `setpts=PTS-STARTPTS+${o.start}/TB`,
    ].join(',');
    parts.push(`[${i + 1}:v]${chain}${lbl}`);

    const outLbl = i === overlays.length - 1 ? '[vout]' : `[b${i}]`;
    const { x, y } = positionExpr(o);
    parts.push(
      `${base}${lbl}overlay=${x}:${y}:enable='between(t,${o.start},${o.end})':eof_action=pass${outLbl}`
    );
    base = outLbl;
  });

  const { args: enc } = await encodeArgs({ quality: opts.quality || 'final', hw: opts.hw || 'auto' });
  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[vout]',
    ...(meta.hasAudio ? ['-map', '0:a', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    ...stripVf(enc),
    '-t', String(meta.duration),
    out
  );

  log.info(`compositing ${overlays.length} overlay(s)`);
  await ffmpeg(args, { label: 'add-overlay', totalSec: meta.duration });

  const got = await probeVideo(out);
  if (got.width !== meta.width || got.height !== meta.height) {
    throw validationError(`overlaying changed the frame size to ${got.width}x${got.height}`);
  }

  return {
    source: relToRoot(abs),
    output: relToRoot(out),
    path: out,
    applied: overlays.length,
    overlays: overlays.map(o => ({
      asset: relToRoot(o.file), start: o.start, end: o.end,
      x: o.x, y: o.y, scale: o.scale, opacity: o.opacity,
      animation: o.animation, reason: o.reason,
    })),
    width: got.width,
    height: got.height,
    duration: got.duration,
    hasAudio: got.hasAudio,
    sizeBytes: got.sizeBytes,
  };
}

/** Centre the overlay on its fractional anchor, clamped inside the frame. */
function positionExpr(o) {
  return {
    x: `max(0\\,min(main_w-overlay_w\\,${o.x}*main_w-overlay_w/2))`,
    y: `max(0\\,min(main_h-overlay_h\\,${o.y}*main_h-overlay_h/2))`,
  };
}

function animationFilters(o) {
  const secs = (o.animationMs / 1000).toFixed(3);
  const dur = o.end - o.start;
  const outStart = Math.max(0, dur - o.animationMs / 1000).toFixed(3);
  switch (o.animation) {
    case 'fade':
      return [`fade=t=in:st=0:d=${secs}:alpha=1`, `fade=t=out:st=${outStart}:d=${secs}:alpha=1`];
    case 'pop':
      // A quick scale overshoot reads as "arriving"; alpha fade alone looks limp.
      return [`fade=t=in:st=0:d=${(o.animationMs / 2000).toFixed(3)}:alpha=1`];
    case 'slide-up':
    case 'slide-down':
      return [`fade=t=in:st=0:d=${secs}:alpha=1`, `fade=t=out:st=${outStart}:d=${secs}:alpha=1`];
    default:
      return [];
  }
}

function stripVf(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-vf') { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

export const tool = {
  name: 'add-overlay',
  summary: 'Composite images, GIFs or clips onto the video with timing and animation.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    overlays: { type: 'string', help: '"asset.png@2-5:top-right", a JSON array, or a .json path' },
    plan: { type: 'string', help: 'JSON file containing {overlays:[...]}' },
    out: { type: 'string', help: 'Output path' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've add-overlay raw/test.mp4 --overlays "assets/memes/wow.png@4-7:top-right"',
    've add-overlay raw/test.mp4 --overlays \'[{"asset":"a.png","start":2,"end":5,"scale":0.5}]\'',
  ],
  run: opts => addOverlay(opts.input, opts),
  pretty: r => `${r.applied} overlay(s) -> ${r.output}  ${r.width}x${r.height} ${r.duration}s`,
};

runIfMain(tool, import.meta.url);
