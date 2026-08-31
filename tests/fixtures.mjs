// Deterministic test media, generated with ffmpeg so the suite never depends on
// a video the user happens to have lying around. Regenerated only when missing.
//
// `speech.mp4` deliberately has a KNOWN silence layout so silence detection can
// be asserted against ground truth instead of eyeballed:
//   0.0-4.0 tone | 4.0-5.5 SILENCE | 5.5-10.0 tone | 10.0-11.2 SILENCE | 11.2-16.0 tone
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from '../lib/ffmpeg.mjs';
import { DIR, ensureDir } from '../lib/paths.mjs';
import { log } from '../lib/log.mjs';

export const SILENCE_TRUTH = [
  { start: 4.0, end: 5.5 },
  { start: 10.0, end: 11.2 },
];

export const FIXTURES = {
  /** 16s 1280x720 30fps, colour bars + burned-in timecode, tone/silence audio. */
  landscape: {
    file: 'landscape.mp4',
    duration: 16,
    width: 1280,
    height: 720,
    fps: 30,
    build: out => [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=16',
      '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=16',
      '-filter_complex',
      // Silence the tone over the two known windows; keep video untouched.
      `[1:a]volume=0:enable='between(t,4,5.5)+between(t,10,11.2)'[a]`,
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', out,
    ],
  },

  /** 6s 1080x1920 vertical, for aspect-ratio handling. */
  portrait: {
    file: 'portrait.mp4',
    duration: 6,
    width: 1080,
    height: 1920,
    fps: 30,
    build: out => [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', out,
    ],
  },

  /**
   * 12s of four visually distinct 3s shots joined by HARD CUTS.
   * Ground truth for scene detection: cuts at exactly 3.0, 6.0 and 9.0.
   * testsrc2 alone is useless here — it changes every frame, so there is no
   * such thing as a "scene boundary" in it.
   */
  scenes: {
    file: 'scenes.mp4',
    duration: 12,
    width: 640,
    height: 360,
    fps: 30,
    build: out => [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=0x8B0000:s=640x360:d=3:r=30',
      '-f', 'lavfi', '-i', 'smptebars=s=640x360:d=3:r=30',
      '-f', 'lavfi', '-i', 'color=c=0x000080:s=640x360:d=3:r=30',
      '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=3:r=30',
      '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=12',
      '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]',
      '-map', '[v]', '-map', '4:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-shortest', out,
    ],
  },

  /** 5s video with NO audio track, to exercise the hasAudio=false path. */
  mute: {
    file: 'mute.mp4',
    duration: 5,
    width: 640,
    height: 480,
    fps: 25,
    build: out => [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=25:duration=5',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
      '-an', out,
    ],
  },
};

/** Ensure one fixture exists; returns its absolute path. */
export async function fixture(name) {
  const spec = FIXTURES[name];
  if (!spec) throw new Error(`Unknown fixture: ${name}`);
  const out = path.join(ensureDir(DIR.fixtures), spec.file);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) return out;
  log.info(`generating fixture ${spec.file} ...`);
  await ffmpeg(spec.build(out), { label: `fixture:${name}` });
  if (!fs.existsSync(out)) throw new Error(`Fixture generation produced nothing: ${out}`);
  return out;
}

export async function allFixtures() {
  const made = {};
  for (const name of Object.keys(FIXTURES)) made[name] = await fixture(name);
  return made;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  allFixtures().then(m => {
    for (const [k, v] of Object.entries(m)) log.ok(`${k}: ${v}`);
  });
}
