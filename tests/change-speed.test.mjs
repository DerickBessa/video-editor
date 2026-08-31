// change-speed — validated by measuring the produced file, not the filter args.
import { test, eq, near, assert, cliOk, tmp, wer } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { buildSpeechFixture } from './speech-fixture.mjs';
import { changeSpeed, atempoChain } from '../tools/change-speed.mjs';
import { transcribe } from '../tools/transcribe.mjs';
import { EXIT } from '../lib/errors.mjs';

const PROMPT = 'Claude Code, npm install, terminal';

/* ------------------------------------------------------------ change-speed */

test('atempoChain multiplies out to exactly the requested rate', () => {
  for (const rate of [0.1, 0.25, 0.4, 0.5, 0.75, 1.5, 2, 4, 10]) {
    const chain = atempoChain(rate);
    const product = chain.reduce((a, b) => a * b, 1);
    near(product, rate, 1e-6, `chain for ${rate}x`);
    for (const t of chain) {
      assert(t >= 0.5 - 1e-9 && t <= 100 + 1e-9, `atempo factor ${t} is outside the filter's 0.5..100 range`);
    }
  }
});

test('atempoChain only chains when it has to', () => {
  eq(atempoChain(1.5).length, 1);
  eq(atempoChain(0.5).length, 1);
  eq(atempoChain(0.25).length, 2, 'below 0.5 needs two stages');
});

test('speed change hits the expected duration', async () => {
  const src = await fixture('landscape');
  for (const rate of [0.5, 1.25, 2]) {
    const r = await changeSpeed(src, { rate, out: tmp(`cs-${rate}.mp4`), quality: 'preview' });
    near(r.duration, 16 / rate, Math.max(0.25, (16 / rate) * 0.02), `duration at ${rate}x`);
    eq(r.rate, rate);
  }
});

test('audio and video stay the same length after retiming', async () => {
  const r = await changeSpeed(await fixture('landscape'), { rate: 1.5, out: tmp('cs-sync.mp4'), quality: 'preview' });
  const { ffprobeJson } = await import('../lib/ffmpeg.mjs');
  const j = await ffprobeJson(r.path);
  const v = Number(j.streams.find(s => s.codec_type === 'video').duration);
  const a = Number(j.streams.find(s => s.codec_type === 'audio').duration);
  near(Math.abs(v - a), 0, 0.15, `A/V lengths diverged: video ${v}s vs audio ${a}s`);
});

test('speech survives a pitch-preserved speed-up', async () => {
  const { video, truth } = await buildSpeechFixture();
  const r = await changeSpeed(video, { rate: 1.5, out: tmp('cs-speech.mp4'), quality: 'preview' });
  const back = await transcribe(r.path, { language: 'pt', prompt: PROMPT, force: true });
  const rate = wer(truth.fullText, back.text);
  assert(rate <= 0.1, `speeding up damaged the speech (WER ${(rate * 100).toFixed(1)}%): ${back.text}`);
});

test('pitch preservation is actually selectable', async () => {
  const { video } = await buildSpeechFixture();
  const kept = await changeSpeed(video, { rate: 1.5, preservePitch: true, out: tmp('cs-pp.mp4'), quality: 'preview' });
  const shifted = await changeSpeed(video, { rate: 1.5, preservePitch: false, out: tmp('cs-ps.mp4'), quality: 'preview' });
  eq(kept.stretcher, 'atempo');
  eq(shifted.stretcher, 'asetrate');
  // Both must still be the right length.
  near(kept.duration, shifted.duration, 0.3, 'both paths must retime identically');
});

test('a video with no audio still retimes', async () => {
  const r = await changeSpeed(await fixture('mute'), { rate: 2, out: tmp('cs-mute.mp4'), quality: 'preview' });
  eq(r.hasAudio, false);
  near(r.duration, 2.5, 0.25);
});

test('rate 1 and out-of-range rates are rejected', async () => {
  const src = await fixture('mute');
  for (const rate of [1, 0, -2, 50]) {
    let code = null;
    try { await changeSpeed(src, { rate, out: tmp('cs-bad.mp4') }); } catch (e) { code = e.code; }
    eq(code, EXIT.USAGE, `rate ${rate} should be rejected`);
  }
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const j = await cliOk('change-speed.mjs', [
    await fixture('mute'), '--rate', '2', '--out', tmp('cs-cli.mp4'), '--quality', 'preview',
  ]);
  eq(j.tool, 'change-speed');
  eq(j.rate, 2);
});
