// Test runner. Discovers tests/*.test.mjs, runs every case, and records a
// machine-readable report at tests/.results/latest.json.
//
// The report is the source of truth for `ve capabilities` — a capability is
// only ever reported as working because its test actually passed here.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, ensureDir } from '../lib/paths.mjs';
import { cases, AssertionError } from './harness.mjs';

const RESULTS = path.join(ROOT, 'tests', '.results');
const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m', yellow: '\x1b[33m', reset: '\x1b[0m' }
  : { green: '', red: '', dim: '', bold: '', yellow: '', reset: '' };

const filter = process.argv.slice(2).filter(a => !a.startsWith('-'));

async function main() {
  const dir = path.join(ROOT, 'tests');
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.test.mjs'))
    .filter(f => !filter.length || filter.some(s => f.includes(s)))
    .sort();

  if (!files.length) {
    console.error('No test files matched.');
    process.exitCode = 1;
    return;
  }

  const suites = [];
  for (const f of files) {
    cases.length = 0;
    await import(pathToFileURL(path.join(dir, f)).href);
    suites.push({ file: f, cases: [...cases] });
  }

  const report = { startedAt: new Date().toISOString(), suites: [], totals: { pass: 0, fail: 0, ms: 0 } };
  const t0 = Date.now();

  for (const suite of suites) {
    console.log(`\n${C.bold}${suite.file}${C.reset}`);
    const entry = { file: suite.file, cases: [] };

    for (const c of suite.cases) {
      const started = Date.now();
      try {
        await c.fn();
        const ms = Date.now() - started;
        console.log(`  ${C.green}PASS${C.reset} ${c.name} ${C.dim}(${ms}ms)${C.reset}`);
        entry.cases.push({ name: c.name, status: 'pass', ms });
        report.totals.pass++;
      } catch (e) {
        const ms = Date.now() - started;
        const isAssert = e instanceof AssertionError;
        console.log(`  ${C.red}FAIL${C.reset} ${c.name} ${C.dim}(${ms}ms)${C.reset}`);
        console.log(`       ${C.red}${indent(isAssert ? e.message : e.stack || String(e))}${C.reset}`);
        entry.cases.push({ name: c.name, status: 'fail', ms, error: isAssert ? e.message : String(e?.message || e) });
        report.totals.fail++;
      }
    }
    report.suites.push(entry);
  }

  report.totals.ms = Date.now() - t0;
  report.finishedAt = new Date().toISOString();

  ensureDir(RESULTS);
  fs.writeFileSync(path.join(RESULTS, 'latest.json'), JSON.stringify(report, null, 2));

  const { pass, fail, ms } = report.totals;
  const head = fail ? `${C.red}${fail} failed${C.reset}, ` : '';
  console.log(`\n${head}${C.green}${pass} passed${C.reset} ${C.dim}in ${(ms / 1000).toFixed(1)}s${C.reset}`);
  console.log(`${C.dim}report: tests/.results/latest.json${C.reset}`);
  process.exitCode = fail ? 1 : 0;
}

const indent = s => String(s).split('\n').join('\n       ');

main().catch(e => { console.error(e); process.exitCode = 1; });
