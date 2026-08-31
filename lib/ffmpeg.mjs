// FFmpeg/FFprobe access layer. Every tool goes through here so that binary
// discovery, error formatting and encoder selection stay in exactly one place.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, tail } from './proc.mjs';
import { log } from './log.mjs';
import { VeError, EXIT, depError } from './errors.mjs';
import { DIR, ensureDir } from './paths.mjs';

export const FFMPEG = process.env.VE_FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.VE_FFPROBE || 'ffprobe';

const BASE = ['-hide_banner', '-nostdin', '-loglevel', 'error'];

/* ------------------------------------------------------------------ probe */

/** Raw ffprobe payload: format + all streams. */
export async function ffprobeJson(file, extra = []) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...extra, file];
  let res;
  try {
    res = await run(FFPROBE, args, { timeoutMs: 120000 });
  } catch (e) {
    if (e.code === EXIT.DEPENDENCY) throw e;
    throw new VeError(`ffprobe could not read: ${path.basename(file)}`, {
      code: EXIT.INPUT,
      hint: 'The file may be corrupt, still being written, or not a media file.',
      details: e.details,
      cause: e,
    });
  }
  try {
    return JSON.parse(res.stdout);
  } catch (cause) {
    throw new VeError('ffprobe returned malformed JSON', { code: EXIT.PROCESS, cause });
  }
}

/** Duration in seconds, preferring the container value, falling back to a decode. */
export async function durationOf(file) {
  const j = await ffprobeJson(file);
  const d = Number(j?.format?.duration);
  if (Number.isFinite(d) && d > 0) return d;
  // Container lies (common for some WebM/MKV): count it the slow but honest way.
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-count_packets', '-select_streams', 'v:0',
    '-show_entries', 'stream=duration', '-of', 'csv=p=0', file,
  ], { timeoutMs: 300000 });
  const d2 = Number(String(stdout).trim());
  if (Number.isFinite(d2) && d2 > 0) return d2;
  throw new VeError(`Could not determine duration of ${path.basename(file)}`, { code: EXIT.INPUT });
}

/**
 * Presentation times of every video keyframe, ascending.
 * Reads packet flags only — no decoding — so it stays fast on long files.
 * Stream-copy cuts can only land on these points.
 */
export async function keyframeTimes(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags',
    '-of', 'csv=print_section=0', file,
  ], { timeoutMs: 600000 });

  return stdout.split(/\r?\n/)
    .map(line => {
      const [t, flags] = line.split(',');
      return flags?.includes('K') ? Number(t) : null;
    })
    .filter(t => t !== null && Number.isFinite(t))
    .sort((a, b) => a - b);
}

/* ----------------------------------------------------------------- encode */

/**
 * Run ffmpeg. When `totalSec` is given, `-progress` output is parsed so long
 * renders report percentage on stderr at debug level.
 * @param {string[]} args ffmpeg args WITHOUT the leading binary
 * @param {{totalSec?:number, label?:string, timeoutMs?:number}} opts
 */
export async function ffmpeg(args, opts = {}) {
  const { totalSec, label = 'ffmpeg', timeoutMs = 0 } = opts;
  const full = [...BASE, ...args];

  let lastPct = -1;
  const onStderr = totalSec
    ? chunk => {
        const m = /out_time_us=(\d+)/.exec(chunk) || /out_time_ms=(\d+)/.exec(chunk);
        if (!m) return;
        const pct = Math.min(100, Math.round((Number(m[1]) / 1e6 / totalSec) * 100));
        if (pct >= lastPct + 10) { lastPct = pct; log.debug(`${label}: ${pct}%`); }
      }
    : undefined;

  try {
    return await run(FFMPEG, totalSec ? ['-progress', 'pipe:2', ...full] : full, { onStderr, timeoutMs });
  } catch (e) {
    if (e.code === EXIT.DEPENDENCY) throw e;
    throw new VeError(`${label} failed`, {
      code: EXIT.PROCESS,
      details: e.details,
      hint: e.details?.stderrTail ? `ffmpeg said:\n${e.details.stderrTail}` : undefined,
      cause: e,
    });
  }
}

/* -------------------------------------------------------- hw acceleration */

const HW_CANDIDATES = [
  { name: 'nvenc', encoder: 'h264_nvenc', hevc: 'hevc_nvenc', quality: ['-rc', 'vbr', '-cq', '23', '-preset', 'p5'] },
  { name: 'qsv', encoder: 'h264_qsv', hevc: 'hevc_qsv', quality: ['-global_quality', '23', '-preset', 'medium'] },
  { name: 'amf', encoder: 'h264_amf', hevc: 'hevc_amf', quality: ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23'] },
];

const CPU = { name: 'cpu', encoder: 'libx264', hevc: 'libx265', quality: ['-crf', '20', '-preset', 'medium'] };

let hwCache = null;

/**
 * Pick a working video encoder. Listing an encoder is NOT proof it runs
 * (no driver, no device, GPU busy), so each candidate is verified with a real
 * few-frame encode. Result is cached in cache/hw.json, keyed on ffmpeg version.
 */
export async function detectEncoder({ force = false } = {}) {
  if (hwCache && !force) return hwCache;
  const cacheFile = path.join(ensureDir(DIR.cache), 'hw.json');
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c.ffmpeg === (await ffmpegVersion())) return (hwCache = c);
    } catch { /* fall through and re-detect */ }
  }

  const listed = await listEncoders();
  const tried = [];
  let chosen = CPU;

  for (const cand of HW_CANDIDATES) {
    if (!listed.has(cand.encoder)) { tried.push({ name: cand.name, encoder: cand.encoder, status: 'not-built' }); continue; }
    const ok = await testEncoder(cand.encoder);
    tried.push({ name: cand.name, encoder: cand.encoder, status: ok ? 'ok' : 'runtime-failure' });
    if (ok && chosen === CPU) chosen = cand;
  }

  hwCache = {
    ffmpeg: await ffmpegVersion(),
    accel: chosen.name,
    video: chosen.encoder,
    hevc: chosen.hevc,
    qualityArgs: chosen.quality,
    hardware: chosen.name !== 'cpu',
    candidates: tried,
    detectedAt: new Date().toISOString(),
  };
  fs.writeFileSync(cacheFile, JSON.stringify(hwCache, null, 2));
  log.debug(`encoder: ${hwCache.video} (${hwCache.accel})`);
  return hwCache;
}

async function testEncoder(enc) {
  const out = path.join(os.tmpdir(), `ve-enc-test-${enc}-${process.pid}.mp4`);
  try {
    await run(FFMPEG, [
      ...BASE, '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1:r=10',
      '-frames:v', '3', '-c:v', enc, out,
    ], { timeoutMs: 60000 });
    return fs.existsSync(out) && fs.statSync(out).size > 0;
  } catch (e) {
    log.debug(`encoder ${enc} unusable: ${tail(e.details?.stderrTail || e.message, 2)}`);
    return false;
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* best effort */ }
  }
}

let listedCache = null;
export async function listEncoders() {
  if (listedCache) return listedCache;
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-encoders'], { timeoutMs: 30000 });
  listedCache = new Set(
    stdout.split(/\r?\n/).map(l => /^\s*[A-Z.]{6}\s+(\S+)/.exec(l)?.[1]).filter(Boolean)
  );
  return listedCache;
}

let filtersCache = null;
export async function listFilters() {
  if (filtersCache) return filtersCache;
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-filters'], { timeoutMs: 30000 });
  // Flag column width has changed between ffmpeg releases (2 chars in 8.x,
  // 3 in some 6.x builds), so anchor on the stable "A->A" signature column.
  filtersCache = new Set(
    stdout.split(/\r?\n/)
      .map(l => /^\s*\S{2,3}\s+(\w+)\s+[AVN|]+->[AVN|]+/.exec(l)?.[1])
      .filter(Boolean)
  );
  return filtersCache;
}

let verCache = null;
export async function ffmpegVersion() {
  if (verCache) return verCache;
  try {
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-version'], { timeoutMs: 20000 });
    verCache = /ffmpeg version (\S+)/.exec(stdout)?.[1] || 'unknown';
  } catch (cause) {
    throw depError('FFmpeg not found', 'Install FFmpeg and make sure `ffmpeg` is on PATH.');
  }
  return verCache;
}

/**
 * Standard video+audio encode arguments.
 * `quality` is an intent ('preview' | 'final'), not a codec-specific number,
 * so preview and final renders can share one call site.
 */
export async function encodeArgs({ quality = 'final', hw = 'auto', fps, scale, pixFmt = 'yuv420p', audioBitrate = '192k' } = {}) {
  const enc = hw === 'off'
    ? { accel: 'cpu', video: CPU.encoder, qualityArgs: CPU.quality }
    : await detectEncoder();

  const args = ['-c:v', enc.video];

  if (quality === 'preview') {
    args.push(...(
      enc.accel === 'nvenc' ? ['-rc', 'vbr', '-cq', '30', '-preset', 'p1']
      : enc.accel === 'qsv' ? ['-global_quality', '30', '-preset', 'veryfast']
      : enc.accel === 'amf' ? ['-quality', 'speed', '-rc', 'cqp', '-qp_i', '30', '-qp_p', '30']
      : ['-crf', '28', '-preset', 'veryfast']
    ));
  } else {
    args.push(...enc.qualityArgs);
  }

  args.push('-pix_fmt', pixFmt);
  if (fps) args.push('-r', String(fps));
  if (scale) args.push('-vf', `scale=${scale}`);
  args.push('-movflags', '+faststart', '-c:a', 'aac', '-b:a', audioBitrate);
  return { args, encoder: enc.video, accel: enc.accel };
}

/**
 * Locate a usable TTF for `drawtext`.
 *
 * drawtext resolves font NAMES through fontconfig, which Windows does not ship
 * ("Fontconfig error: Cannot load default config file"), so every drawtext call
 * must pass an explicit `fontfile=`. libass (used by the `ass` filter for
 * captions) has its own font handling and is unaffected — which is why captions
 * worked while drawtext did not.
 *
 * Returns null when nothing is found, so callers can degrade instead of failing.
 */
let fontCache;
export function findFont() {
  if (fontCache !== undefined) return fontCache;

  const candidates = [
    // A font committed to the project always wins, for reproducibility.
    path.join(DIR.assets, 'fonts', 'default.ttf'),
    ...(process.platform === 'win32' ? [
      'C:/Windows/Fonts/arial.ttf',
      'C:/Windows/Fonts/segoeui.ttf',
      'C:/Windows/Fonts/calibri.ttf',
    ] : []),
    ...(process.platform === 'darwin' ? [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/System/Library/Fonts/Helvetica.ttc',
    ] : []),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  ];

  // Any .ttf the user dropped into assets/fonts/ is also acceptable.
  const fontDir = path.join(DIR.assets, 'fonts');
  if (fs.existsSync(fontDir)) {
    for (const f of fs.readdirSync(fontDir)) {
      if (/\.(ttf|otf)$/i.test(f)) candidates.push(path.join(fontDir, f));
    }
  }

  fontCache = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
  if (!fontCache) log.debug('no TTF found for drawtext; text overlays will be skipped');
  return fontCache;
}

/** Escape text for a drawtext `text=` value: ':' and '\' both break the parser. */
export function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

/** Escape a path for use inside an ffmpeg filtergraph value (Windows drive letters bite here). */
export function escapeFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
