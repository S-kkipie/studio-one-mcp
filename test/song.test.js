import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSong, summarizeSong, readChords, readKeySignatures } from '../src/song.js';
import { parseXml } from '../src/xml.js';
import { fixture, mediaPath } from './helpers/fixtures.js';

test('tempo, time signature and metadata', () => {
  const s = readSong(fixture());
  assert.equal(s.title, 'Fixture Song');
  assert.deepEqual(s.tempo.map((t) => t.bpm), [120, 60]);
  assert.deepEqual(s.timeSignatures.map((t) => t.signature), ['4/4', '3/4']);
  assert.equal(s.key, null);
});

test('markers convert beats to bars and seconds', () => {
  const s = readSong(fixture());
  assert.deepEqual(s.markers.map((m) => [m.name, m.bar, m.beat, m.seconds]), [
    ['Start', 1, 1, 0],
    ['Chorus', 5, 1, 8],
  ]);
});

test('takes: active layer drives track events; positions cross tempo and meter changes', () => {
  const [vox] = readSong(fixture()).tracks;
  assert.equal(vox.name, 'Vox');
  assert.deepEqual(vox.layers.map((l) => [l.name, l.active]), [['Vox Take 1', false], ['Vox Take 2', true]]);
  const [ev] = vox.events;
  assert.equal(ev.name, 'take2');
  // beat 34 = 32 beats at 0.5s (16s) + 2 beats at 1s → 18s; bar 9 is at beat 32 so this is bar 9 beat 3.
  assert.deepEqual([ev.start.bar, ev.start.beat, ev.start.seconds, ev.lengthSeconds], [9, 3, 18, 3]);
  assert.equal(ev.file, mediaPath('Vox 2.wav'));
  assert.equal(vox.layers[0].events[0].file, mediaPath('Vox 1.wav'), 'file URLs are decoded');
});

test('mixer: dB, pan, mute, inserts without rack state entries', () => {
  const s = readSong(fixture());
  const vox = s.mixer.find((c) => c.label === 'Vox');
  assert.equal(vox.volumeDb, -6.02);
  assert.equal(vox.pan, -0.5);
  assert.equal(vox.mute, true);
  assert.deepEqual(vox.inserts.map((i) => i.name), ['Pro EQ']);
  assert.equal(s.tracks[0].mixer.output, 'Main');
});

test('transport positions are seconds', () => {
  const { transport } = readSong(fixture());
  assert.deepEqual([transport.position.seconds, transport.position.beats, transport.position.bar], [20, 36, 10]);
  assert.equal(transport.loop.end.beats, 8);
  assert.equal(transport.loop.active, true);
});

test('summary is compact', () => {
  const sum = summarizeSong(readSong(fixture()));
  assert.deepEqual(sum.tracks, [{ name: 'Vox', type: 'Audio', events: 1, notes: undefined, automation: undefined, takes: 2, activeTake: 'Vox Take 2', volumeDb: -6.02, mute: true, solo: undefined, inserts: ['Pro EQ'] }]);
  assert.deepEqual(sum.markers, ['Start @ bar 1', 'Chorus @ bar 5']);
});

test('instrument part notes from the clip performance (UBJSON), placed by the part offset', () => {
  const s = readSong(fixture({ extras: true }));
  const part = s.tracks.find((t) => t.name === 'Keys').events[0];
  assert.deepEqual(part.notes.map((n) => [n.pitch, n.velocity, n.start.beats, n.start.seconds, n.lengthBeats]), [
    [60, 102, 4.5, 2.25, 0.5],
    [64, 127, 6, 3, 1],
  ]);
  assert.ok(!('performance' in s.media.find((m) => m.id === '{CLIP-M}')), 'raw performance not echoed in media');
  assert.equal(summarizeSong(s).tracks.find((t) => t.name === 'Keys').notes, 2);
});

test('song notes and channel notes (empty ones left out), also in the summary', () => {
  const s = readSong(fixture({ extras: true }));
  assert.equal(s.notes, 'Verse 1: keep the breath before the chorus');
  assert.deepEqual(s.channelNotes, [{ channel: 'Vox', text: 'Take 2 is the keeper' }]);
  const sum = summarizeSong(s);
  assert.equal(sum.notes, 'Verse 1: keep the breath before the chorus');
  assert.deepEqual(sum.channelNotes, ['Vox: Take 2 is the keeper']);
  const plain = readSong(fixture());
  assert.deepEqual([plain.notes, plain.channelNotes, summarizeSong(plain).notes], ['', [], undefined]);
});

test('insert settings from the saved preset; automation mode and envelopes with points', () => {
  const s = readSong(fixture({ extras: true }));
  const vox = s.mixer.find((c) => c.label === 'Vox');
  assert.deepEqual(vox.inserts[0].settings, { format: 'fxpreset', values: { lffreq: 40, lfgain: -3.5 } });
  assert.equal(vox.automation, 'read');
  assert.deepEqual(s.automation, [{ channel: 'Vox', parameter: 'Volume', bipolar: false, points: [{ time: 0, value: 0.5 }, { time: 8, value: 1 }] }]);
  const sum = summarizeSong(s);
  assert.deepEqual(sum.automation, ['Vox/Volume: 2 points']);
  assert.equal(sum.tracks.find((t) => t.name === 'Vox').automation, 'read');
});

test('chord track and key signatures from the saved song', () => {
  const s = readSong(fixture({ harmony: true }));
  assert.deepEqual(s.chords.map((c) => [c.chord, c.startBeat, c.lengthBeats, c.bar]), [['Cm', 0, 4, 1], ['G', 4, 4, 2]]);
  assert.deepEqual(s.chords.map((c) => c.label), [undefined, 'G7'], 'event name is a label, not the chord');
  assert.deepEqual(s.keySignatures, [{ root: 'C', scale: '', startBeat: 0 }]);
  assert.ok(!s.tracks.some((t) => t.type === 'ChordTrack'));
  const sum = summarizeSong(s);
  assert.deepEqual(sum.chords, ['Cm @ bar 1', 'G @ bar 2']);
  assert.deepEqual(sum.keySignatures, s.keySignatures);
});

test('no chord track gives empty chords and key signatures', () => {
  const s = readSong(fixture());
  assert.deepEqual([s.chords, s.keySignatures], [[], []]);
});

test('offline chords: non-beat timeFormat and malformed roots are skipped; chordsTotal when truncated', () => {
  const ev = (attrs, root) => `<ChordEvent ${attrs} length="4"><Attributes x:id="chord" root="${root}" intervals="FF 0 0 0 FF 0 0 FF 0 0 0 0"/></ChordEvent>`;
  const node = parseXml(`<ChordTrack>${ev('timeFormat="0" start="1"', 0)}${ev('timeFormat="2" start="4"', 'x')}${ev('start="8"', 1)}</ChordTrack>`);
  const chords = readChords(node, { at: () => ({ bar: 1 }) });
  assert.deepEqual(chords.map((c) => [c.chord, c.startBeat]), [['G', 8]]);
  const keys = readKeySignatures(parseXml('<Song><KeySignatureMap x:id="keySignatureMap"><Attributes root="zz" start="0"/><Attributes root="1" start="4"/></KeySignatureMap></Song>'));
  assert.deepEqual(keys.map((k) => k.root), ['G']);
  const s = readSong(fixture({ harmony: true }));
  s.chords = Array.from({ length: 70 }, (_, i) => ({ chord: 'C', bar: i + 1 }));
  const sum = summarizeSong(s);
  assert.deepEqual([sum.chords.length, sum.chordsTotal], [64, 70]);
  assert.equal(summarizeSong(readSong(fixture({ harmony: true }))).chordsTotal, undefined);
});
