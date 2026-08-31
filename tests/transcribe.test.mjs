import fs from 'node:fs';
import { test, eq, near, assert, cliOk, cliFails, tmp, wer, normalizeText } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { buildSpeechFixture } from './speech-fixture.mjs';
import { transcribe, flattenWords } from '../tools/transcribe.mjs';
import { hasVenv } from '../lib/python.mjs';
import { EXIT } from '../lib/errors.mjs';

// Domain vocabulary the acoustic model cannot be expected to guess.
const PROMPT = 'Claude Code, npm install, terminal, Docker, GitHub';

const skipIfNoVenv = () => {
  if (!hasVenv()) {
    // Better to say so loudly than to pass a test that never ran.
    throw new Error('.venv is missing — run: python -m venv .venv && .venv/Scripts/python.exe -m pip install -r pysrc/requirements.txt');
  }
};

test('transcribes Portuguese speech at near-zero word error rate', async () => {
  skipIfNoVenv();
  const { video, truth } = await buildSpeechFixture();
  const r = await transcribe(video, { language: 'pt', prompt: PROMPT });

  eq(r.language, 'pt', 'language detection');
  const rate = wer(truth.fullText, r.text);
  assert(rate <= 0.05, `word error rate ${(rate * 100).toFixed(1)}% should be <= 5%\n  ref: ${truth.fullText}\n  hyp: ${r.text}`);
});

test('every sentence of the source appears in the transcript', async () => {
  skipIfNoVenv();
  const { video, truth } = await buildSpeechFixture();
  const r = await transcribe(video, { language: 'pt', prompt: PROMPT });
  const got = normalizeText(r.text);
  for (const s of truth.sentences) {
    const want = normalizeText(s.text);
    assert(got.includes(want), `transcript is missing a whole sentence: "${s.text}"`);
  }
});

test('produces word-level timestamps', async () => {
  skipIfNoVenv();
  const { video } = await buildSpeechFixture();
  const r = await transcribe(video, { language: 'pt', prompt: PROMPT });
  const words = flattenWords(r);
  assert(words.length >= 30, `expected 30+ words, got ${words.length}`);
  for (const w of words) {
    assert(typeof w.word === 'string' && w.word.length, 'word text should be non-empty');
    assert(Number.isFinite(w.start) && Number.isFinite(w.end), `word "${w.word}" lacks timestamps`);
    assert(w.end >= w.start, `word "${w.word}" ends before it starts`);
    assert(w.probability >= 0 && w.probability <= 1, `word "${w.word}" has an out-of-range probability`);
  }
});

test('word timestamps are monotonic and stay inside their segment', async () => {
  skipIfNoVenv();
  const { video } = await buildSpeechFixture();
  const r = await transcribe(video, { language: 'pt', prompt: PROMPT });
  for (const seg of r.segments) {
    let prevEnd = -Infinity;
    for (const w of seg.words) {
      assert(w.start >= prevEnd - 0.01, `words out of order in segment ${seg.id}: "${w.word}" at ${w.start}`);
      prevEnd = w.end;
      assert(w.start >= seg.start - 0.15 && w.end <= seg.end + 0.15,
        `word "${w.word}" (${w.start}-${w.end}) escapes segment ${seg.id} (${seg.start}-${seg.end})`);
    }
  }
});

test('word timestamps land inside the true sentence windows', async () => {
  skipIfNoVenv();
  const { video, truth } = await buildSpeechFixture();
  const r = await transcribe(video, { language: 'pt', prompt: PROMPT });

  // Each transcript segment should sit within one known sentence window.
  for (const seg of r.segments) {
    const home = truth.sentences.find(s => seg.start >= s.start - 0.6 && seg.end <= s.end + 0.6);
    assert(home, `segment "${seg.text.slice(0, 40)}" (${seg.start}-${seg.end}) matches no known sentence window`);
  }
});

test('no word is timed inside a known silence gap', async () => {
  skipIfNoVenv();
  const { video, truth } = await buildSpeechFixture();
  const r = await transcribe(video, { language: 'pt', prompt: PROMPT });
  for (const w of flattenWords(r)) {
    const mid = (w.start + w.end) / 2;
    const gap = truth.silences.find(g => mid > g.start + 0.15 && mid < g.end - 0.15);
    assert(!gap, `word "${w.word}" is timed at ${mid.toFixed(2)}s, inside the silence ${gap?.start}-${gap?.end}`);
  }
});

test('an initial prompt fixes domain vocabulary', async () => {
  skipIfNoVenv();
  const { video } = await buildSpeechFixture();
  const without = await transcribe(video, { language: 'pt' });
  const withPrompt = await transcribe(video, { language: 'pt', prompt: PROMPT });
  assert(normalizeText(withPrompt.text).includes('claude code'),
    `prompted transcript should contain "Claude Code", got: ${withPrompt.text}`);
  // The un-prompted run is allowed to get it wrong; that is exactly why the
  // option exists. Just prove the two runs are cached separately.
  assert(without.cacheKey !== withPrompt.cacheKey, 'prompt must be part of the cache key');
});

test('second run is served from cache', async () => {
  skipIfNoVenv();
  const { video } = await buildSpeechFixture();
  const first = await transcribe(video, { language: 'pt', prompt: PROMPT, force: true });
  eq(first.cached, false, 'forced run should do the work');
  const second = await transcribe(video, { language: 'pt', prompt: PROMPT });
  eq(second.cached, true, 'second run should hit the cache');
  eq(second.text, first.text, 'cached text must match');
  eq(second.wordCount, first.wordCount, 'cached word count must match');
});

test('every setting that changes output is part of the cache key', async () => {
  skipIfNoVenv();
  const { video } = await buildSpeechFixture();
  const { cacheKey } = await import('../lib/hash.mjs');
  const base = { model: 'small', language: 'pt', beamSize: 5, vad: false, prompt: null };
  const k = s => cacheKey(video, { ...base, ...s });

  const variants = {
    model: { model: 'medium' },
    language: { language: 'en' },
    beamSize: { beamSize: 1 },
    vad: { vad: true },
    prompt: { prompt: PROMPT },
  };
  for (const [name, change] of Object.entries(variants)) {
    assert(k({}) !== k(change), `${name} must change the cache key`);
  }
  eq(k({}), k({}), 'the same settings must produce a stable key');
});

test('device is NOT part of the cache key', async () => {
  skipIfNoVenv();
  // CPU and GPU produce identical text, so a GPU run must reuse a CPU result.
  const { video } = await buildSpeechFixture();
  const gpu = await transcribe(video, { language: 'pt', prompt: PROMPT, device: 'auto' });
  const cpu = await transcribe(video, { language: 'pt', prompt: PROMPT, device: 'cpu' });
  eq(cpu.cacheKey, gpu.cacheKey, 'device must not fragment the cache');
  eq(cpu.cached, true, 'the second run should have been served from cache');
});

test('writes the transcript to transcripts/', async () => {
  skipIfNoVenv();
  const { video } = await buildSpeechFixture();
  const out = tmp('tr-written.json');
  const r = await transcribe(video, { language: 'pt', prompt: PROMPT, out });
  assert(fs.existsSync(out), 'transcript file should exist');
  const onDisk = JSON.parse(fs.readFileSync(out, 'utf8'));
  eq(onDisk.segments.length, r.segmentCount);
  assert(onDisk.segments[0].words.length > 0, 'persisted transcript must keep word timestamps');
});

test('refuses a source with no audio track', async () => {
  skipIfNoVenv();
  let code = null;
  try { await transcribe(await fixture('mute'), {}); } catch (e) { code = e.code; }
  eq(code, EXIT.VALIDATION);
});

test('CLI round-trip returns JSON and exits 0', async () => {
  skipIfNoVenv();
  const { video } = await buildSpeechFixture();
  const j = await cliOk('transcribe.mjs', [video, '--language', 'pt', '--prompt', PROMPT]);
  eq(j.tool, 'transcribe');
  eq(j.language, 'pt');
  assert(j.segments.length > 0, 'should return segments');
});
