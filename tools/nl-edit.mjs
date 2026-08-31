// nl-edit — change an edit plan by describing the change.
//
// DIVISION OF LABOUR, stated plainly. Understanding an arbitrary sentence is
// the LLM's job; this tool does not pretend otherwise. What it provides is:
//
//   1. a PRECISE, validated way to mutate a plan (`--set`, `--remove`,
//      `--add`), which is what Claude should drive; and
//   2. pattern matching for a set of instructions people actually repeat, in
//      English and Portuguese, so the common cases work without a model.
//
// Every change is reported as a diff, nothing is written until the result
// validates, and `--dry-run` shows what would happen. A plan that would become
// unrenderable is refused, so an instruction can never quietly break a render.
//
// Because plan timestamps are in SOURCE time (see lib/edit-plan.mjs), an
// instruction like "remove the zoom at 17 seconds" means the obvious thing even
// after cuts have shortened the video.
import fs from 'node:fs';
import path from 'node:path';
import { loadPlan, normalizePlan, validatePlan } from '../lib/edit-plan.mjs';
import { resolveInput, prepareOutput, relToRoot, ROOT } from '../lib/paths.mjs';
import { usageError, VeError, EXIT } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

/* --------------------------------------------------------- path helpers */

/** Read `a.b[0].c` out of an object. */
export function getPath(obj, p) {
  return p.split('.').reduce((o, part) => {
    if (o == null) return undefined;
    const m = /^(\w+)\[(\d+)\]$/.exec(part);
    return m ? o[m[1]]?.[Number(m[2])] : o[part];
  }, obj);
}

/** Write `a.b[0].c`, creating intermediate objects as needed. */
export function setPath(obj, p, value) {
  const parts = p.split('.');
  let node = obj;
  for (const [i, part] of parts.entries()) {
    const m = /^(\w+)\[(\d+)\]$/.exec(part);
    const key = m ? m[1] : part;
    const idx = m ? Number(m[2]) : null;
    const last = i === parts.length - 1;

    if (last) {
      if (idx === null) node[key] = value;
      else { node[key] = node[key] || []; node[key][idx] = value; }
      return obj;
    }
    if (idx === null) {
      if (node[key] == null || typeof node[key] !== 'object') node[key] = {};
      node = node[key];
    } else {
      node[key] = node[key] || [];
      if (node[key][idx] == null) node[key][idx] = {};
      node = node[key][idx];
    }
  }
  return obj;
}

/* ------------------------------------------------------- phrase fragments */

// Verb STEMS, so Portuguese conjugation does not break matching:
// remove / remover / remova / removendo, tira / tirar / tire / tirando.
// NOTE: these are regex SOURCE held in strings, so every backslash must be
// doubled. Writing '\w' here silently yields 'w' and the pattern stops matching.
const DELETE_VERB = String.raw`(?:remov\w*|delet\w*|drop|tir[aeo]\w*|apag\w*|exclu\w*|sem)`;
const ADD_VERB = String.raw`(?:add\w*|put|insert\w*|coloc\w*|adicion\w*|p[oõ]e|inser\w*)`;
// Optional articles and quantifiers in both languages: "the", "all the",
// "o", "os", "todos os", "um", "uma".
const SP = String.raw`\s+`;
const ARTICLE = String.raw`(?:(?:all|todos?|todas?)\s+)?(?:the|os?|as?|um|uma)?\s*`;
// A short bounded gap, so "add a 1.2x zoom" still reaches the noun without the
// pattern turning into a wildcard that matches anything.
const GAP = String.raw`(?:[\w.%]+\s+){0,3}`;

/* ---------------------------------------------------- instruction patterns */

/**
 * Each rule turns one recognised phrasing into concrete plan changes.
 * `test` returns a match, `apply` mutates the plan and returns a description.
 *
 * These are for the phrases that come up over and over. Anything else should
 * go through --set/--remove/--add, driven by whoever understood the sentence.
 */
export const RULES = [
  {
    name: 'remove-zoom-at',
    // "remove the zoom at 17", "tira o zoom entre 17 e 20", "no zoom at 17s"
    // Portuguese conjugates the verb (remove / remover / remova / removendo),
    // so these match STEMS. An exact-form list silently failed on "Remova".
    test: t => new RegExp(`${DELETE_VERB}${SP}${ARTICLE}${GAP}zoom`, 'i').test(t)
      && /(\d+(?:\.\d+)?)/.test(t),
    apply: (plan, t) => {
      const nums = [...t.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
      const [a, b] = nums.length >= 2 ? [nums[0], nums[1]] : [nums[0] - 1.5, nums[0] + 1.5];
      const before = plan.zooms?.length ?? 0;
      plan.zooms = (plan.zooms || []).filter(z => !(z.end > a && z.start < b));
      const removed = before - plan.zooms.length;
      if (!removed) return { changed: false, description: `no zoom overlaps ${a}-${b}s` };
      return { changed: true, description: `removed ${removed} zoom(s) overlapping ${a}-${b}s` };
    },
  },
  {
    name: 'add-zoom-at',
    test: t => new RegExp(`${ADD_VERB}${SP}${ARTICLE}${GAP}zoom`, 'i').test(t)
      && /(\d+(?:\.\d+)?)/.test(t),
    apply: (plan, t) => {
      const nums = [...t.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
      const scaleMatch = /(\d\.\d+)\s*x|(\d+)\s*%/i.exec(t);
      const scale = scaleMatch
        ? (scaleMatch[1] ? Number(scaleMatch[1]) : 1 + Number(scaleMatch[2]) / 100)
        : 1.12;
      const times = nums.filter(n => n !== scale && n < 100000);
      const start = times[0];
      const end = times.length >= 2 && times[1] > start ? times[1] : start + 2;
      if (!Number.isFinite(start)) return { changed: false, description: 'no timestamp found' };
      plan.zooms = [...(plan.zooms || []), { start, end, scale, mode: 'smooth', reason: 'requested' }]
        .sort((x, y) => x.start - y.start);
      return { changed: true, description: `added a ${scale}x zoom from ${start}s to ${end}s` };
    },
  },
  {
    name: 'caption-position',
    // "the caption is too low", "a legenda está muito baixa", "captions higher"
    test: t => /(caption|legenda|subtitle)/i.test(t)
      && /(too\s+low|too\s+high|higher|lower|muito\s+baixa|muito\s+alta|mais\s+alta|mais\s+baixa|sobe|desce)/i.test(t),
    apply: (plan, t) => {
      const up = /(too\s+low|higher|muito\s+baixa|mais\s+alta|sobe)/i.test(t);
      plan.captions = plan.captions || {};
      const current = plan.captions.marginV ?? 0.10;
      // marginV is a fraction of frame height measured from the anchor edge, so
      // for bottom-anchored captions a BIGGER margin moves them UP.
      const next = Math.min(0.45, Math.max(0.02, current + (up ? 0.06 : -0.06)));
      plan.captions.marginV = round(next);
      plan.captions.enabled = true;
      return { changed: true, description: `moved captions ${up ? 'up' : 'down'} (margin ${current} -> ${next})` };
    },
  },
  {
    name: 'caption-size',
    test: t => /(caption|legenda|subtitle)/i.test(t)
      && /(bigger|larger|smaller|maior|menor|aumenta|diminui)/i.test(t),
    apply: (plan, t) => {
      const bigger = /(bigger|larger|maior|aumenta)/i.test(t);
      plan.captions = plan.captions || {};
      const current = plan.captions.fontSize ?? 0.045;
      const next = Math.min(0.12, Math.max(0.02, current * (bigger ? 1.25 : 0.8)));
      plan.captions.fontSize = round(next, 4);
      plan.captions.enabled = true;
      return { changed: true, description: `made captions ${bigger ? 'bigger' : 'smaller'} (${current} -> ${round(next, 4)} of frame height)` };
    },
  },
  {
    name: 'caption-style',
    test: t => /(caption|legenda|subtitle)/i.test(t)
      && /(clean|viral|minimal|bold|karaoke)/i.test(t),
    apply: (plan, t) => {
      const style = /(clean|viral|minimal|bold|karaoke)/i.exec(t)[1].toLowerCase();
      plan.captions = { ...(plan.captions || {}), enabled: true, style };
      return { changed: true, description: `switched captions to the "${style}" style` };
    },
  },
  {
    name: 'speed-range',
    // "make the first five seconds faster", "deixe os primeiros 5 segundos mais rápidos"
    test: t => /(faster|slower|speed|mais\s+r[aá]pid|mais\s+lent|acelera|desacelera)/i.test(t),
    apply: (plan, t) => {
      const faster = /(faster|speed\s*up|mais\s+r[aá]pid|acelera)/i.test(t);
      const explicit = /(\d+(?:\.\d+)?)\s*x/i.exec(t);
      const rate = explicit ? Number(explicit[1]) : (faster ? 1.15 : 0.85);
      plan.speed = [{ rate, preservePitch: true }];
      return { changed: true, description: `set the overall pace to ${rate}x` };
    },
  },
  {
    name: 'silence-intensity',
    test: t => /(silence|sil[êe]ncio|pause|pausa)/i.test(t)
      && /(more|less|aggressive|gentle|mais|menos|agressiv|suave)/i.test(t),
    apply: (plan, t) => {
      const more = /(more|aggressive|mais|agressiv)/i.test(t);
      const note = more
        ? 'cut pauses harder: re-run edit-video with --style viral, or lower cuts.minSilence'
        : 'keep more pauses: re-run edit-video with a softer style';
      plan.meta = plan.meta || {};
      plan.meta.notes = [...(plan.meta.notes || []), note];
      return {
        changed: true,
        description: `noted the request (${more ? 'more' : 'less'} aggressive silence removal)`,
        warning: 'silence ranges come from detection, so this is recorded as a note rather than applied directly',
      };
    },
  },
  {
    name: 'remove-sfx-at',
    test: t => new RegExp(`${DELETE_VERB}${SP}${ARTICLE}(sfx|sound|effect|efeito|som)`, 'i').test(t),
    apply: (plan, t) => {
      const nums = [...t.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
      if (!nums.length) {
        const n = plan.sfx?.length ?? 0;
        plan.sfx = [];
        return { changed: n > 0, description: `removed all ${n} sound effect(s)` };
      }
      const [a, b] = nums.length >= 2 ? [nums[0], nums[1]] : [nums[0] - 1, nums[0] + 1];
      const before = plan.sfx?.length ?? 0;
      plan.sfx = (plan.sfx || []).filter(s => {
        const t0 = s.timestamp ?? s.time;
        return !(t0 >= a && t0 <= b);
      });
      return { changed: before !== plan.sfx.length, description: `removed ${before - plan.sfx.length} effect(s) between ${a}s and ${b}s` };
    },
  },
  {
    name: 'no-captions',
    test: t => new RegExp(`(?:no|without|${DELETE_VERB})${SP}${ARTICLE}(caption|legenda|subtitle)`, 'i').test(t),
    apply: plan => {
      const was = plan.captions?.enabled;
      plan.captions = { ...(plan.captions || {}), enabled: false };
      return { changed: Boolean(was), description: 'turned captions off' };
    },
  },
  {
    name: 'no-zooms',
    test: t => new RegExp(`(?:no|without|${DELETE_VERB})${SP}${ARTICLE}zoom`, 'i').test(t) && !/\d/.test(t),
    apply: plan => {
      const n = plan.zooms?.length ?? 0;
      plan.zooms = [];
      return { changed: n > 0, description: `removed all ${n} zoom(s)` };
    },
  },
];

/**
 * @param {string} planFile
 * @param {{instruction?:string, set?:string, remove?:string, add?:string,
 *          dryRun?:boolean, out?:string}} opts
 */
export async function nlEdit(planFile, opts = {}) {
  const planPath = resolveInput(planFile, 'plan');
  const original = loadPlan(planPath);
  const plan = JSON.parse(JSON.stringify(original));
  const changes = [];
  const warnings = [];

  /* ------------------------------------------- precise, machine-driven edits */

  if (opts.set) {
    for (const pair of String(opts.set).split(';')) {
      const i = pair.indexOf('=');
      if (i === -1) throw usageError(`--set expects PATH=VALUE, got "${pair}"`);
      const p = pair.slice(0, i).trim();
      const raw = pair.slice(i + 1).trim();
      let value;
      try { value = JSON.parse(raw); } catch { value = raw; }
      const before = getPath(plan, p);
      setPath(plan, p, value);
      changes.push({ kind: 'set', path: p, from: before, to: value });
    }
  }

  if (opts.remove) {
    for (const p of String(opts.remove).split(';').map(s => s.trim()).filter(Boolean)) {
      const m = /^(\w+(?:\.\w+)*)\[(\d+)\]$/.exec(p);
      if (m) {
        const arr = getPath(plan, m[1]);
        if (!Array.isArray(arr)) throw usageError(`--remove "${p}": ${m[1]} is not an array`);
        const removed = arr.splice(Number(m[2]), 1);
        changes.push({ kind: 'remove', path: p, from: removed[0] });
      } else {
        const before = getPath(plan, p);
        setPath(plan, p, undefined);
        changes.push({ kind: 'remove', path: p, from: before });
      }
    }
  }

  if (opts.add) {
    const i = String(opts.add).indexOf('=');
    if (i === -1) throw usageError('--add expects PATH=JSON');
    const p = String(opts.add).slice(0, i).trim();
    const value = JSON.parse(String(opts.add).slice(i + 1).trim());
    // An array VALUE appends its elements, not itself: `--add 'zooms=[{...}]'`
    // should add one zoom, not one array-shaped zoom.
    const items = Array.isArray(value) ? value : [value];
    const arr = getPath(plan, p);
    if (arr === undefined) setPath(plan, p, items);
    else if (Array.isArray(arr)) arr.push(...items);
    else throw usageError(`--add "${p}": that path is not an array`);
    changes.push({ kind: 'add', path: p, to: items, count: items.length });
  }

  /* ------------------------------------------------- natural-language rules */

  let matched = null;
  if (opts.instruction) {
    const t = opts.instruction.trim();
    for (const rule of RULES) {
      if (!rule.test(t)) continue;
      const res = rule.apply(plan, t);
      matched = rule.name;
      changes.push({ kind: 'rule', rule: rule.name, description: res.description, applied: res.changed });
      if (res.warning) warnings.push(res.warning);
      break;
    }
    if (!matched) {
      throw new VeError(
        `No rule understood: "${t}"`,
        {
          code: EXIT.USAGE,
          hint: 'This tool only pattern-matches common phrasings. For anything else, express the ' +
            'change precisely:\n' +
            '  --set "captions.style=\\"viral\\";captions.maxWords=3"\n' +
            '  --add \'zooms=[{"start":5,"end":7,"scale":1.12}]\'\n' +
            '  --remove "zooms[0]"\n' +
            `Recognised phrasings: ${RULES.map(r => r.name).join(', ')}`,
        }
      );
    }
  }

  if (!changes.length) throw usageError('Nothing to do', 'Give an instruction, or --set/--add/--remove.');

  /* ---------------------------------------------------------- validate */

  let meta = null;
  if (plan.source) {
    try { meta = await probeVideo(path.resolve(ROOT, plan.source)); } catch { /* validated below */ }
  }
  const check = validatePlan(plan, {
    duration: meta?.duration, hasAudio: meta?.hasAudio, root: ROOT,
  });

  if (!check.valid) {
    throw new VeError(
      `that change would make the plan unrenderable:\n${check.problems.map(p => `  - ${p}`).join('\n')}`,
      { code: EXIT.VALIDATION, details: { changes, problems: check.problems } }
    );
  }

  const result = {
    plan: relToRoot(planPath),
    instruction: opts.instruction ?? null,
    matchedRule: matched,
    changes,
    changeCount: changes.length,
    warnings: [...warnings, ...check.warnings],
    valid: true,
    dryRun: Boolean(opts.dryRun),
  };

  if (opts.dryRun) return result;

  const out = prepareOutput(opts.out || planPath);
  fs.writeFileSync(out, JSON.stringify(plan, null, 2));
  result.output = relToRoot(out);

  for (const w of result.warnings) log.warn(w);
  log.info('re-render with: ve render-edit ' + relToRoot(out));
  return result;
}

const round = (n, p = 3) => Math.round(n * 10 ** p) / 10 ** p;

export const tool = {
  name: 'nl-edit',
  summary: 'Change an edit plan from an instruction, or from a precise path expression.',
  args: {
    plan: { positional: 0, required: true, help: 'Edit plan JSON to modify' },
    instruction: { positional: 1, help: 'What to change, in words' },
    set: { type: 'string', help: 'PATH=VALUE, semicolon-separated. VALUE is parsed as JSON.' },
    add: { type: 'string', help: 'PATH=JSON — append to an array in the plan' },
    remove: { type: 'string', help: 'PATH or PATH[i], semicolon-separated' },
    dryRun: { type: 'bool', default: false, help: 'Show the change without writing it' },
    out: { type: 'string', help: 'Write to a different file instead of in place' },
  },
  examples: [
    've nl-edit edit-plans/video.json "remove the zoom between 17 and 20 seconds"',
    've nl-edit edit-plans/video.json "a legenda está muito baixa"',
    've nl-edit edit-plans/video.json --set \'captions.style="viral";captions.maxWords=3\'',
    've nl-edit edit-plans/video.json --add \'zooms=[{"start":5,"end":7,"scale":1.12}]\'',
  ],
  run: opts => nlEdit(opts.plan, { ...opts, instruction: opts.instruction || opts._?.[1] }),
  pretty: r => `${r.changeCount} change(s)${r.matchedRule ? ` via "${r.matchedRule}"` : ''}: ` +
    r.changes.map(c => c.description || `${c.kind} ${c.path}`).join('; ') +
    (r.dryRun ? '  [dry run]' : ` -> ${r.output}`),
};

runIfMain(tool, import.meta.url);
