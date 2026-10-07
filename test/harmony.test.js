// Chord track flows over a fake bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listChords, setChords, extractChords, partsFromChords, clearChords } from '../src/harmony.js';

function bridge({ playing = false, recording = false, removed = [], chordsAfter, removeExecuted = true, extractExecuted = true, partsExecuted = true, trackTaskError, notes } = {}) {
  const log = [];
  let added = false;
  let notesCalls = 0;
  const call = async (op, a = {}) => {
    log.push(op === 'command' ? `command ${a.category}/${a.name}` : op === 'trackTask' ? `trackTask ${a.ops[0].op}` : op);
    switch (op) {
      case 'song': return { transport: { playing, recording, position: { seconds: 0 } }, selectedTracks: ['Vox'] };
      case 'setTransport': return a.positionBars ? { position: { seconds: (parseInt(a.positionBars, 10) - 1) * 2 } } : {};
      case 'tracks': return added ? [{ name: 'Vox' }, { name: 'Pista 2' }] : [{ name: 'Vox' }];
      case 'addTrack': added = true; return {};
      case 'selectEvents': case 'selectTrack': return {};
      case 'command':
        if (a.name === 'Remove Track') return { executed: removeExecuted };
        if (a.name === 'Extract to Chord Track') return { executed: extractExecuted };
        return { executed: partsExecuted };
      case 'notes': return { parts: notes[Math.min(notesCalls++, notes.length - 1)] };
      case 'trackTask': {
        const op0 = a.ops[0];
        if (trackTaskError) return { results: [{ error: trackTaskError }] };
        if (op0.op === 'removeChords') return { results: [{ removed }] };
        if (op0.op === 'chords') return { results: [{ chords: (chordsAfter || []).map((n, i) => ({ name: n, start: 4 + i * 2, end: 6 + i * 2 })) }] };
        return { results: [{}] };
      }
      default: throw new Error(`unexpected ${op}`);
    }
  };
  return { call, log };
}

const deps = (log, { writeFails = false } = {}) => ({
  createPart: async () => { log.push('createPart'); return { undoSteps: 2 }; },
  writeChords: async () => { log.push('writeChords'); if (writeFails) throw new Error('boom'); return {}; },
});

test('setChords: happy path runs the ops in order and restores the selection', async () => {
  const b = bridge({ chordsAfter: ['G', 'D', 'Em', 'C'] });
  const r = await setChords(b.call, { bar: 3, progression: 'G D Em C' }, deps(b.log));
  const ops = b.log.filter((o) => !['song', 'setTransport', 'tracks'].includes(o));
  assert.deepEqual(ops, [
    'trackTask removeChords', 'addTrack', 'createPart', 'writeChords', 'selectEvents', 'command Event/Extract to Chord Track',
    'selectTrack', 'command Song/Remove Track', 'selectEvents', 'selectTrack', 'trackTask chords',
  ]);
  assert.deepEqual(r.written, ['G', 'D', 'Em', 'C']);
  assert.equal(r.mismatches, undefined);
  assert.equal(r.warnings, undefined);
  assert.equal(r.chords.length, 4);
});

test('setChords: writeChords throwing still removes the scratch track and propagates', async () => {
  const b = bridge();
  await assert.rejects(setChords(b.call, { bar: 3, progression: 'G D' }, deps(b.log, { writeFails: true })), /boom/);
  assert.ok(b.log.includes('command Song/Remove Track'));
});

test('setChords: a failed Remove Track becomes a warning naming the scratch track', async () => {
  const b = bridge({ chordsAfter: ['G'], removeExecuted: false });
  const r = await setChords(b.call, { bar: 3, progression: 'G' }, deps(b.log));
  assert.match(r.warnings.join('\n'), /Pista 2/);
});

test('setChords: a removed event reaching outside the range warns', async () => {
  const b = bridge({ chordsAfter: ['G'], removed: [{ name: 'C', start: 0, end: 10 }] });
  const r = await setChords(b.call, { bar: 3, progression: 'G' }, deps(b.log));
  assert.match(r.warnings[0], /chord C at 0s extended outside the range and was removed whole/);
  assert.equal(r.removed.length, 1);
});

test('setChords: CM7 for Cmaj7 is not a mismatch, Am for A is', async () => {
  let b = bridge({ chordsAfter: ['CM7'] });
  let r = await setChords(b.call, { bar: 3, progression: 'Cmaj7' }, deps(b.log));
  assert.equal(r.mismatches, undefined);
  b = bridge({ chordsAfter: ['Am'] });
  r = await setChords(b.call, { bar: 3, progression: 'A' }, deps(b.log));
  assert.deepEqual(r.mismatches, [{ requested: 'A', got: 'Am' }]);
  b = bridge({ chordsAfter: ['A'] });
  r = await setChords(b.call, { bar: 3, progression: 'A D' }, deps(b.log));
  assert.deepEqual(r.mismatches, [{ requested: 2, got: 1 }]);
});

test('setChords: refuses while playing, before adding a track', async () => {
  const b = bridge({ playing: true });
  await assert.rejects(setChords(b.call, { bar: 1, progression: 'C' }, deps(b.log)), /stop playback first/);
  assert.ok(!b.log.includes('addTrack'));
});

test('extractChords: executed:false gives the error', async () => {
  const b = bridge({ extractExecuted: false });
  await assert.rejects(extractChords(b.call, { track: 'Gtr' }), /nothing to extract from on Gtr/);
});

test('extractChords returns the chord track', async () => {
  const b = bridge({ chordsAfter: ['Am', 'F'] });
  const r = await extractChords(b.call, { track: 'Gtr' });
  assert.deepEqual(r.chords.map((c) => c.chord), ['Am', 'F']);
});

test('partsFromChords returns only the new parts', async () => {
  const old = { name: 'old', start: 0, end: 2, notes: [{ note: 60 }] };
  const b = bridge({ notes: [[old], [old, { name: 'G', start: 4, end: 6, notes: [{ note: 55 }, { note: 59 }] }]] });
  const r = await partsFromChords(b.call, { track: 'Keys' });
  assert.deepEqual(r.parts, [{ name: 'G', start: 4, end: 6, notes: [55, 59] }]);
});

test('partsFromChords: executed:false gives the error', async () => {
  const b = bridge({ partsExecuted: false, notes: [[]] });
  await assert.rejects(partsFromChords(b.call, { track: 'Keys' }), /could not insert parts on Keys/);
});

test('listChords propagates the track task error', async () => {
  const b = bridge({ trackTaskError: 'the chord track is not available' });
  await assert.rejects(listChords(b.call, {}), /the chord track is not available/);
});

test('clearChords converts bars and returns removed', async () => {
  const b = bridge({ removed: [{ name: 'G', start: 4, end: 6 }] });
  const r = await clearChords(b.call, { from: '3.1.1.0' });
  assert.equal(r.removed.length, 1);
});
