import { test, eq, near, assert, verifyMedia, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { zoomVideo, parseEvents } from '../tools/zoom-video.mjs';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { run } from '../lib/proc.mjs';
import { FFMPEG } from '../lib/ffmpeg.mjs';
import { EXIT } from '../lib/errors.mjs';

/**
 * A black frame with a centred 100x100 white box. After a zoom of Z, cropdetect
 * reports the box as 100*Z wide, which makes the zoom factor directly
 * measurable instead of a matter of opinion.
 */
async function boxFixture() {
  const f = tmp('zoom-box.mp4');
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=6:r=30',
    '-vf', 'drawbox=x=270:y=130:w=100:h=100:color=white@1:t=fill',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', f,
  ]);
  return f;
}

/** Width of the white box at time t, via cropdetect. */
async function boxWidth(file, at) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-i', file,
    '-vf', 'cropdetect=limit=0.15:round=2:reset=1', '-frames:v', '2', '-f', 'null', '-',
  ], { timeoutMs: 120000 });
  const all = [...stderr.matchAll(/crop=(\d+):(\d+)/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

test('parseEvents reads the compact CLI form', () => {
  const e = parseEvents('5-7@1.12');
  eq(e.length, 1);
  eq(e[0].start, 5); eq(e[0].end, 7); eq(e[0].scale, 1.12);
  eq(e[0].x, 0.5, 'defaults to a centred focal point');
});

test('parseEvents reads a focal point and multiple events', () => {
  const e = parseEvents('1-3@1.1;5-7@1.25:0.3,0.4');
  eq(e.length, 2);
  eq(e[1].x, 0.3); eq(e[1].y, 0.4);
});

test('parseEvents reads JSON', () => {
  const e = parseEvents('[{"start":1,"end":2,"scale":1.3,"mode":"punch"}]');
  eq(e[0].mode, 'punch');
  eq(e[0].ramp, 0.08, 'punch gets a fast ramp by default');
});

test('parseEvents clamps the ramp to half the event length', () => {
  const [e] = parseEvents([{ start: 0, end: 0.4, scale: 1.2, ramp: 5 }]);
  near(e.ramp, 0.2, 1e-9, 'ramp cannot exceed half the duration or the move never completes');
});

test('parseEvents rejects malformed input', () => {
  for (const bad of ['nonsense', '5-3@1.2', '[{"start":1,"end":2,"mode":"wobble"}]']) {
    let threw = false;
    try { parseEvents(bad); } catch { threw = true; }
    assert(threw, `should reject ${bad}`);
  }
});

test('the zoom factor is objectively correct', async () => {
  const src = await boxFixture();
  const out = tmp('zoom-linear.mp4');
  await zoomVideo(src, {
    events: [{ start: 0, end: 6, scale: 1.8, mode: 'linear', ramp: 3 }],
    out, quality: 'final',
  });

  // Control: unzoomed source measures exactly 100px.
  near(await boxWidth(src, 3), 100, 3, 'control measurement');

  for (const t of [0.5, 1.5, 2.5]) {
    const expected = 100 * (1 + 0.8 * Math.min(1, t / 3));
    const got = await boxWidth(out, t);
    near(got, expected, 5, `box width at ${t}s (cropdetect rounds to even)`);
  }
});

test('zoom preserves frame size, frame rate and duration', async () => {
  const src = await fixture('scenes');
  const r = await zoomVideo(src, { events: '3-8@1.2', out: tmp('zoom-dims.mp4'), quality: 'preview' });
  eq(r.width, 640); eq(r.height, 360);
  near(r.fps, 30, 0.2, 'zoompan must not silently change the frame rate');
  near(r.duration, r.sourceDuration, 0.3, 'zoompan must not silently change the duration');
  await verifyMedia(r.path, { width: 640, height: 360, hasAudio: true });
});

test('the zoom moves and returns to rest', async () => {
  const src = await boxFixture();
  const out = tmp('zoom-return.mp4');
  await zoomVideo(src, {
    events: [{ start: 2, end: 4, scale: 1.5, mode: 'smooth', ramp: 0.5 }],
    out, quality: 'final',
  });
  const before = await boxWidth(out, 1.0);
  const during = await boxWidth(out, 3.0);
  const after = await boxWidth(out, 5.0);
  near(before, 100, 5, 'before the event: at rest');
  near(during, 150, 8, 'mid-event: fully zoomed');
  near(after, 100, 5, 'after the event: back to rest');
});

test('easing is monotonic through the ramp (no jumps or reversals)', async () => {
  const src = await boxFixture();
  const out = tmp('zoom-ease.mp4');
  await zoomVideo(src, {
    events: [{ start: 0, end: 6, scale: 1.6, mode: 'smooth', ramp: 2.5 }],
    out, quality: 'final',
  });
  const widths = [];
  for (const t of [0.2, 0.6, 1.0, 1.4, 1.8, 2.2]) widths.push(await boxWidth(out, t));
  for (let i = 1; i < widths.length; i++) {
    assert(widths[i] >= widths[i - 1] - 2,
      `zoom went backwards during the ramp: ${widths.join(' -> ')}`);
  }
  assert(widths[widths.length - 1] > widths[0] + 20, `ramp barely moved: ${widths.join(' -> ')}`);
});

test('all three modes render', async () => {
  for (const mode of ['smooth', 'punch', 'linear']) {
    const r = await zoomVideo(await fixture('scenes'), {
      events: [{ start: 3, end: 8, scale: 1.2, mode }],
      out: tmp(`zoom-${mode}.mp4`), quality: 'preview',
    });
    eq(r.events[0].mode, mode);
    near(r.duration, 12, 0.3, `${mode} duration`);
  }
});

test('overlapping events are rejected', async () => {
  let code = null;
  try {
    await zoomVideo(await fixture('scenes'), { events: '1-5@1.2;3-7@1.3', out: tmp('zoom-ovl.mp4') });
  } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('events beyond the source are rejected', async () => {
  let code = null;
  try {
    await zoomVideo(await fixture('scenes'), { events: '50-60@1.2', out: tmp('zoom-oob.mp4') });
  } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('requires at least one event', async () => {
  let code = null;
  try { await zoomVideo(await fixture('scenes'), { out: tmp('zoom-none.mp4') }); } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const j = await cliOk('zoom-video.mjs', [
    await fixture('scenes'), '--events', '2-5@1.15', '--out', tmp('zoom-cli.mp4'), '--quality', 'preview',
  ]);
  eq(j.tool, 'zoom-video');
  eq(j.eventCount, 1);
});
