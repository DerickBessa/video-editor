// smart-crop. The tracking maths is tested as pure functions (that is where
// the risk is), and the rendering is tested optically with a moving target
// whose position is known exactly.
//
// Face DETECTION accuracy itself is OpenCV's, not ours, and there is no real
// face footage in this repo to measure it against — so these tests cover the
// tracker, the smoothing, the sendcmd rendering and the no-subject fallback,
// and deliberately do not claim anything about detection quality.
import fs from 'node:fs';
import { test, eq, near, assert, verifyMedia, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import {
  smartCrop, pickSubject, fillGaps, smoothTrack, toCommands, renderSendcmd,
} from '../tools/smart-crop.mjs';
import { ffmpeg, FFMPEG } from '../lib/ffmpeg.mjs';
import { run } from '../lib/proc.mjs';
import { EXIT } from '../lib/errors.mjs';

const face = (cx, cy, area = 0.02) => ({ cx, cy, area, x: 0, y: 0, w: 1, h: 1, score: 0.9 });
const sample = (t, faces) => ({ t, frame: Math.round(t * 30), faces });

/** A white 80x80 box sliding left to right across a black 640x360 frame. */
async function movingFixture() {
  const f = tmp('sc-moving.mp4');
  if (!fs.existsSync(f)) {
    await ffmpeg([
      '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=6:r=30',
      '-f', 'lavfi', '-i', 'color=c=white:s=80x80:d=6:r=30',
      '-filter_complex', "[0:v][1:v]overlay=x='50+75*t':y=140[v]", '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', f,
    ]);
  }
  return f;
}

/** A synthetic detection file that follows the box exactly. */
function movingTrack() {
  const p = tmp('sc-track.json');
  const W = 640, H = 360, samples = [];
  for (let i = 0; i <= 30; i++) {
    const t = i * 0.2;
    const x = 50 + 75 * t;
    samples.push(sample(+t.toFixed(3), [{
      x, y: 140, w: 80, h: 80, score: 0.99,
      cx: +((x + 40) / W).toFixed(5), cy: +(180 / H).toFixed(5), area: (80 * 80) / (W * H),
    }]));
  }
  fs.writeFileSync(p, JSON.stringify({
    width: W, height: H, fps: 30, sampleCount: samples.length,
    framesWithFaces: samples.length, coverage: 1, samples,
  }));
  return p;
}

/** Horizontal centre of the white box inside a frame, via cropdetect. */
async function boxCentre(file, at) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-i', file,
    '-vf', 'cropdetect=limit=0.15:round=2:reset=1', '-frames:v', '3', '-f', 'null', '-',
  ], { timeoutMs: 120000 });
  const all = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!all.length) return null;              // subject not in frame at all
  const m = all[all.length - 1];
  return Math.round(Number(m[3]) + Number(m[1]) / 2);
}

/* ---------------------------------------------------------------- tracking */

test('pickSubject follows the largest face when there is no history', () => {
  const [p] = pickSubject([sample(0, [face(0.2, 0.5, 0.01), face(0.8, 0.5, 0.05)])]);
  near(p.cx, 0.8, 1e-9, 'the bigger face should be chosen');
});

test('pickSubject sticks with the current subject against a marginally bigger rival', () => {
  const track = pickSubject([
    sample(0, [face(0.2, 0.5, 0.05)]),
    sample(0.2, [face(0.2, 0.5, 0.05), face(0.8, 0.5, 0.06)]),
  ], { stickiness: 1.35 });
  near(track[1].cx, 0.2, 1e-9, 'a 20% bigger rival must not steal the shot');
});

test('pickSubject does switch when the rival is clearly bigger', () => {
  const track = pickSubject([
    sample(0, [face(0.2, 0.5, 0.02)]),
    sample(0.2, [face(0.2, 0.5, 0.02), face(0.8, 0.5, 0.20)]),
  ], { stickiness: 1.35 });
  near(track[1].cx, 0.8, 1e-9, 'a 10x bigger face is clearly the new subject');
});

test('fillGaps holds the last position through a dropout', () => {
  const filled = fillGaps(pickSubject([
    sample(0, [face(0.3, 0.5)]),
    sample(0.2, []),
    sample(0.4, []),
    sample(0.6, [face(0.35, 0.5)]),
  ]));
  near(filled[1].cx, 0.3, 1e-9, 'a missed detection must hold, not recentre');
  eq(filled[1].held, true);
  eq(filled[3].held, false);
});

test('fillGaps back-fills the head with the first real detection', () => {
  const filled = fillGaps(pickSubject([
    sample(0, []),
    sample(0.2, []),
    sample(0.4, [face(0.8, 0.5)]),
  ]));
  near(filled[0].cx, 0.8, 1e-9, 'the shot must start where the subject is, not centre then slide');
});

test('smoothTrack deadzone freezes the camera on a still subject', () => {
  // Jitter of +/-0.005 around 0.5 — detector noise, not movement.
  const noisy = Array.from({ length: 20 }, (_, i) => ({
    t: i * 0.2, cx: 0.5 + (i % 2 ? 0.005 : -0.005), cy: 0.5, held: false,
  }));
  const out = smoothTrack(noisy, { smoothing: 0.85, deadzone: 0.02 });
  const spread = Math.max(...out.map(p => p.cx)) - Math.min(...out.map(p => p.cx));
  eq(spread, 0, 'detector jitter inside the deadzone must produce zero camera movement');
});

test('smoothTrack still follows real movement', () => {
  const moving = Array.from({ length: 20 }, (_, i) => ({ t: i * 0.2, cx: 0.2 + i * 0.03, cy: 0.5, held: false }));
  const out = smoothTrack(moving, { smoothing: 0.5, deadzone: 0.02 });
  assert(out[out.length - 1].cx > out[0].cx + 0.2, 'a subject crossing the frame must be followed');
});

test('smoothTrack clamps a detection glitch', () => {
  const glitch = [
    { t: 0, cx: 0.5, cy: 0.5, held: false },
    { t: 0.2, cx: 0.5, cy: 0.5, held: false },
    { t: 0.4, cx: 0.02, cy: 0.5, held: false },   // impossible jump
  ];
  const out = smoothTrack(glitch, { smoothing: 0, deadzone: 0, maxStep: 0.06 });
  assert(Math.abs(out[2].cx - 0.5) <= 0.061,
    `a single bad detection must not throw the frame across shot (moved to ${out[2].cx})`);
});

test('toCommands clamps the crop window inside the frame', () => {
  const rect = { w: 202, h: 360, x: 0, y: 0 };
  const cmds = toCommands(
    [{ t: 0, cx: 0.0, cy: 0.5 }, { t: 1, cx: 1.0, cy: 0.5 }],
    { width: 640, height: 360, rect }
  );
  for (const c of cmds) {
    assert(c.x >= 0 && c.x <= 640 - rect.w, `crop x ${c.x} escapes the frame`);
    assert(c.y >= 0 && c.y <= 360 - rect.h, `crop y ${c.y} escapes the frame`);
  }
});

test('toCommands emits only real movements', () => {
  const still = Array.from({ length: 30 }, (_, i) => ({ t: i * 0.2, cx: 0.5, cy: 0.5 }));
  const cmds = toCommands(still, { width: 640, height: 360, rect: { w: 202, h: 360 } });
  eq(cmds.length, 1, 'a static subject needs exactly one command, not thirty');
});

test('renderSendcmd emits valid sendcmd syntax', () => {
  const s = renderSendcmd([{ t: 0, x: 10, y: 0 }, { t: 1.5, x: 20, y: 0 }]);
  assert(/^0\.000 crop x '10', crop y '0';$/m.test(s), `unexpected syntax:\n${s}`);
  eq(s.trim().split('\n').length, 2);
});

/* --------------------------------------------------------------- rendering */

test('the subject stays in frame while a static crop loses it', async () => {
  const src = await movingFixture();
  const track = movingTrack();

  const tracked = await smartCrop(src, {
    track, resolution: '360x640', smoothing: 0, deadzone: 0, maxStep: 1,
    out: tmp('sc-tracked.mp4'), quality: 'preview',
  });

  const { cropVideo } = await import('../tools/crop-video.mjs');
  const staticCrop = await cropVideo(src, {
    aspect: '9:16', resolution: '360x640', out: tmp('sc-static.mp4'), quality: 'preview',
  });

  let trackedMisses = 0, staticMisses = 0;
  for (const t of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]) {
    if ((await boxCentre(tracked.path, t)) === null) trackedMisses++;
    if ((await boxCentre(staticCrop.path, t)) === null) staticMisses++;
  }
  eq(trackedMisses, 0, 'the tracked crop must never lose the subject');
  assert(staticMisses > 0, 'the static crop is expected to lose it — otherwise this fixture proves nothing');
});

test('with no smoothing the subject sits at the centre of frame', async () => {
  const r = await smartCrop(await movingFixture(), {
    track: movingTrack(), resolution: '360x640', smoothing: 0, deadzone: 0, maxStep: 1,
    out: tmp('sc-exact.mp4'), quality: 'preview',
  });
  for (const t of [2.5, 4.5]) {
    const x = await boxCentre(r.path, t);
    near(x, 180, 12, `subject should be centred in a 360px-wide output at t=${t}s`);
  }
});

test('smoothing trades responsiveness for calm, measurably', async () => {
  const src = await movingFixture();
  const track = movingTrack();
  const lag = async smoothing => {
    const r = await smartCrop(src, {
      track, resolution: '360x640', smoothing, deadzone: 0, maxStep: 1,
      out: tmp(`sc-sm-${smoothing}.mp4`), quality: 'preview',
    });
    return Math.abs((await boxCentre(r.path, 3.5)) - 180);
  };
  const none = await lag(0);
  const heavy = await lag(0.85);
  assert(heavy > none, `heavier smoothing must lag more against a constantly-moving subject (${none} vs ${heavy})`);
});

test('a static subject produces a single crop position', async () => {
  const p = tmp('sc-still.json');
  const samples = Array.from({ length: 20 }, (_, i) => sample(i * 0.2, [face(0.4, 0.5)]));
  fs.writeFileSync(p, JSON.stringify({ width: 640, height: 360, sampleCount: 20, framesWithFaces: 20, coverage: 1, samples }));
  const r = await smartCrop(await movingFixture(), {
    track: p, resolution: '360x640', out: tmp('sc-still.mp4'), quality: 'preview',
  });
  eq(r.moveCount, 1, 'a motionless subject must not produce a drifting camera');
  eq(r.xRange[0], r.xRange[1]);
});

test('falls back to a fixed frame when nothing is detected', async () => {
  const p = tmp('sc-none.json');
  const samples = Array.from({ length: 10 }, (_, i) => sample(i * 0.2, []));
  fs.writeFileSync(p, JSON.stringify({ width: 640, height: 360, sampleCount: 10, framesWithFaces: 0, coverage: 0, samples }));
  const r = await smartCrop(await movingFixture(), {
    track: p, resolution: '360x640', out: tmp('sc-nofaces.mp4'), quality: 'preview',
  });
  eq(r.tracked, false, 'with no detections it must report that it is NOT tracking');
  eq(r.moveCount, 1);
  await verifyMedia(r.path, { width: 360, height: 640 });
});

test('output geometry and audio are correct', async () => {
  const r = await smartCrop(await fixture('landscape'), {
    track: (() => {
      const p = tmp('sc-ls.json');
      const samples = Array.from({ length: 16 }, (_, i) => sample(i, [face(0.5, 0.5)]));
      fs.writeFileSync(p, JSON.stringify({ width: 1280, height: 720, sampleCount: 16, framesWithFaces: 16, coverage: 1, samples }));
      return p;
    })(),
    resolution: '1080x1920', out: tmp('sc-ls.mp4'), quality: 'preview',
  });
  await verifyMedia(r.path, { width: 1080, height: 1920, hasAudio: true, duration: 16, durationTol: 0.4 });
});

test('refuses when there is nothing to reframe', async () => {
  let code = null;
  try {
    await smartCrop(await fixture('portrait'), { aspect: '9:16', out: tmp('sc-noop.mp4') });
  } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE, 'a 9:16 source cropped to 9:16 is a no-op and should say so');
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const j = await cliOk('smart-crop.mjs', [
    await movingFixture(), '--track', movingTrack(), '--resolution', '360x640',
    '--out', tmp('sc-cli.mp4'), '--quality', 'preview',
  ]);
  eq(j.tool, 'smart-crop');
  eq(j.width, 360);
});
