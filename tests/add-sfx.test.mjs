import fs from 'node:fs';
import path from 'node:path';
import { test, eq, near, assert, verifyMedia, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { buildSpeechFixture } from './speech-fixture.mjs';
import { addSfx, parseEvents, thin, listSounds } from '../tools/add-sfx.mjs';
import { makeSfx } from '../scripts/make-sfx.mjs';
import { ffmpeg, FFMPEG } from '../lib/ffmpeg.mjs';
import { run } from '../lib/proc.mjs';
import { EXIT } from '../lib/errors.mjs';

/** Peak level in a short window — proves a sound is (or is not) present. */
async function peak(file, at, dur = 0.6) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-t', String(dur),
    '-i', file, '-af', 'volumedetect', '-f', 'null', '-',
  ], { timeoutMs: 120000 });
  const m = /max_volume:\s*(-?[\d.]+)/.exec(stderr);
  return m ? Number(m[1]) : null;
}

async function meanLevel(file, at, dur = 0.8) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-t', String(dur),
    '-i', file, '-af', 'volumedetect', '-f', 'null', '-',
  ], { timeoutMs: 120000 });
  const m = /mean_volume:\s*(-?[\d.]+)/.exec(stderr);
  return m ? Number(m[1]) : null;
}

/** A silent video, so anything audible in the output is definitely an effect. */
async function silentFixture() {
  const f = tmp('sfx-silent.mp4');
  if (!fs.existsSync(f)) {
    await ffmpeg([
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=12:r=30',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '12',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f,
    ]);
  }
  return f;
}

/* ----------------------------------------------------------------- parsing */

test('the generated catalogue exists and is complete', async () => {
  await makeSfx();
  const sounds = listSounds();
  for (const want of ['pop.wav', 'ding.wav', 'thud.wav', 'whoosh.wav']) {
    assert(sounds.includes(want), `catalogue is missing ${want}`);
  }
  const catalog = JSON.parse(fs.readFileSync(path.join('assets', 'sfx', 'catalog.json'), 'utf8'));
  assert(catalog.sounds.length >= 8, 'catalogue manifest should describe every sound');
  assert(catalog.sounds.every(s => s.description), 'each sound needs a description so Claude can pick one');
});

test('parseEvents reads the compact form', () => {
  const e = parseEvents('4.2:pop,7.9:ding@0.5');
  eq(e.length, 2);
  eq(e[0].timestamp, 4.2); eq(e[0].sound, 'pop');
  eq(e[1].volume, 0.5, 'the @ suffix sets volume');
  eq(e[0].volume, 0.4, 'default volume should be modest');
});

test('parseEvents reads JSON and sorts by time', () => {
  const e = parseEvents('[{"timestamp":9,"sound":"thud"},{"timestamp":2,"sound":"pop"}]');
  eq(e[0].timestamp, 2, 'events must come out in time order');
});

test('parseEvents rejects malformed input', () => {
  for (const bad of ['nonsense', '4.2', '[{"sound":"pop"}]', '[{"timestamp":-1,"sound":"pop"}]']) {
    let threw = false;
    try { parseEvents(bad); } catch { threw = true; }
    assert(threw, `should reject ${bad}`);
  }
});

/* ----------------------------------------------------------------- density */

test('thin drops events that crowd each other', () => {
  const events = parseEvents('1.0:pop,1.2:pop,1.4:pop,5.0:ding');
  const { kept, dropped } = thin(events, { minGap: 0.6, maxPerMinute: 60, duration: 60 });
  eq(kept.length, 2, 'three effects inside 0.4s should collapse to one, plus the distant one');
  eq(dropped.length, 2);
  assert(dropped.every(d => d.droppedBecause), 'every drop must carry a reason');
});

test('thin keeps the higher-priority event of a crowded pair', () => {
  const { kept } = thin(
    [{ timestamp: 1.0, sound: 'pop', priority: 0.1, volume: 0.4 },
     { timestamp: 1.1, sound: 'ding', priority: 0.9, volume: 0.4 }],
    { minGap: 0.6, maxPerMinute: 60, duration: 60 }
  );
  eq(kept.length, 1);
  eq(kept[0].sound, 'ding', 'the important beat should survive, not merely the first');
});

test('thin enforces the per-minute budget by priority', () => {
  const events = Array.from({ length: 20 }, (_, i) => ({
    timestamp: i * 3, sound: 'blip', volume: 0.4, priority: i / 20,
  }));
  const { kept } = thin(events, { minGap: 0.6, maxPerMinute: 6, duration: 60 });
  eq(kept.length, 6, 'a 60s clip at 6/min allows six effects');
  // The survivors should be the highest-priority ones.
  assert(Math.min(...kept.map(e => e.priority)) >= 0.6, 'low-priority effects should be the ones dropped');
});

/* ---------------------------------------------------------------- mixing */

test('effects land at the requested timestamps', async () => {
  const src = await silentFixture();
  const r = await addSfx(src, {
    events: '2.0:pop,5.0:ding,9.0:thud', maxPerMinute: 30, out: tmp('sfx-place.mp4'),
  });
  eq(r.applied, 3);
  for (const t of [2.0, 5.0, 9.0]) {
    const level = await peak(r.path, t);
    assert(level > -40, `expected an effect at ${t}s, measured ${level} dB`);
  }
  for (const t of [0.5, 3.5, 7.0]) {
    const level = await peak(r.path, t);
    assert(level < -60, `expected silence at ${t}s, measured ${level} dB`);
  }
});

test('the density budget is enforced on real output, and reported', async () => {
  const src = await silentFixture();
  // 12s at the default 12/min budgets only 2 effects.
  const r = await addSfx(src, { events: '2.0:pop,5.0:ding,9.0:thud', out: tmp('sfx-budget.mp4') });
  eq(r.applied, 2);
  eq(r.droppedCount, 1);
  assert(r.dropped[0].reason.includes('budget'), `drop reason should explain itself: ${r.dropped[0].reason}`);
});

test('volume is honoured', async () => {
  const src = await silentFixture();
  const loud = await addSfx(src, { events: '3.0:ding@0.9', maxPerMinute: 30, out: tmp('sfx-loud.mp4') });
  const quiet = await addSfx(src, { events: '3.0:ding@0.1', maxPerMinute: 30, out: tmp('sfx-quiet.mp4') });
  const lp = await peak(loud.path, 3.0);
  const qp = await peak(quiet.path, 3.0);
  assert(lp > qp + 10, `0.9 gain (${lp} dB) should be well above 0.1 gain (${qp} dB)`);
});

test('ducking dips an effect that lands on speech', async () => {
  const { video } = await buildSpeechFixture();
  // 7.0s is mid-sentence in the fixture.
  const on = await addSfx(video, { events: '7.0:ding@0.9', duck: true, maxPerMinute: 30, out: tmp('sfx-duck-on.mp4') });
  const off = await addSfx(video, { events: '7.0:ding@0.9', duck: false, maxPerMinute: 30, out: tmp('sfx-duck-off.mp4') });
  const lOn = await meanLevel(on.path, 7.0);
  const lOff = await meanLevel(off.path, 7.0);
  assert(lOn < lOff - 1.5,
    `ducking should measurably dip the effect under speech (on ${lOn} dB vs off ${lOff} dB)`);
});

test('ducking leaves an effect in silence alone', async () => {
  const { video, truth } = await buildSpeechFixture();
  // Land it inside a KNOWN silence, where there is no voice to duck under.
  const t = (truth.silences[0].start + truth.silences[0].end) / 2;
  const on = await addSfx(video, { events: `${t}:ding@0.9`, duck: true, maxPerMinute: 30, out: tmp('sfx-sil-on.mp4') });
  const off = await addSfx(video, { events: `${t}:ding@0.9`, duck: false, maxPerMinute: 30, out: tmp('sfx-sil-off.mp4') });
  near(await meanLevel(on.path, t), await meanLevel(off.path, t), 1.0,
    'with no speech present, ducking must not attenuate the effect');
});

test('the video stream is copied, not re-encoded', async () => {
  const { video } = await buildSpeechFixture();
  const before = await verifyMedia(video, {});
  const r = await addSfx(video, { events: '3.0:pop', maxPerMinute: 30, out: tmp('sfx-copy.mp4') });
  const after = await verifyMedia(r.path, {});
  eq(after.frames, before.frames, 'frame count must be identical if the video was stream-copied');
  eq(after.width, before.width);
});

test('duration is preserved', async () => {
  const { video } = await buildSpeechFixture();
  const r = await addSfx(video, { events: '20.0:whoosh', maxPerMinute: 30, out: tmp('sfx-dur.mp4') });
  near(r.actualDuration, r.duration, 0.4, 'mixing must not extend or truncate the video');
});

test('a source with no audio still gets its effects', async () => {
  const r = await addSfx(await fixture('mute'), {
    events: '1.0:pop,3.0:ding', maxPerMinute: 60, out: tmp('sfx-mute.mp4'),
  });
  eq(r.applied, 2);
  await verifyMedia(r.path, { hasAudio: true });
  assert((await peak(r.path, 1.0)) > -40, 'the effect should be audible even with no source audio');
});

test('an unknown sound is rejected and the catalogue is listed', async () => {
  let err = null;
  try { await addSfx(await silentFixture(), { events: '1:kaboom', out: tmp('sfx-bad.mp4') }); }
  catch (e) { err = e; }
  eq(err?.code, EXIT.INPUT);
  assert(/Available:/.test(err.hint || ''), 'the error should tell the user what sounds exist');
});

test('an effect beyond the source duration is rejected', async () => {
  let code = null;
  try { await addSfx(await silentFixture(), { events: '99:pop', out: tmp('sfx-oob.mp4') }); }
  catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('dry run reports without rendering', async () => {
  const r = await addSfx(await silentFixture(), { events: '2:pop,5:ding', dryRun: true });
  eq(r.dryRun, true);
  eq(r.output, undefined);
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const j = await cliOk('add-sfx.mjs', [
    await silentFixture(), '--events', '2:pop', '--out', tmp('sfx-cli.mp4'),
  ]);
  eq(j.tool, 'add-sfx');
  eq(j.applied, 1);
});
