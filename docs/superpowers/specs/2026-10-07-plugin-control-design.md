# Plug-in control (sub-project P) — design

Date: 2026-10-07
Status: approved direction in chat ("con todo: todo lo instalado y lo que instale después"); written spec

## Goal

Claude can control every plug-in installed on this machine, and any plug-in installed later, without per-plug-in manual work:

- know a plug-in's parameters, with name, unit, range and current value;
- set any parameter;
- list, load and save presets;
- insert, remove, bypass, and open or close plug-in windows.

## What the spikes established (2026-10-07, Studio One 7.2.3)

| Fact | Consequence |
|---|---|
| The bridge's `findParameter(name)` only answers PreSonus-native internal names (e.g. `lffreq`). It ignores VST3 names and IDs. | Realtime set-by-name works only for PreSonus plug-ins. |
| Studio One's automation dialog lists every host parameter, but no script API reaches that list. | Parameter lists must come from outside Studio One. |
| An offline VST3 host (Python `pedalboard`) lists host parameters with name, unit and display text. Archetype Petrucci X has 156. | A scanner can build a catalog for every VST3 automatically. |
| Some vendors hide parameters from hosts: IK MODO BASS shows only Bypass, and AmpliTube 5 fails to scan. | The catalog marks those plug-ins "opaque". They fall back to vendor adapters or presets. |
| `Host:PresetParam` + Class:ID lists the presets Studio One indexes. `DeviceEditFunctions.insertDevice(folder, presetObj)` inserts with a preset. A file dropped into `Documents/Studio One/Presets/<Vendor>/<Plug-in>/` plus `Presets/Re-Index Presets` gets indexed. | Presets and state injection are possible for any plug-in Studio One can load. |
| Neural DSP ignores host-side parameter changes in its saved state. Its presets are JUCE ValueTree binaries with `PARAM id/value`. Its MIDI mappings live in `%APPDATA%/Neural DSP/<Plug-in>/MIDI/*.xml` (`<midi><routings/></midi>`). | Neural DSP needs a vendor adapter, either native preset writing or MIDI routings. |
| The insert slot element in the bridge exposes `getParamCount/getParamTitle/getParamValue/setParamValue`, covering Bypass plus "MIDI CC ch\|cc" (2080 entries on Archetype). | Possible realtime path via MIDI CC for plug-ins with MIDI mapping. Still needs a live check. |
| A focused or open plug-in window makes Track edit-task commands unavailable. A JS error in an edit task pops a modal dialog that blocks the bridge. | Close plug-in windows before track tasks, and keep the device code defensive. |

## Architecture: one control surface, layered backends

```
live_plugin_* tools (server)
        │
  PluginController (src/plugins/controller.js) ── picks a backend per plug-in
        │
  ┌─────┴───────────────┬──────────────────────┬────────────────────┬──────────────┐
  Native (PreSonus)     MIDI-CC backend        State backend         Opaque
  findParameter, live   setParamValue on       write preset/state,   presets only
  (exists today)        "MIDI CC ch|cc"        reload via            + window
                        params; mapping file   insertDevice
                        generated per vendor   (replace slot)
        │
  Catalog (src/plugins/catalog/*.json) ← Scanner (scripts/scan-plugins.py, pedalboard)
```

### 1. Catalog and scanner

- `scripts/scan-plugins.py` runs in a project-local Python venv (`.venv-scan`, created by `npm run scan:setup`). It walks the VST3 folders (`C:/Program Files/Common Files/VST3` and any configured extra folders).
- For each plug-in, in a **child process with a timeout** (some plug-ins hang or crash), it records the following and writes `~/.studio-one-mcp/plugins/<sanitized name>.json`:
  - name, vendor, VST3 class ID when obtainable, and file path;
  - parameter list: key, name, unit, min/max, default display, and whether it is boolean or discrete;
  - capabilities:
    - `hostParams` (count > 1);
    - `stateRoundTrip`: set a parameter, then `raw_state` → new instance → read back;
    - `opaque`.
- The catalog is **incremental**. It rescans only new or changed files (path + mtime + size), so installing new plug-ins is picked up by re-running scan (or by `live_plugin_scan`).
- Matching a Studio One insert to a catalog entry is by name. Studio One shows the plug-in name, e.g. "Archetype Petrucci X". Use the class description name and vendor, with a fuzzy fallback.

### 2. Backends

- **Native (PreSonus):** the existing `live_plugin_params` / `live_set_plugin_param` code, unchanged.
- **State backend, XML flavour**: the primary third-party path, verified live on 2026-10-07 with Archetype Petrucci X. Many JUCE plug-ins store their component state as `"VC2!" + u32 size + XML`, with parameter values in real units (Neural: `inputGain="0"`, `gateThreshold="-93.1"`). The loop:
  1. Read the state (see "Reading state" below).
  2. Edit the XML attribute named in the catalog's `stateKey`. The scanner fills `stateKey` by diffing two `raw_state` XML dumps before and after changing one parameter. For Neural, `stateKey` can also come from the plug-in's own `parametersMap` (`/parameters:<id>`).
  3. Rebuild the `.vstpreset`. The chunk list keeps `Comp` / `Cont` / `Info`, with `Comp` size and offsets recomputed.
  4. Load it with the replace-slot flow:
     - drop the file into `Documents/Studio One/Presets/<Vendor>/<Plug-in>/studio-one-mcp/`;
     - run `Presets/Re-Index Presets` (≈15 s; batch changes);
     - `insertDevice(folder, presetObj, position)`;
     - old slot `interpretCommand("Device","Remove")`;
     - restore bypass;
     - delete the temporary preset.
- **State backend, binary flavour**, for plug-ins with `stateRoundTrip=true` but no XML: pedalboard applies the change to a loaded copy of the state and exports `raw_state`, then the same replace-slot flow runs:
  1. Read the current state. Save the song with `live_save`, unzip `Presets/Channels/<channel>/<n> - <name>.vstpreset`, and load it into pedalboard.
  2. Apply the changes by parameter key and build a `.vstpreset`.
  3. Write it to `Documents/Studio One/Presets/<Vendor>/<Plug-in>/studio-one-mcp/<uuid>.vstpreset` and re-index.
  4. Replace the slot: `insertDevice(folder, presetObj)` at the same position, remove the old instance, restore bypass.
  5. Delete the temporary preset file.
  - Reads come from the same saved state (the read-back after `live_save` gives exact display text).
  - It is not realtime (seconds per change) and is documented as such.
  - It needs an edit-task op to remove a device or replace a slot. That API is to be found in the plan's first spike task; if none exists, insert the new instance after the old one and bypass + remove the old one via a command.
- **Reading state** without saving the user's song:
  1. On first control of a slot, replace it with an identical instance loaded from an MCP-owned user preset (`studio-one-mcp/<uuid>`), which preserves the state.
  2. Later reads focus the plug-in with `openEditorAndFocus`, run `Presets/Update Preset` (no dialog: it overwrites the current user preset), read that file, then close the window.
  - If `Update Preset` is unavailable or prompts, fall back to `live_save` + reading `Presets/Channels/...` from the song file, and say so in the result.
  - Plan task 1 verifies this live.
- **MIDI-CC backend (deferred, unproven)**: `setParamValue` on the insert element's "MIDI CC ch|cc" parameter did not change Archetype even with a Neural routing file. Neural's routing schema is known (`<routing enabled routingID type="cc_absolute" target="<parameterMap id>" midiChannel data1 data2 value/>`). This is kept only as a future realtime option; it is not in this plan. The old text follows for reference. For plug-ins whose vendor supports MIDI mapping (Neural DSP first):
  1. Generate the vendor's mapping file: CC (and channel) → parameter, covering every parameter, up to 16 × 128 slots.
  2. Set values with `setParamValue` on the insert element's "MIDI CC ch|cc" parameter.
  - Value read-back comes from the state backend's read path when a song save is acceptable; otherwise the last value written is kept in a cache.
  - The spike checks two things: (a) `setParamValue` on a MIDI CC param reaches the plug-in, and (b) the Neural DSP routing XML schema. If (a) fails, Neural falls back to a native-preset adapter (write their ValueTree preset and load it through the plug-in's preset path).
- **Opaque:** presets, bypass, window only; the tool tells Claude what it cannot do.

### 3. Presets (all plug-ins)

`live_plugin_presets { plugin | channel+slot }`:
- List presets Studio One indexes (PresetParam), including folders.
- Insert with a preset: `live_add_plugin` gains `preset`.
- Load a preset onto an existing slot (replace-slot path).
- Store the current state as a named user preset with the `Presets/Store Preset` command, using args if accepted, else via the state path.

### 4. Windows and housekeeping

`live_plugin_window { channel, slot, action: open|close|closeAll }`:
- **open** uses `PreSonus.HostUtils.openEditorAndFocus(component, slotElement, "Insert", false)`.
- **close** sends WM_CLOSE to the plug-in window from the server side via a tiny PowerShell helper on Windows; on other platforms the tool reports "not supported".
- Track edit tasks first close focused plug-in windows (see spike facts).

### 5. Tools (new or extended)

| Tool | Purpose |
|---|---|
| `live_plugin_scan` | (Re)scan installed plug-ins; returns counts by capability and newly found plug-ins. |
| `plugin_catalog` | Search the catalog by name/vendor/parameter text; offline, no Studio One needed. |
| `live_plugin_params` (extended) | For any plug-in: parameter list with values. Native: live. State: via catalog + read path. Reports the backend used. |
| `live_set_plugin_param` (extended) | Set one or many parameters by catalog name/key, with text or normalized values; batches go in one state round-trip. |
| `live_plugin_presets` | List / load / store presets. |
| `live_add_plugin` (extended) | Optional `preset`. |
| `live_remove_plugin` | Remove an insert slot. |
| `live_plugin_window` | Open/close plug-in windows. |

## Error handling

- Scanner: a crashing or hanging plug-in is recorded as `scanError` and never blocks the scan.
- State backend: if the replace fails, the original instance stays (insert new first, remove old only after success). Temporary preset files are always deleted.
- A change that would need a save warns in the tool description, and the result says when the song was saved.
- Every backend reports `backend` and `realtime: true|false` in results.

## Testing

- Unit:
  - catalog matching;
  - scanner output parsing, with a fake plug-in list;
  - `.vstpreset` reading/writing (header `VST3`, class ID, chunk list);
  - Neural routing XML generation;
  - controller backend selection;
  - tool argument handling with the fake bridge.
- Live, on `mcp-prueba` using installed plug-ins:
  - Pro EQ (native);
  - Archetype Petrucci X (state backend, XML flavour);
  - one plug-in with `stateRoundTrip=true` found by the scan;
  - MODO BASS (opaque presets).

## Out of scope (this sub-project)

- AU and macOS paths; VST2 (scanner may list them, but no backends).
- Automation lanes for plug-in parameters (belongs to a later automation sub-project).
- Sidechain routing (sub-project E).
