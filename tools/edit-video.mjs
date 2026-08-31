// edit-video — the orchestrator. Raw footage in, finished video out.
//
//   probe -> transcribe -> detect silence/scenes -> BUILD A PLAN -> validate
//         -> render -> QA -> reasoning log
//
// The plan is the point. This tool does not render anything itself; it decides
// WHAT to do, writes that decision down as an edit plan, and hands it to
// render-edit. Everything is therefore inspectable and re-runnable: you can
// read the plan, change one number, and re-render only what that number
// touched. It also means a natural-language instruction later only has to
// patch JSON.
//
// The decisions here are deliberately mechanical — thresholds and densities
// from the chosen style, applied to measurements. That keeps the whole thing
// reproducible. Claude's judgement enters by editing the plan afterwards, or
// by passing --keywords, not by being in the middle of the render loop.
import fs from 'node:fs';
import path from 'node:path';
import { loadStyle, listStyles } from '../lib/styles.mjs';
import { emptyPlan, normalizePlan, activeStages } from '../lib/edit-plan.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir, ROOT } from '../lib/paths.mjs';
import { timecode, totalDuration } from '../lib/ranges.mjs';
import { usageError, VeError, EXIT } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { transcribe, flattenWords } from './transcribe.mjs';
import { detectSilence } from './detect-silence.mjs';
import { detectScenes } from './detect-scenes.mjs';
import { detectKeywords } from './detect-keywords.mjs';
import { findFillers } from './remove-fillers.mjs';
import { INTENSITY } from './remove-silence.mjs';
import { renderEdit } from './render-edit.mjs';
import { qaVideo } from './qa-video.mjs';
import { contactSheet } from './contact-sheet.mjs';

/**
 * @param {string} input
 * @param {{style?:string, out?:string, language?:string, prompt?:string, keywords?:string,
 *          quality?:string, planOnly?:boolean, skipQa?:boolean, sheet?:boolean,
 *          resolution?:string, force?:boolean}} opts
 */
export async function editVideo(input, opts = {}) {
  const styleName = opts.style || 'clean';
  const style = loadStyle(styleName);
  if (!style) throw usageError(`Unknown style "${styleName}"`, `Available: ${listStyles().join(', ')}`);

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  const decisions = [];
  const t0 = Date.now();

  log.info(`editing ${relToRoot(abs)} in "${styleName}" style — ${style.description}`);

  /* ---------------------------------------------------- 1. understand it */

  const analysis = { duration: meta.duration, resolution: `${meta.width}x${meta.height}` };

  let transcript = null;
  let words = [];
  if (meta.hasAudio) {
    transcript = await transcribe(abs, { language: opts.language, prompt: opts.prompt });
    words = flattenWords(transcript);
    analysis.language = transcript.language;
    analysis.wordCount = transcript.wordCount;
    log.info(`transcript: ${transcript.wordCount} words, ${transcript.language}`);
  } else {
    log.warn('no audio track — captions, silence removal and keywords are unavailable');
  }

  let silence = null;
  if (meta.hasAudio && style.silence?.enabled) {
    const preset = INTENSITY[style.silence.intensity] || INTENSITY.normal;
    silence = await detectSilence(abs, {
      minDuration: preset.minDuration,
      paddingBefore: preset.paddingBefore,
      paddingAfter: preset.paddingAfter,
    });
    analysis.silenceCount = silence.silenceCount;
    analysis.silenceTotal = silence.silenceTotal;
  }

  const scenes = await detectScenes(abs, {}).catch(() => null);
  if (scenes) analysis.sceneCount = scenes.sceneCount;

  /* ------------------------------------------------------- 2. decide */

  const plan = emptyPlan(relToRoot(abs));
  plan.style = styleName;
  plan.meta.notes = [];
  plan.meta.generatedBy = 'edit-video';
  plan.output.resolution = opts.resolution || style.resolution || null;

  // --- cuts: silence
  if (silence) {
    plan.cuts.silences = silence.silences.map(s => ({ start: s.start, end: s.end }));
    decisions.push({
      stage: 'silence',
      summary: `removed ${silence.silenceCount} silent stretch(es), ${silence.silenceTotal}s`,
      detail: silence.silences.slice(0, 20).map(s =>
        `${timecode(s.start)}-${timecode(s.end)}  removed ${s.duration.toFixed(2)}s of silence`),
    });
  }

  // --- cuts: fillers
  if (words.length && style.fillers?.level && style.fillers.level !== 'off') {
    // Anything the user named in --prompt or --keywords, plus the style's own
    // vocabulary, is protected from filler removal. Rare proper nouns get low
    // recognition confidence, which is exactly what the filler heuristics look
    // for — without this, "Claude Code" loses its second word.
    const protect = [
      ...(opts.prompt ? [opts.prompt] : []),
      ...(opts.keywords ? [opts.keywords] : []),
      ...(style.keywords || []),
    ];
    const found = findFillers(words, {
      language: transcript?.language, level: style.fillers.level, protect,
    });
    const min = style.fillers.level === 'aggressive' ? 0.5 : 0.85;
    const accepted = found.filter(f => f.confidence >= min);
    if (accepted.length) {
      plan.cuts.fillers = accepted.map(f => ({ start: Math.max(0, f.start - 0.03), end: f.end + 0.03 }));
      decisions.push({
        stage: 'fillers',
        summary: `removed ${accepted.length} filler(s) at level "${style.fillers.level}"`,
        detail: accepted.map(f => `${timecode(f.start)}  removed "${f.text}" (${f.kind}) — ${f.reasons.join('; ')}`),
      });
    }
  }

  // --- crop
  if (style.crop) {
    plan.crop = { ...style.crop };
    decisions.push({
      stage: 'crop',
      summary: `reframed ${meta.width}x${meta.height} to ${plan.output.resolution || style.crop.aspect} (${style.crop.mode})`,
      detail: [style.crop.mode === 'contain'
        ? 'used contain with a blurred fill so screen content stays readable'
        : style.crop.mode === 'smart'
          ? 'tracking the speaker so they stay in frame'
          : 'centre crop'],
    });
  }

  // --- speed
  if (style.speed?.rate && Math.abs(style.speed.rate - 1) > 1e-6) {
    plan.speed = [{ rate: style.speed.rate }];
    decisions.push({ stage: 'speed', summary: `${style.speed.rate}x overall pace`, detail: [] });
  }

  // --- keywords, needed by captions and zooms
  let keywords = [];
  if (words.length && (style.captions?.highlightKeywords || style.zoom?.enabled)) {
    const kw = await detectKeywords(abs, {
      transcript: transcript.path,
      perMinute: style.captions?.keywordsPerMinute ?? 8,
      extra: [opts.keywords, (style.keywords || []).join(',')].filter(Boolean).join(','),
    });
    keywords = kw.keywords;
    analysis.keywordCount = keywords.length;
  }

  // --- zooms, placed on the strongest keywords
  if (style.zoom?.enabled && keywords.length) {
    const perMinute = style.zoom.perMinute ?? 5;
    const budget = Math.max(1, Math.round((meta.duration / 60) * perMinute));
    const picked = [...keywords]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, budget)
      .sort((a, b) => a.start - b.start);

    // Zooms must not overlap, and must not start before the previous one ended.
    const zooms = [];
    for (const k of picked) {
      const start = Math.max(0, k.start - 0.35);
      const end = Math.min(meta.duration, k.end + 1.1);
      const prev = zooms[zooms.length - 1];
      if (prev && start < prev.end + 0.2) continue;
      if (end - start < 0.6) continue;
      zooms.push({
        start: round(start), end: round(end),
        scale: style.zoom.strength ?? 1.1,
        mode: style.zoom.mode || 'smooth',
        reason: `emphasis on "${k.text}"`,
      });
    }
    plan.zooms = zooms;
    if (zooms.length) {
      decisions.push({
        stage: 'zoom',
        summary: `${zooms.length} zoom(s) at ${style.zoom.strength}x`,
        detail: zooms.map(z => `${timecode(z.start)}  zoom ${z.scale}x — ${z.reason}`),
      });
    }
  }

  // --- captions
  if (meta.hasAudio && style.captions?.enabled) {
    plan.captions = {
      enabled: true,
      style: style.captions.style,
      maxWords: style.captions.maxWords,
      language: opts.language || transcript?.language,
      prompt: opts.prompt,
      keywords: style.captions.highlightKeywords ? keywords.map(k => k.text) : [],
    };
    decisions.push({
      stage: 'captions',
      summary: `${style.captions.style} captions, up to ${style.captions.maxWords} words per cue` +
        (style.captions.highlightKeywords ? `, highlighting ${keywords.length} keyword(s)` : ''),
      detail: style.captions.highlightKeywords
        ? [`highlighted: ${keywords.map(k => k.text).join(', ')}`]
        : [],
    });
  }

  // --- audio
  if (meta.hasAudio && style.audio?.normalize) {
    plan.audio = { normalize: true, targetLufs: style.audio.targetLufs ?? -16 };
    decisions.push({ stage: 'audio', summary: `normalised to ${plan.audio.targetLufs} LUFS`, detail: [] });
  }

  // --- sfx, on the very strongest beats only
  if (style.sfx?.enabled && keywords.length) {
    const perMinute = style.sfx.perMinute ?? 4;
    const budget = Math.max(1, Math.round((meta.duration / 60) * perMinute));
    const picked = [...keywords].sort((a, b) => b.importance - a.importance).slice(0, budget);
    plan.sfx = picked
      .sort((a, b) => a.start - b.start)
      .map(k => ({
        timestamp: round(k.start), sound: style.sfx.sound || 'pop',
        volume: 0.35, priority: k.importance, reason: `beat on "${k.text}"`,
      }));
    plan.sfxDensity = perMinute;
    if (plan.sfx.length) {
      decisions.push({
        stage: 'sfx',
        summary: `${plan.sfx.length} effect(s) at ${perMinute}/min`,
        detail: plan.sfx.map(s => `${timecode(s.timestamp)}  ${s.sound} — ${s.reason}`),
      });
    }
  }

  const outPath = prepareOutput(opts.out || path.join(DIR.output, `${slug(abs)}-${styleName}.mp4`));
  plan.output.path = relToRoot(outPath);

  const normalized = normalizePlan(plan, { duration: meta.duration });
  const stages = activeStages(normalized, { sourceDuration: meta.duration });
  const estimated = normalized.keepRanges ? totalDuration(normalized.keepRanges) : meta.duration;

  const planPath = prepareOutput(path.join(ensureDir(DIR.editPlans), `${slug(abs)}-${styleName}.json`));
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  log.ok(`plan: ${relToRoot(planPath)} — ${stages.length} stage(s), ~${estimated.toFixed(1)}s`);

  // The reasoning log records observable decisions only, never internal
  // deliberation — it is meant to be read while watching the video.
  const reasoningPath = planPath.replace(/\.json$/, '.reasoning.md');
  fs.writeFileSync(reasoningPath, renderReasoning({
    source: relToRoot(abs), style, styleName, meta, analysis, decisions, estimated, stages,
  }));

  const base = {
    source: relToRoot(abs),
    style: styleName,
    plan: relToRoot(planPath),
    planPath,
    reasoning: relToRoot(reasoningPath),
    analysis,
    decisions: decisions.map(d => ({ stage: d.stage, summary: d.summary })),
    stages,
    sourceDuration: meta.duration,
    estimatedDuration: round(estimated),
  };

  if (opts.planOnly) return { ...base, planOnly: true, elapsedMs: Date.now() - t0 };

  /* ------------------------------------------------------- 3. render */

  const render = await renderEdit(planPath, {
    quality: opts.quality || 'final',
    out: outPath,
    force: opts.force,
    hw: opts.hw,
  });

  /* ----------------------------------------------------------- 4. QA */

  let qa = null;
  if (!opts.skipQa) {
    qa = await qaVideo(outPath, {
      expectDuration: estimated,
      durationTolerance: Math.max(1.0, estimated * 0.12),
      requireAudio: meta.hasAudio,
      strict: false,     // report, do not throw; the caller decides
    });
    if (!qa.passed) {
      log.warn(`QA found ${qa.failureCount} problem(s): ${qa.failures.join('; ')}`);
    }
  }

  let sheet = null;
  if (opts.sheet) sheet = await contactSheet(outPath, {}).catch(e => { log.warn(`contact sheet failed: ${e.message}`); return null; });

  return {
    ...base,
    output: render.output,
    path: render.path,
    duration: render.duration,
    width: render.width,
    height: render.height,
    fps: render.fps,
    hasAudio: render.hasAudio,
    sizeBytes: render.sizeBytes,
    renderMs: render.renderMs,
    cachedStages: render.cachedStages,
    qa: qa ? { passed: qa.passed, failures: qa.failures, warnings: qa.warnings, report: qa.report } : null,
    contactSheet: sheet?.output ?? null,
    elapsedMs: Date.now() - t0,
  };
}

/* ------------------------------------------------------- reasoning log */

export function renderReasoning({ source, style, styleName, meta, analysis, decisions, estimated, stages }) {
  const L = [];
  L.push(`# Edit decisions — ${source}`);
  L.push('');
  L.push(`**Style:** \`${styleName}\` — ${style.description}`);
  L.push(`**Source:** ${meta.width}x${meta.height}, ${meta.duration}s` +
    (analysis.language ? `, ${analysis.language}` : ''));
  L.push(`**Result:** ~${estimated.toFixed(1)}s after cuts ` +
    `(${Math.round((1 - estimated / meta.duration) * 100)}% shorter)`);
  L.push(`**Stages:** ${stages.join(' → ')}`);
  L.push('');
  L.push('---');
  L.push('');

  if (!decisions.length) {
    L.push('_No changes were needed._');
  }

  for (const d of decisions) {
    L.push(`## ${d.stage}`);
    L.push('');
    L.push(d.summary);
    if (d.detail?.length) {
      L.push('');
      L.push('```');
      // Keep the log readable: a 10-minute video can have hundreds of cuts.
      for (const line of d.detail.slice(0, 40)) L.push(line);
      if (d.detail.length > 40) L.push(`... and ${d.detail.length - 40} more`);
      L.push('```');
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('Timestamps refer to the ORIGINAL recording, not the edited result.');
  L.push('Edit the plan JSON beside this file and re-run `ve render-edit` to change any of it.');
  return L.join('\n');
}

const round = n => Math.round(n * 1000) / 1000;

export const tool = {
  name: 'edit-video',
  summary: 'Analyse, plan, render and QA a video in one command.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    style: { type: 'string', default: 'clean', help: `Editing mode: ${listStyles().join(', ')}` },
    out: { type: 'string', help: 'Output path' },
    resolution: { type: 'string', help: 'Override the style resolution, e.g. 1080x1920' },
    language: { type: 'string', help: 'Language hint for transcription' },
    prompt: { type: 'string', help: 'Vocabulary prompt, e.g. product and tool names' },
    keywords: { type: 'string', help: 'Extra words to always highlight' },
    quality: { type: 'enum', values: ['preview', 'final'], default: 'final', help: 'Encode quality intent' },
    planOnly: { type: 'bool', default: false, help: 'Write the plan and reasoning, do not render' },
    skipQa: { type: 'bool', default: false, help: 'Skip the QA pass' },
    sheet: { type: 'bool', default: false, help: 'Also build a contact sheet of the result' },
    force: { type: 'bool', default: false, help: 'Ignore cached render stages' },
    hw: { type: 'enum', values: ['auto', 'off'], default: 'auto', help: 'Hardware encoding' },
  },
  examples: [
    've edit-video raw/test.mp4 --style clean',
    've edit-video raw/test.mp4 --style viral --language pt',
    've edit-video raw/test.mp4 --style coding --plan-only   # inspect before rendering',
  ],
  run: opts => editVideo(opts.input, opts),
  pretty: r => r.planOnly
    ? `plan written: ${r.plan} (${r.stages.length} stages, ~${r.estimatedDuration}s)`
    : `${r.output}  ${r.width}x${r.height} ${r.duration}s  ` +
      `${r.qa ? (r.qa.passed ? 'QA pass' : `QA FAIL (${r.qa.failures.length})`) : 'no QA'}  ` +
      `in ${(r.elapsedMs / 1000).toFixed(1)}s`,
};

runIfMain(tool, import.meta.url);
