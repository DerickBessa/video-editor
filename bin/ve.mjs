#!/usr/bin/env node
// ve — single entry point that dispatches to the individual tools.
//
// Every tool is ALSO runnable directly (`node tools/cut-video.mjs ...`).
// This dispatcher exists for discoverability, not as a required layer.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TOOLS, PLANNED } from '../lib/registry.mjs';
import { ROOT } from '../lib/paths.mjs';
import { main } from '../lib/cli.mjs';
import { log } from '../lib/log.mjs';

const BUILTIN = {
  capabilities: 'capabilities.mjs',
};

async function dispatch(argv) {
  const [name, ...rest] = argv;

  if (!name || name === 'help' || name === '--help' || name === '-h') {
    process.stdout.write(`${topLevelHelp()}\n`);
    return;
  }
  if (name === '--version' || name === 'version') {
    const pkg = await import(pathToFileURL(path.join(ROOT, 'package.json')).href, { with: { type: 'json' } });
    process.stdout.write(`${pkg.default.version}\n`);
    return;
  }

  const entry = TOOLS.find(t => t.name === name);
  const file = BUILTIN[name] || entry?.file;

  if (entry && !entry.file) {
    log.error(`"${name}" is a capability, not a command: ${entry.summary}`);
    process.exitCode = 2;
    return;
  }

  if (!file) {
    const planned = PLANNED.find(p => p.name === name);
    if (planned) {
      log.error(`"${name}" is planned for phase ${planned.phase} but not implemented yet.`);
      process.stderr.write(`        Run \`ve capabilities\` to see what is available today.\n`);
      process.exitCode = 7;
      return;
    }
    log.error(`Unknown command: ${name}`);
    const near = suggest(name);
    if (near) process.stderr.write(`        Did you mean "${near}"?\n`);
    process.stderr.write(`\n${topLevelHelp()}\n`);
    process.exitCode = 2;
    return;
  }

  const mod = await import(pathToFileURL(path.join(ROOT, 'tools', file)).href);
  await main(mod.tool, rest);
}

function topLevelHelp() {
  const L = ['ve — modular automatic video editing toolkit', '', 'Usage: ve <command> [args] [options]', '', 'Available commands:'];
  // Some registry entries are capabilities without a command of their own
  // (slash commands, Skills); they are reported by `capabilities`, not run here.
  for (const t of TOOLS.filter(x => x.file)) L.push(`  ${pad(t.name, 18)}${t.summary}`);
  L.push(`  ${pad('capabilities', 18)}Show what is implemented, tested and working.`);
  L.push('', `Not yet implemented (${PLANNED.length}): ${PLANNED.slice(0, 6).map(p => p.name).join(', ')}, ...`);
  L.push('', 'Every command accepts --help, --log <level> and --quiet.');
  L.push('Each tool is also runnable directly, e.g. `node tools/cut-video.mjs --help`.');
  return L.join('\n');
}

/** Cheap edit-distance suggestion, so typos are not a dead end. */
function suggest(name) {
  const names = [...TOOLS.map(t => t.name), ...Object.keys(BUILTIN)];
  let best = null, bestD = Infinity;
  for (const n of names) {
    const d = distance(name, n);
    if (d < bestD) { bestD = d; best = n; }
  }
  return bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

const pad = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));

dispatch(process.argv.slice(2)).catch(e => {
  log.error(e?.stack || String(e));
  process.exitCode = 1;
});
