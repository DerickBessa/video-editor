// analyze-style — learn the ABSTRACT editing characteristics of a reference.
//
// Explicitly per the brief: this extracts *editing rhythm*, not identity. It
// measures how often the picture changes, how fast the pacing is, whether
// captions are present and where — numbers you could read off any well-edited
// video. It deliberately does NOT copy, fingerprint or reproduce anything
// protected: no frames are kept, no audio is kept, no text is transcribed, no
// visual identity is extracted. The output is a handful of statistics and a
// suggested style preset.
//
// What it measures:
//   cut rhythm     from scene detection: average/median shot length, cuts/min
//   visual change  from frame-difference statistics: how much movement there is
//   speech density from silence detection: how much of the runtime is talking
//
// Caption POSITION is not inferred: that was attempted from band contrast and
// failed in both directions on real files. See detectCaptionBand below.
//
// The result maps onto this project's own style presets, so a reference can be
// turned into a starting point rather than an imitation.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/proc.mjs';
import { FFMPEG } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';
import { detectScenes } from './detect-scenes.mjs';
import { detectSilence } from './detect-silence.mjs';
import { measureMotion } from './analyze-visual.mjs';

/**
 * Band contrast, reported as raw diagnostic data only.
 *
 * REJECTED CLAIM: an earlier version used this to assert where burned-in
 * captions sit. It was tested and it does not work, failing in both directions
 * on real files:
 *   - on a fixture with NO captions it reported "captions in the bottom third"
 *     at 0.59 confidence, because the test pattern simply has more contrast low
 *     in the frame;
 *   - on a genuinely captioned render it reported nothing (0.01), because the
 *     underlying picture was already at maximum contrast everywhere, so text
 *     could not raise it further.
 *
 * Distinguishing caption pixels from busy pixels needs text detection, not
 * contrast statistics. The numbers are still returned because they are cheap
 * and occasionally informative, but nothing downstream draws a conclusion from
 * them. See ROADMAP.md.
 */
export async function detectCaptionBand(file, meta, { samples = 24 } = {}) {
  const bands = {
    bottom: `${meta.width}:${Math.round(meta.height * 0.22)}:0:${Math.round(meta.height * 0.7)}`,
    centre: `${meta.width}:${Math.round(meta.height * 0.22)}:0:${Math.round(meta.height * 0.39)}`,
    top: `${meta.width}:${Math.round(meta.height * 0.22)}:0:${Math.round(meta.height * 0.08)}`,
  };

  const results = {};
  for (const [name, crop] of Object.entries(bands)) {
    const res = await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'info', '-i', file,
      '-vf', `fps=${(samples / Math.max(1, meta.duration)).toFixed(4)},crop=${crop},signalstats,metadata=print:file=-`,
      '-an', '-f', 'null', '-',
    ], { timeoutMs: 900000 });

    const text = `${res.stdout}\n${res.stderr}`;
    const contrasts = [];
    let low = null;
    for (const line of text.split(/\r?\n/)) {
      const lo = /lavfi\.signalstats\.YLOW=(-?[\d.]+)/.exec(line);
      const hi = /lavfi\.signalstats\.YHIGH=(-?[\d.]+)/.exec(line);
      if (lo) low = Number(lo[1]);
      if (hi && low !== null) { contrasts.push(Number(hi[1]) - low); low = null; }
    }
    results[name] = contrasts.length ? mean(contrasts) : 0;
  }

  return {
    bandContrast: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, round(v, 1)])),
    // Deliberately not a caption position. See the note above.
    captionPositionDetected: null,
    note: 'contrast per band only; not a reliable caption indicator',
  };
}

/** Map measurements onto the closest built-in preset. */
export function suggestStyle(m) {
  const reasons = [];
  let style = 'clean';

  if (m.cutsPerMinute >= 12 || m.averageSceneLength < 3) {
    style = 'viral';
    reasons.push(`fast cutting (${m.cutsPerMinute}/min, average shot ${m.averageSceneLength}s)`);
  } else if (m.cutsPerMinute < 2 && m.orientation === 'portrait') {
    style = 'podcast';
    reasons.push('long unbroken takes in a vertical frame');
  } else if (m.speechRatio > 0.85 && m.medianMotion < 4) {
    style = 'educational';
    reasons.push('near-continuous speech over a mostly static picture');
  } else {
    reasons.push(`moderate pacing (${m.cutsPerMinute} cuts/min)`);
  }

  return { style, reasons };
}

/**
 * @param {string} input
 * @param {{out?:string, sampleFps?:number}} opts
 */
export async function analyzeStyle(input, opts = {}) {
  const abs = resolveInput(input, 'reference video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) throw inputError(`${relToRoot(abs)} has no video track`);
  if (meta.duration < 3) throw validationError('the reference is too short to characterise', { duration: meta.duration });

  const scenes = await detectScenes(abs, {}).catch(() => null);
  const frames = await measureMotion(abs, { sampleFps: opts.sampleFps ?? 2 });
  const captions = await detectCaptionBand(abs, meta).catch(() => null);

  let silence = null;
  if (meta.hasAudio) {
    silence = await detectSilence(abs, {}).catch(() => null);
  }

  const lengths = scenes?.scenes.map(s => s.duration) ?? [];
  const motions = frames.map(f => f.YDIF).filter(Number.isFinite);

  const measurements = {
    duration: meta.duration,
    orientation: meta.orientation,
    resolution: `${meta.width}x${meta.height}`,
    fps: meta.fps,

    sceneCount: scenes?.sceneCount ?? null,
    cutCount: scenes?.cutCount ?? 0,
    cutsPerMinute: round((scenes?.cutCount ?? 0) / Math.max(1e-6, meta.duration / 60), 2),
    averageSceneLength: lengths.length ? round(mean(lengths), 2) : round(meta.duration, 2),
    medianSceneLength: lengths.length ? round(median(lengths), 2) : round(meta.duration, 2),
    shortestScene: lengths.length ? round(Math.min(...lengths), 2) : null,

    medianMotion: round(median(motions), 2),
    meanMotion: round(mean(motions), 2),
    visualChangeRate: round(motions.filter(v => v > 8).length / Math.max(1, motions.length), 3),

    speechRatio: silence ? round(1 - silence.silenceRatio, 3) : null,
    silenceRatio: silence ? silence.silenceRatio : null,
    pauseCount: silence?.silenceCount ?? null,

    bandContrast: captions,
  };

  const suggestion = suggestStyle(measurements);

  // The suggested preset, expressed as overrides this project understands.
  const styleOverrides = {
    format: meta.orientation === 'portrait' ? 'short' : 'landscape',
    resolution: meta.orientation === 'portrait' ? `${meta.width}x${meta.height}` : null,
    pace: {
      targetCutsPerMinute: measurements.cutsPerMinute,
      targetSceneLength: measurements.averageSceneLength,
    },
    // Caption position is NOT inferred from the reference — see detectCaptionBand.
    captions: { enabled: true },
  };

  const result = {
    reference: relToRoot(abs),
    note: 'Abstract editing characteristics only. No frames, audio, text or visual identity are retained.',
    measurements,
    estimatedStyle: {
      closestPreset: suggestion.style,
      reasons: suggestion.reasons,
      overrides: styleOverrides,
    },
  };

  const out = prepareOutput(
    opts.out || path.join(ensureDir(path.join(DIR.references, 'analysis')), `${slug(abs)}-style.json`)
  );
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  result.output = relToRoot(out);
  result.path = out;
  return result;
}

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = xs => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const round = (n, p = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : n);

export const tool = {
  name: 'analyze-style',
  summary: 'Measure a reference video\'s editing rhythm and suggest a matching style preset.',
  args: {
    input: { positional: 0, required: true, help: 'Reference video (put them in references/)' },
    sampleFps: { type: 'number', default: 2, help: 'Motion sampling rate' },
    out: { type: 'string', help: 'Output JSON path' },
  },
  examples: [
    've analyze-style references/example.mp4',
    've analyze-style references/example.mp4 | jq .estimatedStyle',
  ],
  run: opts => analyzeStyle(opts.input, opts),
  pretty: r => `${r.measurements.cutsPerMinute} cuts/min, avg shot ${r.measurements.averageSceneLength}s, ` +
    `speech ${r.measurements.speechRatio === null ? 'n/a' : Math.round(r.measurements.speechRatio * 100) + '%'} ` +
    `-> closest preset "${r.estimatedStyle.closestPreset}"`,
};

runIfMain(tool, import.meta.url);
