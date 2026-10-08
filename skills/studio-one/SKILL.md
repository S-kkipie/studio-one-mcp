---
name: studio-one
description: Use when the user asks to do anything in Studio One (PreSonus DAW) — the open song, tracks, notes, chords, mixer, plug-ins, audio clips, export — or when mcp__studio-one__* tools or the studio-one-mcp CLI are available, or Studio One stops answering.
---

# Studio One through the studio-one MCP / CLI

## Overview
The `studio-one` MCP server drives the **running** Studio One 7 (Windows) through a bridge device, and reads saved `.song` files offline. Tools: `mcp__studio-one__live_*` (live song) and `song_*` (files on disk). The CLI `studio-one-mcp` covers setup, diagnostics and the ~1,400 raw Studio One commands.

**Core rule:** read the tool's schema (ToolSearch `select:` or its description) before calling it. Argument names are not guessable: positions are `at`/`bar`, not `position`, and send levels are 0..1, not dB.

## Start of every task
1. `live_status`: is the bridge reachable? If not, follow its fix text (see Troubleshooting).
2. `live_song`: the song title and whether transport is playing. Most edits need playback **stopped**.
3. `live_tracks`: exact track names and types (`Audio` / `Music` = instrument). Never guess names.
4. Before risky or big edits, run `live_save` (or `new_version: true`).

## Conventions
- **Positions:** seconds (number) or a bar string `"17.1.1.0"` (bar.beat.16th.tick, 1-based).
- **Pitches:** MIDI numbers or names, with middle C = **C3** = 60.
- **Plug-in names:** take them from `live_plugins` (they match the installed names, not the UI language).
- **Track name vs channel name:** mixer tools (`live_inserts`, `live_add_plugin`, sends) take the **channel** label. An audio track's channel usually has the track's name; an instrument's channel is its instrument (`live_add_instrument_track` returns `mixerChannel`). Confirm with `live_channels`.
- **Localized names:** global tracks follow the UI language ("Pista de acordes", "Pista de macadores"). Never look them up by English name.
- **Undo:** results often say how many `live_undo` steps revert them. Use that number, then check with `live_tracks` / `live_events`.

## Recipes
| Goal | Do this |
|---|---|
| Import audio file | `live_import_audio {file: absolute path, at: "17.1.1.0", track?}`. It creates its own track named after the file; do NOT add a track first. Check `stretched` (the song may stretch clips to tempo). |
| Process audio clips | `live_audio_process {track, action, event?}` (transients, quantize, normalize, reverse, merge, `event_fx` + plugin). Gain and fades: `live_events` edit. |
| Reverb/delay send | `live_add_send {channel, plugin: "Room Reverb"}` makes a NEW FX channel and send. Then use `live_set_send {channel, index, level: 0..1}`. Sending to an existing bus is not scriptable. |
| Bus / VCA / routing | `live_add_bus {tracks, kind}`, `live_track_edit {action:"route"}`. |
| Notes / chords / drums | `live_write_chords {track, bar, progression: "C Am F G"}` (one chord per bar unless `bars_per_chord`; `"Cm7 | Ab | Eb Bb"` packs bars), `live_write_notes`, `live_write_drums`. Read back with `live_notes`. |
| Chord track | `live_set_chords`, `live_chords`, `live_extract_chords`, `live_parts_from_chords`. |
| Groups | `live_groups list / create {tracks} / dissolve {group}`. Studio One picks the name. |
| Plug-ins | `live_plugins`, `live_add_plugin`, `live_plugin_params` / `live_set_plugin_param`, `live_plugin_presets`. |
| Export | `live_export {kind: "mixdown" or "stems", formats: ["mp3"]}`. The song must be **saved and stopped**. Files go to the song's Mixdown/Stems folder (or `output`), and the result lists them. The dialog flashes; your export settings are restored. |
| Anything else | `live_find_command "plain words"`, then `live_command_info`, then `live_command {command: "Cat/Name", args}`. |
| Saved song (no Studio One) | `song_list`, `song_read`, `song_diff`, `song_history`. |

## Ask first
Ask the user before: `live_record`, `live_write_automation` (both plays in real time), removing tracks or plug-ins, or adding sends they did not ask for. Never use `live_eval` (exploration only; it is usually disabled).

## CLI (`studio-one-mcp`, on PATH)
- `studio-one-mcp doctor`: checks every link (Studio One, loopMIDI port, device, MCP client) and prints fixes.
- `studio-one-mcp setup`: guided install.
- `studio-one-mcp cmd find <words>`, `cmd info "Cat/Name"`, `cmd run "Cat/Name" --Arg value [--check]`, `cmd refresh`.
- Without the MCP tools, `cmd run` still reaches every Studio One command.

## Troubleshooting
| Symptom | Fix |
|---|---|
| "did not answer within …ms" | Studio One may be blocked by a modal dialog (look at its window), busy rendering, or loopMIDI may not be running. Run `studio-one-mcp doctor`. |
| "bridge not loaded" / closed | No song is open, or Studio One was closed. Open a song. |
| "MCP Track Edit is not available right now" | A plug-in window has focus: close it (`live_plugin_window {action: "closeAll"}`). |
| Command "executed: false" | Nothing selected, or the wrong context. Select first (`live_select_track`, `live_select_events`). |
| A command opened a dialog | `live_command` cannot fill dialogs. Prefer the dedicated tool, or ask the user to finish it. |

**Not possible by script:** key signatures, group names, sidechain routing, sends to existing buses, envelope points (automation is recorded in real time).
