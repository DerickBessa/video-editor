// Single source of truth for project layout. RULE: nothing ever writes into raw/.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inputError } from './errors.mjs';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const DIR = {
  raw: path.join(ROOT, 'raw'),
  output: path.join(ROOT, 'output'),
  temp: path.join(ROOT, 'temp'),
  cache: path.join(ROOT, 'cache'),
  assets: path.join(ROOT, 'assets'),
  references: path.join(ROOT, 'references'),
  transcripts: path.join(ROOT, 'transcripts'),
  frames: path.join(ROOT, 'frames'),
  editPlans: path.join(ROOT, 'edit-plans'),
  styles: path.join(ROOT, 'styles'),
  models: path.join(ROOT, 'models'),
  tests: path.join(ROOT, 'tests'),
  fixtures: path.join(ROOT, 'tests', 'fixtures'),
};

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** Guard: refuse to write anywhere inside raw/. */
export function assertNotRaw(p) {
  const abs = path.resolve(p);
  const rel = path.relative(DIR.raw, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw inputError(
      `Refusing to write inside raw/: ${abs}`,
      'raw/ holds originals and is read-only by design. Write to output/ or temp/.'
    );
  }
  return abs;
}

/** Resolve an existing input file, with a clear error when it is missing. */
export function resolveInput(p, label = 'input') {
  if (!p) throw inputError(`Missing ${label}`);
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) throw inputError(`${label} not found: ${abs}`);
  if (!fs.statSync(abs).isFile()) throw inputError(`${label} is not a file: ${abs}`);
  return abs;
}

/** Prepare an output path: make its parent dir, refuse raw/. */
export function prepareOutput(p) {
  const abs = assertNotRaw(p);
  ensureDir(path.dirname(abs));
  return abs;
}

/** "raw/my video.mp4" -> "my-video" ; used to derive sibling artifact names. */
export function slug(p) {
  return path.basename(p, path.extname(p))
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'video';
}

export function relToRoot(p) {
  const r = path.relative(ROOT, path.resolve(p));
  return r.startsWith('..') ? path.resolve(p) : r.split(path.sep).join('/');
}
