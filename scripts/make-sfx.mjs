// Generates a small starter sound-effect catalogue with ffmpeg, so `add-sfx`
// is usable and testable out of the box.
//
// These are SYNTHESISED PLACEHOLDERS, not production sound design. They are
// deliberately plain: drop real .wav files into assets/sfx/ with the same names
// and everything downstream keeps working. Each is defined by an amplitude
// envelope times a waveform, via `aevalsrc`.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { DIR, ensureDir } from '../lib/paths.mjs';
import { log } from '../lib/log.mjs';

const SR = 48000;

/** name -> { expr, duration, description } */
export const SFX = {
  pop: {
    d: 0.16,
    // Pitch drops as it decays — the classic UI "pop".
    expr: "0.7*sin(2*PI*(900-2600*t)*t)*exp(-26*t)",
    description: 'Short bright pop. Word highlights, list items appearing.',
  },
  click: {
    d: 0.05,
    expr: "0.5*random(1)*exp(-90*t)",
    description: 'Dry click. Cursor moves, small UI beats.',
  },
  ding: {
    d: 0.9,
    expr: "0.45*(sin(2*PI*1180*t)+0.5*sin(2*PI*2360*t))*exp(-5.5*t)",
    description: 'Bell. Correct answers, key points, reveals.',
  },
  thud: {
    d: 0.45,
    expr: "0.8*sin(2*PI*(90-60*t)*t)*exp(-11*t)",
    description: 'Low impact. Titles landing, hard cuts, emphasis.',
  },
  whoosh: {
    d: 0.55,
    // Band-limited noise swelling then dying: a transition sweep.
    expr: "0.5*random(2)*sin(2*PI*(160+900*t)*t)*(exp(-3*t)-exp(-14*t))*3",
    description: 'Air sweep. Transitions, zooms, wipes.',
  },
  riser: {
    d: 1.2,
    expr: "0.4*sin(2*PI*(220+700*t*t)*t)*(t/1.2)",
    description: 'Rising tension. Builds into a reveal or punchline.',
  },
  swoosh: {
    d: 0.35,
    expr: "0.55*random(3)*exp(-9*t)*sin(2*PI*(1400-2200*t)*t)",
    description: 'Fast falling sweep. Elements leaving, quick cuts.',
  },
  blip: {
    d: 0.1,
    expr: "0.5*sin(2*PI*1600*t)*exp(-40*t)",
    description: 'Tiny beep. Counters, ticks, subtle markers.',
  },
};

export async function makeSfx({ force = false } = {}) {
  const dir = ensureDir(path.join(DIR.assets, 'sfx'));
  const made = [];

  for (const [name, spec] of Object.entries(SFX)) {
    const out = path.join(dir, `${name}.wav`);
    if (!force && fs.existsSync(out)) { made.push({ name, file: out, skipped: true }); continue; }
    await ffmpeg([
      '-y',
      '-f', 'lavfi', '-i', `aevalsrc=exprs=${spec.expr}:s=${SR}:d=${spec.d}`,
      // A short fade at both ends guarantees no click from a non-zero sample
      // at the very start or end of the file.
      '-af', `afade=t=in:st=0:d=0.005,afade=t=out:st=${Math.max(0, spec.d - 0.02)}:d=0.02,` +
             `alimiter=limit=0.9,aresample=${SR}`,
      '-ac', '1', '-c:a', 'pcm_s16le', out,
    ], { label: `sfx:${name}` });
    made.push({ name, file: out, skipped: false });
  }

  // A manifest so the tool (and Claude) can see what is available and when to use it.
  const manifest = {
    generated: new Date().toISOString(),
    note: 'Synthesised placeholders. Replace any file with a real .wav of the same name.',
    sounds: Object.entries(SFX).map(([name, s]) => ({
      name, file: `${name}.wav`, duration: s.d, description: s.description,
    })),
  };
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(manifest, null, 2));
  return made;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  makeSfx({ force: process.argv.includes('--force') })
    .then(m => {
      for (const x of m) log.ok(`${x.skipped ? 'kept' : 'made'} ${path.basename(x.file)}`);
    })
    .catch(e => { console.error(e); process.exit(1); });
}
