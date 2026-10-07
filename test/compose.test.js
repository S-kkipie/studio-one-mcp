// Composition over a fake bridge: 120 bpm 4/4, so bar n starts at (n-1)*2 seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPart, writeNotes, writeChords, writeDrums, emptyPartAdd } from '../src/compose.js';

function bridge({ noResize = false, parts = [], insertWorks = true, loopStart = 10, loopEnd = 20, insertAt = null } = {}) {
  const state = { loop: false, loopStart, loopEnd, position: 3, selected: ['Vox'], parts: parts.map((p) => ({ ...p })) };
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
        // like Studio One: a start beyond the current end, or an end before the current start, is refused
        if (typeof args.start === 'number') { if (args.start > state.loopEnd) throw new Error('start beyond end'); state.loopStart = args.start; }
        if (typeof args.end === 'number') { if (args.end < state.loopStart) throw new Error('end before start'); state.loopEnd = args.end; }
        if (typeof args.enable === 'boolean') state.loop = args.enable;
        return {};
      case 'selectTrack': state.selected = args.exclusive === false ? [...state.selected, args.name] : [args.name]; return { selected: state.selected };
      case 'command':
        // the part lands at the playhead, one bar (2 s) long; insertAt forces another spot
        if (args.name === 'Insert Instrument Part' && insertWorks) {
          const at = insertAt ? insertAt[0] : state.position;
          state.parts.push({ name: 'P', start: at, end: insertAt ? insertAt[1] : at + 2, noteCount: 0 });
        }
        return { executed: insertWorks };
      case 'notes': return { track: args.track, parts: state.parts };
      case 'trackTask': {
        const o = args.ops[0];
        if (o.op === 'events') return { results: [{ op: 'events', events: state.parts.map((p, i) => ({ number: i + 1, name: p.name, start: p.start, end: p.end })) }] };
        if (o.op === 'editEvent') {
          const p = state.parts[o.event - 1];
          const done = [];
          if (typeof o.to === 'number') { const len = p.end - p.start; p.start = o.to; p.end = o.to + len; done.push('move'); }
          if (typeof o.end === 'number' && !noResize) { p.end = o.end; done.push('resize'); }
          return { results: [{ op: 'editEvent', done }] };
        }
        return { results: [{ op: o.op, track: o.track, part: 'P', added: o.notes.length, errors: [] }] };
      }
      default: throw new Error(`unexpected ${op}`);
    }
  };
  return { call, calls, state };
}

test('createPart: playhead to the bar, insert, resize, restore playhead and selection; no move when it lands at start', async () => {
  const b = bridge();
  const r = await createPart(b.call, { track: 'Keys', bar: 3, bars: 2 });
  assert.deepEqual(r, { track: 'Keys', part: { start: 4, end: 8 } });
  assert.deepEqual(b.state.parts.map((p) => [p.start, p.end]), [[4, 8]]);
  assert.equal(b.state.position, 3);
  assert.deepEqual(b.state.selected, ['Vox']);
  assert.deepEqual([b.state.loopStart, b.state.loopEnd, b.state.loop], [10, 20, false]);
  const edits = b.calls.filter(([op, a]) => op === 'trackTask' && a.ops[0].op === 'editEvent').map(([, a]) => a.ops[0]);
  assert.deepEqual(edits, [{ op: 'editEvent', track: 'Keys', event: 1, end: 8 }]);
});

test('createPart: a one-bar part at the playhead needs no edit at all', async () => {
  const b = bridge();
  await createPart(b.call, { track: 'Keys', bar: 3 });
  assert.ok(!b.calls.some(([op, a]) => op === 'trackTask' && a.ops[0].op === 'editEvent'));
});

test('createPart: if the part lands elsewhere it is moved and resized; other parts untouched', async () => {
  const b = bridge({ insertAt: [7, 9], parts: [{ name: 'Old', start: 0, end: 2, noteCount: 4 }] });
  await createPart(b.call, { track: 'Keys', bar: 5, bars: 1 });
  assert.deepEqual(b.state.parts.map((p) => [p.name, p.start, p.end]).sort(), [['Old', 0, 2], ['P', 8, 10]]);
});

test('createPart fails loudly when an old device does not resize', async () => {
  const b = bridge({ noResize: true });
  await assert.rejects(createPart(b.call, { track: 'Keys', bar: 1, bars: 4 }), /did not resize the new part/);
});

test('createPart restores playhead and selection even when the insert fails, and edits nothing', async () => {
  const b = bridge({ insertWorks: false });
  await assert.rejects(createPart(b.call, { track: 'Keys', bar: 1 }), /could not insert an instrument part/);
  assert.deepEqual(b.state.selected, ['Vox']);
  assert.equal(b.state.position, 3);
  assert.ok(!b.calls.some(([op, a]) => op === 'trackTask' && a.ops[0].op === 'editEvent'));
});

test('writeNotes: creates a part covering every note (rounded up to whole bars), names → MIDI', async () => {
  const b = bridge();
  const r = await writeNotes(b.call, { track: 'Keys', bar: 2, notes: [{ pitch: 'C3', beat: 0, length: 4 }, { pitch: 64, beat: 3, length: 2 }] });
  assert.equal(r.createdPart, true);
  assert.equal(r.added, 2);
  assert.deepEqual(b.state.parts.map((p) => [p.start, p.end]), [[2, 6]]); // bar 2 → 2 s; 5 beats → 2 bars → 4 s
  const task = b.calls.find(([op, a]) => op === 'trackTask' && a.ops[0].op === 'addNotes')[1].ops[0];
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
  const notes = b.calls.find(([op, a]) => op === 'trackTask' && a.ops[0].op === 'addNotes')[1].ops[0].notes;
  assert.deepEqual(notes.map((n) => [n.pitch, n.beat, n.length]), [[60, 0, 4], [63, 0, 4], [67, 0, 4], [68, 4, 4], [72, 4, 4], [75, 4, 4]]);
});

test('writeDrums: grid over bars', async () => {
  const b = bridge();
  const r = await writeDrums(b.call, { track: 'Drums', bar: 1, bars: 2, pattern: { kick: 'x...x...x...x...', snare: '....x.......x...' } });
  assert.equal(r.added, 12);
  assert.deepEqual(b.state.parts.map((p) => [p.start, p.end]), [[0, 4]]);
});

test('writeNotes validates notes before moving the playhead', async () => {
  const b = bridge();
  await assert.rejects(writeNotes(b.call, { track: 'Keys', bar: 1, notes: [{ pitch: 60, beat: 0, length: 1 }, { pitch: 60, beat: -1, length: 1 }] }), /note 2: beat must be >= 0/);
  await assert.rejects(writeNotes(b.call, { track: 'Keys', bar: 1, notes: [{ pitch: 60, beat: 0, length: 0 }] }), /note 1: length must be > 0 beats/);
  assert.equal(b.calls.length, 0);
});

test('emptyPartAdd: single part at bar 1', () => {
  const r = emptyPartAdd([{ start: 0, startBeat: 0, endBeat: 4 }], [{ pitch: 60, beat: 1, length: 1 }]);
  assert.deepEqual(r, { at: 0, notes: [{ pitch: 60, beat: 1, length: 1 }] });
});
test('emptyPartAdd: picks the part covering the first note and rebases', () => {
  const parts = [{ start: 0, startBeat: 0, endBeat: 4 }, { start: 4, startBeat: 8, endBeat: 12 }];
  const r = emptyPartAdd(parts, [{ pitch: 60, beat: 9, length: 1 }, { pitch: 64, beat: 10, length: 1 }]);
  assert.equal(r.at, 4);
  assert.deepEqual(r.notes.map((n) => n.beat), [1, 2]);
});
test('emptyPartAdd: missing positions throw', () => {
  assert.throws(() => emptyPartAdd([{ start: 0, startBeat: null, endBeat: null }], [{ pitch: 60, beat: 0, length: 1 }]), /did not report part positions/);
});
test('emptyPartAdd: note beyond every part throws', () => {
  assert.throws(() => emptyPartAdd([{ start: 0, startBeat: 0, endBeat: 4 }], [{ pitch: 60, beat: 6, length: 1 }]), /no part covers beat 6/);
});
