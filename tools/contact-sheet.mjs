// contact-sheet — one image showing the whole video at a glance.
//
// The fastest way to spot a render that went wrong: a black stretch, a crop
// that lost the subject, a caption in the wrong place. Cheaper to look at than
// scrubbing, and small enough to hand to a vision model.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, escapeFilterPath, findFont, escapeDrawtext } from '../lib/ffmpeg.mjs';
import { resolveInput, prepareOutput, relToRoot, slug, DIR, ensureDir } from '../lib/paths.mjs';
import { usageError, inputError, validationError } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

export async function contactSheet(input, opts = {}) {
  const columns = Math.max(1, Math.round(opts.columns ?? 5));
  const rows = Math.max(1, Math.round(opts.rows ?? 4));
  const tileWidth = Math.max(80, Math.round(opts.tileWidth ?? 320));
  const count = columns * rows;

  const abs = resolveInput(input, 'video');
  const meta = await probeVideo(abs);
  if (!meta.hasVideo) throw inputError(`${relToRoot(abs)} has no video track`);
  if (!meta.duration) throw validationError('cannot build a contact sheet for a zero-length video');

  // Sample at the MIDPOINT of each of `count` equal slices, so the first tile
  // is not the (often black) very first frame and the last is not past the end.
  const step = meta.duration / count;
  const timestamps = Array.from({ length: count }, (_, i) => Math.min(meta.duration - 0.05, step * (i + 0.5)));

  // drawtext needs an explicit fontfile on Windows (no fontconfig). If no font
  // is available anywhere, the sheet is still built — just without timecodes.
  const font = opts.timestamps === false ? null : findFont();
  if (opts.timestamps !== false && !font) {
    log.warn('no TTF found, so tiles will not be labelled; put one in assets/fonts/ to enable timecodes');
  }

  const work = ensureDir(path.join(DIR.temp, `sheet-${process.pid}-${Date.now()}`));
  const tiles = [];
  try {
    for (const [i, t] of timestamps.entries()) {
      const f = path.join(work, `t-${String(i).padStart(3, '0')}.png`);
      const label = font ? [
        `drawtext=fontfile='${escapeFilterPath(font)}':text='${escapeDrawtext(timecode(t))}'` +
        `:x=6:y=h-th-6:fontsize=${Math.max(11, Math.round(tileWidth / 16))}` +
        `:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`,
      ] : [];
      await ffmpeg([
        '-y', '-ss', String(t), '-accurate_seek', '-i', abs, '-frames:v', '1',
        '-vf', [`scale=${tileWidth}:-2:flags=lanczos`, ...label].join(','),
        '-an', '-sn', f,
      ], { label: `tile ${i + 1}/${count}` });
      if (fs.existsSync(f)) tiles.push(f);
      else log.warn(`no frame decoded at ${t.toFixed(2)}s`);
    }

    if (!tiles.length) throw validationError('no frames could be extracted', { file: relToRoot(abs) });

    const out = prepareOutput(
      opts.out || path.join(ensureDir(path.join(DIR.output, 'sheets')), `${slug(abs)}-sheet.png`)
    );
    // tile= needs exactly rows*cols inputs or it pads; use the real count.
    const usedCols = Math.min(columns, tiles.length);
    const usedRows = Math.ceil(tiles.length / usedCols);
    await ffmpeg([
      '-y', '-framerate', '1', '-i', path.join(work, 't-%03d.png'),
      '-vf', `tile=${usedCols}x${usedRows}:margin=6:padding=4:color=0x141414`,
      '-frames:v', '1', out,
    ], { label: 'contact-sheet' });

    const sheet = await probeVideo(out);
    return {
      source: relToRoot(abs),
      output: relToRoot(out),
      path: out,
      tiles: tiles.length,
      columns: usedCols,
      rows: usedRows,
      tileWidth,
      width: sheet.width,
      height: sheet.height,
      sourceDuration: meta.duration,
      timestamps: timestamps.slice(0, tiles.length).map(t => Math.round(t * 100) / 100),
      sizeBytes: sheet.sizeBytes,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function timecode(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const tool = {
  name: 'contact-sheet',
  summary: 'Build one image of evenly spaced frames, for a quick visual check.',
  args: {
    input: { positional: 0, required: true, help: 'Source video' },
    columns: { type: 'number', default: 5, help: 'Tiles per row' },
    rows: { type: 'number', default: 4, help: 'Number of rows' },
    tileWidth: { type: 'number', default: 320, help: 'Width of each tile in px' },
    timestamps: { type: 'bool', default: true, help: 'Burn a timecode into each tile' },
    out: { type: 'string', help: 'Output PNG path' },
  },
  examples: [
    've contact-sheet output/final.mp4',
    've contact-sheet output/final.mp4 --columns 6 --rows 3 --tile-width 240',
  ],
  run: opts => contactSheet(opts.input, opts),
  pretty: r => `${r.tiles} frames in a ${r.columns}x${r.rows} grid -> ${r.output} (${r.width}x${r.height})`,
};

runIfMain(tool, import.meta.url);
