import { test, eq, near, assert } from './harness.mjs';
import {
  parseRanges, normalize, invert, pad, shrink, totalDuration, validate, mapToCut, timecode,
} from '../lib/ranges.mjs';

const pairs = rs => rs.map(r => [r.start, r.end]);

test('parseRanges accepts strings, pairs and objects', () => {
  eq(JSON.stringify(pairs(parseRanges('0-5.2,6.1-13.4'))), '[[0,5.2],[6.1,13.4]]');
  eq(JSON.stringify(pairs(parseRanges([[1, 2], [3, 4]]))), '[[1,2],[3,4]]');
  eq(JSON.stringify(pairs(parseRanges([{ start: 1, end: 2 }]))), '[[1,2]]');
  eq(parseRanges(null).length, 0);
});

test('parseRanges rejects malformed input', () => {
  let threw = false;
  try { parseRanges('nonsense'); } catch { threw = true; }
  assert(threw, 'should reject unparseable range strings');
});

test('normalize sorts, clamps to duration and merges overlaps', () => {
  const r = normalize(parseRanges([[6, 9], [0, 5], [4, 7]]), { duration: 10 });
  eq(JSON.stringify(pairs(r)), '[[0,9]]', 'overlapping ranges merge');

  const clamped = normalize(parseRanges([[8, 20]]), { duration: 10 });
  eq(JSON.stringify(pairs(clamped)), '[[8,10]]', 'clamped to duration');

  const dropped = normalize(parseRanges([[1, 1.05]]), { duration: 10, minDuration: 0.1 });
  eq(dropped.length, 0, 'sub-minimum ranges dropped');
});

test('normalize can merge across a gap', () => {
  const r = normalize(parseRanges([[0, 1], [1.1, 2]]), { gap: 0.2 });
  eq(JSON.stringify(pairs(r)), '[[0,2]]');
  const r2 = normalize(parseRanges([[0, 1], [1.1, 2]]), { gap: 0 });
  eq(r2.length, 2, 'no merge when the gap is too wide');
});

test('invert produces the complement within the source duration', () => {
  eq(JSON.stringify(pairs(invert(parseRanges([[4, 5.5], [10, 11.2]]), 16))),
    '[[0,4],[5.5,10],[11.2,16]]');
  eq(JSON.stringify(pairs(invert(parseRanges([[0, 5]]), 10))), '[[5,10]]', 'leading range');
  eq(JSON.stringify(pairs(invert(parseRanges([[5, 10]]), 10))), '[[0,5]]', 'trailing range');
  eq(invert(parseRanges([[0, 10]]), 10).length, 0, 'removing everything keeps nothing');
});

test('invert of invert returns the original ranges', () => {
  const original = normalize(parseRanges([[2, 4], [7, 9]]), { duration: 12 });
  const round = invert(invert(original, 12), 12);
  eq(JSON.stringify(pairs(round)), JSON.stringify(pairs(original)));
});

test('pad grows ranges and re-merges, shrink pulls them in', () => {
  eq(JSON.stringify(pairs(pad(parseRanges([[5, 6]]), 0.5, 0.5, { duration: 10 }))), '[[4.5,6.5]]');
  eq(JSON.stringify(pairs(pad(parseRanges([[0, 1]]), 2, 0, { duration: 10 }))), '[[0,1]]', 'clamped at zero');
  eq(JSON.stringify(pairs(shrink(parseRanges([[5, 8]]), 0.5, 0.5))), '[[5.5,7.5]]');
  eq(shrink(parseRanges([[5, 5.4]]), 0.3, 0.3).length, 0, 'over-shrunk ranges disappear');
});

test('totalDuration sums segment lengths', () => {
  near(totalDuration(parseRanges([[0, 5.2], [6.1, 13.4]])), 12.5, 1e-9);
});

test('validate catches negative, inverted, overflowing and overlapping ranges', () => {
  eq(validate(parseRanges([[-1, 5]]), { duration: 10 }).length, 1, 'negative start');
  eq(validate(parseRanges([[5, 3]]), { duration: 10 }).length, 1, 'inverted');
  eq(validate(parseRanges([[2, 20]]), { duration: 10 }).length, 1, 'past the end');
  eq(validate(parseRanges([[0, 5], [3, 8]]), { duration: 10 }).length, 1, 'overlap');
  eq(validate(parseRanges([[0, 5], [6, 8]]), { duration: 10 }).length, 0, 'valid input is silent');
});

test('mapToCut translates source time into cut-timeline time', () => {
  const keep = parseRanges([[0, 5], [10, 15]]);
  near(mapToCut(2, keep), 2, 1e-9, 'inside first segment');
  near(mapToCut(12, keep), 7, 1e-9, 'inside second segment, offset by the removed gap');
  near(mapToCut(7, keep), 5, 1e-9, 'inside a removed gap collapses to the cut point');
  near(mapToCut(15, keep), 10, 1e-9, 'end of last segment');
});

test('timecode formats seconds for reasoning logs', () => {
  eq(timecode(4.2), '00:04.20');
  eq(timecode(64.5), '01:04.50');
  eq(timecode(3725.1), '1:02:05.10');
});
