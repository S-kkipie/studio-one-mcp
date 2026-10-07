// Chord names from what Studio One stores in a chord track event: a root as an
// index on the circle of fifths (C=0, G=1, D=2, ... so pitch class = root * 7 mod 12)
// and a 12-slot interval mask ("FF 0 0 FF ..." where non-zero = interval present).
export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export const fifthsToPitchClass = (i) => {
  const n = Math.round(Number(i));
  return Number.isFinite(n) ? (((n * 7) % 12) + 12) % 12 : 0;
};

// Only the first 12 slots count. Slot values are non-zero markers: seen FF, and
// also small order values like 1/3/5, so presence is all that matters.
export function parseIntervalsMask(mask) {
  const out = [];
  String(mask || '').trim().split(/\s+/).slice(0, 12).forEach((slot, i) => {
    if (slot && parseInt(slot, 16) !== 0 && !Number.isNaN(parseInt(slot, 16))) out.push(i);
  });
  return out;
}

const QUALITIES = {
  '0,4,7': '',
  '0,3,7': 'm',
  '0,3,6': 'dim',
  '0,4,8': 'aug',
  '0,2,7': 'sus2',
  '0,5,7': 'sus4',
  '0,4,7,9': '6',
  '0,3,7,9': 'm6',
  '0,4,7,10': '7',
  '0,4,7,11': 'maj7',
  '0,3,7,10': 'm7',
  '0,3,6,10': 'm7b5',
  '0,3,6,9': 'dim7',
  '0,2,4,7': 'add9',
  '0,2,3,7': 'madd9',
  '0,2,4,7,10': '9',
  '0,2,4,7,11': 'maj9',
  '0,2,3,7,10': 'm9',
};

export function chordName(rootPc, intervals, bassPc = null) {
  const sorted = [...intervals].sort((a, b) => a - b);
  const key = sorted.join(',');
  const q = Object.hasOwn(QUALITIES, key) ? QUALITIES[key] : undefined;
  const root = NOTE_NAMES[Math.round(Number(rootPc))] ?? NOTE_NAMES[fifthsToPitchClass(rootPc)];
  let name = q !== undefined ? root + q : `${root}(${intervals.join(',')})`;
  if (bassPc !== null && bassPc !== undefined && bassPc !== rootPc) name += `/${NOTE_NAMES[bassPc]}`;
  return name;
}
