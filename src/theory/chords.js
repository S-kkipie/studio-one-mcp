// Chord symbols ("Cm7", "Bbmaj7", "F/A"), progressions ("Cm7 | Ab | Eb Bb") and voicings.
import { pitchClass } from './notes.js';

const QUALITIES = {
  '': [0, 4, 7], maj: [0, 4, 7], M: [0, 4, 7],
  m: [0, 3, 7], min: [0, 3, 7], '-': [0, 3, 7],
  dim: [0, 3, 6], aug: [0, 4, 8], '+': [0, 4, 8],
  sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7],
  6: [0, 4, 7, 9], m6: [0, 3, 7, 9],
  7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], m7: [0, 3, 7, 10], min7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10], 'ø': [0, 3, 6, 10], dim7: [0, 3, 6, 9],
  9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14],
  add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
};

export function parseChord(symbol) {
  const s = String(symbol).trim();
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(s);
  const intervals = m && Object.hasOwn(QUALITIES, m[2]) ? QUALITIES[m[2]] : undefined;
  if (!intervals) throw new Error(`unknown chord symbol "${s}" (e.g. C, Cm, C7, Cmaj7, Cm7, Cm7b5, Cdim7, Csus4, Cadd9, C/E)`);
  return { symbol: s, root: pitchClass(m[1]), intervals: [...intervals], bass: m[3] ? pitchClass(m[3]) : null };
}

export function parseProgression(text, { barsPerChord = 1, beatsPerBar = 4 } = {}) {
  const src = String(text);
  const bars = src.includes('|')
    ? src.split('|').map((b) => b.trim()).filter(Boolean).map((b) => b.split(/\s+/))
    : src.trim().split(/\s+/).filter(Boolean).map((c) => [c]);
  if (!bars.length) throw new Error('empty progression');
  const barBeats = beatsPerBar * barsPerChord;
  const out = [];
  bars.forEach((chords, i) => {
    const each = barBeats / chords.length;
    chords.forEach((c, j) => out.push({ chord: parseChord(c), beat: i * barBeats + j * each, length: each }));
  });
  return out;
}

export function voice(chord, { voicing = 'close', octave = 3 } = {}) {
  const base = chord.root + (octave + 2) * 12;
  let notes = chord.intervals.map((i) => base + i);
  if (voicing === 'open') {
    if (notes.length >= 3) notes = [notes[0], ...notes.slice(2), notes[1] + 12];
  } else if (voicing === 'drop2') {
    if (notes.length >= 3) {
      const i = notes.length - 2;
      notes = [notes[i] - 12, ...notes.slice(0, i), ...notes.slice(i + 1)];
    }
  } else if (voicing !== 'close') {
    throw new Error('voicing must be close, open or drop2');
  }
  notes.sort((a, b) => a - b);
  if (chord.bass !== null) {
    let b = chord.bass + (octave + 2) * 12;
    while (b >= notes[0]) b -= 12;
    notes.unshift(b);
  }
  for (const p of notes) if (p < 0 || p > 127) throw new Error(`chord ${chord.symbol} at octave ${octave} goes outside MIDI 0-127`);
  return notes;
}
