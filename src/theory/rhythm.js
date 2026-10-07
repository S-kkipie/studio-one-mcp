// A voiced chord (MIDI pitches) over `beats` as timed notes, beats relative to the chord.
const STEP = { quarters: 1, eighths: 0.5, arp_up: 0.5, arp_down: 0.5 };

export function rhythmize(pitches, { rhythm = 'sustain', beats, velocity = 90 } = {}) {
  if (!(beats > 0)) throw new Error('beats must be > 0');
  if (rhythm === 'sustain') return pitches.map((pitch) => ({ pitch, beat: 0, length: beats, velocity }));
  const step = STEP[rhythm];
  if (!step) throw new Error('rhythm must be sustain, quarters, eighths, arp_up or arp_down');
  const out = [];
  const order = rhythm === 'arp_down' ? [...pitches].sort((a, b) => b - a) : [...pitches].sort((a, b) => a - b);
  for (let i = 0, beat = 0; beat < beats - 1e-9; i++, beat += step) {
    const length = Math.min(step, beats - beat);
    if (rhythm.startsWith('arp')) out.push({ pitch: order[i % order.length], beat, length, velocity });
    else for (const pitch of pitches) out.push({ pitch, beat, length, velocity });
  }
  return out;
}
