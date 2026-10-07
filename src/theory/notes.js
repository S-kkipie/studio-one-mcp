// Note names with Studio One's default octave numbering: middle C (MIDI 60) is C3.
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function pitchClass(name) {
  const m = /^([A-Ga-g])([#b]?)$/.exec(String(name));
  if (!m) throw new Error(`bad pitch class "${name}"`);
  const pc = NATURAL[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return (pc + 12) % 12;
}

const inRange = (p, label) => {
  if (!Number.isInteger(p) || p < 0 || p > 127) throw new Error(`${label} is outside MIDI 0-127`);
  return p;
};

export function toMidi(x) {
  if (typeof x === 'number') return inRange(x, `pitch ${x}`);
  const m = /^([A-Ga-g][#b]?)(-?\d+)$/.exec(String(x).trim());
  if (!m) throw new Error(`bad note "${x}" (use a MIDI number or a name like C3, Eb4, F#2; middle C = C3)`);
  const NAT = NATURAL[m[1][0].toUpperCase()];
  const acc = m[1][1] === '#' ? 1 : m[1][1] === 'b' ? -1 : 0;
  return inRange(NAT + acc + (Number(m[2]) + 2) * 12, `note ${x}`);
}

export const noteName = (p) => `${NAMES[p % 12]}${Math.floor(p / 12) - 2}`;
