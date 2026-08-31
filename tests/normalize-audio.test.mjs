// normalize-audio — every assertion re-measures the OUTPUT with loudnorm.
import { test, eq, near, assert, verifyMedia, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { buildSpeechFixture } from './speech-fixture.mjs';
import { normalizeAudio, measureLoudness } from '../tools/normalize-audio.mjs';
import { EXIT } from '../lib/errors.mjs';

/* --------------------------------------------------------- normalize-audio */

test('normalisation lands within 1 LU of the target', async () => {
  const { video } = await buildSpeechFixture();
  const r = await normalizeAudio(video, { targetLufs: -16, out: tmp('na-16.mp4') });
  assert(Math.abs(r.errorLu) <= 1.0, `landed ${r.errorLu} LU from target: ${r.after.lufs} LUFS`);
  assert(r.after.truePeak <= -1.0, `true peak ${r.after.truePeak} dBTP exceeds the ceiling`);
});

test('a different target is actually honoured', async () => {
  const { video } = await buildSpeechFixture();
  const a = await normalizeAudio(video, { targetLufs: -14, out: tmp('na-14.mp4') });
  const b = await normalizeAudio(video, { targetLufs: -23, out: tmp('na-23.mp4') });
  near(a.after.lufs, -14, 1.0);
  near(b.after.lufs, -23, 1.0);
  assert(a.after.lufs > b.after.lufs, '-14 target must be louder than -23');
});

test('two-pass is more accurate than one-pass', async () => {
  // This is the justification for the extra decode pass; if it stops being
  // true, the default should change.
  const { video } = await buildSpeechFixture();
  const one = await normalizeAudio(video, { passes: 1, out: tmp('na-p1.mp4') });
  const two = await normalizeAudio(video, { passes: 2, out: tmp('na-p2.mp4') });
  assert(Math.abs(two.errorLu) <= Math.abs(one.errorLu),
    `two-pass (${two.errorLu} LU) should be at least as accurate as one-pass (${one.errorLu} LU)`);
});

test('quiet and loud inputs both converge on the target', async () => {
  const { ffmpeg } = await import('../lib/ffmpeg.mjs');
  const { video } = await buildSpeechFixture();
  for (const [name, gain] of [['quiet', '-18dB'], ['loud', '+6dB']]) {
    const src = tmp(`na-src-${name}.mp4`);
    await ffmpeg(['-y', '-i', video, '-af', `volume=${gain}`, '-c:v', 'copy', '-c:a', 'aac', src]);
    const r = await normalizeAudio(src, { targetLufs: -16, out: tmp(`na-out-${name}.mp4`) });
    assert(Math.abs(r.errorLu) <= 1.0, `${name} input landed ${r.errorLu} LU from target`);
  }
});

test('the video stream is copied, not re-encoded', async () => {
  const { video } = await buildSpeechFixture();
  const r = await normalizeAudio(video, { out: tmp('na-copy.mp4') });
  eq(r.hasVideo, true);
  const before = await verifyMedia(video, {});
  const after = await verifyMedia(r.path, {});
  eq(after.width, before.width);
  eq(after.height, before.height);
  eq(after.frames, before.frames, 'frame count must be identical if the video was copied');
});

test('measureLoudness reports the fields the second pass needs', async () => {
  const { video } = await buildSpeechFixture();
  const m = await measureLoudness(video);
  for (const k of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) {
    assert(m[k] !== undefined, `missing ${k} in loudnorm measurement`);
    assert(Number.isFinite(Number(m[k])), `${k} is not numeric: ${m[k]}`);
  }
});

test('refuses a source with no audio', async () => {
  let code = null;
  try { await normalizeAudio(await fixture('mute'), { out: tmp('na-mute.mp4') }); } catch (e) { code = e.code; }
  eq(code, EXIT.INPUT);
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const { video } = await buildSpeechFixture();
  const j = await cliOk('normalize-audio.mjs', [video, '--out', tmp('na-cli.mp4')]);
  eq(j.tool, 'normalize-audio');
  assert(Math.abs(j.errorLu) <= 1.5);
});
