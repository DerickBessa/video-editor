// The interface layer: slash commands, the Skill, and the dispatcher.
// These are documentation files, so the tests check they EXIST, are complete,
// and refer only to things that actually work — documentation that promises a
// capability the project does not have is worse than none.
import fs from 'node:fs';
import path from 'node:path';
import { test, eq, assert } from './harness.mjs';
import { TOOLS, PLANNED } from '../lib/registry.mjs';
import { ROOT } from '../lib/paths.mjs';
import { listStyles } from '../lib/styles.mjs';
import { cli } from './harness.mjs';

const CMD_DIR = path.join(ROOT, '.claude', 'commands');
const SKILL = path.join(ROOT, '.claude', 'skills', 'video-editor', 'SKILL.md');

test('the slash commands from the brief all exist', () => {
  for (const name of ['edit', 'preview', 'transcribe', 'cut-silence', 'captions', 'vertical']) {
    const f = path.join(CMD_DIR, `${name}.md`);
    assert(fs.existsSync(f), `missing slash command: /${name}`);
    const text = fs.readFileSync(f, 'utf8');
    assert(text.startsWith('---'), `/${name} needs frontmatter`);
    assert(/description:/.test(text), `/${name} needs a description`);
    assert(text.includes('$ARGUMENTS'), `/${name} should take the user's argument`);
  }
});

test('slash commands only reference tools that exist', () => {
  const known = new Set([...TOOLS.map(t => t.name), 'capabilities']);
  for (const f of fs.readdirSync(CMD_DIR)) {
    const text = fs.readFileSync(path.join(CMD_DIR, f), 'utf8');
    for (const m of text.matchAll(/ve\.mjs\s+([a-z-]+)/g)) {
      assert(known.has(m[1]), `${f} references "${m[1]}", which is not a real tool`);
    }
  }
});

test('the Skill exists with usable frontmatter', () => {
  assert(fs.existsSync(SKILL), 'SKILL.md is missing');
  const text = fs.readFileSync(SKILL, 'utf8');
  assert(/^---\r?\nname: video-editor/m.test(text), 'the skill needs a name');
  const desc = /description:\s*(.+)/.exec(text);
  assert(desc, 'the skill needs a description');
  assert(desc[1].length > 80, 'the description should say when to use it, not just what it is');
});

test('the Skill only references tools that exist', () => {
  const text = fs.readFileSync(SKILL, 'utf8');
  const known = new Set([...TOOLS.map(t => t.name), 'capabilities']);
  for (const m of text.matchAll(/ve\.mjs\s+([a-z-]+)/g)) {
    assert(known.has(m[1]), `SKILL.md references "${m[1]}", which is not a real tool`);
  }
  // Every tool named in the table must be real too.
  for (const m of text.matchAll(/`([a-z]+-[a-z-]+)`/g)) {
    const name = m[1];
    if (PLANNED.some(p => p.name === name)) {
      assert(false, `SKILL.md presents "${name}" as available, but it is only planned`);
    }
  }
});

test('the Skill names the real styles', () => {
  const text = fs.readFileSync(SKILL, 'utf8');
  for (const s of listStyles().filter(n => n !== 'default')) {
    assert(text.includes(s), `SKILL.md does not mention the "${s}" style`);
  }
});

test('the Skill documents the known limitations', () => {
  const text = fs.readFileSync(SKILL, 'utf8');
  for (const topic of ['crossfade', 'disfluenc', 'Face-detection accuracy', 'Caption position']) {
    assert(text.includes(topic), `SKILL.md should state the "${topic}" limitation`);
  }
});

test('the dispatcher lists only runnable commands', async () => {
  // `help` rather than no args: the shared cli() helper appends --log silent,
  // which an argument-less dispatcher would read as the command name.
  const r = await cli('../bin/ve.mjs', ['help']);
  eq(r.code, 0);
  // Capability-only registry entries must not appear as commands.
  for (const t of TOOLS.filter(x => !x.file)) {
    assert(!new RegExp(`^  ${t.name}\s`, 'm').test(r.stdout),
      `"${t.name}" has no command file and must not be listed as one`);
  }
  for (const t of TOOLS.filter(x => x.file).slice(0, 5)) {
    assert(r.stdout.includes(t.name), `"${t.name}" should be listed`);
  }
});

test('asking for a capability-only entry explains itself', async () => {
  const r = await cli('../bin/ve.mjs', ['skills']);
  eq(r.code, 2);
  assert(/capability, not a command/.test(r.stderr), r.stderr);
});

test('asking for an unimplemented tool says which phase it is in', async () => {
  if (!PLANNED.length) return;
  const r = await cli('../bin/ve.mjs', [PLANNED[0].name]);
  eq(r.code, 7);
  assert(/not implemented yet/.test(r.stderr), r.stderr);
});

test('a typo suggests the closest command', async () => {
  const r = await cli('../bin/ve.mjs', ['captons']);
  eq(r.code, 2);
  assert(/Did you mean "captions"/.test(r.stderr), r.stderr);
});
