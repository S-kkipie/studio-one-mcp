# Instruments + in-place preset I/O (sub-project P2) — design

Date: 2026-10-07
Status: direction approved in chat ("dale sigue con todo"); written spec

## Goal

1. Control **instrument plug-ins** (drums, bass, synths, samplers; e.g. MODO BASS, Impact, Mai Tai, MT-PowerDrumKit and any installed later) the same way as insert effects:
   - read and set parameters, for native plug-ins and for third-party ones through state;
   - list and load presets;
   - open the editor window;
   - list instruments.
2. Replace the current third-party state backend with **in-place preset I/O**:
   - read a plug-in's state **without saving the user's song**;
   - load an edited state **into the same instance**, with no replace-slot, so the mixer channel, routing and position are untouched.

## Spike facts (2026-10-07, Studio One 7.2.3) — verified live

| Fact | Consequence |
|---|---|
| An insert slot's FX component (`pluginOf(...).device.parent`) and an instrument's component (`ActiveDocument/Environment/Synths` → `find("InstNN")`) both accept `interpretCommand("Presets", "Export Preset" \| "Load Preset File" \| "Store Preset" \| "Import Preset")`, aimed at that plug-in with no UI focus. | Preset I/O addressed per plug-in. |
| Those commands open a **standard Windows file dialog** (class `#32770`, titles "Exportar preset" / "Cargar preset" in the Spanish UI; the filename edit is control id `0x47C`; OK is id `1`; Cancel is id `2`). The `interpretCommand` call blocks until the dialog closes. | The server fills the dialog with WM_SETTEXT and BM_CLICK while the bridge call is pending. |
| Export wrote a correct `.preset` (Pro EQ) and `.vstpreset` (Archetype) of the current state, without saving the song. Loading an edited file applied it **to the same instance**: Pro EQ `lfgain` 6→-3 and Archetype `inputGain` 0→4, with the slot count unchanged. | The state backend no longer needs a song save, re-indexing, scratch presets or replace-slot. |
| Instrument components are named `Inst01..`. `find("Device")` is the plug-in, and its title is the instrument name (Mai Tai, Mai Tai 2, Impact). They also accept `Device/Remove` and `Device/Edit`. | Instrument addressing. |
| The plug-in object's own `interpretCommand` returns 0 for preset commands, and the global `Presets/*` commands act on whatever UI object has focus (once it exported the color palette). | Always use the slot component, never the global commands. |
| The song stores instrument state as `Presets/Synths/<n> - <name>.(vstpreset\|fxpreset)` (`Devices/audiosynthfolder.xml` → `presetPath`). | Song-save fallback path for instruments (non-Windows). |

## Architecture

```
tools (target = { channel, slot } | { instrument })
   │
controller.js ── resolveTarget(): insert slot or instrument → bridge target spec
   │
   ├─ native backend: bridge pluginParams/setPluginParam, extended to instrument targets (Device.findParameter)
   ├─ state backend (rewritten): presetio.exportState → edit (vstpreset/xml + stateScale) → presetio.loadState
   └─ presets: list via PresetParam (cid); load by preset file path → presetio.loadState
   │
presetio.js (new) ── bridge op `presetCommand {target, command}` (blocks on the dialog)
                   + fileDialog.fill({ path, kind }) (PowerShell, Windows) in parallel
```

### Bridge ops (`device/StudioOneMCP`, null-safe, no eval)

- `instruments {}` → `[{ index, component: "Inst01", name, classId? }]`, read from the Synths folder by iterating `Inst01..Inst99` until two misses in a row.
- Target spec, accepted by `pluginParams`, `setPluginParam`, `presetCommand`, `openPluginEditor`: `{ channel, slot }` (insert) or `{ instrument }` (name, or component `InstNN`).
- `presetCommand { target, command: "Export Preset" | "Load Preset File" }` runs `component.interpretCommand("Presets", command, false)` and returns `{ ok }`. It checks with `interpretCommand(..., true)` first.

### Server

- `src/plugins/filedialog.js`:
  - `fillFileDialog({ path, expect: 'export' | 'load', timeoutMs })` polls for a `#32770` window of the Studio One process (≤ 5 s), sets the filename, clicks OK, and waits for the dialog to close.
  - If an overwrite-confirm dialog appears, it answers it. Paths are always fresh temp names, so overwrite should not happen.
  - On failure it clicks Cancel (id 2), so the bridge call returns.
  - The script is static, with arguments passed through env or argv; there is no string interpolation into PowerShell.
  - Windows only; other platforms report "not supported" and the controller falls back.
- `src/plugins/presetio.js`:
  - `exportState(call, target)` builds a temp path in `os.tmpdir()/studio-one-mcp/<uuid>.<ext>`, sends the bridge `presetCommand Export` and the dialog fill concurrently, reads the file (it may come back with `.vstpreset` or `.preset` appended; glob the uuid), deletes it, and returns `{ ext, buf }`.
  - `loadState(call, target, buf, ext)` writes the temp file, sends `presetCommand Load` with the dialog fill, then deletes the file.
  - Both run inside the controller's existing serial queue.
- State backend rewrite (`state.js`):
  - `readPluginState` uses `exportState`.
  - `writePluginParams` = export → edit (existing `stateKeys` / `stateScale` logic) → `loadState`.
  - `replaceSlot` stays only for `live_plugin_presets load` when no preset file path is known.
  - The song-save path stays as the non-Windows fallback, and results say which source was used.
- Presets for any target:
  - **list:** PresetParam names, as today.
  - **load:** find the preset **file** on disk, in Studio One's preset roots (install `Presets/`, `Documents/Studio One/Presets`) and the vendor's own presets where the format matches (`.preset`, `.fxpreset`, `.vstpreset`). Match by name, then `loadState` it in place.
  - If no file is found, fall back to `replaceSlot` for inserts, or report "not loadable in place" for instruments.
- Instruments in tools:
  - `live_plugin_params`, `live_set_plugin_param`, `live_plugin_presets` and `live_plugin_window` accept `instrument` instead of `channel` + `slot`.
  - New `live_instruments` lists instruments with name, backend and the track(s) they feed (from `live_tracks` + the channel label).
- Fix the parked issues:
  - `addInstrumentTrack` / `addPlugin` / `addFxSend` use the 30 s timeout and re-read on a thrown call;
  - on/off text is accepted only for boolean or two-choice params.

## Error handling

- The dialog never appears (within 5 s): the bridge call is still pending, so the server cannot cancel it. It reports "Studio One did not show the preset dialog" and the request times out normally. This case is unlikely, since `interpretCommand(check)` ran first.
- The dialog appears but the fill fails: click Cancel, then report.
- Temp files are deleted in `finally`.
- The user's screen: the file dialog appears for under a second. Tool descriptions say a Studio One dialog flashes briefly.

## Testing

- **Unit:** filedialog script generation (no interpolation); presetio with a fake bridge and a fake dialog filler (ordering, timeout, Cancel path, cleanup); state backend with the export/load fakes; instrument target resolution; tool schemas.
- **Live, on `mcp-prueba`:**
  - Archetype set/read with no song save: check the song is not dirty, or its mtime is unchanged;
  - Pro EQ preset load in place;
  - Mai Tai (instrument, native) param set;
  - Impact (instrument) preset list and load;
  - MODO BASS: added as an instrument track, presets listed or loaded where files exist, params opaque-explained;
  - Archetype window open via the instrument/insert target.

## Out of scope

- macOS dialog automation (song-save fallback stays).
- Multi-output instrument routing, Note FX.
