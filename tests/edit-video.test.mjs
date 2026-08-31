// edit-video — the orchestrator. These tests care about DECISIONS and the
// artefacts they leave behind (plan + reasoning log), not about re-proving that
// each underlying tool works; those have their own suites.
import fs from 'node:fs';
import path from 'node:path';
import { test, eq, near, assert, verifyMedia, cliOk, tmp, wer, normalizeText } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { buildSpeechFixture } from './speech-fixture.mjs';
import { editVideo } from '../tools/edit-video.mjs';
import { transcribe } from '../tools/transcribe.mjs';
import { loadStyle } from '../lib/styles.mjs';
import { ROOT } from '../lib/paths.mjs';
import { EXIT } from '../lib/errors.mjs';

const PROMPT = 'Claude Code, npm install, terminal';
const opts = extra => ({ language: 'pt', prompt: PROMPT, quality: 'preview', ...extra });

test('plan-only writes a plan and a reasoning log without rendering', async () => {
  const { video } = await buildSpeechFixture();
  const out = tmp('ev-planonly.mp4');
  const r = await editVideo(video, opts({ style: 'clean', planOnly: true, out }));

  eq(r.planOnly, true);
  eq(fs.existsSync(out), false, 'plan-only must not render');
  assert(fs.existsSync(path.join(ROOT, r.plan)), 'the plan file should exist');
  assert(fs.existsSync(path.join(ROOT, r.reasoning)), 'the reasoning log should exist');

  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, r.plan), 'utf8'));
  eq(plan.style, 'clean');
  eq(plan.source, 'tests/fixtures/speech.mp4');
  assert(plan.cuts.silences.length > 0, 'clean style should have found silence to cut');
});

test('the reasoning log explains observable decisions with timestamps', async () => {
  const { video } = await buildSpeechFixture();
  const r = await editVideo(video, opts({ style: 'viral', planOnly: true, out: tmp('ev-reason.mp4') }));
  const md = fs.readFileSync(path.join(ROOT, r.reasoning), 'utf8');

  assert(md.includes('# Edit decisions'), 'should be a readable document');
  assert(/\d\d:\d\d\.\d\d/.test(md), 'should carry real timecodes');
  assert(md.includes('## silence'), 'should explain the cuts');
  assert(/ORIGINAL recording/.test(md), 'should state which timeline the timestamps use');
  // It must describe WHY, not just what.
  assert(/because|emphasis on|removed .* of silence/.test(md), 'decisions should carry reasons');
});

test('each style produces a materially different plan', async () => {
  const { video } = await buildSpeechFixture();
  const plans = {};
  for (const style of ['clean', 'viral', 'coding']) {
    const r = await editVideo(video, opts({ style, planOnly: true, out: tmp(`ev-${style}.mp4`) }));
    plans[style] = JSON.parse(fs.readFileSync(path.join(ROOT, r.plan), 'utf8'));
  }
  eq(plans.clean.captions.style, 'clean');
  eq(plans.viral.captions.style, 'viral');
  assert(plans.viral.zooms.length > 0, 'viral should add zooms');
  eq(plans.clean.zooms.length, 0, 'clean should not');
  eq(plans.coding.crop.mode, 'contain', 'coding must not crop screen content away');
  assert(plans.viral.sfx.length > 0, 'viral should add effects');
  eq(plans.clean.sfx.length, 0, 'clean should not');
});

test('viral trims more than clean', async () => {
  const { video } = await buildSpeechFixture();
  const clean = await editVideo(video, opts({ style: 'clean', planOnly: true, out: tmp('ev-c.mp4') }));
  const viral = await editVideo(video, opts({ style: 'viral', planOnly: true, out: tmp('ev-v.mp4') }));
  assert(viral.estimatedDuration < clean.estimatedDuration,
    `viral (${viral.estimatedDuration}s) should be shorter than clean (${clean.estimatedDuration}s)`);
});

test('generated plans always validate', async () => {
  const { video } = await buildSpeechFixture();
  const { validateEditPlan } = await import('../tools/validate-edit-plan.mjs');
  for (const style of ['clean', 'viral', 'coding', 'educational', 'landscape']) {
    const r = await editVideo(video, opts({ style, planOnly: true, out: tmp(`ev-val-${style}.mp4`) }));
    const v = await validateEditPlan(path.join(ROOT, r.plan), {});
    eq(v.valid, true, `the ${style} plan should be renderable`);
  }
});

test('zooms generated for a style never overlap', async () => {
  const { video } = await buildSpeechFixture();
  const r = await editVideo(video, opts({ style: 'viral', planOnly: true, out: tmp('ev-z.mp4') }));
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, r.plan), 'utf8'));
  const z = [...plan.zooms].sort((a, b) => a.start - b.start);
  for (let i = 1; i < z.length; i++) {
    assert(z[i].start >= z[i - 1].end, `zooms ${i - 1} and ${i} overlap: ${JSON.stringify(z)}`);
  }
  for (const e of z) assert(e.reason, 'every generated zoom should record why it is there');
});

test('protected vocabulary is never removed as filler', async () => {
  // Regression: "Code" (from "Claude Code") was deleted because Whisper
  // reported it at probability 0.13.
  const { video } = await buildSpeechFixture();
  const r = await editVideo(video, opts({ style: 'viral', planOnly: true, out: tmp('ev-prot.mp4') }));
  const md = fs.readFileSync(path.join(ROOT, r.reasoning), 'utf8');
  assert(!/removed "Code"/.test(md), `"Code" must not be treated as a hesitation:\n${md}`);
  assert(!/removed "Claude"/.test(md), '"Claude" must not be treated as a hesitation');
});

test('END TO END: clean style renders, passes QA and keeps every word', async () => {
  const { video, truth } = await buildSpeechFixture();
  const r = await editVideo(video, opts({ style: 'clean', out: tmp('ev-clean.mp4') }));

  eq(r.width, 1080); eq(r.height, 1920);
  assert(r.duration < truth.duration, 'silence removal should make it shorter');
  eq(r.qa.passed, true, `QA failed: ${r.qa?.failures.join('; ')}`);
  await verifyMedia(r.path, { width: 1080, height: 1920, hasAudio: true });

  const back = await transcribe(r.path, { language: 'pt', prompt: PROMPT, force: true });
  const rate = wer(truth.fullText, back.text);
  assert(rate <= 0.1, `the edit changed the words (WER ${(rate * 100).toFixed(1)}%): ${back.text}`);
});

test('END TO END: viral style renders and passes QA', async () => {
  const { video } = await buildSpeechFixture();
  const r = await editVideo(video, opts({ style: 'viral', out: tmp('ev-viral.mp4') }));
  eq(r.qa.passed, true, `QA failed: ${r.qa?.failures.join('; ')}`);
  assert(r.stages.includes('zoom') && r.stages.includes('captions'));
  await verifyMedia(r.path, { width: 1080, height: 1920, hasAudio: true });
});

test('a second run reuses cached stages', async () => {
  const { video } = await buildSpeechFixture();
  const first = await editVideo(video, opts({ style: 'clean', out: tmp('ev-cache1.mp4'), force: true }));
  const second = await editVideo(video, opts({ style: 'clean', out: tmp('ev-cache2.mp4') }));
  assert(second.cachedStages > 0, 'the second run should reuse intermediates');
  near(second.duration, first.duration, 0.3);
});

test('a video with no audio still edits, skipping the audio stages', async () => {
  const r = await editVideo(await fixture('mute'), {
    style: 'clean', quality: 'preview', out: tmp('ev-mute.mp4'), skipQa: true,
  });
  assert(!r.stages.includes('captions'), 'captions need audio');
  assert(!r.stages.includes('audio'), 'normalisation needs audio');
  assert(r.stages.includes('crop'), 'the visual stages should still run');
  await verifyMedia(r.path, { width: 1080, height: 1920 });
});

test('an unknown style is rejected and lists the real ones', async () => {
  const { video } = await buildSpeechFixture();
  let err = null;
  try { await editVideo(video, { style: 'cinematic' }); } catch (e) { err = e; }
  eq(err?.code, EXIT.USAGE);
  assert(/clean/.test(err.hint || ''), 'the error should list available styles');
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const { video } = await buildSpeechFixture();
  const j = await cliOk('edit-video.mjs', [
    video, '--style', 'clean', '--language', 'pt', '--prompt', PROMPT,
    '--plan-only', '--out', tmp('ev-cli.mp4'),
  ]);
  eq(j.tool, 'edit-video');
  eq(j.planOnly, true);
});
