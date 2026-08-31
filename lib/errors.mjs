// Typed errors so tools fail loudly with actionable messages and stable exit codes.
export const EXIT = {
  OK: 0,
  USAGE: 2,          // bad arguments
  INPUT: 3,          // missing / unreadable input
  DEPENDENCY: 4,     // required external tool missing
  PROCESS: 5,        // external process failed
  VALIDATION: 6,     // output failed its own sanity check
  UNSUPPORTED: 7,    // not implemented for this platform / format
};

export class VeError extends Error {
  constructor(message, { code = EXIT.PROCESS, hint, cause, details } = {}) {
    super(message, { cause });
    this.name = 'VeError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

export const usageError = (m, hint) => new VeError(m, { code: EXIT.USAGE, hint });
export const inputError = (m, hint) => new VeError(m, { code: EXIT.INPUT, hint });
export const depError = (m, hint) => new VeError(m, { code: EXIT.DEPENDENCY, hint });
export const validationError = (m, d) => new VeError(m, { code: EXIT.VALIDATION, details: d });
