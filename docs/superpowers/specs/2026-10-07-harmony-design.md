# Harmony and chord track (sub-project C) — design

Date: 2026-10-07
Status: direction approved in chat ("si go"). Written spec.

## Goal

Claude can read and write the running song's **chord track**, take chords from a track's parts (MIDI or audio), generate instrument parts from the chord track, and see the chords and key in saved songs.

## Spike facts (2026-10-07, Studio One 7.2.3, verified live)

| Fact | Consequence |
|---|---|
| A TrackEdit task's `context.editor.model.chords.getChordTrack()` returns the chord track whatever the UI language (its name was "Pista de acordes"). `createIterator()` yields ChordEvents with `startTime`/`endTime` (MediaTime; `.seconds`) and `chord` (`name` "Cm"/"G"/"Em", `root`, `type`, `bass`). The iterator yields events newest-first, so sort them by start. | Live read through a new MCP Track Edit op. |
| `chord.root` is a circle-of-fifths index (C=0, G=1, D=2, A=3, E=4…), not a semitone. `type` 0 is major, 1 is minor. | Use `chord.name`. For the saved file, derive names from root plus the intervals mask. |
| `editor.model.chords.addChordEvent(track, start, end)` adds an event that copies the previous chord. Setting `chord.root`/`chord.type` or renaming the event has no effect, and no setter exists. | Chords cannot be written field by field. |
| `Event/Extract to Chord Track` (no dialog) on the selected events of an instrument part wrote the exact chords: `G D Em C` written by `live_write_chords` at bars 3–6 came back as G, D, Em, C events at those bars. It also works on audio events (Studio One's audio chord detection). | Writing = notes in a scratch part → extract → remove the scratch track. |
| `context.functions.removeEvent(chordEvent)` removes chord events. The removal shows after the task run ends, not within the same run. | Replace a range before extracting into it. |
| `live_add_track {type:'instrument'}` adds an instrument track with no instrument ("Pista 2"). `Song/Remove Track` removes the selected track (no dialog, enabled). | Scratch track lifecycle. |
| `Instrument Parts/Insert Instrument Parts from Chord Track` (no dialog), with an instrument track selected, made one part per chord with close voicings (G3 B3 D4…). One `live_undo` reverted it. | Parts from chords. |
| `Edit/Insert Key Signature` declares `Bar, Key` but was disabled in the arrangement. Key signatures are not on the script model (`editor.model.signatures` has no members). The saved song has `<KeySignatureMap><Attributes root="0" scale="" start="0"/>`. | Key is read-only, from saved songs. |
| The saved song: `<ChordTrack …><ChordEvent timeFormat="2" length="4" [start="…"]><Attributes x:id="chord" root="0" intervals="FF 0 0 FF 0 0 0 FF 0 0 0 0" type="1"/>`. `start` and `length` are in beats, `start` is omitted at 0, and the intervals are 12 slots (`FF` = present) from the root. | Offline chord names. |
| Per-track "follow chords" is not exposed on the track object. | Out of scope. |

## Tools

- **`live_chords { from?, to? }`:** the chord track's events, sorted: `[{ chord: "G", start: 5.053, end: 7.579, startBar?: "3.1.1.0" }]`.
  - `from` and `to` are seconds or bars (`toSeconds`) and filter to events that overlap the range.
  - Bars come from the bridge's position conversion when it is cheap. Otherwise only seconds are given; see Plan.
- **`live_set_chords { bar, progression, bars_per_chord?, replace? = true }`:** writes the progression onto the chord track starting at `bar`. It uses the same progression syntax as `live_write_chords` (`"G D Em C"`, `"Cm7 | Ab | Eb Bb"`).
  1. Compute the range in seconds.
  2. If `replace` is set, remove every chord event that overlaps the range. Report the removed events, and warn when one extended outside the range.
  3. Add a scratch instrument track (named by the diff).
  4. Create a part covering the range on it and `writeChords` the progression there (sustain, close voicing).
  5. Select the scratch track's events and run `Event/Extract to Chord Track`.
  6. In `finally`, select the scratch track and run `Song/Remove Track`.
  7. Read back the chords in the range and return `{ written: [...requested symbols], chords: [...read back], mismatches?: [...], undoSteps: n }`.
  - Studio One names the chords itself, so `Cmaj7` may read back as `CM7`. Mismatches are compared by pitch-class set when possible, else by name.
  - The selection is restored afterwards: the previously selected tracks.
- **`live_extract_chords { track }`:** selects every event on that track (instrument parts or audio) and runs `Event/Extract to Chord Track`, then returns `live_chords`. It is one undo step.
- **`live_parts_from_chords { track }`:** selects that instrument track and runs `Insert Instrument Parts from Chord Track`. It returns the parts that were added (a diff of `live_notes` parts: name, start, end, notes) and is one undo step.
- **`live_clear_chords { from?, to? }`:** removes the chord events that overlap the range, or all of them. It returns the removed events and is one undo step (one task run).
- **`song_read` / summary:** adds `chords: [{ chord, startBeat, lengthBeats, bar }]` and `keySignatures: [{ root: "C", scale, startBeat }]` from the saved file.

## Architecture

- **Device:** new ops in `device/EditTasks/package/McpTrackOps.js`. Every host member is checked before use, and nothing throws.
  - `chords { from?, to? }` returns `{ chords: [{ name, start, end }] }`, filtered to overlap.
  - `removeChords { from?, to? }` returns `{ removed: [{ name, start, end }] }`.
  - Both use `context.editor.model.chords.getChordTrack()`. If anything is missing they return `{ error: "the chord track is not available" }`.
- **Server:** `src/harmony.js` exports `listChords`, `setChords`, `extractChords`, `partsFromChords` and `clearChords`, built on `trackTask`, `call('addTrack')`, `call('selectEvents')`, `call('selectTrack')`, `call('command')`, and `createPart`/`writeChords` from `src/compose.js`.
- **Offline:** `src/theory/chordnames.js` provides `chordName(rootFifths, intervalsMask, type?) → "Cm"` and `fifthsToPitchClass`. `src/song.js` parses ChordTrack and KeySignatureMap.

## Error handling

- **Busy transport:** if Studio One is playing or recording, `set`/`extract`/`parts` fail with "stop playback first".
- **Scratch track removal fails** in `live_set_chords`: report it with the track's name ("remove track X by hand") and never throw it over the main error.
- **Extract did not run** (`executed:false`): report "nothing to extract from (empty part?)".
- **Unknown track:** the usual "no track named X".
- **Chord track unavailable** (an old device or no edit context): a clear error that suggests reinstalling the device.

## Testing

- **Unit:**
  - the device ops with a fake context (chord track iterator, removeEvent, missing members);
  - `chordName` against a table of masks (major, minor, 7, maj7, m7, dim, aug, sus2, sus4, m7b5, dim7, 6, m6, add9) and fifths roots;
  - `song.js` parsing of a ChordTrack/KeySignatureMap fixture;
  - `harmony.js` flows with a fake `call` (the order of ops, scratch track cleanup in `finally` on errors, selection restore, replace semantics, mismatch detection);
  - the tool schemas.
- **Live, on `mcp-prueba`:**
  1. `live_set_chords {bar:3, progression:"G D Em C"}`, then `live_chords` shows them, with no extra tracks left.
  2. Replace bars 4–5 with `"Am F"`; the neighbours stay.
  3. `live_parts_from_chords {track:"Claude Synth"}`, then undo.
  4. `live_extract_chords` from the Claude Synth part.
  5. `live_clear_chords` for a range.
  6. Save, and `song_read` shows the chords.

## Out of scope

- Writing key signatures or scales (not reachable).
- Per-track follow-chords modes and chord track playback settings.
- Harmonic editing of audio (Audio/Apply Chords from Chord Track can be run through `live_command`).
