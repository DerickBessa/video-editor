import fs from 'node:fs';
import { test, eq, near, assert, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { qaVideo, checkCaptionBounds } from '../tools/qa-video.mjs';
import { contactSheet } from '../tools/contact-sheet.mjs';
import { captions } from '../tools/captions.mjs';
import { buildSpeechFixture } from './speech-fixture.mjs';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { EXIT } from '../lib/errors.mjs';

const status = (r, name) => r.checks.find(c => c.name === name)?.status;

test('a healthy video passes every check', async () => {
  const r = await qaVideo(await fixture('landscape'), { out: tmp('qa-good.json'), strict: false });
  eq(r.passed, true, `unexpected failures: ${r.failures.join('; ')}`);
  eq(status(r, 'video-stream'), 'pass');
  eq(status(r, 'audio-stream'), 'pass');
  eq(status(r, 'black-frames'), 'pass');
});

test('a missing audio track is a failure by default', async () => {
  const r = await qaVideo(await fixture('mute'), { out: tmp('qa-mute.json'), strict: false });
  eq(status(r, 'audio-stream'), 'fail');
  eq(r.passed, false);
});

test('a missing audio track is only a warning when audio is not required', async () => {
  const r = await qaVideo(await fixture('mute'), { out: tmp('qa-mute2.json'), strict: false, requireAudio: false });
  eq(status(r, 'audio-stream'), 'warn');
  eq(r.passed, true);
});

test('a wrong resolution is caught', async () => {
  const r = await qaVideo(await fixture('landscape'), {
    expectWidth: 1080, expectHeight: 1920, out: tmp('qa-res.json'), strict: false,
  });
  eq(status(r, 'resolution'), 'fail');
  assert(r.failures.some(f => f.includes('1080x1920')), r.failures.join('; '));
});

test('a wrong duration is caught', async () => {
  const r = await qaVideo(await fixture('landscape'), {
    expectDuration: 60, out: tmp('qa-dur.json'), strict: false,
  });
  eq(status(r, 'duration'), 'fail');
});

test('a mostly-black video is caught', async () => {
  const black = tmp('qa-black.mp4');
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=6:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', black,
  ]);
  const r = await qaVideo(black, { out: tmp('qa-black.json'), strict: false });
  eq(status(r, 'black-frames'), 'fail');
  assert(r.failures.some(f => f.includes('black')), r.failures.join('; '));
});

test('silent audio is caught', async () => {
  const silent = tmp('qa-silent.mp4');
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=5:r=30',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '5',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', silent,
  ]);
  const r = await qaVideo(silent, { out: tmp('qa-silent.json'), strict: false });
  eq(status(r, 'audio-level'), 'fail');
});

test('a hot signal is flagged as clipping', async () => {
  const loud = tmp('qa-loud.mkv');
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=5:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-af', 'volume=20dB',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_s16le', '-shortest', loud,
  ]);
  const r = await qaVideo(loud, { out: tmp('qa-loud.json'), strict: false });
  assert(['fail', 'warn'].includes(status(r, 'audio-clipping')),
    `a signal driven 20dB hot should be flagged, got ${status(r, 'audio-clipping')}`);
});

test('strict mode exits non-zero on a failure', async () => {
  let code = null;
  try { await qaVideo(await fixture('mute'), { out: tmp('qa-strict.json') }); } catch (e) { code = e.code; }
  eq(code, EXIT.VALIDATION);
});

test('a report file is written', async () => {
  const out = tmp('qa-report.json');
  const r = await qaVideo(await fixture('landscape'), { out, strict: false });
  assert(fs.existsSync(out));
  eq(JSON.parse(fs.readFileSync(out, 'utf8')).checkCount, r.checkCount);
});

test('caption bounds: a PlayRes mismatch is caught', () => {
  const f = tmp('qa-bad.ass');
  fs.writeFileSync(f,
    'PlayResX: 640\nPlayResY: 360\n' +
    'Style: Caption,Arial,40,&H0,&H0,&H0,&H0,0,0,0,0,100,100,0,0,1,2,1,2,60,60,100,1\n');
  const c = checkCaptionBounds(f, { width: 1080, height: 1920 });
  eq(c.ok, false);
  assert(/PlayRes/.test(c.message), c.message);
});

test('caption bounds: captions too tall for the frame are caught', () => {
  const f = tmp('qa-tall.ass');
  // A 400px font with a 1500px bottom margin cannot fit in a 1920px frame.
  fs.writeFileSync(f,
    'PlayResX: 1080\nPlayResY: 1920\n' +
    'Style: Caption,Arial,400,&H0,&H0,&H0,&H0,0,0,0,0,100,100,0,0,1,2,1,2,60,60,1500,1\n');
  eq(checkCaptionBounds(f, { width: 1080, height: 1920 }).ok, false);
});

test('caption bounds: a real generated .ass passes', async () => {
  const { video } = await buildSpeechFixture();
  const cap = await captions(video, {
    transcript: 'transcripts/speech.json', style: 'clean', assOut: tmp('qa-real.ass'),
  });
  const r = await qaVideo(video, { captionsAss: cap.assPath, out: tmp('qa-cap.json'), strict: false });
  eq(status(r, 'caption-bounds'), 'pass');
});

/* ------------------------------------------------------------ contact sheet */

test('contact sheet tiles the whole video into one image', async () => {
  const r = await contactSheet(await fixture('landscape'), {
    columns: 4, rows: 2, tileWidth: 160, out: tmp('cs.png'),
  });
  eq(r.tiles, 8);
  eq(r.columns, 4);
  assert(r.width >= 4 * 160, `sheet should be at least four tiles wide, got ${r.width}`);
  assert(fs.existsSync(r.path));
});

test('contact sheet samples inside the video, never at the very edges', async () => {
  const r = await contactSheet(await fixture('landscape'), { columns: 3, rows: 1, out: tmp('cs2.png') });
  assert(r.timestamps[0] > 0, 'the first tile should not be frame zero, which is often black');
  assert(r.timestamps[r.timestamps.length - 1] < r.sourceDuration, 'the last tile must be inside the video');
});

test('contact sheet refuses a file with no picture', async () => {
  const audioOnly = tmp('cs-audio.wav');
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:a', 'pcm_s16le', audioOnly]);
  let code = null;
  try { await contactSheet(audioOnly, { out: tmp('cs-none.png') }); } catch (e) { code = e.code; }
  eq(code, EXIT.INPUT);
});

test('CLI round-trips for qa and contact-sheet', async () => {
  const a = await cliOk('qa-video.mjs', [await fixture('landscape'), '--out', tmp('qa-cli.json'), '--no-strict']);
  eq(a.tool, 'qa-video');
  const b = await cliOk('contact-sheet.mjs', [
    await fixture('landscape'), '--columns', '3', '--rows', '2', '--out', tmp('cs-cli.png'),
  ]);
  eq(b.tool, 'contact-sheet');
  eq(b.tiles, 6);
});
