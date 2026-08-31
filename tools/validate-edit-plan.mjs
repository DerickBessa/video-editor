// validate-edit-plan — refuse to render a plan that cannot work.
//
// A render is minutes of GPU time. Every check here is something that would
// otherwise fail late, or worse, succeed and produce a quietly wrong video:
// a missing sound file, a zoom past the end of the source, an output path
// pointing into raw/, cuts that leave nothing behind.
//
// Exit 0 = renderable. Exit 6 = do not render.
import path from 'node:path';
import { loadPlan, normalizePlan, validatePlan, toCutTimeline, activeStages } from '../lib/edit-plan.mjs';
import { resolveInput, relToRoot, ROOT } from '../lib/paths.mjs';
import { VeError, EXIT } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

/**
 * @param {string} planFile
 * @param {{strict?:boolean}} opts strict = treat warnings as failures
 */
export async function validateEditPlan(planFile, opts = {}) {
  const abs = resolveInput(planFile, 'plan');
  const plan = loadPlan(abs);

  // Probe the source so ranges can be checked against a real duration; without
  // it, half the useful checks are impossible.
  let meta = null;
  if (plan.source) {
    const src = path.resolve(ROOT, plan.source);
    try { meta = await probeVideo(src); } catch { /* reported as a problem below */ }
  }

  const { valid, problems, warnings } = validatePlan(plan, {
    duration: meta?.duration,
    width: meta?.width,
    height: meta?.height,
    hasAudio: meta?.hasAudio,
    root: ROOT,
  });

  const normalized = normalizePlan(plan, { duration: meta?.duration });
  const mapped = meta ? toCutTimeline(plan, { duration: meta.duration }) : null;
  const stages = activeStages(normalized, { sourceDuration: meta?.duration });

  const result = {
    plan: relToRoot(abs),
    source: plan.source,
    valid: valid && (!opts.strict || warnings.length === 0),
    problems,
    warnings,
    problemCount: problems.length,
    warningCount: warnings.length,
    sourceDuration: meta?.duration ?? null,
    estimatedDuration: mapped?.cutDuration ?? meta?.duration ?? null,
    stages,
    stageCount: stages.length,
    droppedEvents: mapped?.dropped ?? [],
  };

  if (!result.valid) {
    const detail = [
      ...problems.map(p => `  - ${p}`),
      ...(opts.strict ? warnings.map(w => `  ! ${w}`) : []),
    ].join('\n');
    throw new VeError(
      `edit plan is not renderable (${problems.length} problem(s)${opts.strict && warnings.length ? `, ${warnings.length} warning(s)` : ''})\n${detail}`,
      { code: EXIT.VALIDATION, details: result }
    );
  }

  for (const w of warnings) log.warn(w);
  return result;
}

export const tool = {
  name: 'validate-edit-plan',
  summary: 'Check an edit plan is renderable before spending time rendering it.',
  args: {
    plan: { positional: 0, required: true, help: 'Path to the edit plan JSON' },
    strict: { type: 'bool', default: false, help: 'Treat warnings as failures too' },
  },
  examples: [
    've validate-edit-plan edit-plans/video.json',
    've validate-edit-plan edit-plans/video.json --strict',
  ],
  run: opts => validateEditPlan(opts.plan, opts),
  pretty: r => `valid — ${r.stageCount} stage(s): ${r.stages.join(' -> ')}  ` +
    `${r.sourceDuration}s -> ~${r.estimatedDuration}s` +
    `${r.warningCount ? `  (${r.warningCount} warning(s))` : ''}`,
};

runIfMain(tool, import.meta.url);
