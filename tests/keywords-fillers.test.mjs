// detect-keywords + remove-fillers. Both score transcript words, and both are
// tested first as pure functions (where the risk lives) and then end to end.
import { test, eq, near, assert, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { buildSpeechFixture, buildFillerFixture, FILLER_TRUTH } from './speech-fixture.mjs';
import { detectKeywords, scoreWords } from '../tools/detect-keywords.mjs';
import { removeFillers, findFillers } from '../tools/remove-fillers.mjs';
import { transcribe } from '../tools/transcribe.mjs';
import { normalizeText } from './harness.mjs';
import { EXIT } from '../lib/errors.mjs';

const W = (word, start, end, probability = 0.9) => ({ word, start, end, probability });
const texts = list => list.map(k => k.text);

/* ---------------------------------------------------------- detect-keywords */

test('stopwords never become keywords', () => {
  const words = [W('o', 0, 0.2), W('que', 0.2, 0.4), W('terminal', 0.5, 1.0), W('the', 1.1, 1.3)];
  const scored = scoreWords(words);
  assert(!texts(scored).includes('o'), 'Portuguese stopwords must be filtered');
  assert(!texts(scored).includes('the'), 'English stopwords must be filtered');
  assert(texts(scored).includes('terminal'));
});

test('technical terms score highly', () => {
  const words = [W('abrir', 0, 0.4), W('docker', 0.5, 0.9), W('coisa', 1.0, 1.4)];
  const scored = scoreWords(words);
  const docker = scored.find(s => s.norm === 'docker');
  const coisa = scored.find(s => s.norm === 'coisa');
  assert(docker.importance > coisa.importance, 'a technical term should outrank a generic noun');
  assert(docker.reasons.includes('technical term'));
});

test('a word held longer than usual scores as emphasis', () => {
  // Same word length, very different durations.
  const base = Array.from({ length: 8 }, (_, i) => W(`palavra${i}`, i * 0.5, i * 0.5 + 0.3));
  const withHold = [...base, W('palavraX', 4.0, 5.4)];
  const scored = scoreWords(withHold);
  const held = scored.find(s => s.norm === 'palavrax');
  assert(held, 'the held word should be scored');
  assert(held.signals.emphasis > 0.3, `expected emphasis, got ${held.signals.emphasis}`);
  assert(held.reasons.some(r => r.includes('longer')), held.reasons.join('; '));
});

test('sentence-boundary pauses are NOT treated as emphasis', () => {
  // "canal." ends a sentence; the pause after it is grammar, not emphasis.
  const words = [W('meu', 0, 0.3), W('canal.', 0.35, 0.8), W('Hoje', 2.3, 2.7), W('falamos', 2.75, 3.2)];
  const scored = scoreWords(words);
  const canal = scored.find(s => s.norm === 'canal');
  assert(canal.signals.emphasis < 0.3,
    `a structural sentence pause must not read as emphasis (got ${canal.signals.emphasis})`);
});

test('low recognition confidence damps the score', () => {
  const sure = scoreWords([W('kubernetes', 0, 0.6, 0.99)])[0];
  const unsure = scoreWords([W('kubernetes', 0, 0.6, 0.30)])[0];
  assert(sure.importance > unsure.importance, 'an uncertain word should not be shouted on screen');
});

test('ranks the expected words in real speech', async () => {
  const { video } = await buildSpeechFixture();
  await transcribe(video, { language: 'pt', prompt: 'Claude Code, npm install, terminal' });
  const r = await detectKeywords(video, { transcript: 'transcripts/speech.json', perMinute: 10, out: tmp('kw.json') });
  const got = texts(r.keywords).map(t => normalizeText(t));
  for (const want of ['npm', 'terminal', 'claude']) {
    assert(got.includes(want), `expected "${want}" among keywords, got: ${got.join(', ')}`);
  }
});

test('density cap limits keywords per minute', async () => {
  const { video } = await buildSpeechFixture();
  const loose = await detectKeywords(video, { transcript: 'transcripts/speech.json', out: tmp('kw-loose.json') });
  const tight = await detectKeywords(video, { transcript: 'transcripts/speech.json', perMinute: 5, out: tmp('kw-tight.json') });
  assert(tight.keywordCount < loose.keywordCount, 'a density cap must reduce the count');
  // The cap is on COUNT, computed as ceil(minutes * perMinute). On a 25s clip
  // that is ceil(0.41 * 5) = 3, whose effective rate is 7.3/min — asserting the
  // rate directly would be asserting something the tool never promised.
  const allowed = Math.ceil((tight.duration / 60) * 5);
  assert(tight.keywordCount <= allowed,
    `expected at most ${allowed} keywords for ${tight.duration}s at 5/min, got ${tight.keywordCount}`);
});

test('external keywords are forced in and re-ranked', async () => {
  const { video } = await buildSpeechFixture();
  const r = await detectKeywords(video, {
    transcript: 'transcripts/speech.json', extra: 'automaticamente', max: 4, out: tmp('kw-extra.json'),
  });
  const hit = r.keywords.find(k => normalizeText(k.text) === 'automaticamente');
  assert(hit, `forced keyword missing from the top ${r.keywordCount}: ${texts(r.keywords).join(', ')}`);
  eq(hit.importance, 1);
  assert(hit.reasons.includes('externally specified'));
});

test('unique mode keeps one occurrence per word', async () => {
  const { video } = await buildSpeechFixture();
  const r = await detectKeywords(video, { transcript: 'transcripts/speech.json', out: tmp('kw-u.json') });
  const seen = new Set();
  for (const k of r.keywords) {
    const n = normalizeText(k.text);
    assert(!seen.has(n), `"${k.text}" appears more than once`);
    seen.add(n);
  }
});

/* ----------------------------------------------------------- remove-fillers */

test('level off removes nothing', () => {
  eq(findFillers([W('ahn', 0, 0.3)], { level: 'off' }).length, 0);
});

test('non-lexical hesitations are caught at every active level', () => {
  const words = [W('eu', 0, 0.3), W('ahn', 0.6, 1.0), W('queria', 1.4, 1.9)];
  for (const level of ['safe', 'aggressive']) {
    const f = findFillers(words, { language: 'pt', level });
    eq(f.length, 1, `${level} should find the hesitation`);
    eq(f[0].kind, 'hesitation');
    assert(f[0].confidence > 0.9);
  }
});

test('exact stutters are caught, and the repeat is what survives', () => {
  const f = findFillers([W('o', 0, 0.2), W('o', 0.25, 0.45), W('terminal', 0.5, 1.0)], { level: 'safe' });
  eq(f.length, 1);
  eq(f[0].kind, 'stutter');
  eq(f[0].start, 0, 'the FIRST utterance is removed, not the second');
});

test('THE safety property: a sentence-initial connective is never removed', () => {
  const words = [W('Certo.', 0, 0.5), W('Então', 0.7, 1.1), W('vamos', 1.2, 1.5), W('começar', 1.6, 2.1)];
  for (const level of ['safe', 'aggressive']) {
    const f = findFillers(words, { language: 'pt', level });
    assert(!f.some(x => x.text === 'Então'),
      `"Então" opens a sentence and carries meaning; removing it at ${level} would change what was said`);
  }
});

test('a discourse marker without pause evidence is left alone', () => {
  // Natural, connected speech: "eu então fiz" — no hesitation pattern at all.
  const words = [W('eu', 0, 0.3), W('então', 0.32, 0.6), W('fiz', 0.62, 0.9)];
  eq(findFillers(words, { language: 'pt', level: 'aggressive' }).length, 0,
    'without pause evidence there is no reason to believe it is filler');
});

test('a discourse marker isolated by pauses is caught, but only at aggressive', () => {
  const words = [W('eu', 0, 0.3), W('então,', 0.9, 1.3), W('fiz', 1.9, 2.2)];
  eq(findFillers(words, { language: 'pt', level: 'safe' }).length, 0, 'safe must not touch discourse markers');
  const agg = findFillers(words, { language: 'pt', level: 'aggressive' });
  eq(agg.length, 1);
  eq(agg[0].kind, 'discourse');
});

test('each word yields at most one finding', () => {
  // A repeated "tipo" is both a stutter and a discourse marker.
  const words = [W('era', 0, 0.3), W('tipo', 0.5, 0.8), W('tipo', 0.85, 1.15), W('assim', 1.2, 1.6)];
  const f = findFillers(words, { language: 'pt', level: 'aggressive' });
  const indices = f.map(x => x.index);
  eq(new Set(indices).size, indices.length, 'duplicate findings would produce overlapping cuts');
});

test('unrecognisable low-confidence tokens are treated as hesitations', () => {
  // Whisper renders a spoken "ahn" as an invented token; the fixture produced
  // "eitn," at p=0.45. Matching the word list alone would miss it.
  const words = [W('queria,', 0, 0.5, 0.98), W('eitn,', 1.0, 1.4, 0.45), W('mostrar', 1.9, 2.4, 0.97)];
  const f = findFillers(words, { language: 'pt', level: 'safe' });
  eq(f.length, 1);
  eq(f[0].kind, 'hesitation');
  assert(f[0].reasons.some(r => r.includes('unrecognisable')));
});

test('ordinary short words are never mistaken for hesitations', () => {
  // Same shape as above but a real word, so it must survive.
  const words = [W('queria,', 0, 0.5, 0.98), W('sim,', 1.0, 1.4, 0.40), W('mostrar', 1.9, 2.4, 0.97)];
  eq(findFillers(words, { language: 'pt', level: 'safe' }).length, 0);
});

test('removes the real hesitation from real speech and keeps the meaning', async () => {
  const { video } = await buildFillerFixture();
  const before = await transcribe(video, { language: 'pt' });
  const r = await removeFillers(video, { level: 'safe', language: 'pt', out: tmp('nf-safe.mp4'), quality: 'preview' });
  assert(r.removedCount >= 1, 'should have found the hesitation');
  assert(r.removedDuration > 0 && r.removedDuration < 2, `removed an implausible ${r.removedDuration}s`);

  const after = await transcribe(r.path, { language: 'pt', force: true });
  for (const word of FILLER_TRUTH.mustKeep) {
    assert(normalizeText(after.text).includes(normalizeText(word)),
      `"${word}" must survive filler removal. Got: ${after.text}`);
  }
  assert(after.text.length < before.text.length, 'something should actually have been removed');
});

test('aggressive removes more than safe, still keeping the connective', async () => {
  const { video } = await buildFillerFixture();
  const safe = await removeFillers(video, { level: 'safe', language: 'pt', dryRun: true });
  const agg = await removeFillers(video, { level: 'aggressive', language: 'pt', dryRun: true });
  assert(agg.removedDuration > safe.removedDuration, 'aggressive should cut more');
  assert(!agg.fillers.some(f => normalizeText(f.text) === 'entao'),
    'the sentence-initial connective must survive even at aggressive');
});

test('dry run reports without rendering', async () => {
  const { video } = await buildFillerFixture();
  const r = await removeFillers(video, { level: 'aggressive', language: 'pt', dryRun: true });
  eq(r.dryRun, true);
  eq(r.output, undefined);
});

test('rejects an unknown level', async () => {
  const { video } = await buildFillerFixture();
  let code = null;
  try { await removeFillers(video, { level: 'nuclear' }); } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('CLI round-trips for both tools', async () => {
  const { video } = await buildSpeechFixture();
  const kw = await cliOk('detect-keywords.mjs', [video, '--transcript', 'transcripts/speech.json', '--out', tmp('kw-cli.json')]);
  eq(kw.tool, 'detect-keywords');
  assert(kw.keywordCount > 0);

  const { video: fv } = await buildFillerFixture();
  const rf = await cliOk('remove-fillers.mjs', [fv, '--language', 'pt', '--dry-run']);
  eq(rf.tool, 'remove-fillers');
});
