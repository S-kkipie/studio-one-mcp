import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMidi, noteName, pitchClass } from '../src/theory/notes.js';
import { parseChord, parseProgression, voice } from '../src/theory/chords.js';

test('note names use middle C = C3', () => {
  assert.equal(toMidi('C3'), 60);
  assert.equal(toMidi('Eb4'), 75);
  assert.equal(toMidi('F#2'), 54);
  assert.equal(toMidi('C-2'), 0);
  assert.equal(toMidi(64), 64);
  assert.equal(noteName(60), 'C3');
  assert.equal(noteName(61), 'C#3');
  assert.equal(pitchClass('Bb'), 10);
  assert.throws(() => toMidi('H3'), /bad note "H3"/);
  assert.throws(() => toMidi(128), /0-127/);
  assert.throws(() => toMidi('G9'), /0-127/);
});

test('parseChord: qualities, flats, slash bass, unknown symbol', () => {
  assert.deepEqual(parseChord('C'), { symbol: 'C', root: 0, intervals: [0, 4, 7], bass: null });
  assert.deepEqual(parseChord('Cm7').intervals, [0, 3, 7, 10]);
  assert.deepEqual(parseChord('Bbmaj7'), { symbol: 'Bbmaj7', root: 10, intervals: [0, 4, 7, 11], bass: null });
  assert.deepEqual(parseChord('Ebm7b5').intervals, [0, 3, 6, 10]);
  assert.deepEqual(parseChord('F/A'), { symbol: 'F/A', root: 5, intervals: [0, 4, 7], bass: 9 });
  for (const [s, iv] of [['Gsus4', [0, 5, 7]], ['Dsus2', [0, 2, 7]], ['Bdim', [0, 3, 6]], ['Caug', [0, 4, 8]], ['A6', [0, 4, 7, 9]], ['Am6', [0, 3, 7, 9]],
    ['G7', [0, 4, 7, 10]], ['Bdim7', [0, 3, 6, 9]], ['D9', [0, 4, 7, 10, 14]], ['Fmaj9', [0, 4, 7, 11, 14]], ['Em9', [0, 3, 7, 10, 14]], ['Cadd9', [0, 4, 7, 14]]]) {
    assert.deepEqual(parseChord(s).intervals, iv, s);
  }
  assert.throws(() => parseChord('Cfoo'), /unknown chord symbol "Cfoo"/);
});

test('parseProgression: bars with |, several chords split a bar, no bars = one chord per bar', () => {
  const p = parseProgression('Cm7 | Ab | Eb Bb');
  assert.deepEqual(p.map((x) => [x.chord.symbol, x.beat, x.length]), [['Cm7', 0, 4], ['Ab', 4, 4], ['Eb', 8, 2], ['Bb', 10, 2]]);
  const q = parseProgression('C G Am F', { barsPerChord: 2 });
  assert.deepEqual(q.map((x) => [x.chord.symbol, x.beat, x.length]), [['C', 0, 8], ['G', 8, 8], ['Am', 16, 8], ['F', 24, 8]]);
  assert.throws(() => parseProgression(' | '), /empty progression/);
});

test('voice: close, open, drop2, slash bass below', () => {
  const cm7 = parseChord('Cm7');
  assert.deepEqual(voice(cm7), [60, 63, 67, 70]);
  assert.deepEqual(voice(cm7, { voicing: 'open' }), [60, 67, 70, 75]);
  assert.deepEqual(voice(cm7, { voicing: 'drop2' }), [55, 60, 63, 70]);
  assert.deepEqual(voice(parseChord('F/A')), [57, 65, 69, 72]);
  assert.deepEqual(voice(parseChord('C'), { octave: 4 }), [72, 76, 79]);
  assert.throws(() => voice(cm7, { voicing: 'spread' }), /voicing must be/);
});
