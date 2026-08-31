// Thin, promise-based child-process runner with proper error surfacing.
// No shell: args are passed as an array, so paths with spaces are safe on Windows.
import { spawn } from 'node:child_process';
import { log } from './log.mjs';
import { VeError, EXIT } from './errors.mjs';

const TAIL_LINES = 25;

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?:string, timeoutMs?:number, onStderr?:(chunk:string)=>void, maxBuffer?:number}} opts
 * @returns {Promise<{stdout:string, stderr:string, code:number, ms:number}>}
 */
export function run(cmd, args, opts = {}) {
  const { cwd, timeoutMs = 0, onStderr, maxBuffer = 64 * 1024 * 1024 } = opts;
  const started = Date.now();
  log.debug(`$ ${cmd} ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (cause) {
      return reject(new VeError(`Failed to spawn "${cmd}"`, { code: EXIT.DEPENDENCY, cause }));
    }

    let stdout = '', stderr = '', killed = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    }

    child.stdout.on('data', d => {
      stdout += d;
      if (stdout.length > maxBuffer) { killed = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', d => {
      const s = String(d);
      stderr += s;
      if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer / 2);
      onStderr?.(s);
    });

    child.on('error', cause => {
      clearTimeout(timer);
      reject(new VeError(
        `"${cmd}" is not available on this system`,
        { code: EXIT.DEPENDENCY, cause, hint: `Install it, or make sure "${cmd}" is on PATH.` }
      ));
    });

    child.on('close', code => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (killed) {
        return reject(new VeError(`"${cmd}" timed out or exceeded buffer after ${ms}ms`, { code: EXIT.PROCESS }));
      }
      if (code !== 0) {
        return reject(new VeError(`${cmd} exited with code ${code}`, {
          code: EXIT.PROCESS,
          details: { exitCode: code, stderrTail: tail(stderr) },
        }));
      }
      resolve({ stdout, stderr, code, ms });
    });
  });
}

export function tail(s, n = TAIL_LINES) {
  return String(s).trimEnd().split(/\r?\n/).slice(-n).join('\n');
}

/** Resolve a binary's version string, or null if it is not installed. */
export async function which(cmd, args = ['-version']) {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeoutMs: 20000 });
    return (stdout || stderr).trim().split(/\r?\n/)[0] || 'installed';
  } catch {
    return null;
  }
}
