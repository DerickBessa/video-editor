import fs from 'node:fs';
import { test, eq, near, assert, verifyMedia, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { buildSpeechFixture } from './speech-fixture.mjs';
import { emptyPlan } from '../lib/edit-plan.mjs';
import { renderEdit } from '../tools/render-edit.mjs';
import { previewEdit, previewResolution } from '../tools/preview-edit.mjs';
import { EXIT } from '../lib/errors.mjs';

const LANDSCAPE = 'tests/fixtures/landscape.mp4';   // 16s 1280x720, silence at 4-5.5 and 10-11.2

function plan(over = {}, name = `plan-${Math.random().toString(36).slice(2, 8)}.json`) {
  const p = tmp(name);
  fs.writeFileSync(p, JSON.stringify({ ...emptyPlan(LANDSCAPE), ...over }, null, 2));
  return p;
}

test('a plan with no work copies the source', async () => {
  const r = await renderEdit(plan({}), { out: tmp('re-noop.mp4'), quality: 'preview' });
  eq(r.stageCount, 0);
  await verifyMedia(r.path, { width: 1280, height: 720, duration: 16, durationTol: 0.3 });
});

test('cuts alone shorten the video by the removed amount', async () => {
  const r = await renderEdit(plan({ cuts: { remove: [[4, 6]] } }), { out: tmp('re-cut.mp4'), quality: 'preview' });
  eq(JSON.stringify(r.stages), '["cuts"]');
  near(r.duration, 14, 0.3);
});

test('stages run in the declared order', async () => {
  const r = await renderEdit(plan({
    cuts: { remove: [[4, 6]] },
    crop: { aspect: '9:16', mode: 'static' },
    output: { resolution: '360x640' },
    zooms: [{ start: 1, end: 3, scale: 1.15 }],
  }), { out: tmp('re-order.mp4'), quality: 'preview' });
  eq(JSON.stringify(r.stages), '["cuts","crop","zoom"]');
  eq(r.steps.map(s => s.stage).join(','), 'cuts,crop,zoom', 'execution order must match the plan order');
  await verifyMedia(r.path, { width: 360, height: 640 });
});

test('a zoom in SOURCE time survives an earlier cut', async () => {
  // Remove 2-6s, then zoom at source 10-12s. The zoom must appear in the
  // output, at 6-8s, and the render must not fail with "beyond the source".
  const r = await renderEdit(plan({
    cuts: { remove: [[2, 6]] },
    zooms: [{ start: 10, end: 12, scale: 1.2 }],
  }), { out: tmp('re-map.mp4'), quality: 'preview' });
  eq(r.stageCount, 2);
  near(r.duration, 12, 0.3);
});

test('an event inside removed footage is dropped without failing the render', async () => {
  const r = await renderEdit(plan({
    cuts: { remove: [[4, 8]] },
    zooms: [{ start: 5, end: 6, scale: 1.2 }],
  }), { out: tmp('re-drop.mp4'), quality: 'preview' });
  eq(JSON.stringify(r.stages), '["cuts"]', 'the zoom stage should vanish along with its only event');
  near(r.duration, 12, 0.3);
});

test('caching skips completed stages on a re-run', async () => {
  const p = plan({
    cuts: { remove: [[4, 6]] },
    crop: { aspect: '9:16', mode: 'static' },
    output: { resolution: '360x640' },
  }, 're-cache.json');

  const first = await renderEdit(p, { out: tmp('re-cache1.mp4'), quality: 'preview', force: true });
  eq(first.cachedStages, 0, 'a forced run must do all the work');

  const second = await renderEdit(p, { out: tmp('re-cache2.mp4'), quality: 'preview' });
  assert(second.cachedStages > 0, 'the second run should reuse at least one intermediate');
  near(second.duration, first.duration, 0.2, 'cached and fresh renders must agree');
});

test('changing a late stage does not invalidate earlier ones', async () => {
  const a = plan({
    cuts: { remove: [[4, 6]] },
    crop: { aspect: '9:16', mode: 'static' },
    output: { resolution: '360x640' },
    zooms: [{ start: 1, end: 3, scale: 1.1 }],
  }, 're-inv-a.json');
  await renderEdit(a, { out: tmp('re-inv-a.mp4'), quality: 'preview', force: true });

  // Same plan, different zoom only.
  const b = plan({
    cuts: { remove: [[4, 6]] },
    crop: { aspect: '9:16', mode: 'static' },
    output: { resolution: '360x640' },
    zooms: [{ start: 1, end: 3, scale: 1.25 }],
  }, 're-inv-b.json');
  const r = await renderEdit(b, { out: tmp('re-inv-b.mp4'), quality: 'preview' });
  assert(r.steps.filter(s => s.cached).length >= 2,
    `cuts and crop should still be cached, got: ${JSON.stringify(r.steps.map(s => [s.stage, s.cached]))}`);
  eq(r.steps.find(s => s.stage === 'zoom').cached, false, 'the changed stage must re-run');
});

test('dry run lists stages without producing a file', async () => {
  const out = tmp('re-dry.mp4');
  const r = await renderEdit(plan({ cuts: { remove: [[4, 6]] } }), { out, dryRun: true });
  eq(r.dryRun, true);
  eq(fs.existsSync(out), false, 'a dry run must not write the output');
});

test('an invalid plan is refused before any rendering happens', async () => {
  const out = tmp('re-invalid.mp4');
  let code = null;
  try {
    await renderEdit(plan({ zooms: [{ start: 9, end: 3, scale: 1.1 }] }), { out });
  } catch (e) { code = e.code; }
  eq(code, EXIT.VALIDATION);
  eq(fs.existsSync(out), false, 'nothing should have been rendered');
});

test('a failing stage names itself and what had already completed', async () => {
  // A sound that does not exist gets past validation only with --skip-validation.
  const out = tmp('re-fail.mp4');
  let err = null;
  try {
    await renderEdit(plan({ cuts: { remove: [[4, 6]] }, sfx: [{ timestamp: 1, sound: 'not-a-real-sound' }] }),
      { out, quality: 'preview', skipValidation: true });
  } catch (e) { err = e; }
  assert(err, 'should have failed');
  eq(err.details?.stage, 'sfx');
  assert(err.details.completed.includes('cuts'), 'the error should report which stages succeeded');
});

test('audio and captions run end to end on real speech', async () => {
  const { video } = await buildSpeechFixture();
  const p = tmp('re-speech.json');
  fs.writeFileSync(p, JSON.stringify({
    ...emptyPlan(video.replace(/\\/g, '/').split('video-editor/')[1] || video),
    source: 'tests/fixtures/speech.mp4',
    cuts: { silences: [{ start: 3.9, end: 5.2 }] },
    captions: { enabled: true, style: 'clean', language: 'pt' },
    audio: { normalize: true, targetLufs: -16 },
  }, null, 2));

  const r = await renderEdit(p, { out: tmp('re-speech.mp4'), quality: 'preview' });
  eq(JSON.stringify(r.stages), '["cuts","captions","audio"]');
  assert(r.steps.find(s => s.stage === 'captions').cues > 0, 'captions stage should report cues');
  await verifyMedia(r.path, { hasAudio: true });
});

/* ---------------------------------------------------------------- preview */

test('previewResolution halves and keeps dimensions even', () => {
  eq(previewResolution('1080x1920'), '540x960');
  eq(previewResolution('1281x721'), '640x360', 'odd results must be rounded down to even');
  eq(previewResolution(null), null);
  eq(previewResolution('1080x1920', 0.25), '270x480');
});

test('preview renders smaller but through the same pipeline', async () => {
  const p = plan({
    cuts: { remove: [[4, 6]] },
    crop: { aspect: '9:16', mode: 'static' },
    output: { resolution: '1080x1920' },
  }, 're-preview.json');

  const preview = await previewEdit(p, { out: tmp('re-preview.mp4'), scale: 0.25 });
  eq(preview.width, 270); eq(preview.height, 480);
  eq(preview.preview, true);
  near(preview.duration, 14, 0.3, 'a preview must have the same duration as the real render');
  eq(JSON.stringify(preview.stages), '["cuts","crop"]', 'and run the same stages');
});

test('preview does not modify the original plan', async () => {
  const p = plan({ output: { resolution: '1080x1920' }, crop: { aspect: '9:16', mode: 'static' } }, 're-untouched.json');
  const before = fs.readFileSync(p, 'utf8');
  await previewEdit(p, { out: tmp('re-untouched.mp4'), scale: 0.25 });
  eq(fs.readFileSync(p, 'utf8'), before, 'the plan file must be left exactly as it was');
});

test('CLI round-trips for render and preview', async () => {
  const p = plan({ cuts: { remove: [[4, 6]] } }, 're-cli.json');
  const a = await cliOk('render-edit.mjs', [p, '--out', tmp('re-cli.mp4'), '--quality', 'preview']);
  eq(a.tool, 'render-edit');
  const b = await cliOk('preview-edit.mjs', [p, '--out', tmp('re-cli-p.mp4')]);
  eq(b.tool, 'preview-edit');
});
