# Studio One MCP: Windows fixes + composition layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the forked studio-one-mcp fully work on Windows and add tools that let Claude compose into a running Studio One: create parts, write notes (even into empty parts), chord progressions and drum patterns.

**Architecture:** Node MCP server (`src/server.js`) talks to a Studio One control-surface script (`device/StudioOneMCP/BridgeCore.js`) through a file mailbox plus a MIDI "doorbell" (loopMIDI). Note writing runs inside the **MCP Track Edit** edit task (`device/EditTasks/package/McpTrackOps.js`) with Studio One's `MusicFunctions`. Music theory lives in pure Node modules under `src/theory/`; `src/compose.js` glues theory to bridge calls.

**Tech Stack:** Node ≥ 20 (ESM), `node --test`, `zod`, `@modelcontextprotocol/sdk`, `@julusian/midi`; Studio One's embedded JavaScript (ES5 style in device files: `var`, no arrow functions in `device/EditTasks`).

**Spec:** `docs/superpowers/specs/2026-10-07-studio-one-mcp-design.md`

## Global Constraints

- Repo is a fork of NeanderthalMan/studio-one-mcp (MIT): keep LICENSE, keep upstream behaviour on macOS.
- Work on branch `main-windows`. Commit after each task; end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Pitch convention: **middle C = C3 = MIDI 60** (Studio One default). Names accept `#` and `b`.
- Positions in new tools: bars are 1-based integers; note `beat`/`length` are quarter-note beats.
- Device files (`device/**`) run in Studio One's engine: ES5 only in `device/EditTasks/package/*.js` (`var`, `function`, no `=>`, no template strings). A null member access there pops a modal "Scripting Error" dialog in Studio One, so check every lookup (`mtoFn`).
- Default Windows MIDI port name: `studio-one-mcp`; env `STUDIO_ONE_MCP_MIDI_PORT` overrides on every platform.
- Bridge must end up installed **without** `--allow-eval`.
- Run tests with `npm test` (= `node --test test/*.test.js`) from the repo root.

## Review Focus

1. A chord symbol with a slash bass or flat root (`F/A`, `Bbmaj7`, `Ebm7b5`) must voice correctly, and an unknown symbol must name itself in the error. Tests in Task 2.
2. A drum pattern shorter than a bar, written with spaces or `|`, or with an `X` accent, must repeat over every requested bar. An unknown lane must list the known lanes. Tests in Task 3.
3. Writing at a bar where no part exists must create one that covers all the notes, including notes whose end crosses the bar line. Tests in Task 5.
4. `live_create_part` must restore the loop range and loop on/off even when the insert command fails. Tests in Task 5.
5. Invalid notes in a batch (pitch 128, length 0) must be reported per note while the valid notes are still written. Tests in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/midi.js` (modify) | Platform default for the doorbell port. |
| `scripts/call-tool.js` (modify) | Windows-safe server path. |
| `test/*.test.js` (modify, Task 1 only) | Make path assertions portable. |
| `src/theory/notes.js` (create) | Note name ↔ MIDI. |
| `src/theory/chords.js` (create) | Chord symbol parsing, progressions, voicings. |
| `src/theory/rhythm.js` (create) | Turn voiced chords into timed notes. |
| `src/theory/drums.js` (create) | Drum grid strings → notes, GM map. |
| `device/EditTasks/package/McpTrackOps.js` (modify) | New `addNotes` op (MusicFunctions). |
| `src/compose.js` (create) | `createPart`, `writeNotes`, `writeChords`, `writeDrums` over `call`. |
| `src/server.js` (modify) | Register 4 new tools; `live_edit_notes` add fallback. |
| `test/theory.test.js`, `test/drums.test.js`, `test/compose.test.js` (create) | Unit tests. |
| `test/trackedittask.test.js`, `test/server.test.js` (modify) | addNotes op test; tool list. |
| `README.md` (modify) | Windows notes + new tools + fork credit. |

---

### Task 1: Windows fixes — green test suite

**Files:**
- Modify: `src/midi.js:8`
- Modify: `scripts/call-tool.js` (server path line)
- Modify: whichever of `src/*.js` / `test/*.test.js` the 11 failing tests point to

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` exit code 0 on Windows; `src/midi.js` exports unchanged (`nudge`, `midiPort`).

- [ ] **Step 1: Record the failing tests**

Run: `npm install` then `node --test --test-reporter=spec test/*.test.js 2>&1 | grep -E "✖|ℹ (tests|pass|fail)"`
Expected (seen in spike): 11 failures — `installs every device file plus a generated BridgeConfig.js`, `installs the edit-task extension…`, 7 × `song_*` tests in server.test.js, `serverEntry from npx…`, `takes: active layer drives track events…`. Read each failure's diff with `node --test test/<file>.test.js`.

- [ ] **Step 2: Fix the MIDI port default**

In `src/midi.js` replace line 8:

```js
const DEFAULT_PORT = process.platform === 'win32' ? 'studio-one-mcp' : 'IAC';
const PORT = process.env.STUDIO_ONE_MCP_MIDI_PORT || DEFAULT_PORT;
```

and make the error message platform-aware (replace the macOS-only sentence inside the thrown `Error`):

```js
    const hint = process.platform === 'win32'
      ? 'On Windows run loopMIDI and add a port named "studio-one-mcp"'
      : 'On macOS enable Audio MIDI Setup → IAC Driver → "Device is online"';
    throw new Error(
      `No MIDI output matching "${PORT}" (found: ${names.join(', ') || 'none'}). ` +
        `${hint}, and set the MCP Bridge device's Receive From to that port. Override with STUDIO_ONE_MCP_MIDI_PORT.`,
    );
```

- [ ] **Step 3: Fix `scripts/call-tool.js` server path**

Find the line that builds the server path from `new URL(...).pathname` (or similar) and change it to use `fileURLToPath`:

```js
import { fileURLToPath } from 'node:url';
const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));
```

Verify: `node scripts/call-tool.js song_list "{}"` prints a JSON list (not `C:\C:\…` MODULE_NOT_FOUND).

- [ ] **Step 4: Fix each remaining failure at its root**

For each failing test decide: is the **product code** wrong on Windows (fix `src/`), or does the **test** hard-code POSIX paths (fix the test with `path.join`, `fileURLToPath`, `pathToFileURL`)? Known example from the spike: a test expected `'/tmp/Media/Vox 2.wav'` but got `'file:///tmp/Media/Vox 2.wav'` — check whether `src/song.js` resolves media URLs with `fileURLToPath` and whether the expected value should be built with `fileURLToPath(pathToFileURL(...))`. Do not delete or skip tests.

- [ ] **Step 5: Verify green**

Run: `npm test`
Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Windows: loopMIDI port default, portable paths, green tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Theory — note names and chords

**Files:**
- Create: `src/theory/notes.js`, `src/theory/chords.js`
- Test: `test/theory.test.js`

**Interfaces:**
- Produces:
  - `toMidi(x: number|string): number` — int 0..127 passthrough, or name like `"C3"`, `"Eb4"`, `"F#-1"`; throws `Error('bad note "X"…')`.
  - `noteName(p: number): string` — 60 → `"C3"`, sharps.
  - `pitchClass(name: string): number` — `"Eb"` → 3.
  - `parseChord(symbol: string): { symbol, root: number(pc), intervals: number[], bass: number|null }`.
  - `parseProgression(text: string, { barsPerChord = 1, beatsPerBar = 4 } = {}): Array<{ chord, beat, length }>` (beats from progression start).
  - `voice(chord, { voicing = 'close', octave = 3 } = {}): number[]` ascending MIDI pitches.

- [ ] **Step 1: Write the failing tests**

`test/theory.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMidi, noteName, pitchClass } from '../src/theory/notes.js';
import { parseChord, parseProgression, voice } from '../src/theory/chords.js';

test('note names use middle C = C3', () => {
  assert.equal(toMidi('C3'), 60);
  assert.equal(toMidi('Eb4'), 75);
  assert.equal(toMidi('F#2'), 54);
  assert.equal(toMidi('C-2'), 0);
  assert.equal(toMidi(64), 64);
  assert.equal(noteName(60), 'C3');
  assert.equal(noteName(61), 'C#3');
  assert.equal(pitchClass('Bb'), 10);
  assert.throws(() => toMidi('H3'), /bad note "H3"/);
  assert.throws(() => toMidi(128), /0-127/);
  assert.throws(() => toMidi('G9'), /0-127/);
});

test('parseChord: qualities, flats, slash bass, unknown symbol', () => {
  assert.deepEqual(parseChord('C'), { symbol: 'C', root: 0, intervals: [0, 4, 7], bass: null });
  assert.deepEqual(parseChord('Cm7').intervals, [0, 3, 7, 10]);
  assert.deepEqual(parseChord('Bbmaj7'), { symbol: 'Bbmaj7', root: 10, intervals: [0, 4, 7, 11], bass: null });
  assert.deepEqual(parseChord('Ebm7b5').intervals, [0, 3, 6, 10]);
  assert.deepEqual(parseChord('F/A'), { symbol: 'F/A', root: 5, intervals: [0, 4, 7], bass: 9 });
  for (const [s, iv] of [['Gsus4', [0, 5, 7]], ['Dsus2', [0, 2, 7]], ['Bdim', [0, 3, 6]], ['Caug', [0, 4, 8]], ['A6', [0, 4, 7, 9]], ['Am6', [0, 3, 7, 9]],
    ['G7', [0, 4, 7, 10]], ['Bdim7', [0, 3, 6, 9]], ['D9', [0, 4, 7, 10, 14]], ['Fmaj9', [0, 4, 7, 11, 14]], ['Em9', [0, 3, 7, 10, 14]], ['Cadd9', [0, 4, 7, 14]]]) {
    assert.deepEqual(parseChord(s).intervals, iv, s);
  }
  assert.throws(() => parseChord('Cfoo'), /unknown chord symbol "Cfoo"/);
});

test('parseProgression: bars with |, several chords split a bar, no bars = one chord per bar', () => {
  const p = parseProgression('Cm7 | Ab | Eb Bb');
  assert.deepEqual(p.map((x) => [x.chord.symbol, x.beat, x.length]), [['Cm7', 0, 4], ['Ab', 4, 4], ['Eb', 8, 2], ['Bb', 10, 2]]);
  const q = parseProgression('C G Am F', { barsPerChord: 2 });
  assert.deepEqual(q.map((x) => [x.chord.symbol, x.beat, x.length]), [['C', 0, 8], ['G', 8, 8], ['Am', 16, 8], ['F', 24, 8]]);
  assert.throws(() => parseProgression(' | '), /empty progression/);
});

test('voice: close, open, drop2, slash bass below', () => {
  const cm7 = parseChord('Cm7');
  assert.deepEqual(voice(cm7), [60, 63, 67, 70]);
  assert.deepEqual(voice(cm7, { voicing: 'open' }), [60, 67, 70, 75]);
  assert.deepEqual(voice(cm7, { voicing: 'drop2' }), [55, 60, 63, 70]);
  assert.deepEqual(voice(parseChord('F/A')), [57, 65, 69, 72]);
  assert.deepEqual(voice(parseChord('C'), { octave: 4 }), [72, 76, 79]);
  assert.throws(() => voice(cm7, { voicing: 'spread' }), /voicing must be/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/theory.test.js`
Expected: FAIL — `Cannot find module …/src/theory/notes.js`.

- [ ] **Step 3: Implement `src/theory/notes.js`**

```js
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
```

- [ ] **Step 4: Implement `src/theory/chords.js`**

```js
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
  const intervals = m ? QUALITIES[m[2]] : undefined;
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
```

Check against the tests: `voice(F/A)` → close F A C = 65,69,72; bass A = 9+60=69 ≥ 65 → 57 → `[57,65,69,72]` ✓. drop2 Cm7 close `[60,63,67,70]`, i=2 → 67-12=55 → `[55,60,63,70]` ✓. open Cm7 → `[60,67,70,63+12=75]` ✓.

- [ ] **Step 5: Run to verify pass**

Run: `node --test test/theory.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/theory test/theory.test.js
git commit -m "Theory: note names (C3 = 60), chord symbols, progressions, voicings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Theory — rhythms and drum grids

**Files:**
- Create: `src/theory/rhythm.js`, `src/theory/drums.js`
- Test: `test/drums.test.js`

**Interfaces:**
- Consumes: nothing from Task 2 at runtime.
- Produces:
  - `rhythmize(pitches: number[], { rhythm = 'sustain', beats, velocity = 90 }): Array<{ pitch, beat, length, velocity }>` (beats relative to chord start). Rhythms: `sustain`, `quarters`, `eighths`, `arp_up`, `arp_down`.
  - `GM_DRUMS: Record<string, number>`.
  - `drumGrid(pattern: Record<string,string>, { bars = 1, stepsPerBeat = 4, beatsPerBar = 4, velocity = 100 } = {}): Array<{ pitch, beat, length, velocity }>`, sorted by beat then pitch.

- [ ] **Step 1: Write the failing tests**

`test/drums.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rhythmize } from '../src/theory/rhythm.js';
import { drumGrid, GM_DRUMS } from '../src/theory/drums.js';

const rows = (notes) => notes.map((n) => [n.pitch, n.beat, n.length, n.velocity]);

test('rhythmize: sustain, quarters, eighths, arpeggios', () => {
  assert.deepEqual(rows(rhythmize([60, 64], { rhythm: 'sustain', beats: 4 })), [[60, 0, 4, 90], [64, 0, 4, 90]]);
  assert.equal(rhythmize([60, 64], { rhythm: 'quarters', beats: 4 }).length, 8);
  assert.deepEqual(rows(rhythmize([60], { rhythm: 'eighths', beats: 1, velocity: 70 })), [[60, 0, 0.5, 70], [60, 0.5, 0.5, 70]]);
  assert.deepEqual(rhythmize([60, 64, 67], { rhythm: 'arp_up', beats: 2 }).map((n) => n.pitch), [60, 64, 67, 60]);
  assert.deepEqual(rhythmize([60, 64, 67], { rhythm: 'arp_down', beats: 2 }).map((n) => n.pitch), [67, 64, 60, 67]);
  assert.throws(() => rhythmize([60], { rhythm: 'swing', beats: 4 }), /rhythm must be/);
});

test('drumGrid: GM lanes, accents, spaces and bars repeat', () => {
  const n = drumGrid({ kick: 'x... x...', snare: '..X.' }, { bars: 2 });
  // kick "x... x..." = 8 steps (2 beats) cycling: a hit every beat → 8 over 2 bars;
  // snare "..X." = 4 steps (1 beat) cycling: 4 per bar → 8, all accented.
  assert.equal(n.filter((x) => x.pitch === 36).length, 8);
  assert.equal(n.filter((x) => x.pitch === 38).length, 8);
  assert.deepEqual(rows(n.filter((x) => x.pitch === 36)).map((r) => r[1]), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(rows(n.filter((x) => x.pitch === 36))[0], [36, 0, 0.25, 100]);
  assert.ok(n.filter((x) => x.pitch === 38).every((x) => x.velocity === 120));
  assert.equal(n[n.length - 1].beat < 8, true);
});

test('drumGrid: lane by MIDI number, | separators, errors', () => {
  assert.deepEqual(rows(drumGrid({ 37: 'x...|....|....|....' })), [[37, 0, 0.25, 100]]);
  assert.equal(GM_DRUMS.closed_hat, 42);
  assert.throws(() => drumGrid({ cowbell2: 'x' }), /unknown drum lane "cowbell2" \(known: .*kick/);
  assert.throws(() => drumGrid({ kick: 'x.o.' }), /use x, X or \./);
  assert.throws(() => drumGrid({}), /at least one lane/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/drums.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/theory/rhythm.js`**

```js
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
```

- [ ] **Step 4: Implement `src/theory/drums.js`**

```js
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
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test test/drums.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/theory/rhythm.js src/theory/drums.js test/drums.test.js
git commit -m "Theory: chord rhythms and drum grids (General MIDI lanes)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Device — `addNotes` op in MCP Track Edit (works on empty parts)

**Files:**
- Modify: `device/EditTasks/package/McpTrackOps.js` (append a new op after `mtoOps.events`)
- Test: `test/trackedittask.test.js` (append tests)

**Interfaces:**
- Consumes: existing helpers in `McpTrackOps.js`: `mtoFn`, `mtoTrack(context, name)`, `mtoEvents(track)`, `mtoSeconds(time)`, `mtoIn(context, seconds, format)`.
- Produces: track-edit op `{ op: 'addNotes', track: string, at: number(seconds), notes: [{ pitch:int, beat:number, length:number, velocity?:int }] }` → result `{ track, part, added: number, errors: string[] }` or `{ error }`. `beat` is relative to `at`, in quarter notes.

Background (spike, 2026-10-06): Studio One disables all Musical Functions on a part with no notes, so the existing `Musical Functions/MCP Edit` path cannot add the first notes. Inside the track edit task, `context.functions.root.createFunctions("MusicFunctions")` gives `createEvent("Note")`, `insertEvent(part, note)`, `modifyPitch`, `modifyVelocity(note, 0..1)`, `freezeVelocity`, `resizeEvent(note, beats)`, `moveEvent(note, beats)` — this sequence wrote notes into an empty part starting at song position 0. The task runs as one undo step.

- [ ] **Step 1: Write the failing tests** (append to `test/trackedittask.test.js`)

```js
// An instrument track "Keys" with one part from 4 s to 8 s (beats 8..16 at 120 bpm).
function keysSong() {
  const s = song();
  const t = (sec) => ({ seconds: sec, musical: sec * 2, as: (f) => (f === 2 ? sec * 2 : sec) });
  const notes = [];
  const part = { name: 'Keys', startTime: t(4), endTime: t(8), timeFormat: 2, notes, createSequenceIterator: () => { let k = 0; return { done: () => k >= notes.length, next: () => notes[k++] }; } };
  const keys = { name: 'Keys', mediaType: 'Music', parentFolderID: '', events: [part] };
  keys.createIterator = () => { let k = 0; return { next: () => keys.events[k++] || null }; };
  s.tracks.push(keys);
  const music = {
    createEvent: (kind) => (kind === 'Note' ? { kind } : null),
    insertEvent: (p, n) => { n.part = p; p.notes.push(n); },
    modifyPitch: (n, p) => { n.pitch = p; },
    modifyVelocity: (n, v) => { n.velocity = v; },
    freezeVelocity: (n) => { n.frozen = true; },
    resizeEvent: (n, len) => { n.length = len; },
    moveEvent: (n, at) => { n.at = at; },
  };
  const prev = s.context.functions.root.createFunctions;
  s.context.functions.root.createFunctions = (n) => (n === 'MusicFunctions' ? music : prev(n));
  return { ...s, part, notes };
}

function runKeys(ops) {
  const t = load();
  const s = keysSong();
  t.request(ops);
  t.task.performEdit(s.context);
  return { results: t.result().results, s };
}

test('addNotes writes notes into the part covering `at`, beats relative to `at`, part-relative positions', () => {
  // at = 5 s → song beat 10; part starts at beat 8 → base 2.
  const { results, s } = runKeys([{ op: 'addNotes', track: 'Keys', at: 5, notes: [{ pitch: 60, beat: 0, length: 4, velocity: 127 }, { pitch: 67, beat: 1.5, length: 0.5 }] }]);
  assert.deepEqual(results[0], { op: 'addNotes', track: 'Keys', part: 'Keys', added: 2, errors: [] });
  assert.deepEqual(s.notes.map((n) => [n.pitch, n.at, n.length, Math.round(n.velocity * 127), n.frozen]), [[60, 2, 4, 127, true], [67, 3.5, 0.5, 100, true]]);
});

test('addNotes reports bad notes and still writes the good ones', () => {
  const { results, s } = runKeys([{ op: 'addNotes', track: 'Keys', at: 4, notes: [{ pitch: 128, beat: 0, length: 1 }, { pitch: 60, beat: 0, length: 0 }, { pitch: 62, beat: -1, length: 1 }, { pitch: 64, beat: 0, length: 1, velocity: 300 }] }]);
  assert.equal(results[0].added, 1);
  assert.deepEqual(results[0].errors, ['note 1: pitch must be an integer 0-127', 'note 2: length must be > 0 beats', 'note 3: beat must be >= 0']);
  assert.equal(Math.round(s.notes[0].velocity * 127), 127);
});

test('addNotes: no part at that position, unknown track', () => {
  assert.match(runKeys([{ op: 'addNotes', track: 'Keys', at: 9, notes: [{ pitch: 60, beat: 0, length: 1 }] }]).results[0].error, /no instrument part on Keys at 9 s/);
  assert.match(runKeys([{ op: 'addNotes', track: 'Nope', at: 4, notes: [] }]).results[0].error, /no track named Nope/);
});
```

Each result carries `op` because `McpTrackEdit.js:108` starts every result as `var r = { op: op.op }` and merges the op's fields into it.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/trackedittask.test.js`
Expected: the 3 new tests FAIL with `unknown op addNotes`.

- [ ] **Step 3: Implement the op** (append to `McpTrackOps.js`, ES5 only)

```js
// { track, at (seconds), notes: [{ pitch, beat, length, velocity }] }: notes into the
// instrument part covering `at`, beats relative to `at`. Goes through MusicFunctions,
// not a Musical Function, because Studio One disables those on a part with no notes
// (seen on 7.2.3), so this is how the first notes get into a new part.
mtoOps.addNotes = function (context, op) {
	var t = mtoTrack(context, op.track);
	if (t.error) return t;
	var root = context.functions ? context.functions.root : null;
	var mf = mtoFn(root, "createFunctions") ? root.createFunctions("MusicFunctions") : null;
	if (!mtoFn(mf, "createEvent") || !mtoFn(mf, "insertEvent") || !mtoFn(mf, "moveEvent")) return { error: "MusicFunctions are not available" };
	var at = typeof op.at === "number" ? op.at : 0;
	var list = mtoEvents(t.track), part = null;
	for (var i = 0; i < list.length; i++) {
		var ev = list[i];
		if (!mtoFn(ev, "createSequenceIterator")) continue;
		var s = mtoSeconds(ev.startTime), e = mtoSeconds(ev.endTime);
		if (s !== null && e !== null && s <= at + 0.001 && at < e - 0.001) { part = ev; break; }
	}
	if (!part) return { error: "no instrument part on " + op.track + " at " + at + " s (create one first)" };
	var anchor = mtoIn(context, at, 2), partStart = mtoIn(context, mtoSeconds(part.startTime), 2);
	if (anchor === null || partStart === null) return { error: "cannot convert positions to beats" };
	var base = anchor - partStart;
	var notes = op.notes || [], added = 0, errors = [];
	mf.executeImmediately = true;
	for (var n = 0; n < notes.length; n++) {
		var spec = notes[n], label = "note " + (n + 1) + ": ";
		if (!spec || typeof spec.pitch !== "number" || spec.pitch % 1 !== 0 || spec.pitch < 0 || spec.pitch > 127) { errors.push(label + "pitch must be an integer 0-127"); continue; }
		if (typeof spec.length !== "number" || !(spec.length > 0)) { errors.push(label + "length must be > 0 beats"); continue; }
		if (typeof spec.beat !== "number" || spec.beat < 0) { errors.push(label + "beat must be >= 0"); continue; }
		var note = mf.createEvent("Note");
		if (!note) { errors.push(label + "could not create a note"); continue; }
		var vel = typeof spec.velocity === "number" ? Math.max(1, Math.min(127, spec.velocity)) : 100;
		mf.insertEvent(part, note);
		mf.modifyPitch(note, spec.pitch);
		mf.modifyVelocity(note, vel / 127);
		if (mtoFn(mf, "freezeVelocity")) mf.freezeVelocity(note);
		mf.resizeEvent(note, spec.length);
		mf.moveEvent(note, base + spec.beat);
		added++;
	}
	mf.executeImmediately = false;
	return { track: op.track, part: part.name, added: added, errors: errors };
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: all PASS (including `device-files.test.js`/`install.test.js`, which package the device).

- [ ] **Step 5: Live check of the position semantics (Studio One must be running)**

Prerequisites already on this machine: loopMIDI port `studio-one-mcp`, External Device "MCP Bridge" receiving from it, song `mcp-prueba` open with instrument track `Claude Synth` (Mai Tai). Reinstall the device from this repo **without eval**, then restart Studio One and reopen `mcp-prueba`:

```bash
node scripts/install-device.js
```

Create a part starting at bar 3 and write one note at its start, then read it back (the server reads `STUDIO_ONE_MCP_MIDI_PORT`; after Task 1 the Windows default already matches):

```bash
node scripts/call-tool.js live_set_loop '{"start":"3.1.1.0","end":"4.1.1.0","enable":false}'
node scripts/call-tool.js live_select_track '{"name":"Claude Synth"}'
node scripts/call-tool.js live_command '{"category":"Instrument Parts","name":"Insert Instrument Part"}'
node -e "import('./src/bridge.js').then(async b=>{const s=(await b.call('setTransport',{positionBars:'3.1.1.0'})).position.seconds; console.log(JSON.stringify(await b.call('trackTask',{ops:[{op:'addNotes',track:'Claude Synth',at:s,notes:[{pitch:72,beat:0,length:1}]}]})))})"
node scripts/call-tool.js live_notes '{"track":"Claude Synth"}'
```

Expected: the new note (pitch 72) reports `"beat": 8` (bar 3 in 4/4). **If it reports 16 instead** (moveEvent takes song beats, not part-relative), change `var base = anchor - partStart;` to `var base = anchor;`, update the first addNotes test's expected `n.at` values to `[10, 11.5]` and its comment, rerun `npm test`, reinstall, recheck. Record the observed behaviour in the op's comment ("moveEvent takes part-relative beats (seen on 7.2.3)" or "song beats").

Clean up: `node scripts/call-tool.js live_undo '{"steps":2}'` (check with `live_notes` that the bar-3 part is gone; undo more if needed).

- [ ] **Step 6: Commit**

```bash
git add device/EditTasks/package/McpTrackOps.js test/trackedittask.test.js
git commit -m "MCP Track Edit: addNotes through MusicFunctions, works on empty parts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `src/compose.js` — create parts and write notes/chords/drums over the bridge

**Files:**
- Create: `src/compose.js`
- Test: `test/compose.test.js`

**Interfaces:**
- Consumes:
  - `call(op, args)` bridge function (from `src/bridge.js`); ops used: `'song'` → `{ transport: { playing, loop, position:{seconds}, loopRange:{start:{seconds}, end:{seconds}} }, selectedTracks: string[] }`; `'setTransport'` `{ positionBars }` → `{ position:{seconds} }` and `{ positionSeconds }`; `'setLoop'` `{ start, end, enable }` (seconds); `'selectTrack'` `{ name, exclusive }`; `'command'` `{ category, name }` → `{ executed }`; `'notes'` `{ track }` → `{ parts:[{ name, start, end, noteCount }] }`; `'trackTask'` `{ ops }` → `{ results }`.
  - `trackTask(call, op)` from `src/tracks.js` (throws on `r.error`).
  - `toMidi` (Task 2), `parseProgression`, `voice` (Task 2), `rhythmize` (Task 3), `drumGrid` (Task 3).
- Produces:
  - `createPart(call, { track, bar, bars = 1 }) → { track, part: { start, end } }`
  - `writeNotes(call, { track, bar, notes, createPart = true }) → { track, bar, added, errors, createdPart: boolean }`
  - `writeChords(call, { track, bar, progression, barsPerChord = 1, voicing = 'close', octave = 3, rhythm = 'sustain', velocity = 90 }) → writeNotes result + { chords: string[] }`
  - `writeDrums(call, { track, bar, bars = 1, pattern, stepsPerBeat = 4, velocity = 100 }) → writeNotes result`
  - All assume 4/4 (`BEATS_PER_BAR = 4`) for beat math; bar positions are converted to seconds by Studio One (so tempo is respected).

- [ ] **Step 1: Write the failing tests** — `test/compose.test.js`

```js
// Composition over a fake bridge: 120 bpm 4/4, so bar n starts at (n-1)*2 seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPart, writeNotes, writeChords, writeDrums } from '../src/compose.js';

function bridge({ parts = [], insertWorks = true } = {}) {
  const state = { loop: false, loopStart: 10, loopEnd: 20, position: 3, selected: ['Vox'], parts: parts.map((p) => ({ ...p })) };
  const calls = [];
  const barSeconds = (bars) => { const [b, beat = 1] = bars.split('.').map(Number); return (b - 1) * 2 + (beat - 1) * 0.5; };
  const call = async (op, args = {}) => {
    calls.push([op, args]);
    switch (op) {
      case 'song': return { selectedTracks: [...state.selected], transport: { playing: false, loop: state.loop, position: { seconds: state.position }, loopRange: { start: { seconds: state.loopStart }, end: { seconds: state.loopEnd } } } };
      case 'setTransport':
        if (args.positionBars) state.position = barSeconds(args.positionBars);
        if (typeof args.positionSeconds === 'number') state.position = args.positionSeconds;
        return { position: { seconds: state.position } };
      case 'setLoop':
        if (typeof args.start === 'number') state.loopStart = args.start;
        if (typeof args.end === 'number') state.loopEnd = args.end;
        if (typeof args.enable === 'boolean') state.loop = args.enable;
        return {};
      case 'selectTrack': state.selected = args.exclusive === false ? [...state.selected, args.name] : [args.name]; return { selected: state.selected };
      case 'command':
        if (args.name === 'Insert Instrument Part' && insertWorks) state.parts.push({ name: 'P', start: state.loopStart, end: state.loopEnd, noteCount: 0 });
        return { executed: insertWorks };
      case 'notes': return { track: args.track, parts: state.parts };
      case 'trackTask': {
        const o = args.ops[0];
        return { results: [{ op: o.op, track: o.track, part: 'P', added: o.notes.length, errors: [] }] };
      }
      default: throw new Error(`unexpected ${op}`);
    }
  };
  return { call, calls, state };
}

test('createPart: loop to the bar range, insert, restore loop and selection', async () => {
  const b = bridge();
  const r = await createPart(b.call, { track: 'Keys', bar: 3, bars: 2 });
  assert.deepEqual(r, { track: 'Keys', part: { start: 4, end: 8 } });
  assert.deepEqual([b.state.loopStart, b.state.loopEnd, b.state.loop], [10, 20, false]);
  assert.deepEqual(b.state.selected, ['Vox']);
  assert.ok(b.calls.some(([op, a]) => op === 'command' && a.category === 'Instrument Parts' && a.name === 'Insert Instrument Part'));
});

test('createPart restores the loop even when the insert fails', async () => {
  const b = bridge({ insertWorks: false });
  await assert.rejects(createPart(b.call, { track: 'Keys', bar: 1 }), /could not insert an instrument part/);
  assert.deepEqual([b.state.loopStart, b.state.loopEnd, b.state.loop], [10, 20, false]);
  assert.deepEqual(b.state.selected, ['Vox']);
});

test('writeNotes: creates a part covering every note (rounded up to whole bars), names → MIDI', async () => {
  const b = bridge();
  const r = await writeNotes(b.call, { track: 'Keys', bar: 2, notes: [{ pitch: 'C3', beat: 0, length: 4 }, { pitch: 64, beat: 3, length: 2 }] });
  assert.equal(r.createdPart, true);
  assert.equal(r.added, 2);
  assert.deepEqual(b.state.parts.map((p) => [p.start, p.end]), [[2, 6]]); // bar 2 → 2 s; 5 beats → 2 bars → 4 s
  const task = b.calls.find(([op]) => op === 'trackTask')[1].ops[0];
  assert.deepEqual(task, { op: 'addNotes', track: 'Keys', at: 2, notes: [{ pitch: 60, beat: 0, length: 4, velocity: 100 }, { pitch: 64, beat: 3, length: 2, velocity: 100 }] });
});

test('writeNotes: reuses a part that covers the range; refuses when createPart is false and none does', async () => {
  const b = bridge({ parts: [{ name: 'P', start: 0, end: 8, noteCount: 3 }] });
  assert.equal((await writeNotes(b.call, { track: 'Keys', bar: 2, notes: [{ pitch: 60, beat: 0, length: 1 }] })).createdPart, false);
  const c = bridge();
  await assert.rejects(writeNotes(c.call, { track: 'Keys', bar: 2, notes: [{ pitch: 60, beat: 0, length: 1 }], createPart: false }), /no part covers bar 2/);
  await assert.rejects(writeNotes(c.call, { track: 'Keys', bar: 0, notes: [{ pitch: 60, beat: 0, length: 1 }] }), /bar must be an integer >= 1/);
  await assert.rejects(writeNotes(c.call, { track: 'Keys', bar: 1, notes: [] }), /notes: one or more/);
});

test('writeChords: progression → voiced, rhythmized notes at song beats', async () => {
  const b = bridge();
  const r = await writeChords(b.call, { track: 'Keys', bar: 1, progression: 'Cm | Ab' });
  assert.deepEqual(r.chords, ['Cm', 'Ab']);
  const notes = b.calls.find(([op]) => op === 'trackTask')[1].ops[0].notes;
  assert.deepEqual(notes.map((n) => [n.pitch, n.beat, n.length]), [[60, 0, 4], [63, 0, 4], [67, 0, 4], [68, 4, 4], [72, 4, 4], [75, 4, 4]]);
});

test('writeDrums: grid over bars', async () => {
  const b = bridge();
  const r = await writeDrums(b.call, { track: 'Drums', bar: 1, bars: 2, pattern: { kick: 'x...x...x...x...', snare: '....x.......x...' } });
  assert.equal(r.added, 12);
  assert.deepEqual(b.state.parts.map((p) => [p.start, p.end]), [[0, 4]]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/compose.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/compose.js`**

```js
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
```

Check against the drums test: last hit snare at step 28 → beat 7 + 0.25 = 7.25 → span ceil(7.25/4)=2 bars → part 0..4 s ✓. Chords test: Ab close octave 3 = 68,72,75 ✓.

Known edge case, by design: if an existing part covers the start bar but not the whole span, a new part is created over the span and may overlap the old one. `addNotes` takes the first part (in time order) that covers `at`, so the notes can land in the old part. The `live_write_notes` description therefore says "write into an empty area, or into a part that covers the whole range".

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/compose.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/compose.js test/compose.test.js
git commit -m "Compose: create parts, write notes, chord progressions and drum grids

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: MCP tools + `live_edit_notes` add fallback + README

**Files:**
- Modify: `src/server.js` (imports; `live_edit_notes` handler at ~line 216; new tools after `live_add_instrument_track` ~line 463)
- Modify: `test/server.test.js:55-62` (tool name list)
- Modify: `README.md`

**Interfaces:**
- Consumes: `createPart`, `writeNotes`, `writeChords`, `writeDrums` (Task 5); `call` from `src/bridge.js`; `guard` in server.js.
- Produces: tools `live_create_part`, `live_write_notes`, `live_write_chords`, `live_write_drums`.

- [ ] **Step 1: Update the failing server test**

In `test/server.test.js` add the four names to the sorted list in `exposes the song and live tools`: `'live_create_part'` after `'live_command'`; `'live_write_automation', 'live_write_chords', 'live_write_drums', 'live_write_notes'` at the end of the live list (keep alphabetical order).

Run: `node --test test/server.test.js`
Expected: FAIL on the tool list.

- [ ] **Step 2: Register the tools in `src/server.js`**

Add import: `import { createPart, writeNotes, writeChords, writeDrums } from './compose.js';`

Add after the `live_add_instrument_track` tool:

```js
const PITCH = z.union([z.number().int(), z.string()]).describe('MIDI number or a name like "C3" (middle C = C3), "Eb4"');

server.tool(
  'live_create_part',
  'Create an empty instrument part on an instrument track in the running Studio One, from bar `bar` for `bars` bars (4/4). The loop range and track selection are put back. One live_undo removes it.',
  { track: z.string(), bar: z.number().int().describe('1-based bar'), bars: z.number().int().optional().describe('Default 1') },
  guard((a) => createPart(call, a)),
);

server.tool(
  'live_write_notes',
  'Write notes on an instrument track in the running Studio One, starting at bar `bar` (beats relative to that bar, quarter notes, 4/4). Makes a part covering the notes if there is none (create_part: false to refuse); write into an empty area or a part that covers the whole range. Works on new, empty parts. Pitches as MIDI numbers or names (middle C = C3). One live_undo per call. Read back with live_notes.',
  {
    track: z.string(),
    bar: z.number().int(),
    notes: z.array(z.object({ pitch: PITCH, beat: z.number(), length: z.number(), velocity: z.number().int().optional().describe('1-127, default 100') })),
    create_part: z.boolean().optional(),
  },
  guard(({ create_part, ...a }) => writeNotes(call, { ...a, createPart: create_part ?? true })),
);

server.tool(
  'live_write_chords',
  'Write a chord progression on an instrument track in the running Studio One from bar `bar`. Progression like "Cm7 | Ab | Eb Bb" (| separates bars; several chords in a bar share it) or "C G Am F" (one per bar). Chords: C, Cm, Cdim, Caug, Csus2, Csus4, C6, Cm6, C7, Cmaj7, Cm7, Cm7b5, Cdim7, C9, Cmaj9, Cm9, Cadd9, slash bass C/E. Voicing close|open|drop2, octave of the root (3 = middle C), rhythm sustain|quarters|eighths|arp_up|arp_down. 4/4. One live_undo per call.',
  {
    track: z.string(),
    bar: z.number().int(),
    progression: z.string(),
    bars_per_chord: z.number().int().optional(),
    voicing: z.enum(['close', 'open', 'drop2']).optional(),
    octave: z.number().int().optional(),
    rhythm: z.enum(['sustain', 'quarters', 'eighths', 'arp_up', 'arp_down']).optional(),
    velocity: z.number().int().optional(),
  },
  guard(({ bars_per_chord, ...a }) => writeChords(call, { ...a, barsPerChord: bars_per_chord })),
);

server.tool(
  'live_write_drums',
  'Write a drum pattern on an instrument track (a drum instrument such as Impact) in the running Studio One from bar `bar`, repeated for `bars` bars. One string per lane: x = hit, X = accent, . = rest, spaces and | ignored; 16 steps = one bar of 16ths by default. Lanes (General MIDI): kick, rim, snare, clap, closed_hat (hat), pedal_hat, open_hat, low_tom, mid_tom, high_tom, crash, ride, or a MIDI note number. Example: { kick: "x...x...x...x...", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." }. 4/4. One live_undo per call.',
  {
    track: z.string(),
    bar: z.number().int(),
    bars: z.number().int().optional(),
    pattern: z.record(z.string(), z.string()),
    steps_per_beat: z.number().int().optional(),
    velocity: z.number().int().optional(),
  },
  guard(({ steps_per_beat, ...a }) => writeDrums(call, { ...a, stepsPerBeat: steps_per_beat })),
);
```

Optional args that arrive as `undefined` (e.g. `barsPerChord: undefined`) still get their defaults, because destructuring defaults apply to `undefined`.

- [ ] **Step 3: `live_edit_notes` add on an empty part**

In the `live_edit_notes` handler, before calling `editNotes`, route a lone `add` op on a track whose parts hold no notes to `writeNotes` semantics via the track task. Replace the handler body with:

```js
  guard(async ({ track, ops }) => {
    if (ops.some((o) => o.op === 'add')) {
      const { parts } = await call('notes', { track, maxNotes: 1 });
      const empty = (parts || []).length > 0 && parts.every((p) => p.noteCount === 0);
      if (empty) {
        if (ops.length !== 1) throw new Error('the track\'s parts have no notes yet: send the add on its own first (or use live_write_notes), then the other operations');
        const first = parts[0];
        const r = await trackTask(call, { op: 'addNotes', track, at: first.start, notes: (ops[0].notes || []).map((n) => ({ ...n, beat: n.beat - (first.startBeat ?? 0) })) });
        return { track, applied: [{ op: 'add', count: r.added }], errors: r.errors, note: 'Added through MCP Track Edit (the part had no notes).' };
      }
    }
    const r = await call('editNotes', { track, ops: ops.map((o) => (o.op === 'quantize' ? { ...o, grid: gridBeats(o.grid) } : o)) });
    for (const p of r.parts || []) for (const n of p.notes) if (typeof n.pitch === 'number') n.note = noteName(n.pitch);
    return r;
  }),
```

`live_edit_notes` beats are song beats (as `live_notes` reports), while `addNotes` takes beats relative to `at`. The bridge's `notes` op does not report a part's start beat, so add it: in `device/StudioOneMCP/BridgeCore.js` `notes()`, inside the part object literal add
`startBeat: ev.startTime && has(ev.startTime, "musical", "number") ? Math.round(ev.startTime.musical * 1000) / 1000 : null,`
(the same `.musical` the notes use). With `first.startBeat`, `n.beat - first.startBeat` is relative to the part start, and `at: first.start` is that start in seconds.

This routing lives inside `server.js` (not exported). The live check in Task 7 Step 2 covers it with the `live_edit_notes` add on an empty part.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: README**

Add near the top of `README.md` (after the status line):

```markdown
> **This fork** (Windows + composition): tested on Windows 11 with Studio One 7.2.3. On Windows the doorbell is a [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html) port named `studio-one-mcp` (the default). Adds `live_create_part`, `live_write_notes`, `live_write_chords` and `live_write_drums`, and `live_edit_notes` can now add the first notes to an empty part. Based on [NeanderthalMan/studio-one-mcp](https://github.com/NeanderthalMan/studio-one-mcp) (MIT).
```

and add the four tools as rows to the live tools table, using the tool descriptions above (one sentence each).

- [ ] **Step 6: Commit**

```bash
git add src/server.js device/StudioOneMCP/BridgeCore.js test/server.test.js README.md
git commit -m "Tools: live_create_part, live_write_notes, live_write_chords, live_write_drums; add notes to empty parts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Live end-to-end check, secure install, register in Claude Code

**Files:**
- None created; may modify code if the live check finds bugs (then add a regression test in the owning test file).

**Interfaces:**
- Consumes: everything above; Studio One running with song `mcp-prueba` open.

- [ ] **Step 1: Reinstall the device without eval, restart Studio One**

```bash
node scripts/install-device.js
node src/cli.js doctor
```

Expected: `doctor` shows device installed **without** "live_eval enabled", edit-task extension installed, virtual MIDI port `studio-one-mcp`. Restart Studio One (it loads the device and extension at startup), open song `mcp-prueba`.

- [ ] **Step 2: Drive the success criteria through the MCP tools**

```bash
node scripts/call-tool.js live_status '{}'
node scripts/call-tool.js live_add_instrument_track '{"instrument":"Mai Tai","name":"E2E Keys"}'
node scripts/call-tool.js live_write_chords '{"track":"E2E Keys","bar":1,"progression":"Cm7 | Ab | Eb | Bb","rhythm":"arp_up"}'
node scripts/call-tool.js live_notes '{"track":"E2E Keys"}'
node scripts/call-tool.js live_add_instrument_track '{"instrument":"Impact","name":"E2E Drums"}'
node scripts/call-tool.js live_write_drums '{"track":"E2E Drums","bar":1,"bars":4,"pattern":{"kick":"x...x...x...x...","snare":"....x.......x...","hat":"x.x.x.x.x.x.x.x."}}'
node scripts/call-tool.js live_create_part '{"track":"E2E Keys","bar":6,"bars":1}'
node scripts/call-tool.js live_edit_notes '{"track":"E2E Keys","ops":[{"op":"add","notes":[{"pitch":72,"beat":20,"length":1}]}]}'
node scripts/call-tool.js live_set_transport '{"tempo":100}'
node scripts/call-tool.js live_set_channel '{"channel":"E2E Keys","field":"volume","value":0.6}'
node scripts/call-tool.js live_transport '{"action":"play"}'
node scripts/call-tool.js live_transport '{"action":"stop"}'
```

Expected:
- chords: `added` 32 and `createdPart: true`. `live_notes` shows the arpeggio notes, starting with beat 0 at pitch 60.
- drums: `added` 4×(4+2+8) = 56.
- `live_edit_notes` add: works, because the bar-6 part was empty. `live_notes` shows pitch 72 at beat 20.
- Tempo, volume, play and stop: each result reflects the change. If the mixer channel label differs from the track name, use `live_channels` to find it.

If any step fails, fix it, add a regression test, and rerun `npm test`.

- [ ] **Step 3: Clean up the test song**

Remove the E2E tracks (`live_track_edit` with action `remove` for `E2E Keys` and `E2E Drums`). Check with `live_tracks`.

- [ ] **Step 4: Register the server in Claude Code (user scope)**

```bash
claude mcp add -s user studio-one -- node "C:/Users/issac/Work/mcps/studio-one-mcp/src/server.js"
claude mcp list
```

Expected: `studio-one` listed as connected. The Windows MIDI port default comes from Task 1, so no env var is needed.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "Live-verified on Windows / Studio One 7.2.3

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
