# Audio and mixing (sub-projects D/E) — design

Date: 2026-10-07
Status: the user asked to go ahead with D and E ("ya continúa e y d"); autonomy granted. Written spec.

## Goal

Claude can import audio files into the running song by path, process audio events (transients, Audio Bend quantize, normalize, reverse, merge, Event FX, Melodyne), and manage edit groups (list, create, dissolve).

## Already covered (not rebuilt)

- **Audio event gain and fades:** `live_events` edit `gain_db` / `add_gain_db` / `fade_in` / `fade_out`.
- **Buses, VCAs and routing:** `live_add_bus` (bus or VCA), `live_track_edit route`, folders.
- **FX sends to a new FX channel:** `live_add_send`.
- **Plug-in presets:** `live_plugin_presets`, P/P2.

## Spike facts (Studio One 7.2.3, 2026-10-07, verified live on `mcp-prueba`)

### The script function signatures

The script function signatures are in `Studio One.exe` as plain strings, for example `importFile (url: Url, time: MediaTime, targetTrack: Track = 0, flags: int = 0)`.

| Fact | Consequence |
|---|---|
| `functions.root.createFunctions("AudioFunctions").importFile(Host.Url("file:///C:/…wav"), time, track, 0)` imports with no dialog:<br>• the file is copied into the song's `Media/`;<br>• with `track: null`, a new audio track is made, named after the file (`beat95(3)`);<br>• with an empty audio track, Studio One renames that track to the file name. | Import by path. |
| **A wrong argument order** (`importFile(url, track)`) left Studio One stuck: a ghost "Pista 3", the bridge dead, the user's audio interface glitching system-wide. Only a kill or reboot fixed it. | Always pass the MediaTime second. Validate everything before the call. Never pass a non-audio track. |
| **Stretching:** with the song's "stretch audio files to song tempo" on (song.xml `stretch="1"`, track `tempoFollow="2"`), Studio One detects a tempo for the file (`AudioTempoMap tempo="0.5"`, i.e. 120 BPM, `tempoApproved="0"`) and stretches it. An 8 s WAV became 16 beats (10.1 s) at 95 BPM. `flags: 1` did not change it. | Report the placed length. For WAV files, also report the file's own duration and flag `stretched`. |
| **Audio commands:** with the events selected (bridge `selectEvents {tracks}` or track op `selectEvent`), these all ran with no dialog and returned executed:<br>• `Audio/Detect Transients` (writes bend markers: `ClipData/Audio/<clip>/….audiobendx`)<br>• `Event/Quantize` (Audio Bend quantize on audio)<br>• `Audio/Normalize Audio`<br>• `Audio/Reverse Audio` (renders a new file into `Bounces/`) | Audio processing tool. |
| **Enabled on a selected audio event:** `Audio/Merge to Audio Part`, `Audio/Edit with Melodyne`, `Audio/Apply Audio Bend`, `Audio/Remove Bend Markers`, `Audio/Insert Event FX`, `Audio/Render Event FX`, `Event/Quantize 50%`.<br>**Not in the tool:** Strip Silence, Detect Tempo, Separate Stems (they may open panels or dialogs). | Included as actions. The excluded commands stay reachable through `live_command`. |
| `Audio/Insert Event FX` takes `mode` (1 = plug-in), `cid` (class ID), `preset` (relative path or ""), `tail` (s), per the factory `Insert FX.js`. A class ID comes from `Host:PlugInMenuParam` (`mtoPluginClass`, category "AudioEffect"). | `event_fx` action. |
| **Groups:** `Track/Group Selected Tracks` (two or more tracks selected) opens a modal `CCLDialogClass` "Añadir Grupo" (title localized).<br>• Enter (posted VK_RETURN) creates the group with Studio One's default name: the tracks' common prefix ("beat").<br>• Typed text (posted WM_CHAR or key presses) does not reach its name field.<br>• `channel.editGroup` (edit-task track's channel) reads the group name, or undefined. Assigning to it does nothing.<br>• `Track/Dissolve Group` (group tracks selected) removes it with no dialog. | Groups: list, create (default name, reported), dissolve. No custom names. |
| **Sends and sidechain:** the edit-task channel has `Sends` and `inserts` folders. No script call was found that targets an existing bus/FX channel, or a plug-in's sidechain input, without guessing arguments. Guessing could crash Studio One (it crashed three times during the hang above). | Out of scope: sends to existing channels, sidechain routing. |
| `Media/Remove Unused Files` opens a confirm dialog listing the files. | Test cleanup only, not a tool. |

## Tools

### `live_import_audio { file, track?, at? }`

Imports an audio file (absolute path; wav, aif, mp3, flac, ogg… whatever Studio One reads) into the running song.

**Arguments:**
- `track`: an existing **audio** track (exact name), or omitted for a new track.
- `at`: seconds or bars (`toSeconds`); default 0.

**Returns:** `{ track, event: { name, start, end, length }, newTrack: bool, renamedFrom?, fileSeconds?, stretched?, note? }`.
- `track` is the track that holds the clip, after any Studio One rename.
- `fileSeconds` is given for WAV files, read from the header.
- `stretched` is true when the placed length differs from `fileSeconds` by more than 2%, with a note explaining tempo stretching.

**Errors:** a missing file, a non-file path, or a track that is not an audio track. All are checked before Studio One is touched.

**Undo:** one `live_undo` (one task run).

### `live_audio_process { track, action, event?, plugin?, preset?, tail? }`

Runs one audio command on one event (number from `live_events` list, or name) or on all events of an audio track.

**Actions:**
- `detect_transients`
- `quantize`
- `quantize_50`
- `apply_bend`
- `remove_bend_markers`
- `normalize`
- `reverse`
- `merge`
- `melodyne`
- `event_fx` (needs `plugin`; optional `preset` relative path and `tail` seconds, default 2)
- `render_event_fx`

**Selection:** the event selection is made with `selectEvent`, or with `selectEvents {tracks}` for all events. Afterwards the event selection is cleared and the previously selected tracks are reselected.

**Returns:** `{ track, action, command, events }`, where `events` is the track's events afterwards, from `live_events` list.

**Errors:**
- `executed: false` gives "Studio One could not run X on that selection".
- A busy transport gives "stop playback first".
- A track that is not audio is refused.

### `live_groups { action: list | create | dissolve, tracks?, group? }`

- **`list`:** `{ groups: [{ name, tracks: [...] }] }` from `editGroup`.
- **`create { tracks }`** (two or more exact names):
  1. Select the tracks.
  2. Run `Track/Group Selected Tracks`.
  3. Press OK on the new modal dialog (`driveExportDialog`, under `withDialogLock`).
  4. Return the group name Studio One gave, `{ group, tracks }`.
  - Refused when any of those tracks is already in a group.
- **`dissolve { group }`:** select that group's tracks, run `Track/Dissolve Group`, then verify they are ungrouped.

**Selection:** the track selection is restored afterwards. Windows only for `create`; `list` and `dissolve` work everywhere.

## Architecture

- **Device:** `device/EditTasks/package/McpTrackOps.js` gets new ops. Every host member is checked before use; nothing throws.
  - `importAudio { file, at, track? }`: `file` is an absolute path with forward slashes. The op checks that the file exists (`Host.IO.File(url).exists()`), that the track is an audio track, and that `at` is a MediaTime. It returns `{ imported: true }` or `{ error }`.
  - `editGroups {}` returns `{ tracks: [{ name, group }] }`, with `group` null when ungrouped.
  - `pluginClass { plugin }` returns `{ cls, name }`.
- **Server:**
  - `src/audio.js`: `importAudio(call, args, deps)` and `processAudio(call, args)`. `wavSeconds(buf)` parses RIFF/WAVE `fmt`/`data` chunks.
  - `src/groups.js`: `listGroups(call)`, `createGroup(call, args, deps)`, `dissolveGroup(call, args)`.
  - Tools are registered in `src/server.js`.
- **Import placement:** the server diffs `call('tracks', { events: true, maxEvents: 500 })` before and after. The new event is the one not present before (matched by track name, name and start). The new track is the track name not present before.

## Error handling

- Every pre-check happens before the device call (file exists, absolute path, audio track, transport stopped).
- When the import ran but no new event is found, return `{ imported: true, note: "imported, but the new clip could not be identified; check live_tracks" }` rather than throwing.
- **Groups `create`:**
  - When no dialog appears, the bridge call is abandoned and an error is reported.
  - When the dialog was pressed but no group shows up in `editGroups`, a "no group was created" error.

## Testing

- **Unit:**
  - `wavSeconds` on built buffers: 16-bit stereo, 24-bit mono, an extra chunk before data, not a WAV.
  - `importAudio` with a fake `call`: argument validation, new track vs. existing track, the rename detection, `stretched`, unidentified clip.
  - `processAudio`: the action → command map, single event vs. all events, `event_fx` args, `executed:false`, selection restore.
  - Groups with a fake `call` and a fake dialog driver.
  - Device ops with a fake context: `importAudio` checks and the call order, `editGroups`, `pluginClass` errors.
- **Live, on `mcp-prueba`, Studio One minimized:**
  1. Import a generated WAV at bar 3 onto a new track, then onto that track at bar 9.
  2. Process: transients, quantize, normalize, reverse, event FX (Pro EQ), then undo.
  3. Groups: create on the two tracks, list, dissolve.
  4. Clean up: remove the tracks, Remove Unused Files, delete the media files, save.

## Out of scope

- Sends to existing buses or FX channels, and sidechain routing. No safe script path was found.
- Custom group names, renaming groups, suspending groups (suspend commands stay in `live_command`).
- Strip Silence, Detect Tempo, Separate Stems (dialogs and panels).
- Controlling tempo stretch on import.
- Channel Editor (UI only).
