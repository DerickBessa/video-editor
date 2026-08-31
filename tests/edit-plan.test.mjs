import fs from 'node:fs';
import path from 'node:path';
import { test, eq, near, assert, cliOk, cliFails, tmp } from './harness.mjs';
import { fixture } from './fixtures.mjs';
import {
  emptyPlan, normalizePlan, validatePlan, toCutTimeline, activeStages, stageHash,
} from '../lib/edit-plan.mjs';
import { validateEditPlan } from '../tools/validate-edit-plan.mjs';
import { loadStyle, listStyles, MODE_NAMES } from '../lib/styles.mjs';
import { ROOT } from '../lib/paths.mjs';
import { EXIT } from '../lib/errors.mjs';

const SRC = 'tests/fixtures/landscape.mp4';   // 16s, 1280x720
const base = (over = {}) => ({ ...emptyPlan(SRC), ...over });

function writePlan(name, plan) {
  const p = tmp(name);
  fs.writeFileSync(p, JSON.stringify(plan, null, 2));
  return p;
}

/* -------------------------------------------------------------- normalize */

test('normalizePlan derives keep ranges from removals', () => {
  const p = normalizePlan(base({ cuts: { remove: [[4, 6]] } }), { duration: 16 });
  eq(JSON.stringify(p.keepRanges.map(r => [r.start, r.end])), '[[0,4],[6,16]]');
});

test('normalizePlan merges silences and fillers into one removal set', () => {
  const p = normalizePlan(base({
    cuts: { silences: [{ start: 4, end: 6 }], fillers: [{ start: 10, end: 10.5 }] },
  }), { duration: 16 });
  eq(p.keepRanges.length, 3, 'two separate removals leave three kept segments');
  eq(p.removeRanges.length, 2);
});

test('normalizePlan prefers an explicit keep list over removals', () => {
  const p = normalizePlan(base({ cuts: { keep: [[0, 5]], remove: [[1, 2]] } }), { duration: 16 });
  eq(JSON.stringify(p.keepRanges.map(r => [r.start, r.end])), '[[0,5]]');
});

test('normalizePlan keeps everything when no cuts are specified', () => {
  const p = normalizePlan(base(), { duration: 16 });
  eq(JSON.stringify(p.keepRanges.map(r => [r.start, r.end])), '[[0,16]]');
});

/* ------------------------------------------------------ source-time mapping */

test('THE core property: event times are source-time and get remapped by cuts', () => {
  // Remove 4-6s. A zoom at 10-12s in SOURCE time must land at 8-10s in the cut.
  const plan = base({
    cuts: { remove: [[4, 6]] },
    zooms: [{ start: 10, end: 12, scale: 1.1 }],
  });
  const mapped = toCutTimeline(plan, { duration: 16 });
  eq(mapped.zooms.length, 1);
  near(mapped.zooms[0].start, 8, 1e-6, 'a 2s removal before the zoom shifts it 2s earlier');
  near(mapped.zooms[0].end, 10, 1e-6);
  eq(mapped.zooms[0].sourceStart, 10, 'the original time is preserved for reference');
});

test('events inside removed footage are dropped, not slid', () => {
  const plan = base({
    cuts: { remove: [[4, 8]] },
    zooms: [{ start: 5, end: 6, scale: 1.1 }],
    sfx: [{ timestamp: 6.5, sound: 'pop' }],
  });
  const mapped = toCutTimeline(plan, { duration: 16 });
  eq(mapped.zooms.length, 0, 'a zoom inside removed footage cannot survive');
  eq(mapped.sfx.length, 0);
  eq(mapped.dropped.length, 2);
  assert(mapped.dropped.every(d => d.reason.includes('removed')), 'each drop must say why');
});

test('sfx timestamps remap and remember their source time', () => {
  const mapped = toCutTimeline(
    base({ cuts: { remove: [[2, 5]] }, sfx: [{ timestamp: 9, sound: 'pop' }] }),
    { duration: 16 }
  );
  near(mapped.sfx[0].timestamp, 6, 1e-6);
  eq(mapped.sfx[0].sourceTimestamp, 9);
});

test('with no cuts, mapping is the identity', () => {
  const mapped = toCutTimeline(base({ zooms: [{ start: 3, end: 5, scale: 1.1 }] }), { duration: 16 });
  near(mapped.zooms[0].start, 3, 1e-6);
  near(mapped.zooms[0].end, 5, 1e-6);
});

/* ------------------------------------------------------------- validation */

test('a minimal plan validates', () => {
  const { valid, problems } = validatePlan(base(), { duration: 16, root: ROOT, hasAudio: true });
  assert(valid, `expected valid, got: ${problems.join('; ')}`);
});

test('a missing source is a problem', () => {
  const { valid, problems } = validatePlan(base({ source: 'raw/nope.mp4' }), { duration: 16, root: ROOT });
  eq(valid, false);
  assert(problems.some(p => p.includes('source not found')), problems.join('; '));
});

test('cuts that remove everything are rejected', () => {
  const { valid, problems } = validatePlan(base({ cuts: { remove: [[0, 16]] } }), { duration: 16, root: ROOT });
  eq(valid, false);
  assert(problems.some(p => /entire video|only/.test(p)), problems.join('; '));
});

test('zoom problems are all reported at once', () => {
  const { valid, problems } = validatePlan(base({
    zooms: [
      { start: 5, end: 3, scale: 1.1 },      // inverted
      { start: -1, end: 2, scale: 1.1 },     // negative
      { start: 100, end: 102, scale: 1.1 },  // past the end
      { start: 6, end: 8, scale: -2 },       // bad scale
    ],
  }), { duration: 16, root: ROOT });
  eq(valid, false);
  assert(problems.length >= 4, `expected every problem reported, got ${problems.length}: ${problems.join('; ')}`);
});

test('overlapping zooms are rejected', () => {
  const { valid } = validatePlan(base({
    zooms: [{ start: 1, end: 5, scale: 1.1 }, { start: 3, end: 7, scale: 1.2 }],
  }), { duration: 16, root: ROOT });
  eq(valid, false);
});

test('a missing sfx asset is caught BEFORE rendering', () => {
  const { valid, problems } = validatePlan(base({ sfx: [{ timestamp: 2, sound: 'nonexistent-sound' }] }),
    { duration: 16, root: ROOT });
  eq(valid, false);
  assert(problems.some(p => p.includes('sound file not found')), problems.join('; '));
});

test('an output path inside raw/ is rejected', () => {
  const { valid, problems } = validatePlan(base({ output: { path: 'raw/out.mp4' } }), { duration: 16, root: ROOT });
  eq(valid, false);
  assert(problems.some(p => p.includes('raw/')), problems.join('; '));
});

test('captions on a silent source are rejected', () => {
  const { valid, problems } = validatePlan(base({ captions: { enabled: true } }),
    { duration: 16, root: ROOT, hasAudio: false });
  eq(valid, false);
  assert(problems.some(p => p.includes('no audio')), problems.join('; '));
});

test('a nonsense resolution or fps is rejected', () => {
  const a = validatePlan(base({ output: { resolution: 'huge' } }), { duration: 16, root: ROOT });
  const b = validatePlan(base({ output: { fps: 9999 } }), { duration: 16, root: ROOT });
  eq(a.valid, false);
  eq(b.valid, false);
});

test('events destined to be cut away produce a WARNING, not a failure', () => {
  const { valid, warnings } = validatePlan(base({
    cuts: { remove: [[4, 8]] },
    zooms: [{ start: 5, end: 6, scale: 1.1 }],
  }), { duration: 16, root: ROOT, hasAudio: true });
  eq(valid, true, 'this is survivable — the event is simply dropped');
  assert(warnings.some(w => w.includes('removed footage')), warnings.join('; '));
});

/* ----------------------------------------------------------------- stages */

test('activeStages lists only the work that actually exists', () => {
  const p = normalizePlan(base(), { duration: 16 });
  eq(activeStages(p, { sourceDuration: 16 }).length, 0, 'an empty plan has nothing to do');

  const full = normalizePlan(base({
    cuts: { remove: [[4, 6]] },
    crop: { aspect: '9:16', mode: 'static' },
    zooms: [{ start: 1, end: 2, scale: 1.1 }],
    captions: { enabled: true, style: 'clean' },
    audio: { normalize: true },
    sfx: [{ timestamp: 3, sound: 'pop' }],
    speed: [{ rate: 1.25 }],
  }), { duration: 16 });
  const stages = activeStages(full, { sourceDuration: 16 });
  eq(JSON.stringify(stages), JSON.stringify(['cuts', 'speed', 'crop', 'zoom', 'captions', 'audio', 'sfx']),
    'stages must come out in the only correct order');
});

test('a speed of exactly 1 is not a stage', () => {
  const p = normalizePlan(base({ speed: [{ rate: 1 }] }), { duration: 16 });
  assert(!activeStages(p, { sourceDuration: 16 }).includes('speed'));
});

test('stageHash changes with the stage settings and not with unrelated ones', () => {
  const a = normalizePlan(base({ zooms: [{ start: 1, end: 2, scale: 1.1 }] }), { duration: 16 });
  const b = normalizePlan(base({ zooms: [{ start: 1, end: 2, scale: 1.3 }] }), { duration: 16 });
  const c = normalizePlan(base({ zooms: [{ start: 1, end: 2, scale: 1.1 }], audio: { normalize: true } }), { duration: 16 });
  assert(stageHash(a, 'zoom') !== stageHash(b, 'zoom'), 'changing the zoom must invalidate the zoom stage');
  eq(stageHash(a, 'zoom'), stageHash(c, 'zoom'), 'changing the AUDIO must not invalidate the zoom stage');
});

/* ------------------------------------------------------------------ tool */

test('validate-edit-plan accepts a good plan', async () => {
  const p = writePlan('vp-good.json', base({ cuts: { remove: [[4, 6]] }, output: { path: 'output/x.mp4' } }));
  const r = await validateEditPlan(p, {});
  eq(r.valid, true);
  assert(r.stages.includes('cuts'));
  near(r.estimatedDuration, 14, 0.2);
});

test('validate-edit-plan rejects a bad plan with exit 6', async () => {
  const p = writePlan('vp-bad.json', base({ zooms: [{ start: 5, end: 3, scale: 1.1 }] }));
  let code = null;
  try { await validateEditPlan(p, {}); } catch (e) { code = e.code; }
  eq(code, EXIT.VALIDATION);
});

test('--strict turns warnings into failures', async () => {
  const p = writePlan('vp-warn.json', base({
    cuts: { remove: [[4, 8]] }, zooms: [{ start: 5, end: 6, scale: 1.1 }],
  }));
  const lenient = await validateEditPlan(p, {});
  eq(lenient.valid, true);
  eq(lenient.warningCount > 0, true);
  let code = null;
  try { await validateEditPlan(p, { strict: true }); } catch (e) { code = e.code; }
  eq(code, EXIT.VALIDATION);
});

test('malformed JSON gives a readable error', async () => {
  const p = tmp('vp-broken.json');
  fs.writeFileSync(p, '{ this is not json');
  let msg = '';
  try { await validateEditPlan(p, {}); } catch (e) { msg = e.message; }
  assert(/not valid JSON/i.test(msg), `expected a JSON error, got: ${msg}`);
});

test('CLI round-trip returns JSON and exits 0', async () => {
  const p = writePlan('vp-cli.json', base({ cuts: { remove: [[4, 6]] } }));
  const j = await cliOk('validate-edit-plan.mjs', [p]);
  eq(j.tool, 'validate-edit-plan');
  eq(j.valid, true);
});

/* ----------------------------------------------------------------- styles */

test('every built-in style loads and is coherent', () => {
  for (const name of MODE_NAMES) {
    const s = loadStyle(name);
    assert(s, `style ${name} failed to load`);
    assert(s.description, `style ${name} has no description`);
    if (s.captions?.enabled) assert(s.captions.style, `style ${name} enables captions but names no style`);
    if (s.crop) assert(['static', 'smart', 'contain'].includes(s.crop.mode), `style ${name} has an invalid crop mode`);
  }
});

test('the coding style does not crop screen content away', () => {
  // Cropping a screen recording to 9:16 makes code unreadable; contain is right.
  eq(loadStyle('coding').crop.mode, 'contain');
});

test('the podcast style is the one that tracks a speaker', () => {
  eq(loadStyle('podcast').crop.mode, 'smart');
});

test('viral trims harder than clean', () => {
  const { INTENSITY } = { INTENSITY: { soft: 3, normal: 2, aggressive: 1 } };
  const rank = i => INTENSITY[i];
  assert(rank(loadStyle('viral').silence.intensity) < rank(loadStyle('clean').silence.intensity),
    'viral should use a more aggressive silence setting than clean');
});

test('an unknown style is rejected by the loader', () => {
  eq(loadStyle('does-not-exist'), null);
  assert(listStyles().length >= MODE_NAMES.length);
});
