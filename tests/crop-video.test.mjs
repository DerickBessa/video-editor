import { test, eq, near, assert, verifyMedia, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { cropVideo, cropRect, parseAspect, parseResolution } from '../tools/crop-video.mjs';
import { run } from '../lib/proc.mjs';
import { FFMPEG } from '../lib/ffmpeg.mjs';
import { EXIT } from '../lib/errors.mjs';

/** Mean luminance of a region, used to prove the blur fill really renders. */
async function luma(file, crop, at = 2) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-i', file,
    '-vf', `crop=${crop},signalstats,metadata=print`, '-frames:v', '1', '-f', 'null', '-',
  ], { timeoutMs: 120000 });
  const m = /YAVG=([0-9.]+)/.exec(stderr);
  return m ? Number(m[1]) : null;
}

test('parseAspect accepts the usual notations', () => {
  near(parseAspect('9:16'), 0.5625, 1e-6);
  near(parseAspect('16x9'), 1.7778, 1e-3);
  near(parseAspect('1:1'), 1, 1e-9);
  near(parseAspect('0.5625'), 0.5625, 1e-9);
  eq(parseAspect(null), null);
});

test('parseResolution rejects nonsense', () => {
  eq(JSON.stringify(parseResolution('1080x1920')), '{"width":1080,"height":1920}');
  let threw = false;
  try { parseResolution('big'); } catch { threw = true; }
  assert(threw, 'should reject unparseable resolutions');
});

test('cropRect fits the target aspect and stays inside the frame', () => {
  const r = cropRect(1280, 720, 9 / 16);
  eq(r.h, 720, 'height is the limiting dimension for 16:9 -> 9:16');
  near(r.w / r.h, 0.5625, 0.005, 'aspect');
  eq(r.x, Math.round((1280 - r.w) / 2) & ~1, 'centred horizontally');
  eq(r.w % 2, 0, 'width must be even for yuv420p');
  eq(r.h % 2, 0, 'height must be even for yuv420p');
  assert(r.x + r.w <= 1280 && r.y + r.h <= 720, 'rect must stay inside the source');
});

test('cropRect honours the anchor', () => {
  const left = cropRect(1280, 720, 9 / 16, { anchorX: 0 });
  const right = cropRect(1280, 720, 9 / 16, { anchorX: 1 });
  const mid = cropRect(1280, 720, 9 / 16, { anchorX: 0.5 });
  eq(left.x, 0);
  eq(right.x + right.w, 1280);
  assert(mid.x > left.x && mid.x < right.x, 'centre must sit between the extremes');
});

test('16:9 -> 9:16 produces the requested resolution', async () => {
  const r = await cropVideo(await fixture('landscape'), {
    aspect: '9:16', resolution: '1080x1920', out: tmp('cv-vert.mp4'), quality: 'preview',
  });
  eq(r.width, 1080); eq(r.height, 1920);
  await verifyMedia(r.path, { width: 1080, height: 1920, hasAudio: true });
  near(r.aspect, 0.5625, 0.002);
});

test('position changes where the crop is taken from', async () => {
  const src = await fixture('landscape');
  const left = await cropVideo(src, { aspect: '9:16', position: 'left', out: tmp('cv-l.mp4'), quality: 'preview' });
  const right = await cropVideo(src, { aspect: '9:16', position: 'right', out: tmp('cv-r.mp4'), quality: 'preview' });
  eq(left.crop.x, 0);
  eq(right.crop.x + right.crop.w, left.sourceWidth);
});

test('anchorX overrides position', async () => {
  const r = await cropVideo(await fixture('landscape'), {
    aspect: '9:16', position: 'center', anchorX: 0, out: tmp('cv-a.mp4'), quality: 'preview',
  });
  eq(r.crop.x, 0, 'explicit anchor must win');
});

test('contain with a blurred background actually fills the bars', async () => {
  const src = await fixture('landscape');
  const blur = await cropVideo(src, {
    resolution: '1080x1920', fit: 'contain', background: 'blur', out: tmp('cv-blur.mp4'), quality: 'preview',
  });
  const black = await cropVideo(src, {
    resolution: '1080x1920', fit: 'contain', background: 'black', out: tmp('cv-black.mp4'), quality: 'preview',
  });
  const blurTop = await luma(blur.path, '1080:300:0:0');
  const blackTop = await luma(black.path, '1080:300:0:0');
  assert(blackTop !== null && blurTop !== null, 'luminance measurement failed');
  assert(blackTop < 20, `black background should be near-black, got ${blackTop}`);
  assert(blurTop > blackTop + 30, `blur background (${blurTop}) should be much brighter than black (${blackTop})`);
});

test('contain keeps the whole frame (no crop)', async () => {
  const r = await cropVideo(await fixture('landscape'), {
    resolution: '1080x1920', fit: 'contain', out: tmp('cv-contain.mp4'), quality: 'preview',
  });
  eq(r.crop.w, r.sourceWidth, 'contain must not crop horizontally');
  eq(r.crop.h, r.sourceHeight, 'contain must not crop vertically');
});

test('square and widescreen targets both work', async () => {
  const sq = await cropVideo(await fixture('landscape'), {
    aspect: '1:1', resolution: '1080x1080', out: tmp('cv-sq.mp4'), quality: 'preview',
  });
  eq(sq.width, 1080); eq(sq.height, 1080);

  // Portrait source -> widescreen is the reverse direction.
  const wide = await cropVideo(await fixture('portrait'), {
    aspect: '16:9', resolution: '1920x1080', out: tmp('cv-wide.mp4'), quality: 'preview',
  });
  eq(wide.width, 1920); eq(wide.height, 1080);
  eq(wide.crop.w, 1080, 'width is the limiting dimension here');
});

test('an explicit rect is used verbatim', async () => {
  const r = await cropVideo(await fixture('landscape'), {
    rect: '640:360:100:50', out: tmp('cv-rect.mp4'), quality: 'preview',
  });
  eq(JSON.stringify(r.crop), JSON.stringify({ w: 640, h: 360, x: 100, y: 50 }));
  await verifyMedia(r.path, { width: 640, height: 360 });
});

test('a rect that does not fit is rejected', async () => {
  let code = null;
  try {
    await cropVideo(await fixture('landscape'), { rect: '9999:9999:0:0', out: tmp('cv-bad.mp4') });
  } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('requires something to do', async () => {
  let code = null;
  try { await cropVideo(await fixture('landscape'), { out: tmp('cv-noop.mp4') }); } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('audio survives the reframe', async () => {
  const r = await cropVideo(await fixture('landscape'), {
    aspect: '9:16', resolution: '540x960', out: tmp('cv-audio.mp4'), quality: 'preview',
  });
  eq(r.hasAudio, true);
  await verifyMedia(r.path, { hasAudio: true, duration: 16, durationTol: 0.3 });
});

test('a source with no audio does not break the mapping', async () => {
  const r = await cropVideo(await fixture('mute'), {
    aspect: '9:16', resolution: '360x640', out: tmp('cv-mute.mp4'), quality: 'preview',
  });
  eq(r.hasAudio, false);
  await verifyMedia(r.path, { width: 360, height: 640, hasAudio: false });
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const j = await cliOk('crop-video.mjs', [
    await fixture('landscape'), '--aspect', '9:16', '--resolution', '540x960',
    '--out', tmp('cv-cli.mp4'), '--quality', 'preview',
  ]);
  eq(j.tool, 'crop-video');
  eq(j.width, 540);
});
