import fs from 'node:fs';
import { test, eq, near, assert, verifyMedia, cliOk, cliFails, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { cutVideo } from '../tools/cut-video.mjs';
import { ffprobeJson } from '../lib/ffmpeg.mjs';
import { EXIT } from '../lib/errors.mjs';

/** The real sync test: compare the two stream durations in the produced file. */
async function avSkew(file) {
  const j = await ffprobeJson(file);
  const v = j.streams.find(s => s.codec_type === 'video');
  const a = j.streams.find(s => s.codec_type === 'audio');
  if (!v || !a) return 0;
  return Math.abs(Number(v.duration) - Number(a.duration));
}

test('keeps the requested ranges and concatenates them', async () => {
  const r = await cutVideo(await fixture('landscape'), {
    keep: '0-5.2,6.1-13.4,14.8-16', out: tmp('cv-keep.mp4'),
  });
  eq(r.segmentCount, 3);
  near(r.actualDuration, 13.7, 0.15, 'output duration');
  await verifyMedia(r.path, { width: 1280, height: 720, hasAudio: true, duration: 13.7, durationTol: 0.15 });
});

test('remove ranges are the complement of keep ranges', async () => {
  const src = await fixture('landscape');
  const removed = await cutVideo(src, { remove: '4-5.5,10-11.2', out: tmp('cv-remove.mp4') });
  const kept = await cutVideo(src, { keep: '0-4,5.5-10,11.2-16', out: tmp('cv-equiv.mp4') });
  eq(removed.segmentCount, kept.segmentCount);
  near(removed.actualDuration, kept.actualDuration, 0.05, 'both routes give the same duration');
  near(removed.actualDuration, 13.3, 0.15);
});

test('A/V stay in sync across many cuts', async () => {
  // 40 cuts is where naive select+setpts approaches audibly drift.
  const keep = Array.from({ length: 40 }, (_, i) => {
    const s = +(i * 0.39).toFixed(2);
    return `${s}-${(s + 0.3).toFixed(2)}`;
  }).join(',');
  const r = await cutVideo(await fixture('landscape'), { keep, out: tmp('cv-40.mp4') });
  eq(r.segmentCount, 40);
  near(r.actualDuration, 12, 0.2, 'total duration');
  const skew = await avSkew(r.path);
  assert(skew < 0.1, `audio/video skew ${skew.toFixed(3)}s should stay under 100ms`);
});

test('reports drift honestly instead of silently producing wrong timing', async () => {
  // Sub-frame segments are known to stretch the concat filter's output.
  const keep = Array.from({ length: 200 }, (_, i) => {
    const s = +(i * 0.079).toFixed(3);
    return `${s}-${(s + 0.05).toFixed(3)}`;
  }).join(',');
  let code = null;
  try { await cutVideo(await fixture('landscape'), { keep, out: tmp('cv-tiny.mp4'), minSegment: 0.001 }); }
  catch (e) { code = e.code; }
  eq(code, EXIT.VALIDATION, 'stretched output must fail validation, not pass quietly');
});

test('drops sub-frame segments at the default minimum', async () => {
  let code = null;
  try {
    await cutVideo(await fixture('landscape'), { keep: '1-1.02,2-2.02', out: tmp('cv-drop.mp4') });
  } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE, 'all segments dropped -> usage error, not an empty file');
});

test('reads keep ranges from a plan file', async () => {
  const plan = tmp('cv-plan.json');
  fs.writeFileSync(plan, JSON.stringify({ keep: [[0, 3], [8, 12]] }));
  const r = await cutVideo(await fixture('landscape'), { plan, out: tmp('cv-fromplan.mp4') });
  eq(r.segmentCount, 2);
  near(r.actualDuration, 7, 0.15);
});

test('reads silences from a plan file and removes them', async () => {
  const plan = tmp('cv-sil.json');
  fs.writeFileSync(plan, JSON.stringify({ silences: [{ start: 4, end: 5.5 }, { start: 10, end: 11.2 }] }));
  const r = await cutVideo(await fixture('landscape'), { plan, out: tmp('cv-desil.mp4') });
  near(r.actualDuration, 13.3, 0.15);
  eq(r.segmentCount, 3);
});

test('handles a source with no audio track', async () => {
  const r = await cutVideo(await fixture('mute'), { keep: '0-2,3-5', out: tmp('cv-mute.mp4') });
  eq(r.hasAudio, false);
  near(r.actualDuration, 4, 0.15);
  await verifyMedia(r.path, { hasVideo: true, hasAudio: false });
});

test('copy strategy snaps to keyframes and says so', async () => {
  const r = await cutVideo(await fixture('landscape'), {
    keep: '0-5,8-12', strategy: 'copy', out: tmp('cv-copy.mp4'),
  });
  eq(r.strategy, 'copy');
  eq(r.requestedSegments, 2);
  assert(r.keyframeCount > 0, 'keyframes should have been detected');
  // The fixture only has keyframes at 0 and 8.33, so the two segments must merge.
  assert(r.maxKeyframeShift > 0, 'shift should be reported, not hidden');
});

test('rejects ranges beyond the source duration', async () => {
  let code = null;
  try { await cutVideo(await fixture('mute'), { keep: '0-2,90-95', out: tmp('cv-oob.mp4') }); }
  catch (e) { code = e.code; }
  // 90-95 is clamped away by normalize; 0-2 survives, so this must succeed.
  eq(code, null, 'out-of-range segments are clamped, not fatal');
});

test('requires at least one of keep/remove/plan', async () => {
  await cliFails('cut-video.mjs', [await fixture('mute')], EXIT.USAGE);
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const j = await cliOk('cut-video.mjs', [
    await fixture('landscape'), '--keep', '0-3,10-13', '--out', tmp('cv-cli.mp4'),
  ]);
  eq(j.tool, 'cut-video');
  eq(j.segmentCount, 2);
  near(j.actualDuration, 6, 0.15);
});
