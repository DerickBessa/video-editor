// Phase 8 audio: denoise-audio, compress-voice, add-music, duck-music.
// Every assertion measures the produced audio rather than trusting the filter.
import fs from 'node:fs';
import path from 'node:path';
import { test, eq, near, assert, verifyMedia, cliOk, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import { buildSpeechFixture } from './speech-fixture.mjs';
import { denoiseAudio, measureNoiseFloor, measureNoise } from '../tools/denoise-audio.mjs';
import { compressVoice, measureDynamics, PRESETS } from '../tools/compress-voice.mjs';
import { addMusic, listMusic, DUCK } from '../tools/add-music.mjs';
import { duckMusic } from '../tools/duck-music.mjs';
import { ffmpeg, FFMPEG } from '../lib/ffmpeg.mjs';
import { run } from '../lib/proc.mjs';
import { EXIT } from '../lib/errors.mjs';

const MUSIC = 'assets/music/bed.wav';

async function levelAt(file, at, dur = 0.8) {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-t', String(dur),
    '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-',
  ], { timeoutMs: 300000 });
  const m = /mean_volume:\s*(-?[\d.]+)/.exec(stderr);
  return m ? Number(m[1]) : null;
}

/** Speech with a known-level hiss added underneath. */
async function noisyFixture() {
  const f = tmp('afx-noisy.mp4');
  if (!fs.existsSync(f)) {
    const { video } = await buildSpeechFixture();
    const hiss = tmp('afx-hiss.wav');
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'anoisesrc=d=25:c=white:a=0.03:r=48000', '-c:a', 'pcm_s16le', hiss]);
    await ffmpeg([
      '-y', '-i', video, '-i', hiss,
      '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0:duration=first[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', f,
    ]);
  }
  return f;
}

/* ------------------------------------------------------------ denoise */

test('the noise floor is measured, not guessed', async () => {
  // The fixture's hiss sits around -40 dB; the estimator should find it.
  const info = await measureNoiseFloor(await noisyFixture());
  assert(info, 'the estimator returned nothing');
  assert(info.windows > 50, `expected many windows, got ${info.windows}`);
  near(info.floor, -40, 4, 'measured noise floor');
  assert(info.median > info.floor, 'the median must sit above the floor, or nothing was measured');
});

test('denoise actually removes noise, and more of it at higher strength', async () => {
  const src = await noisyFixture();
  const base = await levelAt(src, 4.2);      // a known silent gap: pure noise
  const results = [];
  for (const strength of [0.2, 0.9]) {
    const r = await denoiseAudio(src, { strength, out: tmp(`afx-dn-${strength}.mp4`) });
    results.push({ strength, level: await levelAt(r.path, 4.2), nr: r.afftdn.nr, nf: r.afftdn.nf });
  }
  assert(results[0].level < base - 4, `gentle denoise should still cut noise (${base} -> ${results[0].level})`);
  assert(results[1].level < results[0].level - 3,
    `higher strength must remove more (${results[0].level} vs ${results[1].level})`);
  // Regression: nf must track the measured floor, not scale with strength.
  eq(results[0].nf, results[1].nf, 'the noise FLOOR is a measurement and must not change with strength');
  assert(results[1].nr > results[0].nr, 'the reduction AMOUNT is what strength controls');
});

test('denoise leaves a clean recording essentially alone', async () => {
  const { video } = await buildSpeechFixture();
  const r = await denoiseAudio(video, { strength: 0.5, out: tmp('afx-dn-clean.mp4') });
  assert(Math.abs(r.meanChangeDb) < 1.5,
    `a clean source should barely change, moved ${r.meanChangeDb} dB`);
});

test('denoise refuses a source with no audio', async () => {
  let code = null;
  try { await denoiseAudio(await fixture('mute'), { out: tmp('afx-dn-mute.mp4') }); } catch (e) { code = e.code; }
  eq(code, EXIT.INPUT);
});

test('rnn engine explains itself when no model is present', async () => {
  const { video } = await buildSpeechFixture();
  let err = null;
  try { await denoiseAudio(video, { engine: 'rnn', out: tmp('afx-rnn.mp4') }); } catch (e) { err = e; }
  // Either it works (a model was added) or it says exactly what is missing.
  if (err) {
    eq(err.code, EXIT.INPUT);
    assert(/\.rnnn/.test(err.message + err.hint), 'the error should name the missing model type');
  }
});

/* ---------------------------------------------------------- compression */

test('compression reduces the crest factor', async () => {
  const { video } = await buildSpeechFixture();
  const before = await measureDynamics(video);
  const r = await compressVoice(video, { preset: 'voice', out: tmp('afx-cv.mp4') });
  assert(r.after.crest < before.crest - 1,
    `crest should shrink (${before.crest} -> ${r.after.crest} dB)`);
  assert(r.after.peak < -0.1, `output must not clip, peaked at ${r.after.peak} dBFS`);
});

test('stronger presets compress more', async () => {
  const { video } = await buildSpeechFixture();
  const light = await compressVoice(video, { preset: 'light', out: tmp('afx-cv-l.mp4') });
  const hard = await compressVoice(video, { preset: 'broadcast', out: tmp('afx-cv-b.mp4') });
  assert(hard.crestReductionDb > light.crestReductionDb,
    `broadcast (${hard.crestReductionDb} dB) should even out more than light (${light.crestReductionDb} dB)`);
});

test('presets are ordered by ratio', () => {
  assert(PRESETS.light.ratio < PRESETS.voice.ratio);
  assert(PRESETS.voice.ratio < PRESETS.broadcast.ratio);
});

test('compression rejects a source with no audio', async () => {
  let code = null;
  try { await compressVoice(await fixture('mute'), { out: tmp('afx-cv-mute.mp4') }); } catch (e) { code = e.code; }
  eq(code, EXIT.INPUT);
});

/* --------------------------------------------------------------- music */

test('the music asset exists', () => {
  assert(listMusic().length > 0, 'assets/music/ should contain at least the generated bed');
});

test('music is added, looped to length, and does not change the duration', async () => {
  const { video, truth } = await buildSpeechFixture();
  const r = await addMusic(video, { music: MUSIC, volume: 0.2, out: tmp('afx-mu.mp4') });
  eq(r.looped, true, 'an 8s bed under a 24s video must loop');
  near(r.duration, truth.duration, 0.4);
  await verifyMedia(r.path, { hasAudio: true });
});

test('ducking lowers the mix during speech but not during silence', async () => {
  const { video, truth } = await buildSpeechFixture();
  const ducked = await addMusic(video, { music: MUSIC, volume: 0.5, duck: true, duckStrength: 'hard', out: tmp('afx-mu-d.mp4') });
  const flat = await addMusic(video, { music: MUSIC, volume: 0.5, duck: false, out: tmp('afx-mu-f.mp4') });

  const gap = (truth.silences[0].start + truth.silences[0].end) / 2;
  const speech = (truth.sentences[1].start + truth.sentences[1].end) / 2;

  const dSil = await levelAt(ducked.path, gap);
  const fSil = await levelAt(flat.path, gap);
  const dSpe = await levelAt(ducked.path, speech);
  const fSpe = await levelAt(flat.path, speech);

  near(dSil, fSil, 1.0, 'with no voice present, ducking must not attenuate anything');
  assert(dSpe < fSpe, `during speech the ducked mix must be quieter (${dSpe} vs ${fSpe} dB)`);
});

test('--no-duck renders (regression: it produced an unconnected filter output)', async () => {
  const { video } = await buildSpeechFixture();
  const r = await addMusic(video, { music: MUSIC, volume: 0.2, duck: false, out: tmp('afx-mu-nd.mp4') });
  eq(r.ducked, false);
  await verifyMedia(r.path, { hasAudio: true });
});

test('music works on a video with no audio of its own', async () => {
  const r = await addMusic(await fixture('mute'), { music: MUSIC, volume: 0.5, out: tmp('afx-mu-mute.mp4') });
  eq(r.ducked, false, 'there is no voice to duck under');
  await verifyMedia(r.path, { hasAudio: true });
  assert((await levelAt(r.path, 2)) > -50, 'the music should be audible');
});

test('an unknown track is rejected and the folder is listed', async () => {
  const { video } = await buildSpeechFixture();
  let err = null;
  try { await addMusic(video, { music: 'nonexistent', out: tmp('afx-mu-bad.mp4') }); } catch (e) { err = e; }
  eq(err?.code, EXIT.INPUT);
  assert(/Available|empty/.test(err.hint || ''), 'the error should say what is available');
});

test('duck-music ducks a separate track under the voice', async () => {
  const { video, truth } = await buildSpeechFixture();
  const r = await duckMusic(video, { under: MUSIC, musicVolume: 0.5, strength: 'hard', out: tmp('afx-dk.mp4') });
  eq(r.music.kind, 'file');
  near(r.duration, truth.duration, 0.4);
  await verifyMedia(r.path, { hasAudio: true });
});

test('duck-music explains that already-mixed audio cannot be separated', async () => {
  const { video } = await buildSpeechFixture();
  let err = null;
  try { await duckMusic(video, { out: tmp('afx-dk-bad.mp4') }); } catch (e) { err = e; }
  eq(err?.code, EXIT.USAGE);
  assert(/cannot be separated|--under/.test(err.hint || ''),
    `the error should explain the limitation, got: ${err.hint}`);
});

test('CLI round-trips for the audio tools', async () => {
  const { video } = await buildSpeechFixture();
  eq((await cliOk('denoise-audio.mjs', [video, '--out', tmp('afx-cli-dn.mp4')])).tool, 'denoise-audio');
  eq((await cliOk('compress-voice.mjs', [video, '--out', tmp('afx-cli-cv.mp4')])).tool, 'compress-voice');
  eq((await cliOk('add-music.mjs', [video, '--music', MUSIC, '--out', tmp('afx-cli-mu.mp4')])).tool, 'add-music');
});
