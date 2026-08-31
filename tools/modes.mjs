// modes — show the editing styles available, and what each one decides.
//
// The styles themselves live in lib/styles.mjs (built in) and styles/*.json
// (user overrides). This tool exists so the options are discoverable without
// reading source, and so `ve modes --name viral` can explain a preset before
// you spend a render on it.
import { loadStyle, listStyles, MODE_NAMES } from '../lib/styles.mjs';
import { usageError } from '../lib/errors.mjs';
import { runIfMain } from '../lib/cli.mjs';

export async function modes(opts = {}) {
  if (opts.name) {
    const s = loadStyle(opts.name);
    if (!s) throw usageError(`Unknown style "${opts.name}"`, `Available: ${listStyles().join(', ')}`);
    return { style: opts.name, source: s.source, ...s };
  }

  const styles = listStyles().map(name => {
    const s = loadStyle(name);
    return {
      name,
      source: s?.source ?? 'file',
      description: s?.description ?? '',
      builtIn: MODE_NAMES.includes(name),
      resolution: s?.resolution ?? null,
      crop: s?.crop?.mode ?? null,
      captions: s?.captions?.enabled ? s.captions.style : null,
      silence: s?.silence?.enabled ? s.silence.intensity : null,
      fillers: s?.fillers?.level ?? null,
      zoom: s?.zoom?.enabled ? s.zoom.strength : null,
      sfx: s?.sfx?.enabled ? (s.sfx.perMinute ?? 'on') : null,
    };
  });

  return { count: styles.length, styles };
}

export const tool = {
  name: 'modes',
  summary: 'List the editing styles and what each one changes.',
  args: {
    name: { positional: 0, help: 'Show one style in full' },
  },
  examples: ['ve modes', 've modes viral', 've modes --name coding'],
  run: opts => modes({ ...opts, name: opts.name || opts._?.[0] }),
  pretty: r => r.styles
    ? r.styles.map(s =>
        `  ${s.name.padEnd(13)}${(s.crop || '-').padEnd(9)}captions=${String(s.captions || '-').padEnd(8)}` +
        `silence=${String(s.silence || '-').padEnd(11)}zoom=${String(s.zoom || '-').padEnd(6)}sfx=${s.sfx || '-'}`
      ).join('\n')
    : `${r.style}: ${r.description}`,
};

runIfMain(tool, import.meta.url);
