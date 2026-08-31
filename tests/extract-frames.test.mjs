import fs from 'node:fs';
import path from 'node:path';
import { test, eq, near, assert, cliOk, cliFails, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { extractFrames } from '../tools/extract-frames.mjs';
import { probeVideo } from '../tools/probe-video.mjs';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { ROOT } from '../lib/paths.mjs';
import { EXIT } from '../lib/errors.mjs';

const outDir = name => tmp(`frames-${name}`);

/** Every listed frame must be a real, decodable image of the right width. */
async function verifyFrames(r, expectWidth) {
  assert(r.frames.length > 0, 'no frames returned');
  for (const f of r.frames) {
    const abs = path.join(ROOT, f.file);
    assert(fs.existsSync(abs), `missing frame file: ${f.file}`);
    assert(f.sizeBytes > 500, `frame ${f.file} is suspiciously small (${f.sizeBytes} bytes)`);
    const m = await probeVideo(abs);
    eq(m.width, expectWidth, `frame ${f.file} width`);
  }
}

test('scene mode takes one frame per detected shot', async () => {
  const r = await extractFrames(await fixture('scenes'), { mode: 'scene', outDir: outDir('scene'), force: true });
  eq(r.count, 4, 'four shots -> four frames');
  eq(r.sceneCount, 4);
  // Each frame must fall INSIDE its shot, not on a cut boundary.
  const bounds = [[0, 3], [3, 6], [6, 9], [9, 12]];
  r.frames.forEach((f, i) => {
    assert(f.timestamp > bounds[i][0] && f.timestamp < bounds[i][1],
      `frame ${i} at ${f.timestamp}s is not inside shot ${bounds[i]}`);
  });
  await verifyFrames(r, 640);
});

test('timestamp mode extracts exactly the requested times', async () => {
  const want = [1.5, 4.5, 7.5, 10.5];
  const r = await extractFrames(await fixture('scenes'), {
    mode: 'timestamp', timestamps: want, outDir: outDir('ts'), force: true,
  });
  eq(r.count, want.length);
  want.forEach((t, i) => near(r.frames[i].timestamp, t, 0.01, `frame ${i}`));
  await verifyFrames(r, 640);
});

test('interval mode spaces frames evenly', async () => {
  const r = await extractFrames(await fixture('scenes'), {
    mode: 'interval', interval: 2, outDir: outDir('int'), force: true,
  });
  eq(r.count, 6, '12s at 2s spacing');
  for (let i = 1; i < r.frames.length; i++) {
    near(r.frames[i].timestamp - r.frames[i - 1].timestamp, 2, 0.05, `gap ${i}`);
  }
});

test('a user-requested tight interval is NOT silently deduplicated', async () => {
  // Regression: an internal 0.25s dedupe once collapsed a requested 0.2s
  // interval down to a single frame.
  const r = await extractFrames(await fixture('scenes'), {
    mode: 'interval', interval: 0.2, max: 8, outDir: outDir('tight'), force: true,
  });
  eq(r.count, 8, 'the cap should apply, not the dedupe');
  eq(r.capped, true, 'capping must be reported');
});

test('the max cap is enforced and frames stay spread across the video', async () => {
  const r = await extractFrames(await fixture('scenes'), {
    mode: 'interval', interval: 0.25, max: 5, outDir: outDir('cap'), force: true,
  });
  eq(r.count, 5);
  eq(r.capped, true);
  assert(r.frames[0].timestamp < 1, 'should still sample near the start');
  assert(r.frames[r.frames.length - 1].timestamp > 10, 'should still sample near the end');
});

test('smart mode covers every shot', async () => {
  const r = await extractFrames(await fixture('scenes'), { mode: 'smart', outDir: outDir('smart'), force: true });
  assert(r.count >= 4, `smart mode should cover all 4 shots, got ${r.count}`);
  assert(r.count <= r.max, 'must respect the cap');
});

test('honours width and format', async () => {
  const r = await extractFrames(await fixture('scenes'), {
    mode: 'timestamp', timestamps: [2, 5], width: 320, format: 'png', outDir: outDir('png'), force: true,
  });
  eq(r.count, 2);
  assert(r.frames.every(f => f.file.endsWith('.png')), 'files should be .png');
  await verifyFrames(r, 320);
});

test('timestamps outside the source are ignored, not fatal', async () => {
  const r = await extractFrames(await fixture('scenes'), {
    mode: 'timestamp', timestamps: [2, 999, -5], outDir: outDir('oob'), force: true,
  });
  eq(r.count, 1, 'only the in-range timestamp survives');
  near(r.frames[0].timestamp, 2, 0.01);
});

test('timestamp mode requires timestamps', async () => {
  let code = null;
  try { await extractFrames(await fixture('scenes'), { mode: 'timestamp', outDir: outDir('none') }); }
  catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('rejects an unknown mode', async () => {
  let code = null;
  try { await extractFrames(await fixture('scenes'), { mode: 'nonsense', outDir: outDir('bad') }); }
  catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('refuses a source with no video track', async () => {
  const audioOnly = tmp('ef-audio.wav');
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:a', 'pcm_s16le', audioOnly]);
  let code = null;
  try { await extractFrames(audioOnly, { mode: 'interval', outDir: outDir('novid') }); }
  catch (e) { code = e.code; }
  eq(code, EXIT.INPUT);
});

test('never writes into raw/', async () => {
  let code = null;
  try { await extractFrames(await fixture('scenes'), { mode: 'interval', outDir: 'raw/frames-oops' }); }
  catch (e) { code = e.code; }
  eq(code, EXIT.INPUT);
  eq(fs.existsSync(path.join(ROOT, 'raw', 'frames-oops')), false);
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const j = await cliOk('extract-frames.mjs', [
    await fixture('scenes'), '--mode', 'timestamp', '--timestamps', '1,5,9',
    '--out-dir', outDir('cli'), '--force',
  ]);
  eq(j.tool, 'extract-frames');
  eq(j.count, 3);
});
