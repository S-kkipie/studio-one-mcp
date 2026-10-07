// Composition over a fake bridge: 120 bpm 4/4, so bar n starts at (n-1)*2 seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPart, writeNotes, writeChords, writeDrums } from '../src/compose.js';

function bridge({ parts = [], insertWorks = true } = {}) {
  const state = { loop: false, loopStart: 10, loopEnd: 20, position: 3, selected: ['Vox'], parts: parts.map((p) => ({ ...p })) };
  const calls = [];
  const barSeconds = (bars) => { const [b, beat = 1] = bars.split('.').map(Number); return (b - 1) * 2 + (beat - 1) * 0.5; };
  const call = async (op, args = {}) => {
    calls.push([op, args]);
    switch (op) {
      case 'song': return { selectedTracks: [...state.selected], transport: { playing: false, loop: state.loop, position: { seconds: state.position }, loopRange: { start: { seconds: state.loopStart }, end: { seconds: state.loopEnd } } } };
      case 'setTransport':
        if (args.positionBars) state.position = barSeconds(args.positionBars);
        if (typeof args.positionSeconds === 'number') state.position = args.positionSeconds;
        return { position: { seconds: state.position } };
      case 'setLoop':
        if (typeof args.start === 'number') state.loopStart = args.start;
        if (typeof args.end === 'number') state.loopEnd = args.end;
        if (typeof args.enable === 'boolean') state.loop = args.enable;
        return {};
      case 'selectTrack': state.selected = args.exclusive === false ? [...state.selected, args.name] : [args.name]; return { selected: state.selected };
      case 'command':
        if (args.name === 'Insert Instrument Part' && insertWorks) state.parts.push({ name: 'P', start: state.loopStart, end: state.loopEnd, noteCount: 0 });
        return { executed: insertWorks };
      case 'notes': return { track: args.track, parts: state.parts };
      case 'trackTask': {
        const o = args.ops[0];
        return { results: [{ op: o.op, track: o.track, part: 'P', added: o.notes.length, errors: [] }] };
      }
      default: throw new Error(`unexpected ${op}`);
    }
  };
  return { call, calls, state };
}

test('createPart: loop to the bar range, insert, restore loop and selection', async () => {
  const b = bridge();
  const r = await createPart(b.call, { track: 'Keys', bar: 3, bars: 2 });
  assert.deepEqual(r, { track: 'Keys', part: { start: 4, end: 8 } });
  assert.deepEqual([b.state.loopStart, b.state.loopEnd, b.state.loop], [10, 20, false]);
  assert.deepEqual(b.state.selected, ['Vox']);
  assert.ok(b.calls.some(([op, a]) => op === 'command' && a.category === 'Instrument Parts' && a.name === 'Insert Instrument Part'));
});

test('createPart restores the loop even when the insert fails', async () => {
  const b = bridge({ insertWorks: false });
  await assert.rejects(createPart(b.call, { track: 'Keys', bar: 1 }), /could not insert an instrument part/);
  assert.deepEqual([b.state.loopStart, b.state.loopEnd, b.state.loop], [10, 20, false]);
  assert.deepEqual(b.state.selected, ['Vox']);
});

test('writeNotes: creates a part covering every note (rounded up to whole bars), names → MIDI', async () => {
  const b = bridge();
  const r = await writeNotes(b.call, { track: 'Keys', bar: 2, notes: [{ pitch: 'C3', beat: 0, length: 4 }, { pitch: 64, beat: 3, length: 2 }] });
  assert.equal(r.createdPart, true);
  assert.equal(r.added, 2);
  assert.deepEqual(b.state.parts.map((p) => [p.start, p.end]), [[2, 6]]); // bar 2 → 2 s; 5 beats → 2 bars → 4 s
  const task = b.calls.find(([op]) => op === 'trackTask')[1].ops[0];
  assert.deepEqual(task, { op: 'addNotes', track: 'Keys', at: 2, notes: [{ pitch: 60, beat: 0, length: 4, velocity: 100 }, { pitch: 64, beat: 3, length: 2, velocity: 100 }] });
});

test('writeNotes: reuses a part that covers the range; refuses when createPart is false and none does', async () => {
  const b = bridge({ parts: [{ name: 'P', start: 0, end: 8, noteCount: 3 }] });
  assert.equal((await writeNotes(b.call, { track: 'Keys', bar: 2, notes: [{ pitch: 60, beat: 0, length: 1 }] })).createdPart, false);
  const c = bridge();
  await assert.rejects(writeNotes(c.call, { track: 'Keys', bar: 2, notes: [{ pitch: 60, beat: 0, length: 1 }], createPart: false }), /no part covers bar 2/);
  await assert.rejects(writeNotes(c.call, { track: 'Keys', bar: 0, notes: [{ pitch: 60, beat: 0, length: 1 }] }), /bar must be an integer >= 1/);
  await assert.rejects(writeNotes(c.call, { track: 'Keys', bar: 1, notes: [] }), /notes: one or more/);
});

test('writeChords: progression → voiced, rhythmized notes at song beats', async () => {
  const b = bridge();
  const r = await writeChords(b.call, { track: 'Keys', bar: 1, progression: 'Cm | Ab' });
  assert.deepEqual(r.chords, ['Cm', 'Ab']);
  const notes = b.calls.find(([op]) => op === 'trackTask')[1].ops[0].notes;
  assert.deepEqual(notes.map((n) => [n.pitch, n.beat, n.length]), [[60, 0, 4], [63, 0, 4], [67, 0, 4], [68, 4, 4], [72, 4, 4], [75, 4, 4]]);
});

test('writeDrums: grid over bars', async () => {
  const b = bridge();
  const r = await writeDrums(b.call, { track: 'Drums', bar: 1, bars: 2, pattern: { kick: 'x...x...x...x...', snare: '....x.......x...' } });
  assert.equal(r.added, 12);
  assert.deepEqual(b.state.parts.map((p) => [p.start, p.end]), [[0, 4]]);
});
