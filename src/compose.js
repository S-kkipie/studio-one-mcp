// Composition in the running Studio One: make instrument parts and write notes,
// chord progressions and drum grids into them. Notes go through the MCP Track
// Edit task's addNotes op, which also works on an empty part. Beat math assumes
// 4/4; bar positions are turned into seconds by Studio One itself.
import { trackTask } from './tracks.js';
import { toMidi } from './theory/notes.js';
import { parseProgression, voice } from './theory/chords.js';
import { rhythmize } from './theory/rhythm.js';
import { drumGrid } from './theory/drums.js';

const BEATS_PER_BAR = 4;
const EPS = 0.001;

function checkBar(bar) {
  if (!Number.isInteger(bar) || bar < 1) throw new Error('bar must be an integer >= 1');
}

// Seconds of the start of each bar, through the playhead (restored afterwards).
async function barSeconds(call, bars) {
  const { transport } = await call('song');
  if (transport.playing) throw new Error('stop playback first: bars are converted by moving the playhead');
  const out = [];
  try {
    for (const b of bars) out.push((await call('setTransport', { positionBars: `${b}.1.1.0` })).position.seconds);
  } finally {
    await call('setTransport', { positionSeconds: transport.position.seconds });
  }
  return out;
}

async function restoreSelection(call, names) {
  for (const [i, name] of names.entries()) await call('selectTrack', { name, exclusive: i === 0 }).catch(() => {});
}

export async function createPart(call, { track, bar, bars = 1 }) {
  checkBar(bar);
  if (!Number.isInteger(bars) || bars < 1) throw new Error('bars must be an integer >= 1');
  const [start, end] = await barSeconds(call, [bar, bar + bars]);
  const { transport, selectedTracks } = await call('song');
  const loop = { start: transport.loopRange.start.seconds, end: transport.loopRange.end.seconds, enable: !!transport.loop };
  let r;
  try {
    await call('setLoop', { start, end });
    await call('selectTrack', { name: track });
    r = await call('command', { category: 'Instrument Parts', name: 'Insert Instrument Part' });
  } finally {
    await call('setLoop', loop);
    await restoreSelection(call, selectedTracks);
  }
  if (!r || !r.executed) throw new Error(`could not insert an instrument part on ${track} (is it an instrument track?)`);
  return { track, part: { start, end } };
}

export async function writeNotes(call, { track, bar, notes, createPart: create = true }) {
  checkBar(bar);
  if (!Array.isArray(notes) || !notes.length) throw new Error('notes: one or more { pitch, beat, length, velocity? }');
  const list = notes.map((n) => ({ pitch: toMidi(n.pitch), beat: n.beat, length: n.length, velocity: n.velocity ?? 100 }));
  const lastBeat = Math.max(...list.map((n) => n.beat + n.length));
  const span = Math.max(1, Math.ceil(lastBeat / BEATS_PER_BAR - EPS));
  const [at, end] = await barSeconds(call, [bar, bar + span]);
  const { parts } = await call('notes', { track });
  const covers = (parts || []).some((p) => p.start <= at + EPS && p.end >= end - EPS);
  let createdPart = false;
  if (!covers) {
    if (!create) throw new Error(`no part covers bar ${bar} to ${bar + span} on ${track}`);
    await createPart(call, { track, bar, bars: span });
    createdPart = true;
  }
  const r = await trackTask(call, { op: 'addNotes', track, at, notes: list });
  return { track, bar, added: r.added, errors: r.errors, createdPart };
}

export async function writeChords(call, { track, bar, progression, barsPerChord = 1, voicing = 'close', octave = 3, rhythm = 'sustain', velocity = 90 }) {
  const chords = parseProgression(progression, { barsPerChord, beatsPerBar: BEATS_PER_BAR });
  const notes = [];
  for (const c of chords) {
    for (const n of rhythmize(voice(c.chord, { voicing, octave }), { rhythm, beats: c.length, velocity })) notes.push({ ...n, beat: c.beat + n.beat });
  }
  const r = await writeNotes(call, { track, bar, notes });
  return { ...r, chords: chords.map((c) => c.chord.symbol) };
}

export async function writeDrums(call, { track, bar, bars = 1, pattern, stepsPerBeat = 4, velocity = 100 }) {
  const notes = drumGrid(pattern, { bars, stepsPerBeat, beatsPerBar: BEATS_PER_BAR, velocity });
  if (!notes.length) throw new Error('the pattern has no hits');
  return writeNotes(call, { track, bar, notes });
}
