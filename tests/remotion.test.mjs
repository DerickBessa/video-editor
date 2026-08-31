// Remotion motion graphics.
//
// The value of these tests is ALPHA. An overlay that renders without a real
// alpha channel composites as a solid rectangle, which looks like a bug in the
// video rather than in the renderer — and it happened twice while building
// this: once because the ProRes profile alone is not enough, and once because
// Remotion needs PNG frames for any alpha pixel format.
//
// Note on measuring alpha: the overlay must be composited at FULL frame size.
// At the default 35% scale the frame corners are simply outside the overlay, so
// "the corner did not change" proves nothing at all.
import fs from 'node:fs';
import path from 'node:path';
import { test, eq, near, assert, verifyMedia, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { remotionRender, listComponents, CODECS } from '../tools/remotion-render.mjs';
import { addOverlay } from '../tools/add-overlay.mjs';
import { run } from '../lib/proc.mjs';
import { FFMPEG } from '../lib/ffmpeg.mjs';
import { ROOT } from '../lib/paths.mjs';
import { EXIT } from '../lib/errors.mjs';

async function luma(file, at, crop) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-i', file,
    '-vf', `crop=${crop},signalstats,metadata=print`, '-frames:v', '1', '-f', 'null', '-',
  ], { timeoutMs: 300000 });
  const m = /YAVG=([0-9.]+)/.exec(stderr);
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------- the library */

test('the component library covers what the brief asked for', async () => {
  const components = await listComponents();
  for (const want of [
    'Title', 'Subtitle', 'Caption', 'Callout', 'Arrow', 'CircleHighlight', 'ProgressBar',
    'LowerThird', 'Notification', 'CodeBlock', 'Terminal', 'TweetCard', 'ImageCard',
    'BrowserWindow', 'PhoneFrame',
  ]) {
    assert(components.includes(want), `the library is missing ${want}`);
  }
});

test('the code-visualisation components exist', async () => {
  const components = await listComponents();
  for (const want of ['CodeBlock', 'Terminal', 'BrowserWindow', 'CodeDiff', 'PhoneFrame']) {
    assert(components.includes(want), `missing code visual: ${want}`);
  }
});

test('the Remotion project files are present', () => {
  for (const f of ['index.jsx', 'Root.jsx', 'components.jsx', 'README.md']) {
    assert(fs.existsSync(path.join(ROOT, 'remotion', f)), `remotion/${f} is missing`);
  }
});

/* ----------------------------------------------------------------- render */

test('rendering produces a real alpha channel', async () => {
  // Both of the bugs this guards against produced a file that LOOKED fine.
  const r = await remotionRender('Terminal', {
    props: { lines: ['$ npm install'] }, duration: 1, width: 640, height: 360,
    out: tmp('rm-alpha.mov'),
  });
  eq(r.hasAlpha, true, `expected an alpha pixel format, got ${r.pixFmt}`);
  assert(/yuva/.test(r.pixFmt), `expected a yuva format, got ${r.pixFmt}`);
  eq(r.width, 640); eq(r.height, 360);
});

test('THE alpha test: the video shows through where the component is transparent', async () => {
  const src = await fixture('landscape');
  const overlay = await remotionRender('Terminal', {
    props: { lines: ['$ npm install', 'added 402 packages'] },
    duration: 3, width: 1280, height: 720, out: tmp('rm-full.mov'),
  });

  // Full frame size, so transparency is the ONLY way the video can show through.
  const comp = await addOverlay(src, {
    overlays: [{ asset: overlay.path, start: 5, end: 8, scale: 1.0, position: 'center', animation: 'none' }],
    out: tmp('rm-comp.mp4'), quality: 'final',
  });

  const CORNER = '160:120:10:10';     // transparent region of the component
  const CENTRE = '300:200:490:260';   // where the terminal window is drawn

  const cornerBefore = await luma(src, 6, CORNER);
  const cornerAfter = await luma(comp.path, 6, CORNER);
  const centreBefore = await luma(src, 6, CENTRE);
  const centreAfter = await luma(comp.path, 6, CENTRE);

  near(cornerAfter, cornerBefore, 2,
    `the corner must show the video through the transparent area (${cornerBefore} -> ${cornerAfter})`);
  assert(Math.abs(centreAfter - centreBefore) > 30,
    `the terminal window should visibly change the centre (${centreBefore} -> ${centreAfter})`);
});

test('an overlay only appears inside its window', async () => {
  const src = await fixture('landscape');
  const overlay = await remotionRender('LowerThird', {
    props: { title: 'Derick', subtitle: 'Engineer' },
    duration: 2, width: 1280, height: 720, out: tmp('rm-lt.mov'),
  });
  const comp = await addOverlay(src, {
    overlays: [{ asset: overlay.path, start: 8, end: 10, scale: 1.0, position: 'center', animation: 'none' }],
    out: tmp('rm-lt-comp.mp4'), quality: 'final',
  });
  const region = '500:150:60:520';   // where the lower third sits
  const during = await luma(comp.path, 9, region);
  const before = await luma(comp.path, 3, region);
  const untouched = await luma(await fixture('landscape'), 3, region);
  near(before, untouched, 3, 'nothing should be drawn before the window');
  assert(Math.abs(during - before) > 5, `the lower third should be visible at t=9s (${before} -> ${during})`);
});

test('several components render', async () => {
  for (const [component, props] of [
    ['Title', { text: 'Hello', subtitle: 'World' }],
    ['CodeBlock', { code: 'const x = 1;\nconsole.log(x);', title: 'app.js' }],
    ['ProgressBar', {}],
    ['Callout', { text: 'Look' }],
  ]) {
    const r = await remotionRender(component, {
      props, duration: 1, width: 480, height: 270, out: tmp(`rm-${component}.mov`),
    });
    eq(r.hasAlpha, true, `${component} lost its alpha`);
    assert(fs.existsSync(r.path), `${component} produced no file`);
  }
});

test('duration and frame rate are honoured', async () => {
  const r = await remotionRender('Title', {
    props: { text: 'x' }, duration: 2, fps: 25, width: 320, height: 240, out: tmp('rm-dur.mov'),
  });
  near(r.duration, 2, 0.2);
  eq(r.durationInFrames, 50, '2s at 25fps');
});

test('the bundle is cached between renders', async () => {
  // The first render in this suite paid for the bundle; a later one must not.
  const t0 = Date.now();
  await remotionRender('Title', { props: { text: 'cached' }, duration: 1, width: 320, height: 240, out: tmp('rm-cache.mov') });
  const elapsed = Date.now() - t0;
  assert(elapsed < 60000, `a cached-bundle render took ${elapsed}ms, which suggests it rebuilt`);
});

test('an unknown component is rejected with the list', async () => {
  let err = null;
  try { await remotionRender('Sparkles', { duration: 1, out: tmp('rm-bad.mov') }); } catch (e) { err = e; }
  eq(err?.code, EXIT.USAGE);
  assert(/Terminal/.test(err.hint || ''), 'the error should list what IS available');
});

test('malformed props are rejected', async () => {
  let code = null;
  try { await remotionRender('Title', { props: '{not json', duration: 1, out: tmp('rm-bad2.mov') }); }
  catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('an absurd duration is rejected', async () => {
  let code = null;
  try { await remotionRender('Title', { duration: 999, out: tmp('rm-bad3.mov') }); } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('--list reports the components without rendering', async () => {
  const r = await remotionRender(null, { list: true });
  assert(r.count >= 15, `expected the full library, got ${r.count}`);
  assert(r.components.includes('Terminal'));
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const j = await cliOk('remotion-render.mjs', ['--list']);
  eq(j.tool, 'remotion-render');
  assert(j.count >= 15);
});
