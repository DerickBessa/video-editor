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

// `prores` e `vp8` carregam alpha e existem para OVERLAY, que é o caso de uso original.
// `h264` existe para o outro caso: uma peça de tela cheia, com fundo próprio, que é o
// entregável final e não uma camada. Ele não é apenas "outro container" — ele dispensa o
// canal alpha, e com isso os frames intermediários podem ser JPEG em vez de PNG. Num Reel de
// 89s a 60fps isso é a diferença entre 24,7 GB de intermediário e ~1 GB.
export const CODECS = { prores: 'mov', vp8: 'webm', h264: 'mp4', png: 'png' };

/** Codecs cujo sentido é compor por cima de outra coisa — só neles a falta de alpha é um bug. */
const ALPHA_CODECS = new Set(['prores', 'vp8']);

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

/** Hash of the component sources, so the bundle is rebuilt when they change.
 *
 *  This walks SUBDIRECTORIES. It used to read only `remotion/*`, which meant every edit inside
 *  `remotion/scenes/` reused a stale bundle and rendered the previous version of the component —
 *  a silent failure that looks exactly like "my change did nothing". */
export function sourceHash() {
  const root = path.join(ROOT, 'remotion');
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); }
      else if (/\.(jsx?|tsx?|css|json)$/.test(e.name)) files.push(full);
    }
  };
  walk(root);
  return configHash(files.map(f => {
    const st = fs.statSync(f);
    return { f: path.relative(root, f).split(path.sep).join('/'), size: st.size, mtime: Math.floor(st.mtimeMs) };
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
  const crf = opts.crf ?? 18;
  if (!CODECS[codec]) throw usageError(`Unknown codec "${codec}"`, `Use: ${Object.keys(CODECS).join(', ')}`);
  // The cap used to be 60s, on the assumption that an overlay is a short insert. A full
  // animated cut-away is a legitimate use (the Prompt Injection Reel is 89s), so the limit is
  // now a sanity bound against a typo, not an editorial one.
  if (duration <= 0 || duration > 300) throw usageError(`--duration ${duration}s is outside 0..300`);

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
    ...(codec === 'h264' ? { pixelFormat: 'yuv420p', crf } : {}),
    // PNG frames are REQUIRED for any alpha pixel format — Remotion rejects the
    // combination otherwise ("you need to set PNG as the image format"), and
    // JPEG frames would have discarded the alpha channel before encoding.
    // PNG é OBRIGATÓRIO para qualquer pixel format com alpha, e é o passo mais lento do render.
    // Sem alpha ele não serve para nada: JPEG a 95 é visualmente idêntico e escreve muito mais
    // rápido, num intermediário uma ordem de grandeza menor.
    imageFormat: ALPHA_CODECS.has(codec) ? 'png' : 'jpeg',
    ...(ALPHA_CODECS.has(codec) ? {} : { jpegQuality: 95 }),
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
  if (ALPHA_CODECS.has(codec) && !hasAlpha) {
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
    codec: { type: 'enum', values: Object.keys(CODECS), default: 'prores', help: 'prores = alpha (default); vp8 = smaller alpha; h264 = peça final de tela cheia, sem alpha' },
    crf: { type: 'number', default: 18, help: 'Qualidade do h264 (menor = melhor; 16-18 para entrega)' },
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
