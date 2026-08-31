// Content identity for caching. Hashing a 2 GB video byte-by-byte is wasteful,
// so we fingerprint size + mtime + head/tail samples: fast and collision-safe enough
// for a local cache, and it changes whenever the file is re-encoded or re-recorded.
import fs from 'node:fs';
import crypto from 'node:crypto';

const SAMPLE = 1 << 20; // 1 MiB from head and tail

export function fileFingerprint(filePath) {
  const st = fs.statSync(filePath);
  const h = crypto.createHash('sha256');
  h.update(`${st.size}:${Math.floor(st.mtimeMs)}`);

  const fd = fs.openSync(filePath, 'r');
  try {
    const n = Math.min(SAMPLE, st.size);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    h.update(buf);
    if (st.size > SAMPLE * 2) {
      fs.readSync(fd, buf, 0, n, st.size - n);
      h.update(buf);
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex').slice(0, 16);
}

/** Stable hash of a config object (key order independent). */
export function configHash(obj) {
  return crypto.createHash('sha256').update(stable(obj)).digest('hex').slice(0, 12);
}

function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

/** Cache key = what the input is + what we asked for. */
export function cacheKey(filePath, config = {}) {
  return `${fileFingerprint(filePath)}-${configHash(config)}`;
}
