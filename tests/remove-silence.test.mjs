import { test, eq, near, assert, cliOk, tmp, wer } from './harness.mjs';
import { buildSpeechFixture } from './speech-fixture.mjs';
import { fixture } from './fixtures.mjs';
import { removeSilence, snapOutOfWords, mergeShortSpeech, INTENSITY } from '../tools/remove-silence.mjs';
import { transcribe } from '../tools/transcribe.mjs';
import { EXIT } from '../lib/errors.mjs';

const PROMPT = 'Claude Code, npm install, terminal';

test('snapOutOfWords pulls silences clear of word boundaries', () => {
  const words = [{ start: 1.0, end: 1.5 }, { start: 3.0, end: 3.4 }];
  // A silence that overlaps the tail of the first word and the head of the second.
  const [s] = snapOutOfWords([{ start: 1.3, end: 3.2 }], words, 0.02);
  assert(s.start >= 1.5, `start ${s.start} should have moved past the word ending at 1.5`);
  assert(s.end <= 3.0, `end ${s.end} should have moved before the word starting at 3.0`);
});

test('snapOutOfWords drops a silence that lies entirely inside a word', () => {
  const out = snapOutOfWords([{ start: 1.1, end: 1.3 }], [{ start: 1.0, end: 1.5 }]);
  eq(out.length, 0, 'a "silence" inside a word is a detection error and must be discarded');
});

test('mergeShortSpeech absorbs fragments instead of deleting them', () => {
  const keep = [{ start: 0, end: 5 }, { start: 6, end: 6.05 }, { start: 7, end: 10 }];
  const { merged, absorbed } = mergeShortSpeech(keep, 0.15);
  eq(absorbed, 1);
  eq(merged.length, 2);
  eq(merged[0].end, 6.05, 'the fragment should be swallowed by the previous segment, not dropped');
  // Nothing from the source may disappear.
  assert(merged.some(r => r.start <= 6 && r.end >= 6.05), 'fragment audio must still be covered');
});

test('mergeShortSpeech handles a too-short first segment', () => {
  const { merged, absorbed } = mergeShortSpeech([{ start: 0, end: 0.05 }, { start: 1, end: 5 }], 0.15);
  eq(absorbed, 1);
  eq(merged.length, 1);
  eq(merged[0].start, 0, 'the leading fragment must be preserved by extending the next segment');
});

test('intensity presets are ordered from conservative to aggressive', () => {
  assert(INTENSITY.soft.minDuration > INTENSITY.normal.minDuration, 'soft needs longer silences');
  assert(INTENSITY.normal.minDuration > INTENSITY.aggressive.minDuration, 'aggressive triggers sooner');
  assert(INTENSITY.soft.paddingBefore > INTENSITY.aggressive.paddingBefore, 'soft keeps more breathing room');
});

test('more aggressive settings remove strictly more time', async () => {
  const { video } = await buildSpeechFixture();
  const results = {};
  for (const i of ['soft', 'normal', 'aggressive']) {
    results[i] = await removeSilence(video, { intensity: i, dryRun: true });
  }
  assert(results.soft.timeSaved < results.normal.timeSaved,
    `soft (${results.soft.timeSaved}s) should cut less than normal (${results.normal.timeSaved}s)`);
  assert(results.normal.timeSaved < results.aggressive.timeSaved,
    `normal (${results.normal.timeSaved}s) should cut less than aggressive (${results.aggressive.timeSaved}s)`);
});

test('dry run reports without writing a file', async () => {
  const { video } = await buildSpeechFixture();
  const r = await removeSilence(video, { dryRun: true });
  eq(r.dryRun, true);
  eq(r.output, undefined, 'a dry run must not produce an output path');
  assert(r.timeSaved > 0, 'should still report what it would cut');
});

test('THE important one: no speech is lost at any intensity', async () => {
  const { video, truth } = await buildSpeechFixture();
  for (const intensity of ['normal', 'aggressive']) {
    const r = await removeSilence(video, {
      intensity, out: tmp(`rs-${intensity}.mp4`), quality: 'preview',
    });
    const back = await transcribe(r.path, { language: 'pt', prompt: PROMPT, force: true });
    const rate = wer(truth.fullText, back.text);
    assert(rate <= 0.05,
      `${intensity}: cutting silence changed the words (WER ${(rate * 100).toFixed(1)}%)\n  ref: ${truth.fullText}\n  got: ${back.text}`);
    assert(r.actualDuration < truth.duration, 'the output should actually be shorter');
  }
});

test('word snapping keeps cuts clear of speech', async () => {
  const { video, truth } = await buildSpeechFixture();
  const r = await removeSilence(video, {
    intensity: 'aggressive', snap: 'words', language: 'pt', prompt: PROMPT,
    out: tmp('rs-snap.mp4'), quality: 'preview',
  });
  const back = await transcribe(r.path, { language: 'pt', prompt: PROMPT, force: true });
  eq(wer(truth.fullText, back.text) <= 0.05, true, 'snapped cut must not damage words');
  // Snapping can only ever shrink silences, so it must not out-cut raw aggressive.
  const raw = await removeSilence(video, { intensity: 'aggressive', dryRun: true });
  assert(r.timeSaved <= raw.timeSaved + 1e-6,
    `snapping (${r.timeSaved}s) must be no more aggressive than unsnapped (${raw.timeSaved}s)`);
});

test('output duration matches what was promised', async () => {
  const { video } = await buildSpeechFixture();
  const r = await removeSilence(video, { out: tmp('rs-dur.mp4'), quality: 'preview' });
  near(r.actualDuration, r.keptDuration, 0.2, 'rendered duration vs planned kept duration');
  near(r.keptDuration + r.removedDuration, r.sourceDuration, 0.05, 'kept + removed must equal the source');
});

test('a source with no detectable silence is left essentially intact', async () => {
  // portrait is a continuous tone: no silence to remove.
  const r = await removeSilence(await fixture('portrait'), { dryRun: true });
  eq(r.silencesRemoved, 0);
  near(r.keptDuration, r.sourceDuration, 0.05);
});

test('refuses a source with no audio', async () => {
  let code = null;
  try { await removeSilence(await fixture('mute'), { dryRun: true }); } catch (e) { code = e.code; }
  eq(code, EXIT.INPUT);
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const { video } = await buildSpeechFixture();
  const j = await cliOk('remove-silence.mjs', [video, '--dry-run']);
  eq(j.tool, 'remove-silence');
  assert(j.timeSaved > 0);
});
