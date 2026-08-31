// remotion-render — render a motion-graphics component to a transparent overlay.
//
// ARCHITECTURE: Remotion produces an OVERLAY FILE. It never touches the video
// pipeline. `add-overlay` (ffmpeg) composites it. That separation is deliberate:
// the render engine stays FFmpeg-only and fully cacheable, and a headless
// browser is only started for the frames that genuinely need one.
//
// Alpha is the whole point, so the default codec is ProRes 4444 in a .mov:
// it carries a real alpha channel, ffmpeg reads it natively, and it is
// lossless enough that compositing does not introduce edge artefacts. VP8/WebM
// is offered for a much smaller file when quality matters less.
//
// The webpack bundle is cached between runs — building it costs ~8s, and
// nothing about it changes unless the component source does.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveInput, prepareOutput, relToRoot, DIR, ensureDir, ROOT } from '../lib/paths.mjs';
import { configHash } from '../lib/hash.mjs';
import { usageError, inputError, validationError, VeError, EXIT } from '../lib/errors.mjs';
import { log } from '../lib/log.mjs';
import { runIfMain } from '../lib/cli.mjs';
import { probeVideo } from './probe-video.mjs';

export const CODECS = { prores: 'mov', vp8: 'webm', png: 'png' };

/** Component names, read from the library so this can never drift out of date. */
export async function listComponents() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'remotion', 'components.jsx')).href)
    .catch(() => null);
  // The library is JSX, so a plain import fails outside the bundler. Fall back
  // to reading the export list, which is what actually matters here.
  if (mod?.COMPONENTS) return Object.keys(mod.COMPONENTS);
  const src = fs.readFileSync(path.join(ROOT, 'remotion', 'components.jsx'), 'utf8');
  const block = /export const COMPONENTS = \{([\s\S]*?)\};/.exec(src);
  if (!block) return [];
  return [...new Set(
    block[1].split(',').map(s => s.split(':')[0].trim()).filter(n => /^[A-Z]\w*$/.test(n))
  )];
}

/** Hash of the component sources, so the bundle is rebuilt when they change. */
function sourceHash() {
  const dir = path.join(ROOT, 'remotion');
  const files = fs.readdirSync(dir).filter(f => /\.(jsx?|tsx?)$/.test(f)).sort();
  return configHash(files.map(f => {
    const st = fs.statSync(path.join(dir, f));
    return { f, size: st.size, mtime: Math.floor(st.mtimeMs) };
  }));
}

let bundleCache = null;

async function getBundle() {
  const hash = sourceHash();
  const marker = path.join(ensureDir(path.join(DIR.cache, 'remotion')), `bundle-${hash}.txt`);

  if (bundleCache?.hash === hash) return bundleCache.location;
  if (fs.existsSync(marker)) {
    const loc = fs.readFileSync(marker, 'utf8').trim();
    if (loc && fs.existsSync(loc)) {
      bundleCache = { hash, location: loc };
      return loc;
    }
  }

  let bundler;
  try {
    bundler = await import('@remotion/bundler');
  } catch (cause) {
    throw new VeError('Remotion is not installed', {
      code: EXIT.DEPENDENCY,
      hint: 'Run: npm install remotion @remotion/cli @remotion/bundler @remotion/renderer react react-dom',
      cause,
    });
  }

  log.info('bundling the motion-graphics project (cached until the components change)');
  const location = await bundler.bundle({
    entryPoint: path.join(ROOT, 'remotion', 'index.jsx'),
    onProgress: () => {},
  });
  fs.writeFileSync(marker, location);
  bundleCache = { hash, location };
  return location;
}

/**
 * @param {string} component
 * @param {{props?:object|string, duration?:number, fps?:number, width?:number, height?:number,
 *          codec?:string, out?:string, transparent?:boolean}} opts
 */
export async function remotionRender(component, opts = {}) {
  const available = await listComponents();

  if (opts.list) return { components: available, count: available.length };

  if (!component) throw usageError('Which component?', `Available: ${available.join(', ')}`);
  if (available.length && !available.includes(component)) {
    throw usageError(`Unknown component "${component}"`, `Available: ${available.join(', ')}`);
  }

  const fps = opts.fps ?? 30;
  const duration = opts.duration ?? 3;
  const width = opts.width ?? 1080;
  const height = opts.height ?? 1920;
  const codec = opts.codec || 'prores';
  if (!CODECS[codec]) throw usageError(`Unknown codec "${codec}"`, `Use: ${Object.keys(CODECS).join(', ')}`);
  if (duration <= 0 || duration > 60) throw usageError(`--duration ${duration}s is outside 0..60`);

  let props = {};
  if (opts.props) {
    if (typeof opts.props === 'object') props = opts.props;
    else {
      const raw = String(opts.props).trim();
      const text = raw.endsWith('.json') && fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : raw;
      try { props = JSON.parse(text); }
      catch (e) { throw usageError(`--props is not valid JSON: ${e.message}`); }
    }
  }

  const durationInFrames = Math.max(1, Math.round(duration * fps));
  const inputProps = { component, props };

  const serveUrl = await getBundle();

  let renderer;
  try {
    renderer = await import('@remotion/renderer');
  } catch (cause) {
    throw new VeError('@remotion/renderer is not installed', { code: EXIT.DEPENDENCY, cause });
  }

  const composition = await renderer.selectComposition({
    serveUrl, id: 'Overlay', inputProps,
  });

  const ext = CODECS[codec];
  const out = prepareOutput(
    opts.out || path.join(ensureDir(path.join(DIR.output, 'overlays')), `${component.toLowerCase()}.${ext}`)
  );

  log.info(`rendering ${component} — ${width}x${height}, ${duration}s, ${codec}${codec === 'prores' ? ' 4444 (alpha)' : ''}`);

  const started = Date.now();
  await renderer.renderMedia({
    composition: { ...composition, durationInFrames, fps, width, height },
    serveUrl,
    codec,
    // Transparency needs BOTH settings. The 4444 profile alone is not enough:
    // without an explicit alpha-carrying pixel format the render came out
    // yuv422p12le and composited as a solid rectangle.
    ...(codec === 'prores' ? { proResProfile: '4444', pixelFormat: 'yuva444p10le' } : {}),
    ...(codec === 'vp8' ? { pixelFormat: 'yuva420p' } : {}),
    // PNG frames are REQUIRED for any alpha pixel format — Remotion rejects the
    // combination otherwise ("you need to set PNG as the image format"), and
    // JPEG frames would have discarded the alpha channel before encoding.
    imageFormat: 'png',
    outputLocation: out,
    inputProps,
    onProgress: () => {},
  });
  const renderMs = Date.now() - started;

  if (!fs.existsSync(out) || fs.statSync(out).size < 500) {
    throw validationError('Remotion produced no usable output', { out });
  }

  const got = await probeVideo(out);
  if (got.width !== width || got.height !== height) {
    throw validationError(`overlay is ${got.width}x${got.height}, expected ${width}x${height}`);
  }

  // An overlay with no alpha will composite as an opaque box, which is a
  // silent visual failure — so check the pixel format actually carries one.
  const hasAlpha = /a$|yuva|argb|rgba|bgra/i.test(got.pixFmt || '');
  if (codec !== 'png' && !hasAlpha) {
    log.warn(`the overlay pixel format is ${got.pixFmt}, which carries no alpha — ` +
      `it will composite as a solid rectangle`);
  }

  return {
    component,
    output: relToRoot(out),
    path: out,
    codec,
    pixFmt: got.pixFmt,
    hasAlpha,
    width: got.width,
    height: got.height,
    fps,
    duration: got.duration,
    durationInFrames,
    props,
    sizeBytes: got.sizeBytes,
    renderMs,
    available,
  };
}

export const tool = {
  name: 'remotion-render',
  summary: 'Render a motion-graphics component to a transparent overlay for compositing.',
  args: {
    component: { positional: 0, help: 'Component name, e.g. Terminal, CodeBlock, LowerThird' },
    props: { type: 'string', help: 'Component props as JSON, or a path to a .json file' },
    duration: { type: 'number', default: 3, help: 'Overlay length in seconds' },
    fps: { type: 'number', default: 30, help: 'Frame rate' },
    width: { type: 'number', default: 1080, help: 'Overlay width' },
    height: { type: 'number', default: 1920, help: 'Overlay height' },
    codec: { type: 'enum', values: Object.keys(CODECS), default: 'prores', help: 'prores = alpha (default); vp8 = smaller' },
    list: { type: 'bool', default: false, help: 'List the available components and exit' },
    out: { type: 'string', help: 'Output path' },
  },
  examples: [
    've remotion-render --list',
    've remotion-render Terminal --props \'{"lines":["$ npm install","added 402 packages"]}\'',
    've remotion-render CodeBlock --props \'{"code":"const x = 1;","title":"app.js"}\' --duration 4',
    've remotion-render LowerThird --props \'{"title":"Derick","subtitle":"Engineer"}\' --width 1920 --height 1080',
  ],
  run: opts => remotionRender(opts.component, opts),
  pretty: r => r.components
    ? `${r.count} components: ${r.components.join(', ')}`
    : `${r.component} -> ${r.output}  ${r.width}x${r.height} ${r.duration}s ` +
      `${r.pixFmt}${r.hasAlpha ? ' (alpha)' : ' — NO ALPHA'}  ${r.renderMs}ms`,
};

runIfMain(tool, import.meta.url);
