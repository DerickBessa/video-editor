// detect-scenes — find hard cuts and turn them into a list of shots.
//
// Backend: FFmpeg's `scdet` filter. PySceneDetect was NOT added: scdet located
// every cut in the ground-truth fixture exactly (3.000 / 6.000 / 9.000s) with
// no dependency at all, so a Python scene detector would be redundant weight.
// Its known weakness is gradual transitions (crossfades, dissolves) — those
// spread the change over many frames and never exceed the threshold on any
// single one. See ROADMAP.md.
//
// scdet's score is its own 0-100 scale. It is NOT the same quantity as the
// `scene` expression used by `select=gt(scene,x)` (0-1); on identical input the
// same cut scored 23.1 for scdet and 0.59 for `scene`. Do not convert between
// them.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { cacheKey } from '../lib/hash.mjs';
import { inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

/**
 * @param {string} input
 * @param {{threshold?:number, minSceneLength?:number, out?:string, force?:boolean}} opts
 */
export async function detectScenes(input, opts = {}) {
  const { threshold = 10, minSceneLength = 0.5, force = false } = opts;

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) {
    throw inputError(`${relToRoot(abs)} has no video track`, 'Scene detection needs a video stream.');
  }

  const settings = { threshold, minSceneLength };
  const key = cacheKey(abs, settings);
  const cacheFile = path.join(ensureDir(path.join(DIR.cache, 'scenes')), `${slug(abs)}-${key}.json`);

  let detections;
  if (!force && fs.existsSync(cacheFile)) {
    try {
      detections = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      log.debug(`detect-scenes: cache hit ${relToRoot(cacheFile)}`);
    } catch { detections = null; }
  }
  if (!detections) {
    detections = await runScdet(abs, threshold, meta.duration);
    fs.writeFileSync(cacheFile, JSON.stringify(detections, null, 2));
  }

  // A cut at ~0 is the first frame, not a boundary between two shots.
  const cuts = detections
    .map(d => d.time)
    .filter(t => t > 0.05 && t < meta.duration - 0.05)
    .sort((a, b) => a - b);

  // Fold away cuts that would create a shot shorter than the minimum: a
  // one-frame "scene" is a detector artefact, not an editorial unit.
  const kept = [];
  let last = 0;
  for (const t of cuts) {
    if (t - last >= minSceneLength) { kept.push(t); last = t; }
  }
  if (kept.length && meta.duration - kept[kept.length - 1] < minSceneLength) kept.pop();

  const bounds = [0, ...kept, meta.duration];
  const scenes = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    scenes.push({
      id: i + 1,
      start: round(bounds[i]),
      end: round(bounds[i + 1]),
      duration: round(bounds[i + 1] - bounds[i]),
    });
  }

  if (!scenes.length) throw validationError('scene detection produced no shots', { duration: meta.duration });

  const durations = scenes.map(s => s.duration);
  const result = {
    source: relToRoot(abs),
    duration: meta.duration,
    threshold,
    minSceneLength,
    sceneCount: scenes.length,
    scenes,
    cuts: kept.map(round),
    cutCount: kept.length,
    rawCutCount: detections.length,
    scores: detections.map(d => ({ time: round(d.time), score: d.score })),
    averageSceneLength: round(durations.reduce((a, b) => a + b, 0) / durations.length),
    shortestScene: round(Math.min(...durations)),
    longestScene: round(Math.max(...durations)),
    cacheKey: key,
  };

  const outPath = prepareOutput(opts.out || path.join(ensureDir(path.join(DIR.cache, 'scenes')), `${slug(abs)}-scenes.json`));
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  result.output = relToRoot(outPath);
  result.path = outPath;
  return result;
}

/** Parse scdet's info-level log lines: "lavfi.scd.score: 23.115, lavfi.scd.time: 3". */
async function runScdet(file, threshold, totalSec) {
  const { stderr } = await ffmpeg([
    '-loglevel', 'info',
    '-i', file,
    '-vf', `scdet=threshold=${threshold}`,
    '-an', '-sn', '-f', 'null', '-',
  ], { label: 'scdet', totalSec, timeoutMs: 0 });

  const out = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = /lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/.exec(line);
    if (m) out.push({ score: Number(m[1]), time: Number(m[2]) });
  }
  return out;
}

const round = n => Math.round(n * 1000) / 1000;

export const tool = {
  name: 'detect-scenes',
  summary: 'Detect hard cuts and split the video into shots.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    threshold: { type: 'number', default: 10, help: 'scdet score 0-100; LOWER is more sensitive' },
    minSceneLength: { type: 'number', default: 0.5, help: 'Merge shots shorter than this (seconds)' },
    out: { type: 'string', help: 'Output JSON path' },
    force: { type: 'bool', default: false, help: 'Ignore the cache and re-detect' },
  },
  examples: [
    've detect-scenes raw/test.mp4',
    've detect-scenes raw/test.mp4 --threshold 5 --min-scene-length 1',
    've detect-scenes raw/test.mp4 | jq ".cuts"',
  ],
  run: opts => detectScenes(opts.input, opts),
  pretty: r => `${r.sceneCount} scene(s), ${r.cutCount} cut(s), avg ${r.averageSceneLength}s ` +
    `(shortest ${r.shortestScene}s) -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
