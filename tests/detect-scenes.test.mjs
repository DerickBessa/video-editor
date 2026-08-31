import { test, eq, near, assert, cliOk, cliFails, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { detectScenes } from '../tools/detect-scenes.mjs';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { EXIT } from '../lib/errors.mjs';

// The `scenes` fixture is four 3s shots joined by hard cuts.
const TRUE_CUTS = [3, 6, 9];

test('finds every hard cut, to the frame', async () => {
  const r = await detectScenes(await fixture('scenes'), { out: tmp('sc-basic.json') });
  eq(r.cutCount, TRUE_CUTS.length, 'cut count');
  for (const [i, t] of TRUE_CUTS.entries()) near(r.cuts[i], t, 0.05, `cut ${i}`);
  eq(r.sceneCount, 4, 'four shots');
});

test('scenes tile the whole timeline with no gaps or overlaps', async () => {
  const r = await detectScenes(await fixture('scenes'), { out: tmp('sc-tile.json') });
  eq(r.scenes[0].start, 0, 'first scene starts at zero');
  near(r.scenes[r.scenes.length - 1].end, r.duration, 0.05, 'last scene ends at the source end');
  for (let i = 1; i < r.scenes.length; i++) {
    eq(r.scenes[i].start, r.scenes[i - 1].end, `scene ${i} must start where scene ${i - 1} ended`);
  }
  const total = r.scenes.reduce((a, s) => a + s.duration, 0);
  near(total, r.duration, 0.05, 'scene durations should sum to the source duration');
});

test('reports per-scene statistics', async () => {
  const r = await detectScenes(await fixture('scenes'), { out: tmp('sc-stats.json') });
  near(r.averageSceneLength, 3, 0.1);
  near(r.shortestScene, 3, 0.1);
  near(r.longestScene, 3, 0.1);
  assert(r.scores.every(s => s.score > 0), 'every detection should carry a score');
});

test('minSceneLength folds away too-short shots', async () => {
  const src = await fixture('scenes');
  const fine = await detectScenes(src, { minSceneLength: 0.5, out: tmp('sc-fine.json') });
  const coarse = await detectScenes(src, { minSceneLength: 5, out: tmp('sc-coarse.json') });
  assert(coarse.sceneCount < fine.sceneCount, 'a 5s minimum must merge 3s shots');
  for (const s of coarse.scenes) {
    assert(s.duration >= 5 - 1e-6 || s === coarse.scenes[coarse.scenes.length - 1],
      `kept a ${s.duration}s scene below the 5s floor`);
  }
});

test('a video with no cuts yields exactly one scene', async () => {
  // testsrc2 changes every frame but never CUTS; a detector that fires here
  // would be reporting motion as structure.
  const r = await detectScenes(await fixture('portrait'), { out: tmp('sc-single.json') });
  eq(r.sceneCount, 1, 'continuous footage is one shot');
  eq(r.cutCount, 0);
});

test('KNOWN LIMITATION: crossfades are not detected at any threshold', async () => {
  // Documented in ROADMAP.md. scdet compares consecutive frames, so a gradual
  // transition never exceeds the threshold on any single frame. This test
  // exists to detect the day that behaviour CHANGES, not to assert it is good.
  const xf = tmp('sc-crossfade.mp4');
  await ffmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=0x8B0000:s=640x360:d=4:r=30',
    '-f', 'lavfi', '-i', 'smptebars=s=640x360:d=4:r=30',
    '-filter_complex', '[0:v][1:v]xfade=transition=fade:duration=1.5:offset=2.5[v]',
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', xf,
  ]);
  const low = await detectScenes(xf, { threshold: 0.5, out: tmp('sc-xf.json') });
  eq(low.cutCount, 0, 'crossfade is still undetected — if this fails, the limitation is fixed, update ROADMAP.md');

  // Control: the same threshold DOES find hard cuts, proving it is not just
  // an insensitive setting.
  const hard = await detectScenes(await fixture('scenes'), { threshold: 0.5, out: tmp('sc-ctrl.json') });
  eq(hard.cutCount, 3, 'the same threshold must still find hard cuts');
});

test('second run is served from cache', async () => {
  const src = await fixture('scenes');
  const first = await detectScenes(src, { force: true, out: tmp('sc-c1.json') });
  const second = await detectScenes(src, { out: tmp('sc-c2.json') });
  eq(second.cutCount, first.cutCount);
  eq(JSON.stringify(second.cuts), JSON.stringify(first.cuts), 'cached cuts must match');
});

test('refuses a source with no video track', async () => {
  const audioOnly = tmp('sc-audio.wav');
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:a', 'pcm_s16le', audioOnly]);
  let code = null;
  try { await detectScenes(audioOnly, { out: tmp('sc-none.json') }); } catch (e) { code = e.code; }
  eq(code, EXIT.INPUT);
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const j = await cliOk('detect-scenes.mjs', [await fixture('scenes'), '--out', tmp('sc-cli.json')]);
  eq(j.tool, 'detect-scenes');
  eq(j.sceneCount, 4);
});
