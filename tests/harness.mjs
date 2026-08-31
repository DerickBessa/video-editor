// Minimal test harness. Deliberately tiny and dependency-free.
//
// Rules it enforces, from the project brief:
//   - a tool is only "working" if it ran for real and its OUTPUT was inspected
//   - assertions about media go through ffprobe, not through the tool's own claims
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../lib/paths.mjs';
import { probeVideo } from '../tools/probe-video.mjs';

export const cases = [];

/** Register a test case. */
export function test(name, fn) {
  cases.push({ name, fn });
}

/* ------------------------------------------------------------ assertions */

export class AssertionError extends Error {}

export function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg || 'assertion failed');
}

export function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new AssertionError(`${msg || 'values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function near(actual, expected, tol, msg) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    throw new AssertionError(`${msg || 'value out of tolerance'}: expected ${expected} +/- ${tol}, got ${actual}`);
  }
}

export function fileExists(p, minBytes = 1) {
  const abs = path.resolve(p);
  assert(fs.existsSync(abs), `expected file to exist: ${abs}`);
  const size = fs.statSync(abs).size;
  assert(size >= minBytes, `file too small (${size} bytes, expected >= ${minBytes}): ${abs}`);
  return size;
}

/** Independent verification: re-probe the produced file rather than trusting the tool. */
export async function verifyMedia(p, expect = {}) {
  fileExists(p, 1000);
  const m = await probeVideo(p);
  if (expect.duration !== undefined) near(m.duration, expect.duration, expect.durationTol ?? 0.25, `${path.basename(p)} duration`);
  if (expect.width !== undefined) eq(m.width, expect.width, `${path.basename(p)} width`);
  if (expect.height !== undefined) eq(m.height, expect.height, `${path.basename(p)} height`);
  if (expect.fps !== undefined) near(m.fps, expect.fps, expect.fpsTol ?? 0.5, `${path.basename(p)} fps`);
  if (expect.hasAudio !== undefined) eq(m.hasAudio, expect.hasAudio, `${path.basename(p)} hasAudio`);
  if (expect.hasVideo !== undefined) eq(m.hasVideo, expect.hasVideo, `${path.basename(p)} hasVideo`);
  if (expect.audioCodec !== undefined) eq(m.audioCodec, expect.audioCodec, `${path.basename(p)} audioCodec`);
  if (expect.sampleRate !== undefined) eq(m.sampleRate, expect.sampleRate, `${path.basename(p)} sampleRate`);
  if (expect.channels !== undefined) eq(m.channels, expect.channels, `${path.basename(p)} channels`);
  return m;
}

/* ---------------------------------------------------- CLI-level execution */

/**
 * Run a tool THROUGH ITS CLI (not by importing it), so the argument parsing,
 * stdout contract and exit code are all exercised.
 */
export function cli(toolFile, args = []) {
  const script = path.join(ROOT, 'tools', toolFile);
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args, '--log', 'silent'], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('close', code => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* not all invocations emit JSON */ }
      resolve({ code, stdout, stderr, json });
    });
  });
}

/** Assert a CLI run succeeded and returned parseable JSON. */
export async function cliOk(toolFile, args = []) {
  const r = await cli(toolFile, args);
  assert(r.code === 0, `${toolFile} exited ${r.code}\n${r.stderr.trim()}`);
  assert(r.json, `${toolFile} did not emit JSON on stdout\nstdout: ${r.stdout.slice(0, 300)}`);
  assert(r.json.ok === true, `${toolFile} returned ok=false`);
  return r.json;
}

/** Assert a CLI run failed with a specific exit code. */
export async function cliFails(toolFile, args, expectedCode) {
  const r = await cli(toolFile, args);
  assert(r.code !== 0, `${toolFile} was expected to fail but exited 0`);
  if (expectedCode !== undefined) eq(r.code, expectedCode, `${toolFile} exit code`);
  return r;
}

export const tmp = name => {
  const p = path.join(ROOT, 'temp', 'tests', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
};

/* --------------------------------------------------- transcription quality */

/** Lowercase, strip punctuation and accents, collapse whitespace. */
export function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Word Error Rate = (substitutions + deletions + insertions) / referenceWords,
 * via Levenshtein distance over word sequences. 0 means a perfect match.
 */
export function wer(reference, hypothesis) {
  const ref = normalizeText(reference).split(' ').filter(Boolean);
  const hyp = normalizeText(hypothesis).split(' ').filter(Boolean);
  if (!ref.length) return hyp.length ? 1 : 0;

  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[hyp.length] / ref.length;
}
