import fs from 'node:fs';
import path from 'node:path';
import { test, eq, near, assert, verifyMedia, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { addOverlay, parseOverlays, POSITIONS } from '../tools/add-overlay.mjs';
import { ffmpeg, FFMPEG } from '../lib/ffmpeg.mjs';
import { run } from '../lib/proc.mjs';
import { EXIT } from '../lib/errors.mjs';

/** A solid magenta PNG — a colour that appears nowhere in the fixtures. */
async function badgePng() {
  const f = tmp('ov-badge.png');
  if (!fs.existsSync(f)) {
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=0xFF00FF:s=120x120:d=1', '-frames:v', '1', f]);
  }
  return f;
}

/** How magenta is this region? Proves the overlay is really composited. */
async function magenta(file, at, crop) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-i', file,
    '-vf', `crop=${crop},signalstats,metadata=print`, '-frames:v', '1', '-f', 'null', '-',
  ], { timeoutMs: 120000 });
  // U and V both high is the signature of magenta in YUV.
  const u = /UAVG=([0-9.]+)/.exec(stderr);
  const v = /VAVG=([0-9.]+)/.exec(stderr);
  return u && v ? { u: Number(u[1]), v: Number(v[1]) } : null;
}

/* ---------------------------------------------------------------- parsing */

test('parseOverlays reads the compact form', () => {
  const o = parseOverlays('a.png@2-5:top-right');
  eq(o.length, 1);
  eq(o[0].start, 2); eq(o[0].end, 5);
  eq(o[0].x, POSITIONS['top-right'][0]);
});

test('parseOverlays reads JSON and applies defaults', () => {
  const [o] = parseOverlays('[{"asset":"a.png","start":1,"end":3}]');
  eq(o.x, 0.5); eq(o.y, 0.5);
  eq(o.opacity, 1);
  eq(o.animation, 'fade');
  assert(o.scale > 0 && o.scale <= 1);
});

test('parseOverlays sorts by start time', () => {
  const o = parseOverlays('[{"asset":"b.png","start":5,"end":6},{"asset":"a.png","start":1,"end":2}]');
  eq(o[0].asset, 'a.png');
});

test('parseOverlays rejects nonsense', () => {
  for (const bad of ['garbage', '[{"start":1}]', '[{"asset":"a.png","position":"sideways"}]',
                     '[{"asset":"a.png","animation":"explode"}]']) {
    let threw = false;
    try { parseOverlays(bad); } catch { threw = true; }
    assert(threw, `should reject ${bad}`);
  }
});

test('explicit x/y override the position preset', () => {
  const [o] = parseOverlays('[{"asset":"a.png","start":0,"end":1,"x":0.1,"y":0.9}]');
  eq(o.x, 0.1); eq(o.y, 0.9);
});

/* -------------------------------------------------------------- rendering */

test('an overlay appears only during its window', async () => {
  const badge = await badgePng();
  const r = await addOverlay(await fixture('landscape'), {
    overlays: [{ asset: badge, start: 4, end: 8, scale: 0.4, position: 'center', animation: 'none' }],
    out: tmp('ov-window.mp4'), quality: 'preview',
  });
  eq(r.applied, 1);

  const centre = '300:300:490:210';   // middle of a 1280x720 frame
  const during = await magenta(r.path, 6, centre);
  const before = await magenta(r.path, 1, centre);
  assert(during.u > 150 && during.v > 150, `expected magenta at t=6s, got U=${during.u} V=${during.v}`);
  assert(before.u < 150 || before.v < 150, `nothing should be drawn at t=1s, got U=${before.u} V=${before.v}`);
});

test('position moves the overlay to the right corner of the frame', async () => {
  const badge = await badgePng();
  const r = await addOverlay(await fixture('landscape'), {
    overlays: [{ asset: badge, start: 2, end: 8, scale: 0.25, position: 'top-left', animation: 'none' }],
    out: tmp('ov-pos.mp4'), quality: 'preview',
  });
  const topLeft = await magenta(r.path, 5, '260:200:110:30');
  const bottomRight = await magenta(r.path, 5, '260:200:900:480');
  assert(topLeft.u > 150 && topLeft.v > 150, `expected the badge top-left, got U=${topLeft.u} V=${topLeft.v}`);
  assert(bottomRight.u < 150 || bottomRight.v < 150, 'the badge must not also be bottom-right');
});

test('scale changes the overlay size', async () => {
  const badge = await badgePng();
  const big = await addOverlay(await fixture('landscape'), {
    overlays: [{ asset: badge, start: 2, end: 6, scale: 0.6, position: 'center', animation: 'none' }],
    out: tmp('ov-big.mp4'), quality: 'preview',
  });
  const small = await addOverlay(await fixture('landscape'), {
    overlays: [{ asset: badge, start: 2, end: 6, scale: 0.12, position: 'center', animation: 'none' }],
    out: tmp('ov-small.mp4'), quality: 'preview',
  });
  // Sample a ring OUTSIDE the small badge but INSIDE the big one.
  const ring = '120:120:420:300';
  const b = await magenta(big.path, 4, ring);
  const s = await magenta(small.path, 4, ring);
  assert(b.u > s.u + 15, `a 0.6 scale should cover more than a 0.12 scale (U ${b.u} vs ${s.u})`);
});

test('several overlays composite together', async () => {
  const badge = await badgePng();
  const r = await addOverlay(await fixture('landscape'), {
    overlays: [
      { asset: badge, start: 1, end: 5, position: 'top-left', scale: 0.2, animation: 'none' },
      { asset: badge, start: 6, end: 10, position: 'bottom-right', scale: 0.2, animation: 'none' },
    ],
    out: tmp('ov-multi.mp4'), quality: 'preview',
  });
  eq(r.applied, 2);
  await verifyMedia(r.path, { width: 1280, height: 720, hasAudio: true });
});

test('frame size, duration and audio are preserved', async () => {
  const badge = await badgePng();
  const r = await addOverlay(await fixture('landscape'), {
    overlays: [{ asset: badge, start: 2, end: 5 }],
    out: tmp('ov-preserve.mp4'), quality: 'preview',
  });
  eq(r.width, 1280); eq(r.height, 720);
  near(r.duration, 16, 0.4);
  eq(r.hasAudio, true);
});

test('an overlay with no end runs to the end of the video', async () => {
  const badge = await badgePng();
  const r = await addOverlay(await fixture('landscape'), {
    overlays: [{ asset: badge, start: 12 }],
    out: tmp('ov-open.mp4'), quality: 'preview',
  });
  near(r.overlays[0].end, 16, 0.2);
});

test('a video can be used as an overlay (picture in picture)', async () => {
  const r = await addOverlay(await fixture('landscape'), {
    overlays: [{ asset: await fixture('mute'), start: 2, end: 6, scale: 0.3, position: 'bottom-right', animation: 'none' }],
    out: tmp('ov-pip.mp4'), quality: 'preview',
  });
  eq(r.applied, 1);
  await verifyMedia(r.path, { width: 1280, height: 720 });
});

test('a missing asset is rejected', async () => {
  let code = null;
  try {
    await addOverlay(await fixture('landscape'), {
      overlays: [{ asset: 'assets/overlays/nope.png', start: 1, end: 2 }], out: tmp('ov-bad.mp4'),
    });
  } catch (e) { code = e.code; }
  eq(code, EXIT.INPUT);
});

test('an overlay beyond the source is rejected', async () => {
  const badge = await badgePng();
  let code = null;
  try {
    await addOverlay(await fixture('landscape'), {
      overlays: [{ asset: badge, start: 99, end: 100 }], out: tmp('ov-oob.mp4'),
    });
  } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const badge = await badgePng();
  const j = await cliOk('add-overlay.mjs', [
    await fixture('landscape'), '--overlays', `${badge}@2-5:center`,
    '--out', tmp('ov-cli.mp4'), '--quality', 'preview',
  ]);
  eq(j.tool, 'add-overlay');
  eq(j.applied, 1);
});
