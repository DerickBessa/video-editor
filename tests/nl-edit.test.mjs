import fs from 'node:fs';
import path from 'node:path';
import { test, eq, near, assert, cliOk, tmp } from './harness.mjs';
import { nlEdit, getPath, setPath, RULES } from '../tools/nl-edit.mjs';
import { emptyPlan } from '../lib/edit-plan.mjs';
import { EXIT } from '../lib/errors.mjs';

const SRC = 'tests/fixtures/landscape.mp4';   // 16s

function planFile(name, over = {}) {
  const p = tmp(name);
  fs.writeFileSync(p, JSON.stringify({
    ...emptyPlan(SRC),
    zooms: [
      { start: 3, end: 5, scale: 1.1, mode: 'smooth' },
      { start: 12, end: 14, scale: 1.2, mode: 'smooth' },
    ],
    captions: { enabled: true, style: 'clean' },
    sfx: [{ timestamp: 4, sound: 'pop', volume: 0.4 }, { timestamp: 13, sound: 'ding', volume: 0.4 }],
    ...over,
  }, null, 2));
  return p;
}
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));

/* ------------------------------------------------------------ path helpers */

test('getPath and setPath handle nesting and array indices', () => {
  const o = { a: { b: [{ c: 1 }] } };
  eq(getPath(o, 'a.b[0].c'), 1);
  eq(getPath(o, 'a.missing.x'), undefined);
  setPath(o, 'a.b[0].c', 9);
  eq(o.a.b[0].c, 9);
  setPath(o, 'x.y.z', 'new');
  eq(o.x.y.z, 'new');
});

/* ------------------------------------------------------- natural language */

test('every documented phrasing matches a rule, in both languages', () => {
  const cases = {
    'remove-zoom-at': ['remove the zoom between 17 and 20 seconds', 'Remova o zoom entre 12 e 14 segundos'],
    'add-zoom-at': ['add a zoom at 8 seconds', 'coloca um zoom em 21 segundos'],
    'caption-position': ['the caption is too low', 'a legenda está muito baixa'],
    'caption-size': ['make the captions bigger', 'deixa a legenda maior'],
    'caption-style': ['use karaoke captions', 'legenda estilo viral'],
    'speed-range': ['make the first five seconds faster', 'deixe os primeiros 5 segundos mais rápidos'],
    'remove-sfx-at': ['remove all the sound effects', 'tira os efeitos sonoros'],
    'no-captions': ['no captions', 'sem legendas'],
    'no-zooms': ['remove all zooms', 'tira todos os zooms'],
  };
  for (const [name, phrases] of Object.entries(cases)) {
    for (const phrase of phrases) {
      const rule = RULES.find(r => r.test(phrase));
      assert(rule, `nothing matched "${phrase}"`);
      eq(rule.name, name, `"${phrase}" matched ${rule.name} instead of ${name}`);
    }
  }
});

test('THE example from the brief: remove the zoom in a time range', async () => {
  const p = planFile('nl-zoom.json');
  const r = await nlEdit(p, { instruction: 'remove the zoom between 12 and 14 seconds' });
  eq(r.matchedRule, 'remove-zoom-at');
  const after = read(p);
  eq(after.zooms.length, 1, 'only the zoom in that range should go');
  eq(after.zooms[0].start, 3, 'the other zoom must survive');
});

test('the Portuguese form does the same thing', async () => {
  const p = planFile('nl-zoom-pt.json');
  await nlEdit(p, { instruction: 'Remova o zoom entre 12 e 14 segundos' });
  eq(read(p).zooms.length, 1);
});

test('a zoom outside the named range is left alone', async () => {
  const p = planFile('nl-zoom-none.json');
  const r = await nlEdit(p, { instruction: 'remove the zoom between 30 and 40 seconds', dryRun: true });
  eq(r.changes[0].applied, false);
  assert(/no zoom overlaps/.test(r.changes[0].description), r.changes[0].description);
});

test('"the caption is too low" moves them up', async () => {
  const p = planFile('nl-cap.json');
  await nlEdit(p, { instruction: 'a legenda está muito baixa' });
  const after = read(p);
  assert(after.captions.marginV > 0.1, `expected a bigger bottom margin, got ${after.captions.marginV}`);
});

test('caption size and style can be changed by description', async () => {
  const p = planFile('nl-cap2.json');
  await nlEdit(p, { instruction: 'make the captions bigger' });
  assert(read(p).captions.fontSize > 0.045);
  await nlEdit(p, { instruction: 'use karaoke captions' });
  eq(read(p).captions.style, 'karaoke');
});

test('speed can be set by description', async () => {
  const p = planFile('nl-speed.json');
  await nlEdit(p, { instruction: 'deixe os primeiros 5 segundos mais rápidos' });
  const after = read(p);
  eq(after.speed.length, 1);
  assert(after.speed[0].rate > 1, 'faster means a rate above 1');
});

test('adding a zoom by description produces a valid event', async () => {
  const p = planFile('nl-add.json');
  await nlEdit(p, { instruction: 'add a 1.2x zoom at 8 seconds' });
  const added = read(p).zooms.find(z => z.start === 8);
  assert(added, 'the zoom should be there');
  eq(added.scale, 1.2);
  assert(added.end > added.start);
});

test('an unrecognised instruction fails loudly and says what to do instead', async () => {
  const p = planFile('nl-unknown.json');
  let err = null;
  try { await nlEdit(p, { instruction: 'make it feel more cinematic' }); } catch (e) { err = e; }
  eq(err?.code, EXIT.USAGE);
  assert(/--set/.test(err.hint || ''), 'the error should point at the precise interface');
  assert(/remove-zoom-at/.test(err.hint || ''), 'and list what IS recognised');
});

/* -------------------------------------------------------- precise editing */

test('--set writes a value and reports the change', async () => {
  const p = planFile('nl-set.json');
  const r = await nlEdit(p, { set: 'captions.style="viral";captions.maxWords=3' });
  eq(read(p).captions.style, 'viral');
  eq(read(p).captions.maxWords, 3);
  eq(r.changeCount, 2);
  eq(r.changes[0].from, 'clean', 'the previous value should be reported');
});

test('--add appends to an array', async () => {
  const p = planFile('nl-addpath.json');
  await nlEdit(p, { add: 'zooms=[{"start":8,"end":9.5,"scale":1.15}]' });
  eq(read(p).zooms.length, 3);
});

test('--remove deletes an array element by index', async () => {
  const p = planFile('nl-rm.json');
  await nlEdit(p, { remove: 'zooms[0]' });
  const after = read(p);
  eq(after.zooms.length, 1);
  eq(after.zooms[0].start, 12, 'the SECOND zoom should be what remains');
});

test('a change that would break the plan is refused', async () => {
  const p = planFile('nl-bad.json');
  const before = fs.readFileSync(p, 'utf8');
  let code = null;
  // A zoom that ends before it starts is unrenderable.
  try { await nlEdit(p, { add: 'zooms=[{"start":9,"end":3,"scale":1.1}]' }); } catch (e) { code = e.code; }
  eq(code, EXIT.VALIDATION);
  eq(fs.readFileSync(p, 'utf8'), before, 'the plan file must be left untouched');
});

test('a zoom beyond the source duration is refused', async () => {
  const p = planFile('nl-oob.json');
  let code = null;
  try { await nlEdit(p, { add: 'zooms=[{"start":900,"end":902,"scale":1.1}]' }); } catch (e) { code = e.code; }
  eq(code, EXIT.VALIDATION, 'validation should know the source is only 16s');
});

test('dry run changes nothing on disk', async () => {
  const p = planFile('nl-dry.json');
  const before = fs.readFileSync(p, 'utf8');
  const r = await nlEdit(p, { instruction: 'remove all zooms', dryRun: true });
  eq(r.dryRun, true);
  eq(fs.readFileSync(p, 'utf8'), before);
});

test('--out writes elsewhere and leaves the original alone', async () => {
  const p = planFile('nl-out.json');
  const before = fs.readFileSync(p, 'utf8');
  const out = tmp('nl-out-copy.json');
  await nlEdit(p, { instruction: 'no captions', out });
  eq(fs.readFileSync(p, 'utf8'), before);
  eq(read(out).captions.enabled, false);
});

test('doing nothing is an error, not a silent no-op', async () => {
  const p = planFile('nl-noop.json');
  let code = null;
  try { await nlEdit(p, {}); } catch (e) { code = e.code; }
  eq(code, EXIT.USAGE);
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const p = planFile('nl-cli.json');
  const j = await cliOk('nl-edit.mjs', [p, 'remove all zooms', '--dry-run']);
  eq(j.tool, 'nl-edit');
  eq(j.matchedRule, 'no-zooms');
});
