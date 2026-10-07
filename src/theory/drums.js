// Drum grids: one string per lane, x = hit, X = accent (velocity 120), . or - = rest;
// spaces and | are ignored. A lane shorter than the requested bars repeats.
export const GM_DRUMS = {
  kick: 36, rim: 37, snare: 38, clap: 39, closed_hat: 42, hat: 42, pedal_hat: 44, low_tom: 45,
  open_hat: 46, mid_tom: 47, high_tom: 50, crash: 49, ride: 51,
};

function lanePitch(lane) {
  if (/^\d+$/.test(lane)) {
    const p = Number(lane);
    if (p > 127) throw new Error(`drum lane ${lane} is outside MIDI 0-127`);
    return p;
  }
  const p = GM_DRUMS[lane.toLowerCase()];
  if (p === undefined) throw new Error(`unknown drum lane "${lane}" (known: ${Object.keys(GM_DRUMS).join(', ')}, or a MIDI number)`);
  return p;
}

export function drumGrid(pattern, { bars = 1, stepsPerBeat = 4, beatsPerBar = 4, velocity = 100 } = {}) {
  const lanes = Object.entries(pattern || {});
  if (!lanes.length) throw new Error('pattern needs at least one lane, e.g. { kick: "x...x...x...x..." }');
  const total = bars * beatsPerBar * stepsPerBeat;
  const length = 1 / stepsPerBeat;
  const out = [];
  for (const [lane, text] of lanes) {
    const pitch = lanePitch(lane);
    const steps = String(text).replace(/[\s|]/g, '');
    if (!steps.length) continue;
    const bad = steps.replace(/[xX.\-]/g, '');
    if (bad) throw new Error(`lane ${lane}: "${bad[0]}" is not a step (use x, X or .)`);
    for (let i = 0; i < total; i++) {
      const c = steps[i % steps.length];
      if (c === 'x' || c === 'X') out.push({ pitch, beat: i * length, length, velocity: c === 'X' ? 120 : velocity });
    }
  }
  return out.sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
}
