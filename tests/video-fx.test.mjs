// Phase 8 video: freeze-frame, blur-region, transitions, background.
// Effects are verified optically — luminance and PSNR against references —
// rather than by trusting that a filter string was well formed.
import fs from 'node:fs';
import { test, eq, near, assert, verifyMedia, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { freezeFrame, parseFreezes } from '../tools/freeze-frame.mjs';
import { blurRegion, parseRegions, toPixels } from '../tools/blur-region.mjs';
import { transitions, joinWithTransitions, transitionsAt, JOIN_TYPES, AT_TYPES } from '../tools/transitions.mjs';
import { background, MODES as BG_MODES } from '../tools/background.mjs';
import { ffmpeg, FFMPEG } from '../lib/ffmpeg.mjs';
import { run } from '../lib/proc.mjs';
import { EXIT } from '../lib/errors.mjs';

const LANDSCAPE = 'tests/fixtures/landscape.mp4';

async function luma(file, at, crop = '1280:720:0:0') {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-i', file,
    '-vf', `crop=${crop},signalstats,metadata=print`, '-frames:v', '1', '-f', 'null', '-',
  ], { timeoutMs: 300000 });
  const m = /YAVG=([0-9.]+)/.exec(stderr);
  return m ? Number(m[1]) : null;
}

/** PSNR between two files over one region — the honest way to ask "did this change?". */
async function psnr(a, b, crop, at = 5, dur = 1) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-t', String(dur), '-i', a,
    '-ss', String(at), '-t', String(dur), '-i', b,
    '-lavfi', `[0:v]crop=${crop}[x];[1:v]crop=${crop}[y];[x][y]psnr`, '-f', 'null', '-',
  ], { timeoutMs: 300000 });
  const m = /average:([0-9.]+|inf)/.exec(stderr);
  return m ? (m[1] === 'inf' ? Infinity : Number(m[1])) : null;
}

/* ---------------------------------------------------------- freeze-frame */

test('parseFreezes reads the compact form and rejects nonsense', () => {
  const f = parseFreezes('8.4:1.2');
  eq(f[0].timestamp, 8.4); eq(f[0].duration, 1.2);
  for (const bad of ['garbage', '8.4', '[{"timestamp":1}]', '[{"timestamp":1,"duration":-1}]']) {
    let threw = false;
    try { parseFreezes(bad); } catch { threw = true; }
    assert(threw, `should reject ${bad}`);
  }
});

test('freeze extends the video by exactly the hold', async () => {
  const r = await freezeFrame(await fixture('landscape'), {
    freezes: '8.4:1.2', out: tmp('vfx-fz.mp4'), quality: 'preview',
  });
  near(r.duration, 17.2, 0.3, '16s + 1.2s hold');
  eq(r.freezeCount, 1);
  await verifyMedia(r.path, { width: 1280, height: 720, hasAudio: true });
});

test('several freezes add up', async () => {
  const r = await freezeFrame(await fixture('landscape'), {
    freezes: '3:0.5,11:1.0', out: tmp('vfx-fz2.mp4'), quality: 'preview',
  });
  eq(r.freezeCount, 2);
  near(r.totalHold, 1.5, 1e-6);
  near(r.duration, 17.5, 0.35);
});

test('the held frame really is frozen', async () => {
  // During the hold the picture must not change; testsrc2 changes every frame,
  // so two samples inside the hold being identical is strong evidence.
  const r = await freezeFrame(await fixture('landscape'), {
    freezes: '8:1.5', out: tmp('vfx-fz3.mp4'), quality: 'final',
  });
  const same = await psnr(r.path, r.path, '400:400:400:150', 8.3, 0.1);
  const a = await luma(r.path, 8.3, '400:400:400:150');
  const b = await luma(r.path, 9.2, '400:400:400:150');
  assert(a !== null && b !== null, 'measurement failed');
  near(a, b, 1.5, `the frame should not change during the hold (${a} vs ${b})`);
});

test('freeze rejects impossible requests', async () => {
  const src = await fixture('landscape');
  for (const bad of [{ freezes: '99:1' }, { freezes: '5:1,5:1' }]) {
    let code = null;
    try { await freezeFrame(src, { ...bad, out: tmp('vfx-fz-bad.mp4') }); } catch (e) { code = e.code; }
    eq(code, EXIT.USAGE, `should reject ${JSON.stringify(bad)}`);
  }
});

test('out-of-order freezes are sorted, not rejected', async () => {
  // Being liberal here is right: "5:1,3:1" unambiguously means freezes at 3 and 5.
  const r = await freezeFrame(await fixture('landscape'), {
    freezes: '11:0.4,3:0.4', out: tmp('vfx-fz-sort.mp4'), quality: 'preview',
  });
  eq(r.freezes[0].timestamp, 3);
  eq(r.freezes[1].timestamp, 11);
});

/* ----------------------------------------------------------- blur-region */

test('regions are fractions and get clamped into the frame', () => {
  eq(JSON.stringify(toPixels({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, 1280, 720)),
    JSON.stringify({ x: 128, y: 72, w: 384, h: 216 }));
  // Hanging off the edge must still cover what IS on screen.
  const clamped = toPixels({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 1280, 720);
  assert(clamped.x + clamped.w <= 1280 && clamped.y + clamped.h <= 720, 'region escaped the frame');
  assert(clamped.w >= 2 && clamped.h >= 2, 'a clamped region must not collapse to nothing');
});

test('parseRegions reads the compact form with a time window', () => {
  const [r] = parseRegions('0.6,0.7,0.35,0.2@4-9');
  eq(r.x, 0.6); eq(r.start, 4); eq(r.end, 9);
});

test('blurring changes the region and leaves the rest alone', async () => {
  const src = await fixture('landscape');
  const r = await blurRegion(src, {
    regions: '0.1,0.1,0.3,0.3', mode: 'blur', out: tmp('vfx-bl.mp4'), quality: 'final',
  });
  const inside = await psnr(src, r.path, '384:216:128:72');
  const outside = await psnr(src, r.path, '384:216:800:400');
  assert(inside < outside - 3,
    `the blurred region must differ more from the original than the rest does (${inside} vs ${outside} dB)`);
});

test('pixelate and black modes both render', async () => {
  for (const mode of ['pixelate', 'black']) {
    const r = await blurRegion(await fixture('landscape'), {
      regions: '0.1,0.1,0.25,0.25', mode, out: tmp(`vfx-bl-${mode}.mp4`), quality: 'preview',
    });
    eq(r.mode, mode);
    await verifyMedia(r.path, { width: 1280, height: 720 });
  }
});

test('black mode actually blacks the region out', async () => {
  const r = await blurRegion(await fixture('landscape'), {
    regions: '0.1,0.1,0.3,0.3', mode: 'black', out: tmp('vfx-bl-k.mp4'), quality: 'final',
  });
  const inside = await luma(r.path, 5, '300:150:150:100');
  assert(inside < 25, `the region should be black, measured YAVG ${inside}`);
});

test('a time-windowed region only applies inside its window', async () => {
  const r = await blurRegion(await fixture('landscape'), {
    regions: '0.1,0.1,0.3,0.3@6-10', mode: 'black', out: tmp('vfx-bl-t.mp4'), quality: 'final',
  });
  const during = await luma(r.path, 8, '300:150:150:100');
  const before = await luma(r.path, 3, '300:150:150:100');
  assert(during < 25, `should be black at t=8s, got ${during}`);
  assert(before > 40, `should be untouched at t=3s, got ${before}`);
});

test('blur-region requires something to blur', async () => {
  let code = null;
  try { await blurRegion(await fixture('landscape'), { out: tmp('vfx-bl-none.mp4') }); } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

/* ----------------------------------------------------------- transitions */

test('joining two clips overlaps them by the transition duration', async () => {
  const r = await joinWithTransitions(
    [await fixture('landscape'), await fixture('portrait')],
    { type: 'crossfade', duration: 0.5, out: tmp('vfx-tr.mp4'), quality: 'preview' }
  );
  // 16 + 6 - 0.5 = 21.5
  near(r.duration, 21.5, 0.4, 'the transition must overlap, not concatenate');
  eq(r.clipCount, 2);
});

test('clips of different sizes are conformed before xfade', async () => {
  // landscape is 1280x720, portrait is 1080x1920: xfade refuses mismatches.
  const r = await joinWithTransitions(
    [await fixture('landscape'), await fixture('portrait')],
    { type: 'dissolve', duration: 0.4, out: tmp('vfx-tr2.mp4'), quality: 'preview' }
  );
  eq(r.width, 1280); eq(r.height, 720, 'geometry should follow the first clip');
});

test('a clip shorter than the transition is rejected with a reason', async () => {
  let err = null;
  try {
    await joinWithTransitions([await fixture('mute'), await fixture('landscape')],
      { type: 'crossfade', duration: 10, out: tmp('vfx-tr-bad.mp4') });
  } catch (e) { err = e; }
  eq(err?.code, EXIT.USAGE);
  assert(/longer than the transition/.test(err.hint || err.message), err.message);
});

test('dip-black dips ONLY around the point (regression: it stayed black)', async () => {
  const r = await transitionsAt(await fixture('landscape'), {
    at: '8', type: 'dip-black', duration: 0.4, out: tmp('vfx-dip.mp4'), quality: 'final',
  });
  const before = await luma(r.path, 7.0);
  const bottom = await luma(r.path, 7.99);
  const after = await luma(r.path, 9.0);
  const late = await luma(r.path, 13.0);

  assert(bottom < 30, `the dip should reach black, got ${bottom}`);
  assert(before > 90, `before the dip should be normal, got ${before}`);
  assert(after > 90, `after the dip should recover, got ${after}`);
  assert(late > 90, `and stay recovered to the end, got ${late}`);
});

test('applying a transition at a point does not change the duration', async () => {
  const r = await transitionsAt(await fixture('landscape'), {
    at: '5,10', type: 'dip-black', duration: 0.3, out: tmp('vfx-dip2.mp4'), quality: 'preview',
  });
  near(r.duration, 16, 0.3);
  eq(r.pointCount, 2);
});

test('a join type cannot be used as an at-point type', async () => {
  let code = null;
  try {
    await transitionsAt(await fixture('landscape'), { at: '5', type: 'crossfade', out: tmp('vfx-tr-x.mp4') });
  } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('transition points outside the video are rejected', async () => {
  let code = null;
  try {
    await transitionsAt(await fixture('landscape'), { at: '99', type: 'dip-black', out: tmp('vfx-tr-o.mp4') });
  } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

/* ------------------------------------------------------------ background */

test('vignette darkens the corners and leaves the centre', async () => {
  const src = await fixture('landscape');
  const r = await background(src, { mode: 'vignette', strength: 0.8, out: tmp('vfx-vg.mp4'), quality: 'final' });
  eq(r.segmented, false, 'vignette must not need a model');

  const centreBefore = await luma(src, 5, '300:300:490:210');
  const centreAfter = await luma(r.path, 5, '300:300:490:210');
  const cornerBefore = await luma(src, 5, '200:150:0:0');
  const cornerAfter = await luma(r.path, 5, '200:150:0:0');

  near(centreAfter, centreBefore, 6, 'the centre should be broadly untouched');
  assert(cornerAfter < cornerBefore - 8,
    `the corner should darken (${cornerBefore} -> ${cornerAfter})`);
});

test('a supplied matte composites the subject over a processed background', async () => {
  // Circle matte: white in the middle (subject), black around it (background).
  const matte = tmp('vfx-matte.mkv');
  if (!fs.existsSync(matte)) {
    await ffmpeg([
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=16:r=30',
      '-f', 'lavfi', '-i', 'color=c=white:s=400x400:d=16:r=30',
      '-filter_complex',
      "[1:v]format=gray,geq=lum='if(lte(hypot(X-200,Y-200),190),255,0)'[c];[0:v][c]overlay=440:160,format=gray[m]",
      '-map', '[m]', '-c:v', 'ffv1', matte,
    ]);
  }
  const src = await fixture('landscape');
  const r = await background(src, {
    mode: 'blur', strength: 0.9, mask: matte, out: tmp('vfx-bg.mp4'), quality: 'final',
  });

  // A fully blurred reference to compare against.
  const full = tmp('vfx-fullblur.mp4');
  if (!fs.existsSync(full)) {
    await ffmpeg(['-y', '-i', src, '-vf', 'gblur=sigma=28:steps=3',
      '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', full]);
  }

  const IN = '200:200:540:260';   // inside the circle -> subject
  const OUT = '200:200:60:60';    // outside -> background

  const inVsOriginal = await psnr(r.path, src, IN);
  const inVsBlur = await psnr(r.path, full, IN);
  const outVsOriginal = await psnr(r.path, src, OUT);
  const outVsBlur = await psnr(r.path, full, OUT);

  assert(inVsOriginal > inVsBlur,
    `inside the matte should resemble the ORIGINAL (${inVsOriginal} vs ${inVsBlur} dB)`);
  assert(outVsBlur > outVsOriginal,
    `outside the matte should resemble the BLURRED version (${outVsBlur} vs ${outVsOriginal} dB)`);
});

test('segmentation refuses rather than blurring an entire frame', async () => {
  // There is no person in the synthetic fixtures, so this must fail safe.
  let code = null;
  try {
    await background(await fixture('landscape'), { mode: 'blur', out: tmp('vfx-bg-none.mp4'), quality: 'preview' });
  } catch (e) { code = e.code; }
  eq(code, EXIT.VALIDATION, 'finding no subject must be an error, not a fully blurred video');
});

test('an unknown mode is rejected', async () => {
  let code = null;
  try { await background(await fixture('landscape'), { mode: 'bokeh', out: tmp('vfx-bg-x.mp4') }); }
  catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('CLI round-trips for the video effects', async () => {
  const src = await fixture('landscape');
  eq((await cliOk('freeze-frame.mjs', [src, '--freezes', '8:0.5', '--out', tmp('vfx-cli-fz.mp4'), '--quality', 'preview'])).tool, 'freeze-frame');
  eq((await cliOk('blur-region.mjs', [src, '--regions', '0.1,0.1,0.2,0.2', '--out', tmp('vfx-cli-bl.mp4'), '--quality', 'preview'])).tool, 'blur-region');
  eq((await cliOk('background.mjs', [src, '--mode', 'vignette', '--out', tmp('vfx-cli-bg.mp4'), '--quality', 'preview'])).tool, 'background');
});
