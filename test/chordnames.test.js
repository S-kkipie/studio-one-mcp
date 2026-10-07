import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_NAMES, fifthsToPitchClass, parseIntervalsMask, chordName } from '../src/theory/chordnames.js';

test('fifths index to pitch class', () => {
  assert.deepEqual([0, 1, 2, 4, -1].map(fifthsToPitchClass), [0, 7, 2, 4, 5]);
});

test('interval mask parse', () => {
  assert.deepEqual(parseIntervalsMask('FF 0 0 FF 0 0 0 FF 0 0 0 0'), [0, 3, 7]);
});

test('chord names from the table, unknown sets and slash bass', () => {
  const table = {
    '': [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7],
    6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
    m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9], add9: [0, 2, 4, 7], madd9: [0, 2, 3, 7],
    9: [0, 2, 4, 7, 10], maj9: [0, 2, 4, 7, 11], m9: [0, 2, 3, 7, 10],
  };
  for (const [q, iv] of Object.entries(table)) assert.equal(chordName(7, iv), `G${q}`);
  assert.equal(chordName(0, [0, 1, 6]), 'C(0,1,6)');
  assert.equal(chordName(0, [0, 4, 7], 4), 'C/E');
  assert.equal(chordName(0, [0, 4, 7], 0), 'C');
  assert.equal(NOTE_NAMES.length, 12);
});
