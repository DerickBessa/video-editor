// render-edit — execute an edit plan, stage by stage, with caching.
//
// Each stage is a call into the tool that already implements it. This file
// contains NO editing logic of its own; its whole job is order, timeline
// mapping, caching and honest reporting. If a stage needs new behaviour, the
// behaviour belongs in that stage's tool, not here.
//
// CACHING. Each stage writes to temp/render/<sourceId>/<n>-<stage>-<hash>.mp4
// where the hash covers that stage's settings AND the identity of its input.
// A stage is skipped when its output already exists, so changing one zoom
// re-runs zoom and everything after it, but not the transcription, the cut or
// the crop that came before. That is what makes "nudge the plan and re-render"
// fast enough to iterate on.
import fs from 'node:fs';
import path from 'node:path';
import { loadPlan, normalizePlan, toCutTimeline, activeStages, stageHash } from '../lib/edit-plan.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir, ROOT } from '../lib/paths.mjs';
import { fileFingerprint } from '../lib/hash.mjs';
import { VeError, EXIT, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { validateEditPlan } from './validate-edit-plan.mjs';
import { cutVideo } from './cut-video.mjs';
import { changeSpeed } from './change-speed.mjs';
import { cropVideo } from './crop-video.mjs';
import { smartCrop } from './smart-crop.mjs';
import { zoomVideo } from './zoom-video.mjs';
import { captions } from './captions.mjs';
import { normalizeAudio } from './normalize-audio.mjs';
import { addSfx } from './add-sfx.mjs';
import { addOverlay } from './add-overlay.mjs';

/**
 * @param {string} planFile
 * @param {{quality?:'preview'|'final', out?:string, force?:boolean, hw?:string,
 *          skipValidation?:boolean, dryRun?:boolean}} opts
 */
export async function renderEdit(planFile, opts = {}) {
  const planPath = resolveInput(planFile, 'plan');
  const plan = loadPlan(planPath);
  const quality = opts.quality || 'final';

  if (!opts.skipValidation) {
    await validateEditPlan(planPath, {});   // throws EXIT.VALIDATION if unrenderable
  }

  const source = resolveInput(path.resolve(ROOT, plan.source), 'source');
  const meta = await probeVideo(source);

  const normalized = normalizePlan(plan, { duration: meta.duration });
  const mapped = toCutTimeline(plan, { duration: meta.duration });
  // Stages come from the MAPPED plan, not the raw one: an event that sat
  // entirely inside removed footage no longer exists, and asking its tool to
  // run with an empty event list is an error, not a no-op.
  const stages = activeStages(mapped, { sourceDuration: meta.duration });

  if (mapped.dropped.length) {
    for (const d of mapped.dropped) log.warn(`dropped ${d.kind}[${d.index}]: ${d.reason}`);
  }

  const out = prepareOutput(
    opts.out || plan.output?.path || path.join(DIR.output, `${slug(source)}-edited.mp4`)
  );

  if (!stages.length) {
    log.warn('the plan asks for no changes; copying the source');
    if (!opts.dryRun) fs.copyFileSync(source, out);
    return summarise({ plan, planPath, source, meta, stages: [], steps: [], out, quality, dryRun: opts.dryRun });
  }

  // Intermediates are keyed on the SOURCE, not on the plan.
  //
  // Keying on the plan hash looked tidier but destroyed the entire point of the
  // cache: changing one zoom changed the plan hash, which changed the
  // directory, which orphaned the cut and crop intermediates that the zoom did
  // not affect. Per-stage identity is already handled by stageHash(settings) +
  // the input file's fingerprint, so two different plans over the same source
  // can safely share a directory and reuse whatever they genuinely have in
  // common.
  const sourceId = `${slug(source)}-${fileFingerprint(source)}`;
  const work = ensureDir(path.join(DIR.temp, 'render', sourceId));

  if (opts.dryRun) {
    return summarise({
      plan, planPath, source, meta, stages, out, quality, dryRun: true,
      steps: stages.map((s, i) => ({ stage: s, index: i, planned: true })),
    });
  }

  const steps = [];
  let current = source;
  const started = Date.now();

  for (const [i, stage] of stages.entries()) {
    const last = i === stages.length - 1;
    const hash = stageHash(mapped, stage, { input: fileFingerprint(current), quality });
    const target = last ? out : path.join(work, `${i}-${stage}-${hash}.mp4`);

    // Each stage's report is persisted beside its output, so a CACHED stage
    // returns the same fields as a fresh one. Without this the result shape
    // silently changed with cache state — a caller reading `steps[].cues`
    // got a number on a cold run and undefined on a warm one.
    const infoFile = `${target}.json`;
    if (!opts.force && !last && fs.existsSync(target) && fs.statSync(target).size > 1000) {
      let cachedInfo = {};
      try { cachedInfo = JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { /* older cache entry */ }
      log.info(`[${i + 1}/${stages.length}] ${stage}: cached`);
      steps.push({ stage, index: i, cached: true, output: relToRoot(target), ms: 0, ...cachedInfo });
      current = target;
      continue;
    }

    log.info(`[${i + 1}/${stages.length}] ${stage} ...`);
    const t0 = Date.now();
    let info;
    try {
      info = await runStage(stage, current, target, { plan: mapped, meta, quality, hw: opts.hw, source });
    } catch (e) {
      throw new VeError(`stage "${stage}" failed`, {
        code: e.code ?? EXIT.PROCESS,
        hint: e.hint ?? e.message,
        details: { stage, input: relToRoot(current), completed: steps.map(s => s.stage) },
        cause: e,
      });
    }
    const ms = Date.now() - t0;
    if (!last) {
      try { fs.writeFileSync(infoFile, JSON.stringify(info)); } catch { /* cache metadata is best effort */ }
    }
    steps.push({ stage, index: i, cached: false, output: relToRoot(target), ms, ...info });
    current = target;
  }

  const renderMs = Date.now() - started;
  const got = await probeVideo(out);

  if (!got.hasVideo) throw validationError('the render produced a file with no video stream', { out });

  return summarise({ plan, planPath, source, meta, stages, steps, out, quality, got, renderMs });
}

/* -------------------------------------------------------------- the stages */

async function runStage(stage, input, output, { plan, meta, quality, hw, source }) {
  switch (stage) {
    case 'cuts': {
      const r = await cutVideo(input, { keep: plan.keepRanges, out: output, quality, hw, minSegment: 0 });
      return { segments: r.segmentCount, duration: r.actualDuration, removed: r.removedDuration };
    }

    case 'speed': {
      const s = plan.speed[0];
      const r = await changeSpeed(input, {
        rate: s.rate,
        preservePitch: s.preservePitch !== false,
        out: output, quality, hw,
      });
      return { rate: r.rate, duration: r.duration };
    }

    case 'crop': {
      const c = plan.crop;
      const resolution = plan.output?.resolution || undefined;
      if (c.mode === 'smart') {
        const r = await smartCrop(input, {
          aspect: c.aspect, resolution, smoothing: c.smoothing, deadzone: c.deadzone,
          out: output, quality, hw,
        });
        return { width: r.width, height: r.height, tracked: r.tracked, faceCoverage: r.faceCoverage };
      }
      const r = await cropVideo(input, {
        aspect: c.aspect, resolution, position: c.position,
        fit: c.mode === 'contain' ? 'contain' : 'cover',
        background: c.background, out: output, quality, hw,
      });
      return { width: r.width, height: r.height };
    }

    case 'zoom': {
      const r = await zoomVideo(input, { events: plan.zooms, out: output, quality, hw });
      return { events: r.eventCount };
    }

    case 'overlays': {
      const r = await addOverlay(input, { overlays: plan.overlays, out: output, quality, hw });
      return { overlays: r.applied };
    }

    case 'captions': {
      const c = plan.captions;
      const r = await captions(input, {
        style: c.style, burn: true, out: output, quality, hw,
        language: c.language, prompt: c.prompt,
        keywords: c.keywords, maxWords: c.maxWords, position: c.position,
        fontSize: c.fontSize, font: c.font, uppercase: c.uppercase,
        // Captions must be timed against THIS file, which has already been cut
        // and retimed — a transcript of the original would be out of sync.
        transcript: undefined,
      });
      return { cues: r.cueCount, words: r.wordCount, style: r.style };
    }

    case 'audio': {
      const a = plan.audio;
      const r = await normalizeAudio(input, {
        targetLufs: a.targetLufs ?? -16,
        truePeak: a.truePeak,
        denoise: a.denoise,
        highpass: a.highpass,
        out: output,
      });
      return { lufs: r.after.lufs, errorLu: r.errorLu };
    }

    case 'sfx': {
      const r = await addSfx(input, {
        events: plan.sfx, out: output,
        volume: plan.audio?.sfxVolume,
        maxPerMinute: plan.sfxDensity ?? 12,
        duck: plan.audio?.duckSfx !== false,
      });
      return { applied: r.applied, dropped: r.droppedCount };
    }

    default:
      throw new VeError(`unknown stage "${stage}"`, { code: EXIT.UNSUPPORTED });
  }
}

function summarise({ plan, planPath, source, meta, stages, steps, out, quality, got, renderMs = 0, dryRun }) {
  return {
    plan: relToRoot(planPath),
    source: relToRoot(source),
    output: relToRoot(out),
    path: out,
    dryRun: Boolean(dryRun),
    quality,
    style: plan.style ?? null,
    stages,
    stageCount: stages.length,
    steps,
    cachedStages: steps.filter(s => s.cached).length,
    sourceDuration: meta.duration,
    sourceResolution: `${meta.width}x${meta.height}`,
    duration: got?.duration ?? null,
    width: got?.width ?? null,
    height: got?.height ?? null,
    fps: got?.fps ?? null,
    hasAudio: got?.hasAudio ?? null,
    sizeBytes: got?.sizeBytes ?? null,
    renderMs,
  };
}

export const tool = {
  name: 'render-edit',
  summary: 'Render an edit plan to a finished video, reusing cached stages.',
  args: {
    plan: { positional: 0, required: true, help: 'Path to the edit plan JSON' },
    out: { type: 'string', help: 'Override the output path' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    force: { type: 'bool', default: false, help: 'Ignore cached stages and re-render everything' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
    skipValidation: { type: 'bool', default: false, help: 'Render without validating first (not advised)' },
    dryRun: { type: 'bool', default: false, help: 'List the stages that would run' },
  },
  examples: [
    've render-edit edit-plans/video.json',
    've render-edit edit-plans/video.json --quality preview',
    've render-edit edit-plans/video.json --dry-run',
  ],
  run: opts => renderEdit(opts.plan, opts),
  pretty: r => r.dryRun
    ? `[dry run] ${r.stageCount} stage(s): ${r.stages.join(' -> ')}`
    : `${r.stageCount} stage(s) (${r.cachedStages} cached) -> ${r.output}  ` +
      `${r.width}x${r.height} ${r.duration}s in ${(r.renderMs / 1000).toFixed(1)}s`,
};

runIfMain(tool, import.meta.url);
