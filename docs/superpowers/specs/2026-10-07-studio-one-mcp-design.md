# Studio One MCP — Windows fork + composition layer (design)

Date: 2026-10-07
Status: implemented on branch main-windows (2026-10-07)

## Goal

Let Claude control a running Studio One 7 on Windows (live control, song analysis,
MIDI composition) through MCP. Build on
[NeanderthalMan/studio-one-mcp](https://github.com/NeanderthalMan/studio-one-mcp)
(MIT) instead of starting from scratch: its file-mailbox bridge plus loopMIDI
doorbell was verified working on this machine (Windows 11, Studio One 7.2.3) in a
spike on 2026-10-06.

## Success criteria

1. `npm test` passes on Windows.
2. With a song open, Claude can, through MCP tools only: create an instrument
   track, create a part, write notes into an empty part, write a chord progression
   and a drum pattern, play/stop, change tempo and a channel volume.
3. The bridge is installed without `--allow-eval` and the server is registered in
   Claude Code (user scope).

## Repository

- This folder is a clone of upstream; remote `upstream` = NeanderthalMan's repo,
  work on branch `main-windows`. Keep the MIT LICENSE and credit upstream in the README.
- Follow upstream conventions: ESM Node ≥ 20, `node --test`, zod schemas, tools
  registered in `src/server.js`, bridge ops in `device/StudioOneMCP/BridgeCore.js`,
  edit tasks in `device/EditTasks/package/`.

## 1. Windows fixes

| Problem (seen in spike) | Fix |
|---|---|
| Default MIDI port name is `IAC` → "No MIDI output matching IAC" | On `win32` default to `studio-one-mcp` (loopMIDI port name used by setup); `STUDIO_ONE_MCP_MIDI_PORT` still overrides. |
| `scripts/call-tool.js` builds `C:\C:\…\server.js` | Use `fileURLToPath(new URL(...))`. |
| 11/172 unit tests fail on Windows (URL vs path, separators, npx entry) | Fix code where the bug is real, make tests path-portable where the test is wrong. |

## 2. Notes into empty parts

Spike finding: Studio One disables every Musical Function (including the bridge's
`Musical Functions/MCP Edit` task and the built-in Quantize) when the selected part
has no notes, so `live_edit_notes` `add` fails on a fresh part.

Fix: a new `addNotes` op in the **MCP Track Edit** task (`McpTrackOps.js`), which
needs no selection. It finds the track by name and the part covering the target
position, gets `context.functions.root.createFunctions("MusicFunctions")`, and per
note does `createEvent("Note")` → `insertEvent(part, note)` → `modifyPitch` →
`modifyVelocity` (+`freezeVelocity`) → `resizeEvent(length beats)` →
`moveEvent(start beat)`. This exact sequence worked in the spike. All notes of one call are one
undo step (`beginMultiple`/`endMultiple` when available, `endMultiple` always runs).
`addNotes` takes an optional `end` (seconds): among the parts covering `at` it prefers one that
also covers `end`, the one ending latest if several do. Notes running past the chosen part's end
are reported as per-note errors (`note N: ends after the part`) and skipped.

`live_edit_notes` with an `add` op routes to this path when the track's parts hold
no notes; other ops are unchanged.

## 3. New composition tools

All positions are bars (1-based, `"9"` or `"9.1.1.0"`) or beats; lengths in beats.
Pitches accept MIDI numbers or names with Studio One's convention, **middle C = C3
= 60** (`C3`, `Eb4`, `F#2`).

| Tool | Input | Behaviour |
|---|---|---|
| `live_create_part` | `track`, `bar`, `bars` | Select track → `Instrument Parts/Insert Instrument Part` (lands as a one-bar part at a fixed spot unrelated to the playhead and loop) → find the new part by diffing the track's events → move and resize it with the edit task (`editEvent` to + end; only what is needed) → restore selection. The result's `undoSteps` is 1 when the insert already landed right (one `live_undo`), 2 when a move/resize was needed (verified live). Returns the part and `undoSteps`. |
| `live_write_notes` | `track`, `bar`, `notes[{pitch, beat, length, velocity?}]`, `create_part` (default true) | Creates a part covering the notes if none covers `bar`, then `addNotes`. Beats are relative to `bar`. Refuses (error) when a part overlaps the range without covering it, instead of writing into the wrong part. Returns `partUndoSteps` (0 when no part was created, else createPart's `undoSteps`). |
| `live_write_chords` | `track`, `bar`, `progression` (`"Cm7 \| Ab \| Eb \| Bb"`), `bars_per_chord` (1), `voicing` (`close`\|`open`\|`drop2`, default close), `octave` (3), `rhythm` (`sustain`\|`eighths`\|`quarters`\|`arp_up`\|`arp_down`), `velocity` (90) | Theory module → notes → `live_write_notes`. |
| `live_write_drums` | `track`, `bar`, `bars` (1), `pattern` {`kick`: `"x...x...x...x..."`, …}, `steps_per_beat` (4), `velocity` (100, `X` = accent 120) | Lanes map to General MIDI pitches (kick 36, snare 38, clap 39, rim 37, closed_hat 42, open_hat 46, pedal_hat 44, low_tom 45, mid_tom 47, high_tom 50, crash 49, ride 51); a raw MIDI number is also accepted as lane name. Pattern repeats for `bars`. |

### Theory module (`src/theory/`)

Pure functions, no Studio One dependency, fully unit-tested:

- `noteName ↔ midi` (C3 = 60, sharps/flats).
- `parseChord(symbol)` → root + intervals. Supports maj, m, dim, aug, sus2,
  sus4, 6, m6, 7, maj7, m7, m7b5, dim7, 9, maj9, m9, add9, slash bass (`F/A`).
  Unknown symbol → error naming it.
- `parseProgression("Cm7 | Ab | Eb | Bb")` (bars separated by `|`, several
  chords in one bar split it evenly).
- `voice(chord, {voicing, octave})` → MIDI pitches.
- `rhythmize(pitches, {rhythm, beats, velocity})` → notes.
- `drumGrid(pattern, {bars, stepsPerBeat, velocity})` → notes.

## 4. Security

Reinstall the bridge without `--allow-eval` (spike install had it on). `live_eval`
remains available only to users who opt in.

## 5. Error handling

- Tools return MCP tool errors (not crashes) with an actionable message: unknown
  track, no song open, bad chord symbol, Studio One not answering (existing
  messages kept).
- `live_create_part` restores the selection even when inserting fails; if a step after the insert fails, the error says where the stray part was left (there is no clean single-event delete; `live_undo` removes it).
- `addNotes` reports per-note errors (pitch out of 0–127, non-positive length)
  and applies the valid ones.

## 6. Testing

- Unit: theory module, tool argument handling and part-creation flow with the
  bridge mocked (upstream test helpers), Windows-portable path tests.
- Live (`npm run test:live`, manual): against song `mcp-prueba` — create track,
  part, write notes/chords/drums, read back with `live_notes`, undo.

## Out of scope

- Writing `.song` files offline (risk of corrupting songs). Reading stays.
- `.mid` export (possible next step).
- macOS changes beyond keeping upstream behaviour intact.
