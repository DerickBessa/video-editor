// Human-readable logging. ALWAYS to stderr, so stdout stays pure machine-readable JSON.
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
let level = LEVELS[process.env.VE_LOG_LEVEL] ?? LEVELS.info;

export function setLevel(name) {
  if (name in LEVELS) level = LEVELS[name];
}

const C = process.stderr.isTTY && !process.env.NO_COLOR
  ? { dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', green: '\x1b[32m', reset: '\x1b[0m' }
  : { dim: '', red: '', yellow: '', cyan: '', green: '', reset: '' };

const emit = (lvl, color, prefix) => (...args) => {
  if (level < LEVELS[lvl]) return;
  process.stderr.write(`${color}${prefix}${C.reset} ${args.map(fmt).join(' ')}\n`);
};

function fmt(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

export const log = {
  error: emit('error', C.red, '[error]'),
  warn: emit('warn', C.yellow, '[warn] '),
  info: emit('info', C.cyan, '[info] '),
  debug: emit('debug', C.dim, '[debug]'),
  ok: emit('info', C.green, '[ok]   '),
};
