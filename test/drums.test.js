import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rhythmize } from '../src/theory/rhythm.js';
import { drumGrid, GM_DRUMS } from '../src/theory/drums.js';

const rows = (notes) => notes.map((n) => [n.pitch, n.beat, n.length, n.velocity]);

test('rhythmize: sustain, quarters, eighths, arpeggios', () => {
  assert.deepEqual(rows(rhythmize([60, 64], { rhythm: 'sustain', beats: 4 })), [[60, 0, 4, 90], [64, 0, 4, 90]]);
  assert.equal(rhythmize([60, 64], { rhythm: 'quarters', beats: 4 }).length, 8);
  assert.deepEqual(rows(rhythmize([60], { rhythm: 'eighths', beats: 1, velocity: 70 })), [[60, 0, 0.5, 70], [60, 0.5, 0.5, 70]]);
  assert.deepEqual(rhythmize([60, 64, 67], { rhythm: 'arp_up', beats: 2 }).map((n) => n.pitch), [60, 64, 67, 60]);
  assert.deepEqual(rhythmize([60, 64, 67], { rhythm: 'arp_down', beats: 2 }).map((n) => n.pitch), [67, 64, 60, 67]);
  assert.throws(() => rhythmize([60], { rhythm: 'swing', beats: 4 }), /rhythm must be/);
  assert.throws(() => rhythmize([60], { rhythm: 'toString', beats: 4 }), /rhythm must be/);
});

test('drumGrid: GM lanes, accents, spaces and bars repeat', () => {
  const n = drumGrid({ kick: 'x... x...', snare: '..X.' }, { bars: 2 });
  // kick "x... x..." = 8 steps (2 beats) cycling: a hit every beat → 8 over 2 bars;
  // snare "..X." = 4 steps (1 beat) cycling: 4 per bar → 8, all accented.
  assert.equal(n.filter((x) => x.pitch === 36).length, 8);
  assert.equal(n.filter((x) => x.pitch === 38).length, 8);
  assert.deepEqual(rows(n.filter((x) => x.pitch === 36)).map((r) => r[1]), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(rows(n.filter((x) => x.pitch === 36))[0], [36, 0, 0.25, 100]);
  assert.ok(n.filter((x) => x.pitch === 38).every((x) => x.velocity === 120));
  assert.equal(n[n.length - 1].beat < 8, true);
});

test('drumGrid: lane by MIDI number, | separators, errors', () => {
  assert.deepEqual(rows(drumGrid({ 37: 'x...|....|....|....' })), [[37, 0, 0.25, 100]]);
  assert.equal(GM_DRUMS.closed_hat, 42);
  assert.throws(() => drumGrid({ cowbell2: 'x' }), /unknown drum lane "cowbell2" \(known: .*kick/);
  assert.throws(() => drumGrid({ kick: 'x.o.' }), /use x, X or \./);
  assert.throws(() => drumGrid({}), /at least one lane/);
  assert.throws(() => drumGrid({ constructor: 'x' }), /unknown drum lane "constructor"/);
});
