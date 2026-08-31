import fs from 'node:fs';
import { test, eq, near, assert, cliOk, cliFails, tmp } from './harness.mjs';
import { fixture, SILENCE_TRUTH } from './fixtures.mjs';
import { buildSpeechFixture } from './speech-fixture.mjs';
import { detectSilence } from '../tools/detect-silence.mjs';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { totalDuration } from '../lib/ranges.mjs';
import { EXIT } from '../lib/errors.mjs';

const contains = (outer, inner, slack = 0.05) =>
  outer.start <= inner.start + slack && outer.end >= inner.end - slack;

test('finds digitally-silent windows to within 50ms', async () => {
  // The tone fixture has EXACT zero-amplitude regions, so this is the strictest
  // possible check on boundary accuracy.
  const r = await detectSilence(await fixture('landscape'), {
    paddingBefore: 0, paddingAfter: 0, out: tmp('ds-tone.json'),
  });
  eq(r.silenceCount, 2, 'should find both injected silences');
  for (const [i, truth] of SILENCE_TRUTH.entries()) {
    near(r.silences[i].start, truth.start, 0.05, `silence ${i} start`);
    near(r.silences[i].end, truth.end, 0.05, `silence ${i} end`);
  }
});

test('every injected speech gap is covered by a detected silence', async () => {
  const { video, truth } = await buildSpeechFixture();
  const r = await detectSilence(video, { paddingBefore: 0, paddingAfter: 0, out: tmp('ds-speech.json') });
  for (const gap of truth.silences) {
    const hit = r.silences.find(s => contains(s, gap));
    assert(hit, `no detected silence covers the injected gap ${gap.start}-${gap.end}`);
  }
});

test('detected silence never overlaps the middle of a sentence', async () => {
  const { video, truth } = await buildSpeechFixture();
  const r = await detectSilence(video, { paddingBefore: 0, paddingAfter: 0, out: tmp('ds-speech2.json') });
  // Sample the midpoint of each sentence: it must never be inside a silence.
  for (const s of truth.sentences) {
    const mid = (s.start + s.end) / 2;
    const inside = r.silences.find(x => mid > x.start && mid < x.end);
    assert(!inside, `sentence "${s.text.slice(0, 30)}..." midpoint ${mid.toFixed(2)}s was marked silent`);
  }
});

test('padding shrinks each silence by exactly before+after', async () => {
  const src = await fixture('landscape');
  const bare = await detectSilence(src, { paddingBefore: 0, paddingAfter: 0, out: tmp('ds-bare.json') });
  const padded = await detectSilence(src, { paddingBefore: 0.08, paddingAfter: 0.12, out: tmp('ds-pad.json') });
  eq(padded.silenceCount, bare.silenceCount, 'padding should not change the count here');
  for (let i = 0; i < bare.silenceCount; i++) {
    near(padded.silences[i].start, bare.silences[i].start + 0.08, 0.001, `silence ${i} start padded`);
    near(padded.silences[i].end, bare.silences[i].end - 0.12, 0.001, `silence ${i} end padded`);
  }
});

test('minDuration drops silences shorter than the floor', async () => {
  const { video } = await buildSpeechFixture();
  const loose = await detectSilence(video, { minDuration: 0.3, paddingBefore: 0, paddingAfter: 0, out: tmp('ds-loose.json') });
  const strict = await detectSilence(video, { minDuration: 1.0, paddingBefore: 0, paddingAfter: 0, out: tmp('ds-strict.json') });
  assert(strict.silenceCount < loose.silenceCount, 'a higher minimum must find fewer silences');
  for (const s of strict.silences) assert(s.duration >= 1.0 - 1e-6, `kept a ${s.duration}s silence below the 1.0s floor`);
});

test('speech and silence partition the whole timeline', async () => {
  const r = await detectSilence(await fixture('landscape'), { out: tmp('ds-partition.json') });
  const covered = totalDuration(r.silences) + totalDuration(r.speech);
  near(covered, r.duration, 0.05, 'silence + speech should cover the source exactly once');
  // And they must not overlap.
  for (const s of r.silences) {
    for (const p of r.speech) {
      const overlap = Math.min(s.end, p.end) - Math.max(s.start, p.start);
      assert(overlap <= 0.001, `silence ${s.start}-${s.end} overlaps speech ${p.start}-${p.end}`);
    }
  }
});

test('adaptive threshold recovers a recording that a fixed threshold gets wrong', async () => {
  const { video } = await buildSpeechFixture();
  const quiet = tmp('ds-quiet.mp4');
  await ffmpeg(['-y', '-i', video, '-af', 'volume=-20dB', '-c:v', 'copy', '-c:a', 'aac', quiet]);

  const reference = await detectSilence(video, { method: 'rms', out: tmp('ds-ref.json') });
  const fixed = await detectSilence(quiet, { method: 'rms', out: tmp('ds-qfix.json') });
  const adaptive = await detectSilence(quiet, { method: 'auto', out: tmp('ds-qauto.json') });

  assert(adaptive.threshold < -45, `adaptive threshold should drop for a quiet file, got ${adaptive.threshold}`);
  // The adaptive result on the quiet file should look like the reference result
  // on the normal file; the fixed-threshold one should not.
  const adaptiveErr = Math.abs(adaptive.silenceTotal - reference.silenceTotal);
  const fixedErr = Math.abs(fixed.silenceTotal - reference.silenceTotal);
  assert(adaptiveErr < fixedErr,
    `adaptive (${adaptiveErr.toFixed(2)}s off) should beat fixed (${fixedErr.toFixed(2)}s off) on a quiet recording`);
  near(adaptive.silenceTotal, reference.silenceTotal, 0.5, 'adaptive result on quiet audio');
});

test('an explicit threshold overrides the method', async () => {
  const r = await detectSilence(await fixture('landscape'), { threshold: -45, out: tmp('ds-explicit.json') });
  eq(r.threshold, -45);
});

test('writes its JSON result to disk', async () => {
  const out = tmp('ds-written.json');
  const r = await detectSilence(await fixture('landscape'), { out });
  assert(fs.existsSync(out), 'result file should exist');
  const onDisk = JSON.parse(fs.readFileSync(out, 'utf8'));
  eq(onDisk.silenceCount, r.silenceCount, 'file contents should match the returned result');
});

test('refuses a source with no audio track', async () => {
  let code = null;
  try { await detectSilence(await fixture('mute'), { out: tmp('ds-mute.json') }); }
  catch (e) { code = e.code; }
  eq(code, EXIT.INPUT);
});

test('output feeds cut-video directly', async () => {
  // The whole point of the JSON shape: detect-silence output is a valid cut plan.
  const r = await detectSilence(await fixture('landscape'), { out: tmp('ds-plan.json') });
  const { cutVideo } = await import('../tools/cut-video.mjs');
  const cut = await cutVideo(await fixture('landscape'), { plan: r.path, out: tmp('ds-cut.mp4') });
  near(cut.actualDuration, r.speechTotal, 0.3, 'cut duration should equal the detected speech total');
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const j = await cliOk('detect-silence.mjs', [await fixture('landscape'), '--out', tmp('ds-cli.json')]);
  eq(j.tool, 'detect-silence');
  assert(Array.isArray(j.silences), 'should return a silences array');
});

test('CLI exits 3 on a file with no audio', async () => {
  await cliFails('detect-silence.mjs', [await fixture('mute')], EXIT.INPUT);
});
