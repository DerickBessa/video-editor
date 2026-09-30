// Retime a narration track pause-by-pause.
//
//   node scripts/retime-narration.mjs <input-audio> <transcript.json> <output-audio>
//
// `ve remove-silence` is the right tool for video, but it is all-or-nothing per pause and it
// refuses audio-only input (its filtergraph maps [0:v]). This narration needs the opposite of
// all-or-nothing: the breathing pauses get tightened, a few dramatic pauses are PROTECTED
// because the animation freezes on them, and one pause has to be INSERTED because the take ran
// two lines together with no gap where the visual needs one.
//
// Real room tone is preserved wherever a pause is only shortened — only the extended part is
// synthetic silence, so the cuts do not pump.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const [, , INPUT, TRANSCRIPT, OUTPUT, CONFIG] = process.argv;
if (!INPUT || !TRANSCRIPT || !OUTPUT) {
  console.error('usage: retime-narration.mjs <input-audio> <transcript.json> <output-audio> [config.json]');
  process.exit(2);
}

// The vinheta's approved values. A narration with a different rhythm passes its own `config.json`
// rather than editing these — the numbers below are a delivered result, not a general default.
const DEFAULTS = {
  minGap: 0.30,        // anything shorter is natural speech rhythm, left alone
  defaultTarget: 0.20,
  headKeep: 0.08,
  tailKeep: 0.20,
  // Pauses the edit depends on, keyed by the word the pause FOLLOWS (first match wins).
  // `target` overrides the default; a target longer than the real gap inserts silence.
  beats: [
    { after: 'acertar.', target: 0.45, why: 'anticipation antes do "Tcharam" — o reveal do 5837' },
    { after: 'tiro,', target: 0.60, why: 'FREEZE da caveira — a tomada emendou, o silencio e inserido' },
    { after: 'brincando.', target: 0.45, why: 'reset depois da piada, antes de RACE CONDITION' },
    { after: 'tem.', target: 0.50, why: 'tensao antes da virada "So que antes de registrar"' },
    { after: 'hamburguer.', target: 0.50, why: 'o beat do 1 != 2', nth: 2 },
  ],
};

const cfg = { ...DEFAULTS, ...(CONFIG ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {}) };
const MIN_GAP = cfg.minGap;
const DEFAULT_TARGET = cfg.defaultTarget;
const HEAD_KEEP = cfg.headKeep;
const TAIL_KEEP = cfg.tailKeep;
const BEATS = cfg.beats;

const norm = s => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const tr = JSON.parse(fs.readFileSync(TRANSCRIPT, 'utf8'));
const words = tr.segments.flatMap(s => s.words || []);
if (!words.length) { console.error('transcript has no word timestamps'); process.exit(3); }

// Count occurrences so a `nth` beat can target the right repetition of a repeated word.
const seen = new Map();
const gaps = [];
for (let i = 1; i < words.length; i++) {
  const prev = words[i - 1];
  const dur = words[i].start - prev.end;
  const key = norm(prev.word);
  const n = (seen.get(key) || 0) + 1;
  seen.set(key, n);

  const beat = BEATS.find(b => norm(b.after) === key && (b.nth === undefined || b.nth === n));
  if (!beat && dur < MIN_GAP) continue;

  gaps.push({
    start: prev.end,
    end: words[i].start,
    dur,
    target: beat ? beat.target : DEFAULT_TARGET,
    why: beat?.why || null,
    afterWord: prev.word.trim(),
  });
}

// Build the segment list: real audio wherever a pause is only shortened, synthetic silence for
// the extended part of a pause that has to grow.
const lastEnd = words[words.length - 1].end;
const segs = [];
let cursor = Math.max(0, words[0].start - HEAD_KEEP);
// `anullsrc` is an INFINITE source; `atrim=duration=0` therefore never ends and ffmpeg writes
// until the disk does. A protected pause whose target merely equals the real gap lands exactly
// there through float error, so the insert is only emitted when it is audibly non-zero.
const MIN_INSERT = 0.01;
for (const g of gaps) {
  const keep = Math.min(g.target, g.dur);
  segs.push({ type: 'a', from: cursor, to: g.start + keep });
  const insert = +(g.target - g.dur).toFixed(3);
  if (insert >= MIN_INSERT) segs.push({ type: 's', dur: insert });
  cursor = g.end;
}
segs.push({ type: 'a', from: cursor, to: lastEnd + TAIL_KEEP });


const parts = [];
const labels = [];
let ai = 0;
for (const s of segs) {
  if (s.type === 'a') {
    parts.push(`[0:a]atrim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},asetpts=PTS-STARTPTS[a${ai}]`);
  } else {
    parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${s.dur},asetpts=PTS-STARTPTS[a${ai}]`);
  }
  labels.push(`[a${ai}]`);
  ai++;
}
const filter = `${parts.join(';')};${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`;

const args = ['-y', '-i', INPUT, '-filter_complex', filter, '-map', '[out]',
  '-c:a', 'libmp3lame', '-b:a', '192k', OUTPUT];
const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(r.stderr.split('\n').slice(-15).join('\n'));
  process.exit(5);
}

const kept = segs.reduce((n, s) => n + (s.type === 'a' ? s.to - s.from : s.dur), 0);
console.error(`gaps handled: ${gaps.length}`);
for (const g of gaps.filter(x => x.why)) {
  const verb = g.target - g.dur >= MIN_INSERT ? 'INSERIDO' : 'preservado';
  console.error(`  ${verb.padEnd(10)} apos "${g.afterWord}"  ${g.dur.toFixed(2)}s -> ${g.target.toFixed(2)}s  (${g.why})`);
}
console.error(`duracao: ${lastEnd.toFixed(2)}s -> ${kept.toFixed(2)}s`);
console.error(`-> ${OUTPUT}`);
