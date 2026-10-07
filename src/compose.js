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

// Insert Instrument Part drops a one-bar part at the playhead (when it does not,
// the part is moved). So: playhead to the bar, insert, find the part that appeared,
// resize it to the length (and move it if it landed elsewhere), restore playhead
// and selection.
const NEAR = 0.01;

export async function createPart(call, { track, bar, bars = 1 }) {
  checkBar(bar);
  if (!Number.isInteger(bars) || bars < 1) throw new Error('bars must be an integer >= 1');
  const [start, end] = await barSeconds(call, [bar, bar + bars]);
  const { transport, selectedTracks } = await call('song');
  const key = (e) => `${e.start}|${e.end}`;
  const listEvents = async () => (await trackTask(call, { op: 'events', track })).events;
  const before = await listEvents();
  let r;
  try {
    await call('setTransport', { positionSeconds: start });
    await call('selectTrack', { name: track });
    r = await call('command', { category: 'Instrument Parts', name: 'Insert Instrument Part' });
  } finally {
    await call('setTransport', { positionSeconds: transport.position.seconds }).catch(() => {});
    await restoreSelection(call, selectedTracks);
  }
  if (!r || !r.executed) throw new Error(`could not insert an instrument part on ${track} (is it an instrument track?)`);
  const after = await listEvents();
  const seen = new Map();
  for (const e of before) seen.set(key(e), (seen.get(key(e)) || 0) + 1);
  const fresh = after.filter((e) => { const n = seen.get(key(e)) || 0; if (n) seen.set(key(e), n - 1); return !n; });
  if (!fresh.length) throw new Error(`Studio One did not add a part to ${track}`);
  const part = fresh.find((e) => Math.abs(e.start - start) <= NEAR) || fresh[0];
  const atStart = Math.abs(part.start - start) <= NEAR;
  if (fresh.length > 1 && !atStart) throw new Error(`Studio One added ${fresh.length} parts to ${track}; cannot tell which is new`);
  if (!atStart || Math.abs(part.end - end) > NEAR) {
    const op = { op: 'editEvent', track, event: part.number, end };
    if (!atStart) op.to = start;
    const edited = await trackTask(call, op);
    if (!(edited.done || []).includes('resize')) throw new Error('Studio One did not resize the new part (reinstall the device and restart Studio One, then retry)');
  }
  return { track, part: { start, end } };
}

export async function writeNotes(call, { track, bar, notes, createPart: create = true }) {
  checkBar(bar);
  if (!Array.isArray(notes) || !notes.length) throw new Error('notes: one or more { pitch, beat, length, velocity? }');
  notes.forEach((n, i) => {
    if (!Number.isFinite(n.beat) || n.beat < 0) throw new Error(`note ${i + 1}: beat must be >= 0`);
    if (!Number.isFinite(n.length) || n.length <= 0) throw new Error(`note ${i + 1}: length must be > 0 beats`);
  });
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

// Choose the (empty) part an add lands in and rebase the notes' song beats onto its start.
export function emptyPartAdd(parts, notes, track = 'the track') {
  if ((parts || []).some((p) => typeof p.startBeat !== 'number' || typeof p.endBeat !== 'number')) {
    throw new Error('cannot place notes: Studio One did not report part positions (reinstall the device and restart Studio One), or use live_write_notes');
  }
  const minBeat = Math.min(...notes.map((n) => n.beat));
  const hit = parts.filter((p) => p.startBeat <= minBeat && minBeat < p.endBeat).sort((a, b) => a.startBeat - b.startBeat).pop();
  if (!hit) throw new Error(`no part covers beat ${minBeat} on ${track}; use live_write_notes or live_create_part`);
  return { at: hit.start, notes: notes.map((n) => ({ ...n, beat: n.beat - hit.startBeat })) };
}

// Does an add go into an empty part? True when the part covering the first note has no
// notes (other parts on the track may have some), or, if positions are unknown or no
// part covers it, when every part is empty. Studio One's own add cannot start a part.
export function addsToEmptyPart(parts, notes) {
  const list = parts || [];
  if (!list.length) return false;
  const positioned = list.every((p) => typeof p.startBeat === 'number' && typeof p.endBeat === 'number');
  if (positioned && notes && notes.length) {
    const minBeat = Math.min(...notes.map((n) => n.beat));
    const hit = list.filter((p) => p.startBeat <= minBeat && minBeat < p.endBeat).sort((a, b) => a.startBeat - b.startBeat).pop();
    if (hit) return hit.noteCount === 0;
  }
  return list.every((p) => p.noteCount === 0);
}
