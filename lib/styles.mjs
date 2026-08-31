// Editing modes: the editorial opinions, kept out of the code.
//
// A mode is not a set of features, it is a set of DEFAULTS plus limits. The
// difference between "clean" and "viral" is not that viral can do more, it is
// that viral spends its attention budget differently: shorter cues, tighter
// silence, zooms allowed, effects allowed but rationed.
//
// Everything here is overridable per-run, and a user style file in styles/
// with the same name wins over these.
import fs from 'node:fs';
import path from 'node:path';
import { DIR } from './paths.mjs';

export const MODES = {
  clean: {
    description: 'Minimal intervention. Tighten pauses, fix loudness, readable captions.',
    format: 'short',
    resolution: '1080x1920',
    crop: { mode: 'static', aspect: '9:16', position: 'center' },
    silence: { enabled: true, intensity: 'normal', snap: 'words' },
    fillers: { level: 'safe' },
    captions: { enabled: true, style: 'clean', maxWords: 6, highlightKeywords: false },
    zoom: { enabled: false },
    sfx: { enabled: false },
    audio: { normalize: true, targetLufs: -16 },
    speed: null,
  },

  educational: {
    description: 'Clarity first. Calm pacing, generous captions, highlights on key terms.',
    format: 'short',
    resolution: '1080x1920',
    crop: { mode: 'static', aspect: '9:16', position: 'center' },
    silence: { enabled: true, intensity: 'soft', snap: 'words' },
    fillers: { level: 'safe' },
    captions: { enabled: true, style: 'clean', maxWords: 7, highlightKeywords: true },
    zoom: { enabled: true, strength: 1.08, perMinute: 3 },
    sfx: { enabled: false },
    audio: { normalize: true, targetLufs: -16 },
    speed: null,
  },

  viral: {
    description: 'Fast and loud. Aggressive trimming, word-by-word captions, punch zooms, sparing effects.',
    format: 'short',
    resolution: '1080x1920',
    crop: { mode: 'static', aspect: '9:16', position: 'center' },
    silence: { enabled: true, intensity: 'aggressive', snap: 'words' },
    fillers: { level: 'aggressive' },
    captions: { enabled: true, style: 'viral', maxWords: 4, highlightKeywords: true },
    zoom: { enabled: true, strength: 1.14, perMinute: 8, mode: 'punch' },
    sfx: { enabled: true, density: 'low', perMinute: 5, sound: 'pop' },
    audio: { normalize: true, targetLufs: -14 },
    speed: { rate: 1.05 },
  },

  podcast: {
    description: 'Long-form talking heads. Follows the speaker, light on effects.',
    format: 'short',
    resolution: '1080x1920',
    // The one mode where face tracking earns its cost.
    crop: { mode: 'smart', aspect: '9:16', smoothing: 0.88, deadzone: 0.025 },
    silence: { enabled: true, intensity: 'normal', snap: 'words' },
    fillers: { level: 'safe' },
    captions: { enabled: true, style: 'clean', maxWords: 6, highlightKeywords: false },
    zoom: { enabled: false },
    sfx: { enabled: false },
    audio: { normalize: true, targetLufs: -16 },
    speed: null,
  },

  coding: {
    description: 'Technical demos. Keeps the screen readable, highlights tool and command names.',
    format: 'short',
    resolution: '1080x1920',
    // Screen recordings must NOT be cropped to 9:16 — the code becomes
    // unreadable. Contain with a blurred fill keeps the whole frame.
    crop: { mode: 'contain', aspect: '9:16', background: 'blur' },
    silence: { enabled: true, intensity: 'normal', snap: 'words' },
    fillers: { level: 'safe' },
    captions: { enabled: true, style: 'bold', maxWords: 4, highlightKeywords: true },
    zoom: { enabled: true, strength: 1.1, perMinute: 4 },
    sfx: { enabled: true, density: 'low', perMinute: 3, sound: 'click' },
    audio: { normalize: true, targetLufs: -16 },
    speed: null,
    // Words that should always be highlighted in a coding video, on top of
    // whatever detect-keywords finds on its own.
    keywords: ['npm', 'docker', 'git', 'terminal', 'api', 'claude', 'github', 'install', 'build', 'deploy'],
  },

  landscape: {
    description: 'Leave it 16:9. Cleanup only, for YouTube rather than Shorts.',
    format: 'landscape',
    resolution: null,
    crop: null,
    silence: { enabled: true, intensity: 'normal', snap: 'words' },
    fillers: { level: 'safe' },
    captions: { enabled: true, style: 'minimal', maxWords: 9, highlightKeywords: false },
    zoom: { enabled: false },
    sfx: { enabled: false },
    audio: { normalize: true, targetLufs: -16 },
    speed: null,
  },
};

export const MODE_NAMES = Object.keys(MODES);

/**
 * Load a mode, letting a file in styles/<name>.json override the built-in.
 * That is how a user keeps their own house style without editing code.
 */
export function loadStyle(name) {
  const builtin = MODES[name];
  const file = path.join(DIR.styles, `${name}.json`);

  if (!fs.existsSync(file)) {
    if (!builtin) return null;
    return { ...builtin, name, source: 'builtin' };
  }

  let user;
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`styles/${name}.json is not valid JSON: ${e.message}`);
  }
  return deepMerge({ ...(builtin || {}) }, { ...user, name, source: builtin ? 'builtin+file' : 'file' });
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** Every style name available, built in or on disk. */
export function listStyles() {
  const names = new Set(MODE_NAMES);
  if (fs.existsSync(DIR.styles)) {
    for (const f of fs.readdirSync(DIR.styles)) {
      if (f.endsWith('.json') && !f.includes('schema')) names.add(path.basename(f, '.json'));
    }
  }
  return [...names].sort();
}
