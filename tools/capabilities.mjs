// capabilities — what actually works right now, cross-checked against the
// last test run. Nothing is reported as working on the strength of the code
// existing; the test report is the evidence.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TOOLS, PLANNED } from '../lib/registry.mjs';
import { ROOT, DIR } from '../lib/paths.mjs';
import { ffmpegVersion, detectEncoder, listFilters } from '../lib/ffmpeg.mjs';
import { which } from '../lib/proc.mjs';
import { pythonStatus } from '../lib/python.mjs';
import { runIfMain } from '../lib/cli.mjs';

const RESULTS = path.join(ROOT, 'tests', '.results', 'latest.json');

function loadTestReport() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  } catch {
    return null;
  }
}

/** Per-suite pass/fail tally from the last `npm test`. */
function suiteStats(report) {
  const map = {};
  for (const s of report?.suites || []) {
    const pass = s.cases.filter(c => c.status === 'pass').length;
    map[s.file] = { pass, fail: s.cases.length - pass, total: s.cases.length };
  }
  return map;
}

async function environment() {
  const [ffmpeg, ffprobe, node, python, npm] = await Promise.all([
    ffmpegVersion().catch(() => null),
    which('ffprobe', ['-version']),
    Promise.resolve(process.version),
    which('python', ['--version']),
    which('npm', ['--version']),
  ]);

  let encoder = null;
  try { encoder = await detectEncoder(); } catch { /* reported as missing below */ }

  // The interpreter on PATH is reported for diagnosis only — sidecars always
  // run from the project-local .venv.
  const venv = await pythonStatus();

  let filters = new Set();
  try { filters = await listFilters(); } catch { /* ffmpeg missing */ }

  return {
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    cpus: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 1073741824),
    node,
    npm,
    ffmpeg,
    ffprobe: ffprobe ? ffprobe.replace(/^ffprobe version /, '').split(' ')[0] : null,
    python,
    venv,
    encoder: encoder ? { chosen: encoder.video, accel: encoder.accel, hardware: encoder.hardware, candidates: encoder.candidates } : null,
    keyFilters: Object.fromEntries(
      ['silencedetect', 'loudnorm', 'zoompan', 'scdet', 'ass', 'subtitles', 'atempo', 'rubberband',
       'sidechaincompress', 'afftdn', 'arnndn', 'drawtext', 'whisper'].map(f => [f, filters.has(f)])
    ),
  };
}

export async function capabilities() {
  const report = loadTestReport();
  const stats = suiteStats(report);

  const built = TOOLS.map(t => {
    const s = t.tests ? stats[t.tests] : null;
    // Downgrade any self-declared status that the test report does not back up.
    const status = !s ? 'untested' : s.fail > 0 ? 'failing' : t.status;
    return {
      capability: t.capability,
      tool: t.name,
      phase: t.phase,
      status,
      tests: s ? `${s.pass}/${s.total}` : null,
      summary: t.summary,
    };
  });

  const planned = PLANNED.map(p => ({
    capability: p.capability, tool: p.name, phase: p.phase, status: 'planned', tests: null,
  }));

  return {
    environment: await environment(),
    capabilities: [...built, ...planned],
    testReport: report ? { at: report.finishedAt, pass: report.totals.pass, fail: report.totals.fail } : null,
    counts: {
      working: built.filter(c => c.status === 'working').length,
      experimental: built.filter(c => c.status === 'experimental').length,
      failing: built.filter(c => c.status === 'failing').length,
      untested: built.filter(c => c.status === 'untested').length,
      planned: planned.length,
    },
  };
}

const MARK = { working: '✓', experimental: '~', failing: '✗', untested: '?', planned: ' ' };

export function render(r) {
  const e = r.environment;
  const L = [];
  L.push('ENVIRONMENT');
  L.push(`  ${tick(e.ffmpeg)} FFmpeg        ${e.ffmpeg || 'NOT FOUND'}`);
  L.push(`  ${tick(e.ffprobe)} FFprobe       ${e.ffprobe || 'NOT FOUND'}`);
  L.push(`  ${tick(e.node)} Node.js       ${e.node}`);
  L.push(`  ${tick(e.python)} Python (PATH) ${e.python || 'not found'}  — diagnostic only, not used`);
  L.push(`  ${tick(e.venv?.ready)} Python .venv  ${venvLine(e.venv)}`);
  L.push(`  ${tick(e.encoder)} Encoder       ${e.encoder ? `${e.encoder.chosen} (${e.encoder.hardware ? 'hardware' : 'CPU'})` : 'unknown'}`);
  L.push(`    Platform      ${e.platform}, ${e.cpus} cores, ${e.memoryGB} GB`);

  const missing = Object.entries(e.keyFilters).filter(([, v]) => !v).map(([k]) => k);
  L.push(`    FFmpeg filters ${missing.length ? `missing: ${missing.join(', ')}` : 'all required filters present'}`);

  L.push('');
  L.push('CAPABILITIES');
  let phase = null;
  for (const c of r.capabilities) {
    if (c.phase !== phase) { phase = c.phase; L.push(`  -- phase ${phase} --`); }
    const tests = c.tests ? `  (${c.tests} tests)` : '';
    L.push(`  [${MARK[c.status] ?? ' '}] ${padEnd(c.capability, 32)}${padEnd(c.tool || '', 20)}${tests}`);
  }

  L.push('');
  const n = r.counts;
  L.push(`  ${n.working} working, ${n.failing} failing, ${n.untested} untested, ${n.planned} planned`);
  if (!r.testReport) L.push('  no test report found — run `npm test` to validate capabilities');
  else L.push(`  last test run: ${n_(r.testReport.pass)} passed, ${n_(r.testReport.fail)} failed at ${r.testReport.at}`);
  return L.join('\n');
}

function venvLine(v) {
  if (!v?.ready) return v?.reason ? `not usable (${v.reason})` : 'not set up';
  const pkgs = Object.entries(v.packages).filter(([, ok]) => ok).map(([k]) => k);
  return `${v.python} + ${pkgs.join(', ')}`;
}

const tick = v => (v ? '✓' : '✗');
const n_ = v => String(v);
const padEnd = (s, n) => String(s) + ' '.repeat(Math.max(1, n - String(s).length));

export const tool = {
  name: 'capabilities',
  summary: 'Show which capabilities are implemented, tested and working.',
  args: {
    format: { type: 'enum', values: ['text', 'json'], default: 'text', help: 'Output format' },
  },
  examples: ['ve capabilities', 've capabilities --format json'],
  // Text goes to stderr so the stdout-is-JSON contract holds even here; the
  // JSON payload stays small in text mode so the terminal is not flooded.
  run: async opts => {
    const r = await capabilities();
    if (opts.format !== 'text') return r;
    process.stderr.write(`\n${render(r)}\n\n`);
    return { counts: r.counts, testReport: r.testReport };
  },
};

runIfMain(tool, import.meta.url);
