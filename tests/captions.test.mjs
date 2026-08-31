import fs from 'node:fs';
import { test, eq, near, assert, verifyMedia, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { buildSpeechFixture } from './speech-fixture.mjs';
import { captions, buildCues, joinWords, makeKeywordMatcher, renderAss, STYLES } from '../tools/captions.mjs';
import { assColor, assTime, assEscape, alignmentFor } from '../lib/ass.mjs';
import { run } from '../lib/proc.mjs';
import { FFMPEG, ffmpeg } from '../lib/ffmpeg.mjs';
import { EXIT } from '../lib/errors.mjs';

const PROMPT = 'Claude Code, npm install, terminal';
const W = (word, start, end, extra = {}) => ({ word, start, end, probability: 0.9, ...extra });

/** Mean luminance of a region — proves pixels actually changed. */
async function luma(file, crop, at) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-i', file,
    '-vf', `crop=${crop},signalstats,metadata=print`, '-frames:v', '1', '-f', 'null', '-',
  ], { timeoutMs: 120000 });
  const m = /YAVG=([0-9.]+)/.exec(stderr);
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------- ASS format */

test('assColor converts RGB to ASS BGR with inverted alpha', () => {
  // ASS is &HAABBGGRR, and AA is TRANSPARENCY, not opacity.
  eq(assColor('#FFFFFF'), '&H00FFFFFF');
  eq(assColor('#FF0000'), '&H000000FF', 'red must land in the RR slot, last');
  eq(assColor('#0000FF'), '&H00FF0000', 'blue must land in the BB slot, first');
  eq(assColor('#000000', 0.5), '&H80000000', 'opacity 0.5 -> transparency 0x80');
  eq(assColor('#000000', 1), '&H00000000', 'fully opaque -> transparency 00');
});

test('assTime formats centiseconds and carries correctly', () => {
  eq(assTime(0), '0:00:00.00');
  eq(assTime(64.5), '0:01:04.50');
  eq(assTime(3661.239), '1:01:01.24');
  eq(assTime(1.999), '0:00:02.00', 'rounding to 100cs must carry into the next second');
});

test('assEscape neutralises override braces', () => {
  // A bare "{" opens an override block in ASS, so it must arrive backslashed.
  // String.raw is required here: in a normal literal "\{" collapses to "{".
  eq(assEscape('a {bad} tag'), String.raw`a \{bad\} tag`);
  eq(assEscape('line\nbreak'), 'line\\Nbreak');
});

test('alignmentFor maps positions to the numpad layout', () => {
  eq(alignmentFor('bottom-center'), 2);
  eq(alignmentFor('center'), 5);
  eq(alignmentFor('top-center'), 8);
  let threw = false;
  try { alignmentFor('sideways'); } catch { threw = true; }
  assert(threw, 'unknown positions must be rejected, not silently defaulted');
});

/* ------------------------------------------------------------ cue building */

test('joinWords respects hyphenation', () => {
  // Whisper emits "bem" + "-vindo"; naive joining gives "bem -vindo".
  eq(joinWords([W('bem', 0, 0.2), { ...W('-vindo', 0.2, 0.5), spaceBefore: false }]), 'bem-vindo');
  eq(joinWords([W('ao', 0, 0.2), { ...W('meu', 0.2, 0.4), spaceBefore: true }]), 'ao meu');
  // Fallback for transcripts predating the spaceBefore field.
  eq(joinWords([W('bem', 0, 0.2), W('-vindo', 0.2, 0.5)]), 'bem-vindo');
  eq(joinWords([W('olá', 0, 0.2), W(',', 0.2, 0.3)]), 'olá,');
});

test('buildCues respects the word limit', () => {
  const words = Array.from({ length: 9 }, (_, i) => W(`w${i}`, i * 0.3, i * 0.3 + 0.25));
  const cues = buildCues(words, { maxWords: 3, gapBreak: 5 });
  eq(cues.length, 3);
  for (const c of cues) assert(c.words.length <= 3, 'no cue may exceed the word limit');
});

test('buildCues breaks on long pauses and sentence ends', () => {
  const gapped = buildCues([W('a', 0, 0.3), W('b', 0.4, 0.7), W('c', 2.0, 2.3)], { maxWords: 9, gapBreak: 0.6 });
  eq(gapped.length, 2, 'a 1.3s pause must split the cue');

  const sentence = buildCues([W('one.', 0, 0.3), W('two', 0.35, 0.6)], { maxWords: 9, gapBreak: 5 });
  eq(sentence.length, 2, 'a full stop must end the cue');
});

test('buildCues gives every cue a readable minimum duration', () => {
  const cues = buildCues([W('hi', 1.0, 1.05)], { maxWords: 4 });
  assert(cues[0].end - cues[0].start >= 0.35, 'a 50ms cue would be unreadable');
});

test('keyword matcher ignores case and accents', () => {
  const m = makeKeywordMatcher(['edição', 'npm']);
  assert(m.matches('Edição', ''), 'case and accents must not matter');
  assert(m.matches('NPM', ''));
  assert(!m.matches('outro', ''));
});

test('keyword matcher handles multi-word phrases', () => {
  const m = makeKeywordMatcher(['Claude Code']);
  assert(m.matches('Claude', 'o Claude Code e'), 'phrase members match inside the phrase');
  assert(!m.matches('Claude', 'outro contexto'), 'and not outside it');
});

/* --------------------------------------------------------------- rendering */

test('renderAss produces a well-formed document with matching PlayRes', () => {
  const cues = buildCues([W('olá', 0, 0.4), W('mundo', 0.45, 0.9)], { maxWords: 4 });
  const out = renderAss(cues, { width: 1080, height: 1920, style: STYLES.clean, keywords: [] });
  assert(out.includes('PlayResX: 1080'), 'PlayResX must match the video or libass rescales everything');
  assert(out.includes('PlayResY: 1920'));
  assert(out.includes('[V4+ Styles]') && out.includes('[Events]'));
  eq((out.match(/^Dialogue:/gm) || []).length, 1, 'one cue -> one event in a non-wordByWord style');
});

test('word-by-word styles emit one event per word', () => {
  const cues = buildCues([W('um', 0, 0.4), W('dois', 0.45, 0.9), W('três', 0.95, 1.4)], { maxWords: 4 });
  const out = renderAss(cues, { width: 1080, height: 1920, style: STYLES.viral, keywords: [] });
  eq((out.match(/^Dialogue:/gm) || []).length, 3, 'viral highlights each word in turn');
});

test('karaoke style emits \\k timing tags', () => {
  const cues = buildCues([W('um', 0, 0.4), W('dois', 0.45, 0.9)], { maxWords: 4 });
  const out = renderAss(cues, { width: 1080, height: 1920, style: STYLES.karaoke, keywords: [] });
  assert(/\\k\d+/.test(out), 'karaoke must carry per-word \\k durations');
});

test('keywords are recoloured in the output', () => {
  const cues = buildCues([W('use', 0, 0.4), W('npm', 0.45, 0.9)], { maxWords: 4 });
  const plain = renderAss(cues, { width: 1080, height: 1920, style: STYLES.clean, keywords: [] });
  const hl = renderAss(cues, { width: 1080, height: 1920, style: STYLES.clean, keywords: ['npm'] });
  assert(hl.length > plain.length, 'highlighting must add override tags');
  assert(hl.includes(assColor(STYLES.clean.highlightColor)), 'the highlight colour must appear');
});

test('font size scales with frame height, not pixels', () => {
  const cues = buildCues([W('a', 0, 0.4)], { maxWords: 4 });
  const tall = renderAss(cues, { width: 1080, height: 1920, style: STYLES.clean });
  const short = renderAss(cues, { width: 1280, height: 720, style: STYLES.clean });
  const size = doc => Number(/^Style: Caption,[^,]+,([\d.]+)/m.exec(doc)[1]);
  assert(size(tall) > size(short) * 2, 'a 1920-tall frame needs a much larger font than a 720-tall one');
});

/* ------------------------------------------------------------ integration */

test('generates an .ass file for a real video', async () => {
  const { video } = await buildSpeechFixture();
  const r = await captions(video, { language: 'pt', prompt: PROMPT, style: 'clean', assOut: tmp('cap.ass') });
  assert(fs.existsSync(r.assPath), '.ass file should exist');
  assert(r.cueCount > 0 && r.wordCount > 0);
  eq(r.width, 1280); eq(r.height, 720);
  const text = fs.readFileSync(r.assPath, 'utf8');
  assert(text.includes('bem-vindo'), `hyphenation should survive into the .ass: ${r.cues[0]?.text}`);
});

test('every style renders without error', async () => {
  const { video } = await buildSpeechFixture();
  for (const style of Object.keys(STYLES)) {
    const r = await captions(video, { language: 'pt', prompt: PROMPT, style, assOut: tmp(`cap-${style}.ass`) });
    assert(r.cueCount > 0, `${style} produced no cues`);
    assert(fs.existsSync(r.assPath), `${style} produced no file`);
  }
});

test('burned captions change pixels during speech and not during silence', async () => {
  // Burn onto pure black so any luminance is unambiguously text.
  const { video, truth } = await buildSpeechFixture();
  const black = tmp('cap-black.mp4');
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', `color=c=black:s=1280x720:d=${truth.duration.toFixed(2)}:r=30`,
    '-i', video, '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-shortest', black,
  ]);
  const r = await captions(black, { language: 'pt', prompt: PROMPT, style: 'clean', burn: true, out: tmp('cap-burn.mp4'), quality: 'preview' });

  const band = '1280:180:0:520';
  const speech = truth.sentences[1];
  const silence = truth.silences[0];
  const during = await luma(r.path, band, (speech.start + speech.end) / 2);
  const quiet = await luma(r.path, band, (silence.start + silence.end) / 2);

  assert(during > 18, `captions should be visible during speech, got YAVG ${during}`);
  assert(quiet < 17, `nothing should be drawn during a known silence, got YAVG ${quiet}`);
  assert(during > quiet + 2, 'the caption band must be measurably brighter while speaking');
});

test('burning preserves frame size and audio', async () => {
  const { video } = await buildSpeechFixture();
  const r = await captions(video, {
    language: 'pt', prompt: PROMPT, style: 'viral', burn: true,
    out: tmp('cap-dims.mp4'), quality: 'preview',
  });
  await verifyMedia(r.path, { width: 1280, height: 720, hasAudio: true });
});

test('accepts an existing transcript without re-transcribing', async () => {
  const { video } = await buildSpeechFixture();
  const first = await captions(video, { language: 'pt', prompt: PROMPT, assOut: tmp('cap-t1.ass') });
  const reused = await captions(video, { transcript: 'transcripts/speech.json', assOut: tmp('cap-t2.ass') });
  eq(reused.wordCount, first.wordCount);
});

test('rejects an unknown style', async () => {
  const { video } = await buildSpeechFixture();
  let code = null;
  try { await captions(video, { style: 'sparkles' }); } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const { video } = await buildSpeechFixture();
  const j = await cliOk('captions.mjs', [
    video, '--transcript', 'transcripts/speech.json', '--style', 'karaoke', '--ass-out', tmp('cap-cli.ass'),
  ]);
  eq(j.tool, 'captions');
  eq(j.karaoke, true);
});
