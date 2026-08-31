// preview-edit — a fast, low-quality render for checking decisions.
//
// Deliberately a thin wrapper over render-edit rather than a second pipeline:
// a preview that renders differently is a preview you cannot trust. The only
// differences are encode quality and a smaller frame, both of which change how
// it LOOKS, never what it DOES.
import path from 'node:path';
import { loadPlan } from '../lib/edit-plan.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR } from '../lib/paths.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { renderEdit } from './render-edit.mjs';

/** Halve the plan's resolution (rounded to even) for a quicker render. */
export function previewResolution(resolution, scale = 0.5) {
  if (!resolution) return null;
  const m = /^(\d+)x(\d+)$/.exec(String(resolution));
  if (!m) return null;
  const w = Math.max(2, Math.round(Number(m[1]) * scale)) & ~1;
  const h = Math.max(2, Math.round(Number(m[2]) * scale)) & ~1;
  return `${w}x${h}`;
}

export async function previewEdit(planFile, opts = {}) {
  const planPath = resolveInput(planFile, 'plan');
  const plan = loadPlan(planPath);
  const scale = opts.scale ?? 0.5;

  // Render from a temporary copy of the plan so the original is untouched.
  const preview = {
    ...plan,
    output: {
      ...(plan.output || {}),
      resolution: previewResolution(plan.output?.resolution, scale) || plan.output?.resolution || null,
      path: null,
    },
  };

  const tmpPlan = prepareOutput(path.join(DIR.temp, `preview-${slug(planPath)}.json`));
  (await import('node:fs')).writeFileSync(tmpPlan, JSON.stringify(preview, null, 2));

  const out = prepareOutput(
    opts.out || path.join(DIR.output, `${slug(plan.output?.path || plan.source || 'preview')}-preview.mp4`)
  );

  log.info(`preview at ${preview.output.resolution || 'source resolution'} (${Math.round(scale * 100)}%)`);
  const r = await renderEdit(tmpPlan, {
    quality: 'preview',
    out,
    force: opts.force,
    hw: opts.hw,
    skipValidation: opts.skipValidation,
  });

  return {
    ...r,
    preview: true,
    scale,
    fullResolution: plan.output?.resolution ?? null,
    previewResolution: preview.output.resolution ?? null,
  };
}

export const tool = {
  name: 'preview-edit',
  summary: 'Render an edit plan quickly at reduced size, to check it before the real render.',
  args: {
    plan: { positional: 0, required: true, help: 'Path to the edit plan JSON' },
    scale: { type: 'number', default: 0.5, help: 'Fraction of the final resolution' },
    out: { type: 'string', help: 'Output path' },
    force: { type: 'bool', default: false, help: 'Ignore cached stages' },
    skipValidation: { type: 'bool', default: false, help: 'Skip validation' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've preview-edit edit-plans/video.json',
    've preview-edit edit-plans/video.json --scale 0.33',
  ],
  run: opts => previewEdit(opts.plan, opts),
  pretty: r => `preview ${r.width}x${r.height} ${r.duration}s ` +
    `(${r.cachedStages}/${r.stageCount} cached) in ${(r.renderMs / 1000).toFixed(1)}s -> ${r.output}`,
};

runIfMain(tool, import.meta.url);
