// Bridge to the Python sidecars in pysrc/.
//
// Python is used ONLY where it earns its place (ML models with no good FFmpeg
// equivalent). It always runs from the project-local .venv, never from whatever
// `python` happens to be on PATH — on this machine that resolves into an
// unrelated application's virtualenv.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from './proc.mjs';
import { ROOT } from './paths.mjs';
import { VeError, EXIT, depError } from './errors.mjs';
import { log } from './log.mjs';

export const VENV = path.join(ROOT, '.venv');

export const VENV_PYTHON = os.platform() === 'win32'
  ? path.join(VENV, 'Scripts', 'python.exe')
  : path.join(VENV, 'bin', 'python');

export const hasVenv = () => fs.existsSync(VENV_PYTHON);

const SETUP_HINT =
  os.platform() === 'win32'
    ? 'Create it with:\n  python -m venv .venv\n  .venv\\Scripts\\python.exe -m pip install -r pysrc/requirements.txt'
    : 'Create it with:\n  python3 -m venv .venv\n  .venv/bin/python -m pip install -r pysrc/requirements.txt';

export function requireVenv() {
  if (!hasVenv()) {
    throw depError(`Python environment not found at ${path.relative(ROOT, VENV_PYTHON)}`, SETUP_HINT);
  }
  return VENV_PYTHON;
}

/**
 * Run a script from pysrc/ and parse its JSON stdout.
 * The sidecars follow the same contract as the Node tools: JSON on stdout,
 * human logs on stderr, meaningful exit codes.
 *
 * @param {string} script  filename inside pysrc/, e.g. 'transcribe.py'
 * @param {string[]} args
 * @param {{timeoutMs?:number, label?:string, onLog?:(line:string)=>void}} opts
 */
export async function runPython(script, args, opts = {}) {
  const python = requireVenv();
  const scriptPath = path.join(ROOT, 'pysrc', script);
  if (!fs.existsSync(scriptPath)) {
    throw new VeError(`Python sidecar not found: pysrc/${script}`, { code: EXIT.DEPENDENCY });
  }

  const { timeoutMs = 0, label = script, onLog } = opts;

  let res;
  try {
    res = await run(python, ['-X', 'utf8', scriptPath, ...args], {
      timeoutMs,
      onStderr: chunk => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (!line.trim()) continue;
          onLog ? onLog(line) : log.debug(`${label}: ${line}`);
        }
      },
    });
  } catch (e) {
    // The sidecar's own exit codes mirror lib/errors.mjs, so pass them through
    // rather than flattening everything to "process failed".
    const code = e.details?.exitCode;
    throw new VeError(`${label} failed`, {
      code: [EXIT.INPUT, EXIT.DEPENDENCY, EXIT.PROCESS, EXIT.VALIDATION, EXIT.UNSUPPORTED].includes(code)
        ? code
        : EXIT.PROCESS,
      details: e.details,
      hint: e.details?.stderrTail,
      cause: e,
    });
  }

  try {
    return JSON.parse(res.stdout);
  } catch (cause) {
    throw new VeError(`${label} did not return valid JSON`, {
      code: EXIT.PROCESS,
      details: { stdoutHead: res.stdout.slice(0, 400) },
      cause,
    });
  }
}

/** Which sidecar packages are importable, for `ve capabilities`. */
export async function pythonStatus() {
  if (!hasVenv()) return { ready: false, reason: 'no .venv', python: null, packages: {} };
  try {
    const { stdout } = await run(VENV_PYTHON, ['-c',
      'import json,sys,importlib.util as u;' +
      'print(json.dumps({"python":sys.version.split()[0],' +
      '"packages":{n:(u.find_spec(n) is not None) for n in ["faster_whisper","ctranslate2","onnxruntime"]}}))',
    ], { timeoutMs: 60000 });
    const info = JSON.parse(stdout);
    return { ready: Boolean(info.packages.faster_whisper), ...info };
  } catch (e) {
    return { ready: false, reason: String(e.message || e), python: null, packages: {} };
  }
}
