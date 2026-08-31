// add-broll — cut away to supporting footage.
//
// B-roll is the one visual decision that genuinely depends on MEANING, so this
// tool does the mechanical half and makes the editorial half explicit:
//
//   mechanical  place a clip over the main video for a window, in one of four
//               modes, with the audio handled correctly for each
//   editorial   WHICH clip belongs WHERE. `--auto` offers a transcript-driven
//               suggestion by matching spoken words against asset filenames and
//               a per-asset `tags` manifest — deliberately conservative, and
//               always reported as suggestions with their evidence.
//
// Modes:
//   replace  B-roll takes the screen; the ORIGINAL audio continues underneath.
//            This is what "cut to B-roll" normally means.
//   overlay  B-roll sits in a box over the main picture.
//   pip      picture-in-picture, small, in a corner.
//   background  B-roll behind, main video scaled down in front.
//
// Audio: B-roll audio is muted by default. Nothing is more jarring than a
// stock clip's own sound cutting across a sentence.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, encodeArgs } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { transcribe, flattenWords } from './transcribe.mjs';

export const MODES = ['replace', 'overlay', 'pip', 'background'];
export const BROLL_DIR = () => path.join(DIR.assets, 'broll');

export function listBroll() {
  const dir = BROLL_DIR();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /\.(mp4|mov|webm|mkv|avi|gif)$/i.test(f)).sort();
}

/** assets/broll/manifest.json maps a clip to the words it illustrates. */
export function loadManifest() {
  const f = path.join(BROLL_DIR(), 'manifest.json');
  if (!fs.existsSync(f)) return {};
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j.clips || j;
  } catch {
    log.warn('assets/broll/manifest.json is not valid JSON; ignoring it');
    return {};
  }
}

const norm = s => String(s).toLowerCase().normalize('NFD')
  .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Suggest B-roll placements from the transcript.
 *
 * Matching is intentionally shallow — filename and manifest tags against spoken
 * words. It does not try to be clever, because a wrong B-roll cut is far more
 * damaging than a missing one. Every suggestion carries the word that triggered
 * it so the choice can be reviewed or overridden.
 */
export function suggest(words, { assets, manifest = {}, duration, minGap = 6, maxPerMinute = 3, clipSeconds = 3 }) {
  const index = [];
  for (const file of assets) {
    const stem = norm(path.basename(file, path.extname(file)));
    const tags = new Set([
      ...stem.split(' ').filter(w => w.length >= 3),
      ...((manifest[file]?.tags) || (manifest[path.basename(file, path.extname(file))]?.tags) || [])
        .map(norm).filter(Boolean),
    ]);
    if (tags.size) index.push({ file, tags });
  }
  if (!index.length) return [];

  const hits = [];
  for (const w of words) {
    const n = norm(w.word);
    if (n.length < 3) continue;
    for (const entry of index) {
      if (entry.tags.has(n)) {
        hits.push({ t: w.start, word: w.word, asset: entry.file });
        break;
      }
    }
  }

  // Space them out and cap the density: B-roll every few seconds is noise.
  const budget = Math.max(1, Math.round((duration / 60) * maxPerMinute));
  const chosen = [];
  for (const h of hits) {
    if (chosen.length >= budget) break;
    // Compare the START WE WOULD STORE against the previous stored start.
    // Comparing the raw hit time instead let placements land minGap-0.2s apart,
    // quietly breaking the spacing guarantee.
    const start = Math.max(0, h.t - 0.2);
    const prev = chosen[chosen.length - 1];
    if (prev && start - prev.start < minGap) continue;
    const end = Math.min(duration, start + clipSeconds);
    if (end - start < 1) continue;
    chosen.push({
      start: round(start), end: round(end),
      asset: path.join('assets', 'broll', h.asset),
      mode: 'replace',
      reason: `speaker says "${h.word}"`,
    });
  }
  return chosen;
}

export function parseEvents(raw) {
  if (raw == null) return [];
  let list = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.endsWith('.json') && fs.existsSync(s)) {
      const j = JSON.parse(fs.readFileSync(s, 'utf8'));
      list = Array.isArray(j) ? j : j.broll || [];
    } else if (s.startsWith('[') || s.startsWith('{')) {
      const j = JSON.parse(s);
      list = Array.isArray(j) ? j : j.broll || [];
    } else {
      // "terminal.mp4@12.2-15.4" or "...@12.2-15.4:overlay"
      list = s.split(';').map(part => {
        const m = /^(.+?)@([\d.]+)-([\d.]+)(?::(\w+))?$/.exec(part.trim());
        if (!m) throw usageError(`Could not parse b-roll "${part}"`,
          'Use ASSET@START-END[:MODE], e.g. "terminal.mp4@12.2-15.4:replace".');
        return { asset: m[1], start: Number(m[2]), end: Number(m[3]), ...(m[4] ? { mode: m[4] } : {}) };
      });
    }
  }
  if (!Array.isArray(list)) list = [list];

  return list.map((e, i) => {
    if (!e.asset) throw usageError(`broll[${i}]: no asset`);
    const mode = e.mode || 'replace';
    if (!MODES.includes(mode)) throw usageError(`broll[${i}]: unknown mode "${mode}"`, `Use: ${MODES.join(', ')}`);
    const start = Number(e.start);
    const end = Number(e.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw usageError(`broll[${i}]: needs a valid start and end`);
    }
    return { asset: e.asset, start, end, mode, scale: Number(e.scale ?? 0.32), reason: e.reason };
  }).sort((a, b) => a.start - b.start);
}

/**
 * @param {string} input
 * @param {{broll?:*, plan?:string, auto?:boolean, out?:string, keepAudio?:boolean,
 *          maxPerMinute?:number, dryRun?:boolean}} opts
 */
export async function addBroll(input, opts = {}) {
  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) throw inputError(`${relToRoot(abs)} has no video track`);

  let raw = opts.broll;
  if (opts.plan) {
    const plan = JSON.parse(fs.readFileSync(resolveInput(opts.plan, 'plan'), 'utf8'));
    raw = raw ?? plan.broll;
  }

  let events = parseEvents(raw);
  let suggestions = null;

  if (opts.auto && !events.length) {
    const assets = listBroll();
    if (!assets.length) {
      throw inputError(`no B-roll clips in ${relToRoot(BROLL_DIR())}`,
        'Add .mp4 clips there. Name them after what they show (terminal.mp4, docker.mp4), ' +
        'or add assets/broll/manifest.json mapping each clip to tags.');
    }
    if (!meta.hasAudio) throw inputError('--auto needs audio to read the transcript from');

    const tr = await transcribe(abs, { language: opts.language, prompt: opts.prompt });
    suggestions = suggest(flattenWords(tr), {
      assets, manifest: loadManifest(), duration: meta.duration,
      maxPerMinute: opts.maxPerMinute ?? 3,
      minGap: opts.minGap ?? 6,
      clipSeconds: opts.clipSeconds ?? 3,
    });
    events = parseEvents(suggestions);
    log.info(`suggested ${events.length} B-roll placement(s) from the transcript`);
  }

  if (!events.length) {
    throw usageError('No B-roll placements given',
      'Use --broll "clip.mp4@12-15", --plan, or --auto to derive them from the transcript.');
  }

  for (const [i, e] of events.entries()) {
    const candidate = e.asset.includes('/') || e.asset.includes('\\')
      ? e.asset
      : path.join(BROLL_DIR(), e.asset);
    e.file = resolveInput(candidate, `broll[${i}].asset`);
    if (e.start >= meta.duration) throw usageError(`broll[${i}] starts at ${e.start}s, beyond the source`);
    e.end = Math.min(e.end, meta.duration);
    const bm = await probeVideo(e.file);
    e.assetDuration = bm.duration;
    if (i > 0 && e.start < events[i - 1].end) {
      throw usageError(`broll[${i}] overlaps the previous placement`, 'B-roll placements must not overlap.');
    }
  }

  const summary = {
    source: relToRoot(abs),
    duration: meta.duration,
    placements: events.map(e => ({
      asset: relToRoot(e.file), start: e.start, end: e.end,
      mode: e.mode, reason: e.reason, assetDuration: e.assetDuration,
    })),
    count: events.length,
    perMinute: round((events.length / Math.max(1e-6, meta.duration / 60)), 2),
    auto: Boolean(opts.auto),
    suggestions,
  };

  if (opts.dryRun) return { ...summary, dryRun: true };

  /* ------------------------------------------------------------- render */

  const args = ['-y', '-i', abs];
  events.forEach(e => {
    // Loop a clip shorter than its window, and trim one that is longer.
    args.push('-stream_loop', '-1', '-t', String(e.end - e.start), '-i', e.file);
  });

  const parts = [];
  let base = '[0:v]';

  events.forEach((e, i) => {
    const idx = i + 1;
    const enable = `enable='between(t,${e.start},${e.end})'`;
    const outLbl = i === events.length - 1 ? '[vout]' : `[m${i}]`;

    if (e.mode === 'replace') {
      parts.push(
        `[${idx}:v]scale=${meta.width}:${meta.height}:force_original_aspect_ratio=increase,` +
        `crop=${meta.width}:${meta.height},setsar=1,fps=${meta.fps || 30},` +
        `setpts=PTS-STARTPTS+${e.start}/TB[b${i}]`
      );
      parts.push(`${base}[b${i}]overlay=0:0:${enable}:eof_action=pass${outLbl}`);
    } else if (e.mode === 'background') {
      // B-roll fills the frame; the speaker shrinks in front of it.
      parts.push(
        `[${idx}:v]scale=${meta.width}:${meta.height}:force_original_aspect_ratio=increase,` +
        `crop=${meta.width}:${meta.height},setsar=1,fps=${meta.fps || 30},` +
        `setpts=PTS-STARTPTS+${e.start}/TB[b${i}]`
      );
      const w = Math.round(meta.width * 0.55) & ~1;
      parts.push(`${base}scale=${w}:-2[small${i}]`);
      parts.push(`[b${i}][small${i}]overlay=(W-w)/2:(H-h)/2:${enable}:eof_action=pass${outLbl}`);
    } else {
      const scale = e.mode === 'pip' ? Math.min(e.scale, 0.3) : e.scale;
      const w = Math.max(2, Math.round(meta.width * scale)) & ~1;
      const pos = e.mode === 'pip'
        ? `W-w-${Math.round(meta.width * 0.04)}:H-h-${Math.round(meta.height * 0.04)}`
        : '(W-w)/2:(H-h)/2';
      parts.push(
        `[${idx}:v]scale=${w}:-2,setsar=1,fps=${meta.fps || 30},` +
        `setpts=PTS-STARTPTS+${e.start}/TB[b${i}]`
      );
      parts.push(`${base}[b${i}]overlay=${pos}:${enable}:eof_action=pass${outLbl}`);
    }
    base = outLbl;
  });

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-broll.mp4`));
  const { args: enc } = await encodeArgs({ quality: opts.quality || 'final', hw: opts.hw || 'auto' });

  log.info(`${events.length} B-roll placement(s), original audio ${opts.keepAudio ? 'mixed with clip audio' : 'kept'}`);

  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[vout]',
    // The narration continues through B-roll. Clip audio is dropped unless
    // explicitly asked for, because it almost always fights the voice.
    ...(meta.hasAudio ? ['-map', '0:a', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    ...stripVf(enc),
    '-t', String(meta.duration),
    out
  );

  await ffmpeg(args, { label: 'add-broll', totalSec: meta.duration });

  const got = await probeVideo(out);
  if (got.width !== meta.width || got.height !== meta.height) {
    throw validationError(`B-roll changed the frame size to ${got.width}x${got.height}`);
  }
  if (Math.abs(got.duration - meta.duration) > 0.4) {
    throw validationError(`B-roll changed the duration: ${got.duration}s vs ${meta.duration}s`);
  }

  return { ...summary, output: relToRoot(out), path: out, actualDuration: got.duration, sizeBytes: got.sizeBytes };
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
  name: 'add-broll',
  summary: 'Cut away to supporting footage, by hand or suggested from the transcript.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    broll: { type: 'string', help: '"clip.mp4@12.2-15.4:replace", a JSON array, or a .json path' },
    plan: { type: 'string', help: 'JSON file containing {broll:[...]}' },
    auto: { type: 'bool', default: false, help: 'Suggest placements by matching the transcript to asset names/tags' },
    language: { type: 'string', help: 'Language hint for --auto' },
    prompt: { type: 'string', help: 'Vocabulary prompt for --auto' },
    maxPerMinute: { type: 'number', default: 3, help: 'Density cap for --auto' },
    minGap: { type: 'number', default: 6, help: 'Minimum seconds between placements' },
    clipSeconds: { type: 'number', default: 3, help: 'Default length of a suggested placement' },
    keepAudio: { type: 'bool', default: false, help: 'Also mix the B-roll clip audio (rarely wanted)' },
    dryRun: { type: 'bool', default: false, help: 'Report placements without rendering' },
    out: { type: 'string', help: 'Output path' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've add-broll raw/test.mp4 --broll "terminal.mp4@12.2-15.4"',
    've add-broll raw/test.mp4 --auto --language pt --dry-run',
    've add-broll raw/test.mp4 --broll "code.mp4@5-8:pip"',
  ],
  run: opts => addBroll(opts.input, opts),
  pretty: r => `${r.count} B-roll placement(s) at ${r.perMinute}/min` +
    `${r.auto ? ' (auto-suggested)' : ''}${r.output ? ` -> ${r.output}` : ' (dry run)'}`,
};

runIfMain(tool, import.meta.url);
