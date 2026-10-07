// The chord track: read it, write it (through a scratch instrument track, because Studio One names
// chords itself from notes), extract it from a track, fill an instrument track from it, clear it.
// Seen on 7.2.3: Event/Extract to Chord Track, Instrument Parts/Insert Instrument Parts from Chord
// Track and Song/Remove Track all run without dialogs.

import { trackTask } from './tracks.js';
import { toSeconds } from './time.js';
import { createPart as realCreatePart, writeChords as realWriteChords } from './compose.js';
import { parseProgression } from './theory/chords.js';
import { noteName } from './theory/notes.js';

const EPS = 0.001;

async function ensureStopped(call) {
  const song = await call('song');
  if (song.transport?.playing || song.transport?.recording) throw new Error('stop playback first');
  return song;
}

async function restoreSelection(call, names) {
  try { await call('selectEvents', { none: true }); } catch { /* best effort */ }
  for (const [i, name] of (names || []).entries()) {
    try { await call('selectTrack', { name, exclusive: i === 0 }); } catch { /* best effort */ }
  }
}

export async function listChords(call, { from, to } = {}) {
  const f = await toSeconds(call, from);
  const t = await toSeconds(call, to);
  const r = await trackTask(call, { op: 'chords', from: f, to: t });
  return { chords: (r.chords || []).map((c) => ({ chord: c.name, start: c.start, end: c.end })) };
}

export async function clearChords(call, { from, to } = {}) {
  const f = await toSeconds(call, from);
  const t = await toSeconds(call, to);
  const r = await trackTask(call, { op: 'removeChords', from: f, to: t });
  return { removed: r.removed || [] };
}

const normalize = (s) => String(s).replace(/\s+/g, '').replace(/maj7|M7|Δ/g, 'maj7');

export async function setChords(call, { bar, progression, barsPerChord = 1, replace = true }, deps = {}) {
  const createPart = deps.createPart || realCreatePart;
  const writeChords = deps.writeChords || realWriteChords;
  const song0 = await ensureStopped(call);
  const parsed = parseProgression(progression, { barsPerChord });
  const totalBeats = parsed.reduce((n, c) => n + c.length, 0);
  const bars = totalBeats / 4;
  const requested = parsed.map((c) => c.chord.symbol);
  const from = await toSeconds(call, `${bar}.1.1.0`);
  const to = await toSeconds(call, `${bar + bars}.1.1.0`);
  const warnings = [];
  let undoSteps = 0;

  let removed = [];
  if (replace) {
    removed = (await trackTask(call, { op: 'removeChords', from, to })).removed || [];
    if (removed.length) undoSteps += 1;
    for (const e of removed) {
      if (e.start < from - EPS || e.end > to + EPS) warnings.push(`chord ${e.name} at ${e.start}s extended outside the range and was removed whole`);
    }
  }

  async function writeVia() {
    const before = (await call('tracks', { events: false })).map((t) => t.name);
    const addRes = await call('addTrack', { type: 'instrument' });
    undoSteps += 1;
    let fresh = Array.isArray(addRes?.added) ? addRes.added : null;
    if (!fresh) fresh = (await call('tracks', { events: false })).map((t) => t.name).filter((n) => !before.includes(n));
    if (fresh.length !== 1) {
      throw new Error(`a new track was added but could not be identified as the scratch track${fresh.length ? ` (candidates: ${fresh.join(', ')})` : ''}: remove it by hand`);
    }
    const scratch = fresh[0];

    try {
      const part = await createPart(call, { track: scratch, bar, bars });
      undoSteps += part?.undoSteps ?? 1;
      await writeChords(call, { track: scratch, bar, progression, barsPerChord });
      undoSteps += 1;
      await call('selectEvents', { tracks: [scratch] });
      const r = await call('command', { category: 'Event', name: 'Extract to Chord Track' });
      if (!r.executed) throw new Error('Event/Extract to Chord Track did not run');
      undoSteps += 1;
    } finally {
      try {
        await call('selectTrack', { name: scratch, exclusive: true });
        const rr = await call('command', { category: 'Song', name: 'Remove Track' });
        if (rr.executed) undoSteps += 1;
        else warnings.push(`could not remove the scratch track "${scratch}": remove it by hand`);
      } catch (e) {
        warnings.push(`could not remove the scratch track "${scratch}" (${e.message}): remove it by hand`);
      }
      await restoreSelection(call, song0.selectedTracks);
    }

  }

  try {
    await writeVia();
  } catch (e) {
    if (removed.length) e.message += `; ${removed.length} chord(s) were already removed from the range (live_undo restores them)`;
    throw e;
  }
  const chords = (await listChords(call, { from, to })).chords;
  const mismatches = [];
  if (chords.length !== requested.length) mismatches.push({ requested: requested.length, got: chords.length });
  else requested.forEach((q, i) => { if (normalize(q) !== normalize(chords[i].chord)) mismatches.push({ requested: q, got: chords[i].chord }); });

  return {
    written: requested,
    chords,
    removed,
    ...(mismatches.length ? { mismatches } : {}),
    ...(warnings.length ? { warnings } : {}),
    undoSteps,
    ...(replace ? {} : { rangeNote: 'replace was false: chords already in the range are part of the read-back, so count mismatches can come from them' }),
    note: 'several live_undo steps; easier: live_clear_chords for the range, or call again',
  };
}

export async function extractChords(call, { track }) {
  const song0 = await ensureStopped(call);
  let r;
  try {
    await call('selectEvents', { tracks: [track] });
    r = await call('command', { category: 'Event', name: 'Extract to Chord Track' });
  } finally {
    await restoreSelection(call, song0.selectedTracks);
  }
  if (!r.executed) throw new Error(`nothing to extract from on ${track} (no events?)`);
  return { track, chords: (await listChords(call, {})).chords };
}

const partKey = (p) => `${p.start}|${p.name}`;

export async function partsFromChords(call, { track }) {
  const song0 = await ensureStopped(call);
  const before = (await call('notes', { track })).parts || [];
  let r;
  try {
    await call('selectTrack', { name: track, exclusive: true });
    r = await call('command', { category: 'Instrument Parts', name: 'Insert Instrument Parts from Chord Track' });
  } finally {
    await restoreSelection(call, song0.selectedTracks);
  }
  if (!r.executed) throw new Error(`Studio One could not insert parts on ${track} (an instrument track is needed, and chords on the chord track)`);
  const after = (await call('notes', { track })).parts || [];
  const seen = new Set(before.map(partKey));
  const parts = after.filter((p) => !seen.has(partKey(p))).map((p) => ({ name: p.name, start: p.start, end: p.end, notes: (p.notes || []).map((n) => n.note ?? (typeof n.pitch === 'number' ? noteName(n.pitch) : null)) }));
  return { track, parts };
}
