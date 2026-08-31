// add-sfx — mix sound effects into a video at given timestamps.
//
// VOICE FIRST. The brief is explicit that a video must not become a Christmas
// tree of noises, so this tool defends against that in three ways:
//
//   1. `--max-per-minute` caps density and DROPS the lowest-priority events
//      rather than silently piling them up.
//   2. Events closer together than `--min-gap` are thinned.
//   3. `--duck` briefly dips the effect (not the voice) when it lands on top
//      of speech, so an effect never competes with a word.
//
// Mixing uses `adelay` per effect into a single `amix` with normalize=0.
// Normalisation is off deliberately: amix's default divides every input by the
// input count, so adding one 0.3-gain blip would quietly halve the voice.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, encodeArgs } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

export const SFX_DIR = () => path.join(DIR.assets, 'sfx');

/** Read the generated catalogue, if present. */
export function loadCatalog() {
  const f = path.join(SFX_DIR(), 'catalog.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

export function listSounds() {
  const dir = SFX_DIR();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f)).sort();
}

/**
 * Accepts:
 *   "4.2:pop,7.9:ding@0.5"        compact CLI form (time:sound[@volume])
 *   [{timestamp, sound, volume, priority}]
 *   a .json file containing either an array or {sfx:[...]}
 */
export function parseEvents(raw) {
  if (raw == null) return [];
  let list = raw;

  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.endsWith('.json') && fs.existsSync(s)) {
      const j = JSON.parse(fs.readFileSync(s, 'utf8'));
      list = Array.isArray(j) ? j : j.sfx || j.events || [];
    } else if (s.startsWith('[') || s.startsWith('{')) {
      const j = JSON.parse(s);
      list = Array.isArray(j) ? j : j.sfx || j.events || [];
    } else {
      list = s.split(',').map(part => {
        const m = /^(\d*\.?\d+)\s*:\s*([\w.-]+?)(?:@(\d*\.?\d+))?$/.exec(part.trim());
        if (!m) throw usageError(`Could not parse sfx "${part}"`, 'Use TIME:SOUND[@VOLUME], e.g. "4.2:pop,7.9:ding@0.5".');
        return { timestamp: Number(m[1]), sound: m[2], ...(m[3] ? { volume: Number(m[3]) } : {}) };
      });
    }
  }

  if (!Array.isArray(list)) list = [list];
  return list.map((e, i) => {
    const timestamp = Number(e.timestamp ?? e.time ?? e.start);
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw usageError(`sfx[${i}] has an invalid timestamp`);
    }
    if (!e.sound) throw usageError(`sfx[${i}] has no sound`);
    return {
      timestamp,
      sound: String(e.sound),
      volume: Number.isFinite(Number(e.volume)) ? Number(e.volume) : 0.4,
      priority: Number.isFinite(Number(e.priority)) ? Number(e.priority) : 0.5,
      reason: e.reason,
    };
  }).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Thin events down to a watchable density.
 * Drops by priority, not by position, so the important beats survive.
 */
export function thin(events, { minGap = 0.6, maxPerMinute = 12, duration = 60 }) {
  const dropped = [];
  const kept = [];

  for (const e of events) {
    const last = kept[kept.length - 1];
    if (last && e.timestamp - last.timestamp < minGap) {
      // Keep whichever of the two matters more.
      if (e.priority > last.priority) {
        dropped.push({ ...last, droppedBecause: 'too close to a higher-priority effect' });
        kept[kept.length - 1] = e;
      } else {
        dropped.push({ ...e, droppedBecause: `within ${minGap}s of another effect` });
      }
      continue;
    }
    kept.push(e);
  }

  const budget = Math.max(1, Math.round((duration / 60) * maxPerMinute));
  if (kept.length > budget) {
    const ranked = [...kept].sort((a, b) => b.priority - a.priority || a.timestamp - b.timestamp);
    const survivors = new Set(ranked.slice(0, budget));
    for (const e of kept) if (!survivors.has(e)) dropped.push({ ...e, droppedBecause: `over the ${maxPerMinute}/min budget` });
    return { kept: kept.filter(e => survivors.has(e)), dropped };
  }
  return { kept, dropped };
}

/**
 * @param {string} input
 * @param {{events?:*, plan?:string, volume?:number, minGap?:number, maxPerMinute?:number,
 *          duck?:boolean, out?:string, dryRun?:boolean}} opts
 */
export async function addSfx(input, opts = {}) {
  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);

  let raw = opts.events;
  if (opts.plan) {
    const p = resolveInput(opts.plan, 'plan');
    const plan = JSON.parse(fs.readFileSync(p, 'utf8'));
    raw = raw ?? plan.sfx ?? plan.events;
  }

  const parsed = parseEvents(raw);
  if (!parsed.length) throw usageError('No sfx events given', 'Use --events "4.2:pop" or --plan edit-plans/x.json');

  // Resolve every sound to a real file before doing any work.
  const dir = SFX_DIR();
  const available = listSounds();
  for (const e of parsed) {
    e.file = resolveSound(e.sound, dir, available);
    if (e.timestamp >= meta.duration) {
      throw usageError(`sfx at ${e.timestamp}s is beyond the ${meta.duration}s source`);
    }
  }

  const { kept, dropped } = thin(parsed, {
    minGap: opts.minGap ?? 0.6,
    maxPerMinute: opts.maxPerMinute ?? 12,
    duration: meta.duration,
  });
  if (dropped.length) {
    log.warn(`dropped ${dropped.length} effect(s) to keep the density watchable ` +
      `(${(kept.length / (meta.duration / 60)).toFixed(1)}/min kept)`);
  }

  const masterVolume = opts.volume ?? 1.0;

  const summary = {
    source: relToRoot(abs),
    duration: meta.duration,
    requested: parsed.length,
    applied: kept.length,
    droppedCount: dropped.length,
    perMinute: round((kept.length / Math.max(1e-6, meta.duration / 60)), 2),
    duck: opts.duck !== false,
    events: kept.map(e => ({
      timestamp: round(e.timestamp), sound: e.sound, volume: e.volume,
      priority: e.priority, reason: e.reason, file: relToRoot(e.file),
    })),
    dropped: dropped.map(e => ({ timestamp: round(e.timestamp), sound: e.sound, reason: e.droppedBecause })),
  };

  if (opts.dryRun) return { ...summary, dryRun: true };

  const out = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-sfx.mp4`));
  const args = ['-y', '-i', abs];
  for (const e of kept) args.push('-i', e.file);

  const parts = [];
  const labels = [];

  if (meta.hasAudio) {
    parts.push(`[0:a]aresample=48000,apad=pad_dur=0.1[base]`);
    labels.push('[base]');
  }

  kept.forEach((e, i) => {
    const ms = Math.round(e.timestamp * 1000);
    const gain = e.volume * masterVolume;
    // adelay needs one value per channel; `all=1` applies it to every channel.
    parts.push(
      `[${i + 1}:a]aresample=48000,volume=${gain.toFixed(3)},adelay=${ms}:all=1[s${i}]`
    );
    labels.push(`[s${i}]`);
  });

  let audioLabel;
  if (!labels.length) {
    audioLabel = null;
  } else if (labels.length === 1) {
    parts.push(`${labels[0]}anull[amixed]`);
    audioLabel = '[amixed]';
  } else if (meta.hasAudio && summary.duck) {
    // Duck the EFFECTS under the voice, never the other way round: the voice is
    // the sidechain input, so an effect that lands on a word steps aside.
    const fx = labels.slice(1);
    parts.push(`${fx.join('')}amix=inputs=${fx.length}:normalize=0:dropout_transition=0[fxmix]`);
    parts.push(`[base]asplit=2[voice][key]`);
    parts.push(`[fxmix][key]sidechaincompress=threshold=0.05:ratio=6:attack=5:release=250:makeup=1[fxduck]`);
    parts.push(`[voice][fxduck]amix=inputs=2:normalize=0:dropout_transition=0[amixed]`);
    audioLabel = '[amixed]';
  } else {
    parts.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[amixed]`);
    audioLabel = '[amixed]';
  }

  if (audioLabel) {
    // Force the mix to span the whole video. Without this, a source with NO
    // audio ends up with a track only as long as its last effect, and
    // `-shortest` then truncates the VIDEO to match (measured: a 5s clip came
    // out at 3.9s). apad extends, atrim caps, so the result is exactly right
    // whether the effects run short or long.
    const d = meta.duration.toFixed(3);
    parts.push(`${audioLabel}apad=whole_dur=${d},atrim=end=${d},asetpts=N/SR/TB[aout]`);
    audioLabel = '[aout]';
  }

  args.push('-filter_complex', parts.join(';'));
  args.push('-map', '0:v', '-c:v', 'copy');
  if (audioLabel) args.push('-map', audioLabel, '-c:a', 'aac', '-b:a', '192k');
  args.push('-shortest', out);

  log.info(`mixing ${kept.length} effect(s)${summary.duck && meta.hasAudio ? ' with voice ducking' : ''}`);
  await ffmpeg(args, { label: 'add-sfx', totalSec: meta.duration });

  const got = await probeVideo(out);
  if (!got.hasAudio) throw validationError('add-sfx produced a file with no audio', { out });
  if (Math.abs(got.duration - meta.duration) > 0.4) {
    throw validationError(`add-sfx changed the duration: ${got.duration}s vs ${meta.duration}s`);
  }

  return { ...summary, output: relToRoot(out), path: out, actualDuration: got.duration, sizeBytes: got.sizeBytes };
}

function resolveSound(name, dir, available) {
  // An explicit path wins.
  if (name.includes('/') || name.includes('\\')) {
    return resolveInput(name, `sfx "${name}"`);
  }
  const withExt = /\.\w+$/.test(name) ? name : `${name}.wav`;
  const p = path.join(dir, withExt);
  if (fs.existsSync(p)) return p;

  const hint = available.length
    ? `Available: ${available.map(f => f.replace(/\.\w+$/, '')).join(', ')}`
    : `The catalogue is empty. Run: node scripts/make-sfx.mjs`;
  throw inputError(`sound "${name}" not found in ${relToRoot(dir)}`, hint);
}

const round = n => Math.round(n * 1000) / 1000;

export const tool = {
  name: 'add-sfx',
  summary: 'Mix sound effects at timestamps, with density limits and voice ducking.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    events: { type: 'string', help: '"4.2:pop,7.9:ding@0.5", a JSON array, or a .json path' },
    plan: { type: 'string', help: 'JSON file containing {sfx:[...]}' },
    volume: { type: 'number', default: 1.0, help: 'Master multiplier over each effect volume' },
    minGap: { type: 'number', default: 0.6, help: 'Minimum seconds between effects' },
    maxPerMinute: { type: 'number', default: 12, help: 'Density budget; excess is dropped by priority' },
    duck: { type: 'bool', default: true, help: 'Dip effects under speech so they never mask a word' },
    dryRun: { type: 'bool', default: false, help: 'Report the mix without rendering' },
    out: { type: 'string', help: 'Output path' },
  },
  examples: [
    've add-sfx raw/test.mp4 --events "4.2:pop,12.8:ding@0.5"',
    've add-sfx raw/test.mp4 --plan edit-plans/video.json --max-per-minute 6',
    've add-sfx raw/test.mp4 --events "2:whoosh" --no-duck',
  ],
  run: opts => addSfx(opts.input, opts),
  pretty: r => `${r.applied}/${r.requested} effect(s) at ${r.perMinute}/min` +
    `${r.droppedCount ? `, ${r.droppedCount} dropped` : ''}${r.duck ? ', ducked' : ''}` +
    `${r.output ? ` -> ${r.output}` : ' (dry run)'}`,
};

runIfMain(tool, import.meta.url);
