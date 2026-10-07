// Chord names from what Studio One stores in a chord track event: a root as an
// index on the circle of fifths (C=0, G=1, D=2, ... so pitch class = root * 7 mod 12)
// and a 12-slot interval mask ("FF 0 0 FF ..." where non-zero = interval present).
export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export const fifthsToPitchClass = (i) => (((i * 7) % 12) + 12) % 12;

export function parseIntervalsMask(mask) {
  const out = [];
  String(mask || '').trim().split(/\s+/).forEach((slot, i) => {
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
  const q = QUALITIES[sorted.join(',')];
  const root = NOTE_NAMES[rootPc];
  let name = q !== undefined ? root + q : `${root}(${intervals.join(',')})`;
  if (bassPc !== null && bassPc !== undefined && bassPc !== rootPc) name += `/${NOTE_NAMES[bassPc]}`;
  return name;
}
