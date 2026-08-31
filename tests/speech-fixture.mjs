// A speech fixture with GROUND TRUTH.
//
// Transcription and silence detection cannot be validated by eyeballing. This
// builds a clip where we know exactly what is said and exactly where the gaps
// are, by synthesising each sentence separately and splicing measured silence
// between them:
//
//   [sentence 1][1.50s gap][sentence 2][1.20s gap][sentence 3][0.90s gap][sentence 4]
//
// The sentence text becomes the reference for word-error-rate checks; the gap
// boundaries become the reference for detect-silence.
//
// Windows uses SAPI (Microsoft Maria, pt-BR). Elsewhere it falls back to
// ffmpeg's flite filter, which is English-only — the fixture is then tagged
// `language: 'en'` so tests can adapt.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from '../lib/proc.mjs';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { DIR, ensureDir } from '../lib/paths.mjs';
import { log } from '../lib/log.mjs';
import { probeVideo } from '../tools/probe-video.mjs';

/** Sentences chosen to also exercise later phases: keywords, coding B-roll, fillers. */
export const SCRIPT_PT = [
  { text: 'Olá, seja bem-vindo ao meu canal.', gapAfter: 1.5 },
  { text: 'Hoje vamos falar sobre o Claude Code e como automatizar a edição de vídeos.', gapAfter: 1.2 },
  { text: 'Primeiro, abra o terminal e execute npm install.', gapAfter: 0.9 },
  { text: 'Depois disso, o vídeo será renderizado automaticamente.', gapAfter: 0 },
];

export const SCRIPT_EN = [
  { text: 'Hello and welcome to my channel.', gapAfter: 1.5 },
  { text: 'Today we will talk about Claude Code and how to automate video editing.', gapAfter: 1.2 },
  { text: 'First, open the terminal and run npm install.', gapAfter: 0.9 },
  { text: 'After that, the video is rendered automatically.', gapAfter: 0 },
];

const RATE = 16000;

/** Synthesise one sentence to a 16 kHz mono WAV using Windows SAPI. */
async function sapiSynth(text, out, voice) {
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('${voice.replace(/'/g, "''")}')
$s.Rate = 0
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('${out.replace(/'/g, "''")}', $fmt)
$s.Speak('${text.replace(/'/g, "''")}')
$s.Dispose()
`.trim();
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 120000 });
}

async function sapiVoices() {
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | " +
      "ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture }"], { timeoutMs: 60000 });
    return stdout.trim().split(/\r?\n/).map(l => {
      const [name, culture] = l.trim().split('|');
      return { name, culture };
    }).filter(v => v.name);
  } catch {
    return [];
  }
}

/** flite fallback: English only, but keeps the fixture buildable off Windows. */
async function fliteSynth(text, out) {
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', `flite=text='${text.replace(/'/g, '')}':voice=slt`,
    '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le', out,
  ], { label: 'flite' });
}

async function silenceWav(seconds, out) {
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', `anullsrc=r=${RATE}:cl=mono`,
    '-t', String(seconds), '-c:a', 'pcm_s16le', out,
  ], { label: 'silence' });
}


/**
 * A second script that deliberately contains fillers and a stutter, so
 * remove-fillers can be validated against known ground truth. The words that
 * SHOULD be removable are listed in `fillers`; `keep` lists the ones that look
 * like fillers but carry meaning and must survive.
 */
export const SCRIPT_FILLER_PT = [
  { text: 'Então, vamos começar o tutorial.', gapAfter: 0.8 },
  { text: 'Eu queria, ahn, mostrar o o terminal.', gapAfter: 0.8 },
  { text: 'É tipo, muito simples de usar.', gapAfter: 0 },
];

export const FILLER_TRUTH = {
  // "ahn" is a non-lexical hesitation; "o o" is an exact stutter.
  removable: ['ahn', 'o'],
  // "Então" opens a sentence and is a real connective — removing it is a bug.
  mustKeep: ['Então', 'vamos', 'começar', 'terminal', 'simples'],
};

/** Build tests/fixtures/fillers.mp4 using the filler script. */
export async function buildFillerFixture({ force = false } = {}) {
  return buildFrom(SCRIPT_FILLER_PT, 'fillers', { force });
}

/**
 * Build tests/fixtures/speech.mp4 plus tests/fixtures/speech.truth.json.
 * @returns {Promise<{video:string, truth:object}>}
 */
export async function buildSpeechFixture({ force = false } = {}) {
  return buildFrom(null, 'speech', { force });
}

/**
 * @param {Array|null} script  explicit script, or null to auto-pick by voice language
 * @param {string} name         basename for the fixture and its truth file
 */
async function buildFrom(script, name, { force = false } = {}) {
  const dir = ensureDir(DIR.fixtures);
  const video = path.join(dir, `${name}.mp4`);
  const truthFile = path.join(dir, `${name}.truth.json`);

  if (!force && fs.existsSync(video) && fs.existsSync(truthFile)) {
    return { video, truth: JSON.parse(fs.readFileSync(truthFile, 'utf8')) };
  }

  const voices = os.platform() === 'win32' ? await sapiVoices() : [];
  const pt = voices.find(v => /^pt/i.test(v.culture || ''));
  const en = voices.find(v => /^en/i.test(v.culture || ''));
  const chosen = pt || en;
  const chosenScript = script || (pt ? SCRIPT_PT : SCRIPT_EN);
  const language = pt ? 'pt' : 'en';
  const engine = chosen ? `sapi:${chosen.name}` : 'flite:slt';

  log.info(`building ${name} fixture (${engine}, ${language})`);

  const work = ensureDir(path.join(DIR.temp, `fixture-${name}`));
  const parts = [];
  const segments = [];
  let cursor = 0;

  for (const [i, line] of chosenScript.entries()) {
    const wav = path.join(work, `line-${i}.wav`);
    if (chosen) await sapiSynth(line.text, wav, chosen.name);
    else await fliteSynth(line.text, wav);

    const m = await probeVideo(wav);
    if (!m.duration) throw new Error(`TTS produced an empty clip for: ${line.text}`);

    segments.push({ index: i, text: line.text, start: round(cursor), end: round(cursor + m.duration) });
    parts.push(wav);
    cursor += m.duration;

    if (line.gapAfter > 0) {
      const sil = path.join(work, `gap-${i}.wav`);
      await silenceWav(line.gapAfter, sil);
      parts.push(sil);
      segments.push({ silence: true, start: round(cursor), end: round(cursor + line.gapAfter) });
      cursor += line.gapAfter;
    }
  }

  // Concat demuxer is safe here: every part is already 16 kHz mono PCM.
  const listFile = path.join(work, 'list.txt');
  fs.writeFileSync(listFile, parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const joined = path.join(work, 'joined.wav');
  await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', joined], { label: 'speech-concat' });

  const total = (await probeVideo(joined)).duration;

  // Mux against a synthetic video track so it is a real video file to edit.
  await ffmpeg([
    '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${total.toFixed(3)}`,
    '-i', joined,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', video,
  ], { label: 'speech-mux' });

  const truth = {
    language,
    engine,
    duration: round(total),
    fullText: chosenScript.map(s => s.text).join(' '),
    sentences: segments.filter(s => !s.silence),
    silences: segments.filter(s => s.silence).map(s => ({ start: s.start, end: s.end, duration: round(s.end - s.start) })),
  };
  fs.writeFileSync(truthFile, JSON.stringify(truth, null, 2));
  fs.rmSync(work, { recursive: true, force: true });

  log.ok(`${name} fixture: ${truth.duration}s, ${truth.sentences.length} sentences, ${truth.silences.length} gaps`);
  return { video, truth };
}

const round = n => Math.round(n * 1000) / 1000;

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  buildSpeechFixture({ force: process.argv.includes('--force') })
    .then(r => console.log(JSON.stringify(r.truth, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}
