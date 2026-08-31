// extract-frames — pull still frames out of a video, deliberately sparsely.
//
// Modes:
//   interval   every N seconds                     (one decode pass, fps filter)
//   timestamp  an explicit list of times           (fast seek per frame)
//   scene      one frame per detected shot         (needs detect-scenes)
//   smart      scene frames, topped up to an even  (the default for "show me
//              spread, deduplicated and capped      this video")
//
// The brief is explicit: never emit thousands of images without need. A hard
// `--max` cap applies to EVERY mode, and the default output width is small,
// because these frames exist to be looked at (by a human or a vision model),
// not archived.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { resolveInput, relToRoot, slug, DIR, ensureDir, assertNotRaw } from '../lib/paths.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { detectScenes } from './detect-scenes.mjs';

export const MODES = ['interval', 'timestamp', 'scene', 'smart'];

/**
 * @param {string} input
 * @param {{mode?:string, interval?:number, timestamps?:number[]|string, max?:number,
 *          width?:number, format?:'jpg'|'png', outDir?:string, quality?:number,
 *          threshold?:number, force?:boolean}} opts
 */
export async function extractFrames(input, opts = {}) {
  const {
    mode = 'smart',
    interval = 5,
    max = 24,
    width = 640,
    format = 'jpg',
    quality = 3,
    force = false,
  } = opts;

  if (!MODES.includes(mode)) throw usageError(`Unknown mode "${mode}"`, `Use one of: ${MODES.join(', ')}`);

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) throw inputError(`${relToRoot(abs)} has no video track`);

  const dir = ensureDir(assertNotRaw(opts.outDir || path.join(DIR.frames, slug(abs))));
  if (force) for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });

  let timestamps;
  let sceneInfo = null;

  if (mode === 'interval') {
    timestamps = evenlySpaced(meta.duration, interval);
  } else if (mode === 'timestamp') {
    timestamps = parseTimestamps(opts.timestamps, meta.duration);
  } else {
    sceneInfo = await detectScenes(abs, { threshold: opts.threshold ?? 10 });
    // Sample INSIDE each shot, not on the boundary: a frame taken exactly at a
    // cut is often a blend or the last frame of the outgoing shot.
    timestamps = sceneInfo.scenes.map(s => s.start + Math.min(0.5, s.duration * 0.35));
    if (mode === 'smart') timestamps = topUp(timestamps, meta.duration, max);
    // Only these modes SYNTHESISE times from two sources, so only they can
    // produce near-duplicates. Deduping a user-supplied interval or timestamp
    // list would silently ignore what was actually asked for.
    timestamps = dedupe(timestamps.sort((a, b) => a - b), 0.25);
  }

  timestamps = timestamps.filter(t => t >= 0 && t < meta.duration).sort((a, b) => a - b);

  const trimmed = timestamps.length > max;
  if (trimmed) {
    timestamps = evenSubset(timestamps, max);
    log.warn(`capped to ${max} frames (use --max to raise it)`);
  }
  if (!timestamps.length) throw validationError('no frames selected', { mode, duration: meta.duration });

  const started = Date.now();
  const frames = mode === 'interval' && !trimmed && timestamps.length > 8
    ? await extractByPass(abs, timestamps, dir, { interval, width, format, quality, duration: meta.duration })
    : await extractBySeek(abs, timestamps, dir, { width, format, quality });

  return {
    source: relToRoot(abs),
    mode,
    dir: relToRoot(dir),
    dirPath: dir,
    count: frames.length,
    requested: timestamps.length,
    max,
    width,
    format,
    duration: meta.duration,
    frames,
    sceneCount: sceneInfo?.sceneCount ?? null,
    capped: trimmed,
    extractMs: Date.now() - started,
  };
}

/* ------------------------------------------------------------ extraction */

/** One fast seek per frame. Cheap when the frames are few and far apart. */
async function extractBySeek(abs, timestamps, dir, { width, format, quality }) {
  const frames = [];
  const pad = String(timestamps.length).length + 1;

  for (const [i, t] of timestamps.entries()) {
    const name = `frame-${String(i).padStart(pad, '0')}-${t.toFixed(2).replace('.', '_')}s.${format}`;
    const file = path.join(dir, name);
    const args = [
      '-y',
      // -ss before -i is the fast seek; -accurate_seek keeps it honest.
      '-ss', String(t), '-accurate_seek', '-i', abs,
      '-frames:v', '1', '-an', '-sn',
      '-vf', `scale=${width}:-2:flags=lanczos`,
    ];
    if (format === 'jpg') args.push('-q:v', String(quality));
    args.push(file);

    await ffmpeg(args, { label: `frame ${i + 1}/${timestamps.length}` });
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      frames.push({ index: i, timestamp: round(t), file: relToRoot(file), sizeBytes: fs.statSync(file).size });
    } else {
      log.warn(`no frame decoded at ${t.toFixed(2)}s`);
    }
  }
  return frames;
}

/** Single decode pass with the fps filter. Wins when frames are dense. */
async function extractByPass(abs, timestamps, dir, { interval, width, format, quality, duration }) {
  const pattern = path.join(dir, `frame-%04d.${format}`);
  const args = [
    '-y', '-i', abs,
    '-vf', `fps=1/${interval},scale=${width}:-2:flags=lanczos`,
    '-an', '-sn',
  ];
  if (format === 'jpg') args.push('-q:v', String(quality));
  args.push(pattern);

  await ffmpeg(args, { label: 'extract-frames', totalSec: duration });

  // fps= places the first frame at interval/2, then every `interval` seconds.
  return fs.readdirSync(dir)
    .filter(f => f.startsWith('frame-') && f.endsWith(`.${format}`))
    .sort()
    .map((f, i) => {
      const file = path.join(dir, f);
      return {
        index: i,
        timestamp: round(Math.min(duration, interval / 2 + i * interval)),
        file: relToRoot(file),
        sizeBytes: fs.statSync(file).size,
      };
    });
}

/* -------------------------------------------------------------- selection */

function evenlySpaced(duration, interval) {
  if (interval <= 0) throw usageError('--interval must be greater than 0');
  const out = [];
  for (let t = interval / 2; t < duration; t += interval) out.push(t);
  return out.length ? out : [Math.min(0.1, duration / 2)];
}

function parseTimestamps(raw, duration) {
  if (raw == null) throw usageError('--timestamps is required in timestamp mode', 'e.g. --timestamps 4.3,12.7,18.4');
  const list = (typeof raw === 'string' ? raw.split(',') : raw).map(v => Number(String(v).trim()));
  if (list.some(v => !Number.isFinite(v))) throw usageError(`Could not parse --timestamps "${raw}"`);
  const bad = list.filter(t => t < 0 || t >= duration);
  if (bad.length) log.warn(`ignoring ${bad.length} timestamp(s) outside the ${duration}s source`);
  return list;
}

/** Add evenly spaced samples so long static shots are still represented. */
function topUp(timestamps, duration, max) {
  const out = [...timestamps];
  const want = Math.min(max, Math.max(4, Math.round(duration / 10)));
  if (out.length >= want) return out;
  const step = duration / (want - out.length + 1);
  for (let t = step; t < duration; t += step) out.push(t);
  return out;
}

const dedupe = (sorted, minGap) =>
  sorted.filter((t, i) => i === 0 || t - sorted[i - 1] >= minGap);

/** Keep `n` items spread evenly across the list, always including the ends. */
function evenSubset(list, n) {
  if (list.length <= n) return list;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

const round = n => Math.round(n * 1000) / 1000;

export const tool = {
  name: 'extract-frames',
  summary: 'Extract still frames by interval, timestamp, scene, or a smart mix.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    mode: { type: 'enum', values: MODES, default: 'smart', help: 'Frame selection strategy' },
    interval: { type: 'number', default: 5, help: 'Seconds between frames (interval mode)' },
    timestamps: { type: 'string', help: 'Comma-separated times, e.g. 4.3,12.7,18.4 (timestamp mode)' },
    max: { type: 'number', default: 24, help: 'Hard cap on frames produced' },
    width: { type: 'number', default: 640, help: 'Output width in px (height keeps aspect)' },
    format: { type: 'enum', values: ['jpg', 'png'], default: 'jpg', help: 'Image format' },
    quality: { type: 'number', default: 3, help: 'JPEG quality, 2 = best, 31 = worst' },
    threshold: { type: 'number', help: 'Scene threshold (scene/smart modes)' },
    outDir: { type: 'string', help: 'Output directory (default: frames/<name>/)' },
    force: { type: 'bool', default: false, help: 'Clear the output directory first' },
  },
  examples: [
    've extract-frames raw/test.mp4',
    've extract-frames raw/test.mp4 --mode interval --interval 3',
    've extract-frames raw/test.mp4 --mode timestamp --timestamps 4.3,12.7,18.4',
    've extract-frames raw/test.mp4 --mode scene --max 12',
  ],
  run: opts => extractFrames(opts.input, opts),
  pretty: r => `${r.count} frame(s) -> ${r.dir}  (${r.mode}${r.capped ? ', capped' : ''}, ${r.extractMs}ms)`,
};

runIfMain(tool, import.meta.url);
