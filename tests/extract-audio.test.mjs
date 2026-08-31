import fs from 'node:fs';
import { test, eq, near, assert, verifyMedia, cliOk, cliFails, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { extractAudio } from '../tools/extract-audio.mjs';
import { EXIT } from '../lib/errors.mjs';

// 16-bit mono PCM: bytes = seconds * rate * 2, plus a small WAV header.
const pcmBytes = (sec, rate = 16000) => sec * rate * 2;

test('extracts 16 kHz mono PCM WAV by default', async () => {
  const r = await extractAudio(await fixture('landscape'), { out: tmp('ea-default.wav'), force: true });
  eq(r.sampleRate, 16000);
  eq(r.channels, 1);
  eq(r.codec, 'pcm_s16le');
  near(r.duration, 16, 0.1);
  await verifyMedia(r.path, { sampleRate: 16000, channels: 1, hasVideo: false, duration: 16 });
  // Byte count is the real proof the sample format is what we claim.
  near(r.sizeBytes, pcmBytes(16) + 78, 200, 'PCM byte count');
});

test('honours a custom sample rate and channel count', async () => {
  const r = await extractAudio(await fixture('landscape'), {
    out: tmp('ea-48k.wav'), sampleRate: 48000, channels: 2, force: true,
  });
  eq(r.sampleRate, 48000);
  eq(r.channels, 2);
  await verifyMedia(r.path, { sampleRate: 48000, channels: 2 });
});

test('trims to a start/end window', async () => {
  const r = await extractAudio(await fixture('landscape'), {
    out: tmp('ea-trim.wav'), start: 4, end: 9, force: true,
  });
  near(r.duration, 5, 0.05, 'trimmed duration');
  near(r.sizeBytes, pcmBytes(5) + 78, 200);
});

test('rejects an inverted window', async () => {
  let code = null;
  try { await extractAudio(await fixture('landscape'), { out: tmp('ea-bad.wav'), start: 9, end: 4 }); }
  catch (e) { code = e.code; }
  eq(code, EXIT.INPUT);
});

test('refuses a source with no audio track', async () => {
  let code = null;
  try { await extractAudio(await fixture('mute'), { out: tmp('ea-mute.wav') }); }
  catch (e) { code = e.code; }
  eq(code, EXIT.INPUT);
});

test('second run is served from cache without re-encoding', async () => {
  const src = await fixture('portrait');
  const first = await extractAudio(src, { force: true });
  eq(first.cached, false, 'first run should do the work');
  const second = await extractAudio(src);
  eq(second.cached, true, 'second run should hit the cache');
  eq(second.path, first.path, 'cache key should be stable');
});

test('changing settings produces a different cache entry', async () => {
  const src = await fixture('portrait');
  const a = await extractAudio(src, { sampleRate: 16000 });
  const b = await extractAudio(src, { sampleRate: 22050 });
  assert(a.path !== b.path, 'different settings must not share a cache file');
  eq(b.sampleRate, 22050);
});

test('never writes into raw/', async () => {
  let code = null;
  try { await extractAudio(await fixture('landscape'), { out: 'raw/should-not-exist.wav' }); }
  catch (e) { code = e.code; }
  eq(code, EXIT.INPUT);
  eq(fs.existsSync('raw/should-not-exist.wav'), false);
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const j = await cliOk('extract-audio.mjs', [await fixture('landscape'), '--out', tmp('ea-cli.wav'), '--force']);
  eq(j.tool, 'extract-audio');
  eq(j.sampleRate, 16000);
});

test('CLI exits 3 on a file with no audio', async () => {
  await cliFails('extract-audio.mjs', [await fixture('mute')], EXIT.INPUT);
});
