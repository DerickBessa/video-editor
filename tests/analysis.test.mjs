// Phase 7 analysis + B-roll: track-faces, analyze-visual, add-broll, analyze-style.
//
// There is no real footage of a person in this repo, so nothing here asserts
// anything about face-detection ACCURACY — that is OpenCV's, and untested by
// this project. What IS asserted: the tools report honestly when they find
// nothing, the derived statistics are correct, and the compositing works.
import fs from 'node:fs';
import path from 'node:path';
import { test, eq, near, assert, verifyMedia, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { buildSpeechFixture } from './speech-fixture.mjs';
import { trackFaces, classify, findPresenceChanges } from '../tools/track-faces.mjs';
import { analyzeVisual, motionLabel, facePositionLabel, measureMotion } from '../tools/analyze-visual.mjs';
import { addBroll, suggest, parseEvents, listBroll } from '../tools/add-broll.mjs';
import { analyzeStyle, suggestStyle } from '../tools/analyze-style.mjs';
import { modes } from '../tools/modes.mjs';
import { run } from '../lib/proc.mjs';
import { FFMPEG } from '../lib/ffmpeg.mjs';
import { EXIT } from '../lib/errors.mjs';

const face = (cx, cy, area = 0.06) => ({ cx, cy, area, x: 0, y: 0, w: 1, h: 1, score: 0.9 });
const sample = (t, faces) => ({ t, frame: Math.round(t * 30), faces });

async function psnr(a, b, at) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-t', '0.5', '-i', a,
    '-ss', String(at), '-t', '0.5', '-i', b, '-lavfi', 'psnr', '-f', 'null', '-',
  ], { timeoutMs: 300000 });
  const m = /average:([0-9.]+|inf)/.exec(stderr);
  return m ? (m[1] === 'inf' ? Infinity : Number(m[1])) : null;
}

/* ------------------------------------------------------------ track-faces */

test('classify names the kind of shot', () => {
  const close = classify(Array.from({ length: 20 }, (_, i) => sample(i * 0.2, [face(0.5, 0.5, 0.09)])), { coverage: 1 });
  eq(close.kind, 'talking-head');
  eq(close.singleSubject, true);

  const two = classify(Array.from({ length: 20 }, (_, i) => sample(i * 0.2, [face(0.3, 0.5), face(0.7, 0.5)])), { coverage: 1 });
  eq(two.kind, 'multi-person');
  eq(two.singleSubject, false, 'two faces must not be reported as a single subject');
  eq(two.maxSimultaneousFaces, 2);

  const none = classify(Array.from({ length: 20 }, (_, i) => sample(i * 0.2, [])), { coverage: 0 });
  eq(none.kind, 'no-subject');
});

test('classify separates a close-up from a wide shot', () => {
  const wide = classify(Array.from({ length: 20 }, (_, i) => sample(i * 0.2, [face(0.5, 0.5, 0.004)])), { coverage: 1 });
  eq(wide.kind, 'wide-shot');
});

test('presence changes mark people entering and leaving', () => {
  const samples = [
    sample(0, [face(0.5, 0.5)]), sample(1, [face(0.5, 0.5)]),
    sample(2, [face(0.3, 0.5), face(0.7, 0.5)]),
    sample(3, [face(0.3, 0.5), face(0.7, 0.5)]),
    sample(4, [face(0.3, 0.5)]),
  ];
  const changes = findPresenceChanges(samples);
  eq(changes.length, 2);
  eq(changes[0].kind, 'entered'); eq(changes[0].to, 2);
  eq(changes[1].kind, 'left'); eq(changes[1].to, 1);
});

test('track-faces reports honestly when there is no subject', async () => {
  const r = await trackFaces(await fixture('scenes'), { out: tmp('an-track.json') });
  eq(r.shot.kind, 'no-subject', 'synthetic patterns contain no faces');
  eq(r.coverage, 0);
  assert(r.track.length > 0, 'a track should still be produced, holding a default position');
  assert(fs.existsSync(r.path));
});

test('track-faces caches its detection', async () => {
  const src = await fixture('scenes');
  const first = await trackFaces(src, { force: true, out: tmp('an-t1.json') });
  const second = await trackFaces(src, { out: tmp('an-t2.json') });
  eq(second.sampleCount, first.sampleCount);
  eq(second.cacheKey, first.cacheKey);
});

/* --------------------------------------------------------- analyze-visual */

test('motionLabel bands are ordered', () => {
  eq(motionLabel(0.5), 'static');
  eq(motionLabel(5), 'low');
  eq(motionLabel(12), 'medium');
  eq(motionLabel(40), 'high');
  eq(motionLabel(NaN), 'unknown');
});

test('facePositionLabel maps normalised coordinates to words', () => {
  eq(facePositionLabel(0.5, 0.5), 'center');
  eq(facePositionLabel(0.2, 0.5), 'left');
  eq(facePositionLabel(0.5, 0.2), 'top-center');
  eq(facePositionLabel(0.8, 0.8), 'bottom-right');
  eq(facePositionLabel(null, null), null);
});

test('measureMotion returns a per-sample timeline', async () => {
  const frames = await measureMotion(await fixture('scenes'), { sampleFps: 2 });
  assert(frames.length >= 20, `expected ~24 samples, got ${frames.length}`);
  assert(frames.every(f => Number.isFinite(f.t)), 'every sample needs a timestamp');
  assert(frames.some(f => Number.isFinite(f.YDIF)), 'motion should be measured');
});

test('motion spikes exactly at the known cuts', async () => {
  const r = await analyzeVisual(await fixture('scenes'), { sampleFps: 2, faces: false, out: tmp('an-vis.json') });
  eq(JSON.stringify(r.cuts), '[3,6,9]', 'the known cut points');
  for (const cut of [3, 6, 9]) {
    const at = r.timeline.find(row => Math.abs(row.timestamp - cut) < 0.3);
    assert(at && at.motionValue > 20, `a cut at ${cut}s should register high motion, got ${at?.motionValue}`);
  }
});

test('a static shot is reported as a static stretch', async () => {
  // The fixture opens with 3s of flat colour.
  const r = await analyzeVisual(await fixture('scenes'), { sampleFps: 2, faces: false, out: tmp('an-vis2.json') });
  assert(r.staticRuns.length >= 1, 'the flat opening shot should be found');
  eq(r.staticRuns[0].start, 0);
  assert(r.staticRuns[0].duration >= 2.5, `expected a ~3s static run, got ${r.staticRuns[0].duration}`);
});

test('analyze-visual works without face detection', async () => {
  const r = await analyzeVisual(await fixture('landscape'), { sampleFps: 1, faces: false, scenes: false, out: tmp('an-vis3.json') });
  eq(r.summary.faceCoverage, null);
  eq(r.summary.sceneCount, null);
  assert(r.timeline.length > 5, 'the motion timeline should still be produced');
});

/* --------------------------------------------------------------- add-broll */

test('suggest matches spoken words against asset tags', () => {
  const words = [
    { word: 'abra', start: 1, end: 1.3 },
    { word: 'o', start: 1.4, end: 1.5 },
    { word: 'terminal', start: 1.6, end: 2.1 },
    { word: 'e', start: 2.2, end: 2.3 },
  ];
  const out = suggest(words, {
    assets: ['terminal.mp4', 'docker.mp4'],
    manifest: { 'terminal.mp4': { tags: ['terminal', 'shell'] } },
    duration: 60,
  });
  eq(out.length, 1);
  assert(out[0].asset.includes('terminal.mp4'));
  assert(out[0].reason.includes('terminal'), out[0].reason);
});

test('suggest respects the density cap and the minimum gap', () => {
  const words = Array.from({ length: 40 }, (_, i) => ({ word: 'terminal', start: i * 1.0, end: i * 1.0 + 0.4 }));
  const out = suggest(words, {
    assets: ['terminal.mp4'], manifest: {}, duration: 60, maxPerMinute: 3, minGap: 6,
  });
  assert(out.length <= 3, `expected at most 3 per minute, got ${out.length}`);
  for (let i = 1; i < out.length; i++) {
    assert(out[i].start - out[i - 1].start >= 6, 'placements must be spaced out');
  }
});

test('suggest returns nothing when no asset matches', () => {
  const words = [{ word: 'gato', start: 1, end: 1.4 }];
  eq(suggest(words, { assets: ['terminal.mp4'], manifest: {}, duration: 60 }).length, 0);
});

test('parseEvents rejects overlapping or malformed placements', () => {
  for (const bad of ['garbage', '[{"asset":"a.mp4","start":5,"end":3}]', '[{"start":1,"end":2}]']) {
    let threw = false;
    try { parseEvents(bad); } catch { threw = true; }
    assert(threw, `should reject ${bad}`);
  }
});

test('B-roll actually takes the screen for its window', async () => {
  const assets = listBroll();
  assert(assets.length > 0, 'the test needs at least one clip in assets/broll/');
  const { video } = await buildSpeechFixture();
  const r = await addBroll(video, {
    broll: `${assets[0]}@13-16:replace`, out: tmp('an-br.mp4'), quality: 'preview',
  });
  const outside = await psnr(r.path, video, 8);
  const inside = await psnr(r.path, video, 14);
  assert(inside < outside - 10,
    `the picture should change during B-roll (${inside} dB) and not outside it (${outside} dB)`);
  near(r.actualDuration, r.duration, 0.4, 'B-roll must not change the duration');
});

test('B-roll keeps the original narration', async () => {
  const { video } = await buildSpeechFixture();
  const assets = listBroll();
  const r = await addBroll(video, { broll: `${assets[0]}@13-16`, out: tmp('an-br2.mp4'), quality: 'preview' });
  await verifyMedia(r.path, { hasAudio: true });
});

test('overlapping B-roll placements are rejected', async () => {
  const { video } = await buildSpeechFixture();
  const a = listBroll()[0];
  let code = null;
  try {
    await addBroll(video, { broll: `${a}@5-10;${a}@8-12`, out: tmp('an-br-bad.mp4') });
  } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('--auto suggests placements from the transcript', async () => {
  const { video } = await buildSpeechFixture();
  const r = await addBroll(video, {
    auto: true, language: 'pt', prompt: 'Claude Code, npm install, terminal', dryRun: true,
  });
  eq(r.auto, true);
  assert(r.count >= 1, 'the fixture says "terminal", which the asset tags cover');
  assert(r.placements.every(p => p.reason), 'every suggestion must carry its evidence');
});

/* ------------------------------------------------------------ analyze-style */

test('suggestStyle maps pacing onto a preset', () => {
  eq(suggestStyle({ cutsPerMinute: 20, averageSceneLength: 2, orientation: 'portrait', speechRatio: 0.7, medianMotion: 10 }).style, 'viral');
  eq(suggestStyle({ cutsPerMinute: 0, averageSceneLength: 60, orientation: 'portrait', speechRatio: 0.7, medianMotion: 2 }).style, 'podcast');
  eq(suggestStyle({ cutsPerMinute: 5, averageSceneLength: 10, orientation: 'landscape', speechRatio: 0.9, medianMotion: 1 }).style, 'educational');
});

test('analyze-style measures the real cut rhythm', async () => {
  // The fixture is 12s with cuts at 3, 6, 9 -> 15 cuts/min, 3s shots.
  const r = await analyzeStyle(await fixture('scenes'), { out: tmp('an-style.json') });
  near(r.measurements.cutsPerMinute, 15, 0.5);
  near(r.measurements.averageSceneLength, 3, 0.2);
  eq(r.estimatedStyle.closestPreset, 'viral');
  assert(r.estimatedStyle.reasons.length > 0, 'the suggestion must be justified');
});

test('analyze-style does NOT claim a caption position', async () => {
  // Regression: band contrast was used to guess caption placement and got it
  // wrong in both directions, so the claim was removed.
  const r = await analyzeStyle(await fixture('scenes'), { out: tmp('an-style2.json') });
  eq(r.measurements.bandContrast.captionPositionDetected, null);
  eq(r.estimatedStyle.overrides.captions.position, undefined,
    'no caption position should be inferred from a reference');
});

test('analyze-style refuses a clip too short to characterise', async () => {
  const { ffmpeg } = await import('../lib/ffmpeg.mjs');
  const tiny = tmp('an-tiny.mp4');
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1:r=30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', tiny]);
  let code = null;
  try { await analyzeStyle(tiny, { out: tmp('an-style3.json') }); } catch (e) { code = e.code; }
  eq(code, EXIT.VALIDATION);
});

/* ------------------------------------------------------------------ modes */

test('every style is listed with its decisions', async () => {
  const r = await modes({});
  assert(r.count >= 6, `expected the built-in styles, got ${r.count}`);
  const viral = r.styles.find(s => s.name === 'viral');
  eq(viral.captions, 'viral');
  eq(viral.silence, 'aggressive');
  const coding = r.styles.find(s => s.name === 'coding');
  eq(coding.crop, 'contain');
});

test('a single style can be shown in full', async () => {
  const r = await modes({ name: 'podcast' });
  eq(r.style, 'podcast');
  eq(r.crop.mode, 'smart');
});

test('CLI round-trips for the analysis tools', async () => {
  eq((await cliOk('analyze-visual.mjs', [await fixture('scenes'), '--no-faces', '--out', tmp('an-cli-v.json')])).tool, 'analyze-visual');
  eq((await cliOk('analyze-style.mjs', [await fixture('scenes'), '--out', tmp('an-cli-s.json')])).tool, 'analyze-style');
  eq((await cliOk('modes.mjs', [])).tool, 'modes');
});
