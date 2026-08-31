import { test, eq, near, assert, cliOk, cliFails } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { probeVideo, parseRate, parseRotation } from '../tools/probe-video.mjs';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { EXIT } from '../lib/errors.mjs';
import { tmp } from './harness.mjs';

test('parseRate handles NTSC fractions and degenerate rates', () => {
  near(parseRate('30000/1001'), 29.97, 0.001);
  eq(parseRate('30/1'), 30);
  eq(parseRate('0/0'), null);
  eq(parseRate(undefined), null);
});

test('parseRotation normalises negative and out-of-range angles', () => {
  eq(parseRotation({ side_data_list: [{ rotation: -90 }] }), 270);
  eq(parseRotation({ side_data_list: [{ rotation: 90 }] }), 90);
  eq(parseRotation({ tags: { rotate: '180' } }), 180);
  eq(parseRotation({}), 0);
});

test('reads landscape video metadata', async () => {
  const f = await fixture('landscape');
  const m = await probeVideo(f);
  near(m.duration, 16, 0.2, 'duration');
  eq(m.width, 1280); eq(m.height, 720);
  near(m.fps, 30, 0.1);
  eq(m.codec, 'h264');
  eq(m.audioCodec, 'aac');
  eq(m.sampleRate, 48000);
  eq(m.hasVideo, true); eq(m.hasAudio, true);
  eq(m.orientation, 'landscape');
  assert(m.bitrate > 0, 'bitrate should be positive');
  assert(m.sizeBytes > 1000, 'sizeBytes should be populated');
});

test('reads portrait video and reports orientation', async () => {
  const m = await probeVideo(await fixture('portrait'));
  eq(m.width, 1080); eq(m.height, 1920);
  eq(m.orientation, 'portrait');
  near(m.aspect, 0.5625, 0.001);
});

test('handles a file with no audio track', async () => {
  const m = await probeVideo(await fixture('mute'));
  eq(m.hasAudio, false);
  eq(m.audioCodec, '');
  eq(m.channels, 0);
  eq(m.hasVideo, true);
});

test('applies display-matrix rotation to width/height', async () => {
  const src = await fixture('landscape');
  const out = tmp('rotated-probe.mp4');
  // -display_rotation writes real display-matrix side data (the deprecated
  // `rotate` metadata tag is ignored by ffmpeg 7+).
  await ffmpeg(['-y', '-display_rotation', '90', '-i', src, '-t', '2', '-c', 'copy', out]);
  const m = await probeVideo(out);
  eq(m.rotation, 90, 'rotation');
  eq(m.width, 720, 'display width (rotated)');
  eq(m.height, 1280, 'display height (rotated)');
  eq(m.codedWidth, 1280, 'coded width unchanged');
  eq(m.orientation, 'portrait');
});

test('CLI emits valid JSON on stdout and exits 0', async () => {
  const f = await fixture('landscape');
  const j = await cliOk('probe-video.mjs', [f]);
  eq(j.tool, 'probe-video');
  eq(j.width, 1280);
  assert(typeof j.ms === 'number', 'result should carry timing');
});

test('CLI exits 3 for a missing file', async () => {
  await cliFails('probe-video.mjs', ['raw/definitely-not-here.mp4'], EXIT.INPUT);
});

test('CLI exits 3 for a non-media file', async () => {
  await cliFails('probe-video.mjs', ['package.json'], EXIT.INPUT);
});

test('CLI exits 2 when required argument is missing', async () => {
  await cliFails('probe-video.mjs', [], EXIT.USAGE);
});
