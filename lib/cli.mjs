// Shared CLI contract for every tool.
//
// Conventions (relied on by the orchestrator and by Claude):
//   stdout -> JSON result ONLY, nothing else. Safe to pipe into jq.
//   stderr -> human logs, progress, errors.
//   exit 0 -> success; non-zero -> a code from EXIT in errors.mjs.
import { log, setLevel } from './log.mjs';
import { pathToFileURL } from 'node:url';
import { VeError, EXIT, usageError } from './errors.mjs';

/**
 * @typedef {Object} ArgSpec
 * @property {number}  [positional] index if this is a positional argument
 * @property {'string'|'number'|'bool'|'list'|'enum'} [type]
 * @property {boolean} [required]
 * @property {*}       [default]
 * @property {string[]}[values] allowed values when type is 'enum'
 * @property {string}  [help]
 */

/**
 * @typedef {Object} Tool
 * @property {string} name
 * @property {string} summary
 * @property {Record<string, ArgSpec>} args
 * @property {(opts:Object)=>Promise<Object>} run  resolves to the JSON result
 * @property {(result:Object)=>string} [pretty]    one-line human summary
 * @property {string[]} [examples]
 */

/** Global flags every tool understands. */
const GLOBAL = {
  help: { type: 'bool', help: 'Show usage and exit' },
  log: { type: 'enum', values: ['silent', 'error', 'warn', 'info', 'debug'], default: 'info', help: 'Log verbosity' },
  quiet: { type: 'bool', help: 'Suppress the JSON result on stdout' },
};

export function parseArgs(argv, spec) {
  const full = { ...GLOBAL, ...spec };
  const out = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];

    if (tok === '--') { positionals.push(...argv.slice(i + 1)); break; }

    if (tok.startsWith('--')) {
      let [key, inlineVal] = splitOnce(tok.slice(2), '=');
      let negated = false;
      if (key.startsWith('no-') && !(key in full)) { key = key.slice(3); negated = true; }
      const camel = toCamel(key);
      const s = full[camel];
      if (!s) throw usageError(`Unknown option --${key}`, `Run with --help to see valid options.`);

      if (s.type === 'bool') {
        out[camel] = inlineVal !== undefined ? isTruthy(inlineVal) : !negated;
        continue;
      }
      const raw = inlineVal !== undefined ? inlineVal : argv[++i];
      if (raw === undefined) throw usageError(`Option --${key} needs a value`);
      out[camel] = coerce(raw, s, key);
      continue;
    }

    if (tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok)) {
      throw usageError(`Unknown option ${tok}`, 'Only long options (--name) are supported.');
    }
    positionals.push(tok);
  }

  // Bind positionals declared in the spec.
  for (const [name, s] of Object.entries(full)) {
    if (s.positional === undefined) continue;
    const v = positionals[s.positional];
    if (v !== undefined) out[name] = s.type ? coerce(v, s, name) : v;
  }
  out._ = positionals;

  // Defaults, then required check.
  for (const [name, s] of Object.entries(full)) {
    if (out[name] === undefined && s.default !== undefined) out[name] = s.default;
  }
  for (const [name, s] of Object.entries(full)) {
    if (s.required && (out[name] === undefined || out[name] === '')) {
      throw usageError(`Missing required argument: ${s.positional !== undefined ? `<${name}>` : `--${toKebab(name)}`}`);
    }
  }
  return out;
}

function coerce(raw, s, key) {
  switch (s.type) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw usageError(`--${key} expects a number, got "${raw}"`);
      return n;
    }
    case 'list':
      return String(raw).split(',').map(v => v.trim()).filter(Boolean);
    case 'enum':
      if (!s.values.includes(raw)) {
        throw usageError(`--${key} must be one of: ${s.values.join(', ')} (got "${raw}")`);
      }
      return raw;
    case 'bool':
      return isTruthy(raw);
    default:
      return raw;
  }
}

const isTruthy = v => !['false', '0', 'no', 'off', ''].includes(String(v).toLowerCase());
const toCamel = s => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const toKebab = s => s.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
function splitOnce(s, sep) {
  const i = s.indexOf(sep);
  return i === -1 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

export function usage(tool) {
  const spec = { ...tool.args, ...GLOBAL };
  const pos = Object.entries(spec).filter(([, s]) => s.positional !== undefined)
    .sort((a, b) => a[1].positional - b[1].positional);
  const opts = Object.entries(spec).filter(([, s]) => s.positional === undefined);

  const lines = [
    `${tool.name} — ${tool.summary}`,
    '',
    `Usage: ve ${tool.name} ${pos.map(([n, s]) => (s.required ? `<${n}>` : `[${n}]`)).join(' ')} [options]`,
  ];
  if (pos.length) {
    lines.push('', 'Arguments:');
    for (const [n, s] of pos) lines.push(`  ${pad(`<${n}>`, 26)}${s.help || ''}${s.required ? ' (required)' : ''}`);
  }
  lines.push('', 'Options:');
  for (const [n, s] of opts) {
    const val = s.type === 'bool' || !s.type ? '' : ` <${s.type === 'enum' ? s.values.join('|') : s.type}>`;
    const def = s.default !== undefined ? `  [default: ${Array.isArray(s.default) ? s.default.join(',') : s.default}]` : '';
    lines.push(`  ${pad(`--${toKebab(n)}${val}`, 26)}${s.help || ''}${def}`);
  }
  if (tool.examples?.length) {
    lines.push('', 'Examples:');
    for (const ex of tool.examples) lines.push(`  ${ex}`);
  }
  return lines.join('\n');
}

const pad = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));

/**
 * Execute a tool as a CLI process. Never throws; always sets an exit code.
 * @param {Tool} tool
 * @param {string[]} argv
 */
export async function main(tool, argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv, tool.args);
  } catch (e) {
    reportError(e);
    process.stderr.write(`\n${usage(tool)}\n`);
    process.exitCode = e.code ?? EXIT.USAGE;
    return;
  }

  if (opts.help) { process.stdout.write(`${usage(tool)}\n`); return; }
  setLevel(opts.log);

  const started = Date.now();
  try {
    const result = await tool.run(opts);
    const payload = { ok: true, tool: tool.name, ...result, ms: Date.now() - started };
    if (!opts.quiet) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (tool.pretty) log.ok(tool.pretty(payload));
    process.exitCode = EXIT.OK;
  } catch (e) {
    reportError(e);
    process.exitCode = e instanceof VeError ? e.code : 1;
  }
}

/**
 * Run the tool only when its file was invoked directly, so every tool module is
 * both `node tools/x.mjs ...` executable and importable by the orchestrator.
 * @param {Tool} tool
 * @param {string} importMetaUrl  pass `import.meta.url`
 */
export function runIfMain(tool, importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return;
  if (importMetaUrl === pathToFileURL(entry).href) main(tool);
}

function reportError(e) {
  if (e instanceof VeError) {
    log.error(e.message);
    if (e.hint) process.stderr.write(`        ${e.hint.split('\n').join('\n        ')}\n`);
    if (e.details?.stderrTail && !e.hint) process.stderr.write(`${e.details.stderrTail}\n`);
  } else {
    log.error(e?.stack || String(e));
  }
}
