# Plug-in Control (sub-project P) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude can list and set the parameters of any installed plug-in (native PreSonus live; third-party through state editing), manage presets, insert/remove/bypass plug-ins and open/close their windows — automatically, for every plug-in installed now or later.

**Architecture:** An offline scanner (Python `pedalboard` in a project venv) builds a per-plug-in JSON catalog: parameters, state keys, capabilities. A `PluginController` picks a backend per plug-in:
- **native**: existing `findParameter` path;
- **state**: read the plug-in state, edit the `VC2!` XML or the pedalboard raw state, then reload via the replace-slot flow;
- **opaque**: presets only.

New MCP Track Edit ops do the in-Studio-One work: insert with preset at a position, slot commands, preset listing.

**Tech Stack:** Node ≥ 20 ESM, `node --test`, zod; Python 3.12 + `pedalboard` (venv `.venv-scan`, git-ignored); Studio One device JS (ES5 in `device/EditTasks/package`).

**Spec:** `docs/superpowers/specs/2026-10-07-plugin-control-design.md`

## Global Constraints

- Branch `plugins`. Commit per task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.
- `device/EditTasks/package/*.js` is ES5 only (`var`, `function`, no `=>`/template strings/`let`/`const`). Every host member access is checked with `mtoFn`, because a JS error pops a modal "Scripting Error" dialog that blocks the bridge.
- Edit-task (Track) commands are unavailable while a plug-in window is open or focused. Close plug-in windows before running track tasks (see Task 6 window helper).
- Never modify the user's real songs. Live tests use song `mcp-prueba` only. Never leave files in `Documents/Studio One/Presets/**/studio-one-mcp/` after an operation; that folder is MCP scratch.
- Bridge production code must not depend on `live_eval`; the device stays installed without `--allow-eval`. Exploratory live probes may temporarily reinstall with `--allow-eval`, but must reinstall without it at the end of the task.
- Python always runs isolated: `"<venv>/Scripts/python.exe" -I <script> <args>`. The scanner runs every plug-in load in a child process with a timeout (default 60 s).
- Windows paths: VST3 root `C:/Program Files/Common Files/VST3` (plus `STUDIO_ONE_MCP_VST3_PATHS`, `path.delimiter`-separated). Catalog dir `~/.studio-one-mcp/plugins/`.
- Known IDs, for tests and live checks only:
  - Archetype Petrucci X: class `{ABCDEF01-9182-FAEB-4E44-53504E4A5058}`, vendor folder "Neural DSP";
  - Pro EQ: `{073C4094-E062-4FB5-8328-74608DD1A3A4}`.

## Review Focus

1. A plug-in that crashes or hangs during scan must not abort the scan; it is recorded with `scanError`. Covered in Task 3.
2. Replace-slot must never lose the user's plug-in. Insert the new instance first and remove the old one only after the insert succeeded. Restore the bypass state and slot position. Covered in Task 5.
3. Temporary preset files must be deleted even when a step throws. Covered in Task 5.
4. A third-party plug-in name that matches several catalog entries (e.g. "Archetype Petrucci X 2", the second instance) must still resolve to "Archetype Petrucci X". Covered in Task 4.
5. Setting a parameter on an opaque plug-in must explain what is possible instead of failing silently. Covered in Task 6.

---

### Task 1: Device ops — presets, insert at position, slot commands

**Files:**
- Modify: `device/EditTasks/package/McpTrackOps.js` (append ops)
- Modify: `src/tracks.js` (thin wrappers)
- Test: `test/trackedittask.test.js`

**Interfaces — Produces:**
- `mtoOps.listPresets({ cid })` → `{ presets: [{ index, name }] }`. Index 0 is "no preset", so it is excluded. Uses `Host.Classes.createInstance("Host:PresetParam")`, `shouldShowFolders(true)`, `setMetaInfo(Host.Attributes(["Class:ID", cid]))`, `max`, `value=i` → `string`.
- `mtoOps.insertPreset({ channel, cid, preset, position })` inserts into channel `Inserts` the preset named `preset` (exact name from listPresets), or just the class when `preset` is empty. `position` is a 0-based slot index; when omitted, append. → `{ channel, slot: "<FXnn name>" }`. Uses `root.createFunctions("DeviceEditFunctions").insertDevice(folder, presetObjOrCid, position)`.
- `mtoOps.slotCommand({ channel, slot, command })`. `slot` is a 0-based index → folder child `"FX" + two-digit (slot+1)`, e.g. slot 0 → "FX01". `command` ∈ `Remove | Bypass | Edit`. Runs `slotObj.interpretCommand("Device", command, false)` → `{ channel, slot, command, done: bool }`; it first checks the command with `interpretCommand("Device", command, true)` and returns `{ error }` if it is unavailable.
- `src/tracks.js` exports `listPresets(call, cid)`, `insertPreset(call, {channel, cid, preset, position})` and `slotCommand(call, {channel, slot, command})`, built on `trackTask`.

- [ ] **Step 1: Failing vm tests** in `test/trackedittask.test.js`. Reuse the existing `load()` / `studio()` / `song()` helpers. Add a fake `Host.Classes.createInstance` that returns a PresetParam fake with `max`, a `value` setter, `string`, `getValueAt`. Add fake MixerConsole channel `find('Inserts')` returning a folder whose `find('FX01')` returns a slot with `interpretCommand(cat, name, check)` that logs calls. Tests:
  - listPresets returns names without "no preset";
  - insertPreset calls `insertDevice(folder, presetObj, 1)` when a preset name matches;
  - insertPreset with an unknown preset returns `{ error: /no preset named/ }`;
  - slotCommand Remove calls check, then run;
  - slotCommand on a missing slot returns `{ error: /no plug-in in slot/ }`.
- [ ] **Step 2: Run** `node --test test/trackedittask.test.js`. Expect the new tests to fail with `unknown op`.
- [ ] **Step 3: Implement the ops (ES5)** and the `src/tracks.js` wrappers. Find the channel with the existing `mtoChannel`, which uses `getChannelList(1)` and matches on `label`.
- [ ] **Step 4: Run** `npm test`. Expect fail 0.
- [ ] **Step 5: Live check.** Studio One is running with `mcp-prueba`, and channel "Mai Tai 2" has Pro EQ in slot 0.
  - `node scripts/install-device.js` (no eval);
  - `listPresets` for Pro EQ: expect ~74 names;
  - `insertPreset` channel "Mai Tai 2", Pro EQ, preset "Kick 1", position 0: expect the new slot to appear at slot 0 in `live_inserts`, with the old Pro EQ moved to slot 1;
  - `slotCommand` Remove slot 0: expect the inserts back to the original.
  - Record the results in the report, including whether `position` was honoured. If it was not, note it: Task 5 then moves the new slot using what you find (or documents append-only).
- [ ] **Step 6: Commit.**

---

### Task 2: `.vstpreset` and JUCE state module

**Files:**
- Create: `src/plugins/vstpreset.js`
- Test: `test/vstpreset.test.js`

**Interfaces — Produces:**
- `parseVstPreset(buf: Buffer) → { classId: string, chunks: [{ id: 'Comp'|'Cont'|'Info'|string, data: Buffer }] }`. Throws `/not a VST3 preset/` on a bad header.
- `buildVstPreset({ classId, chunks }) → Buffer`. Header layout: `'VST3'`, int32 version 1, 32-char ASCII class ID, int64 list offset; then chunk data; then `'List'`, int32 count, and per entry 4-char id + int64 offset + int64 size. All little-endian.
- `readJuceXml(compData: Buffer) → string | null`. If it starts with `VC2!`: u32 size, then XML text up to the NUL. Otherwise null.
- `writeJuceXml(xml: string) → Buffer` (`VC2!` + u32(len+1) + utf8 + NUL).
- `setXmlAttrs(xml, { key: value }) → { xml, missing: string[] }` replaces the first `key="…"` occurrence per key; `getXmlAttrs(xml, keys) → { key: value|null }`.

- [ ] **Step 1: Failing tests.**
  - Build a preset in-test from known chunks (`Comp` = `writeJuceXml('<a x="1" y="true"/>')`, `Cont` empty, `Info` = small XML).
  - Round-trip with `parseVstPreset(buildVstPreset(p))`.
  - `readJuceXml` gets the XML back.
  - `setXmlAttrs` changes `x` and reports `missing` for absent keys.
  - A bad header throws.
  - Byte-exact layout check: list offset points to `'List'`; the `Comp` offset is 48.
- [ ] **Step 2: Run** and expect the tests to fail.
- [ ] **Step 3: Implement** with Node `Buffer` (`readBigInt64LE`/`writeBigInt64LE`).
- [ ] **Step 4: Live-data check.** Unzip `mcp-prueba.song` to a temp dir, then parse `Presets/Channels/Mai Tai/1 - Archetype Petrucci X.vstpreset`. Expect classId `ABCDEF019182FAEB4E4453504E4A5058` and XML containing `inputGain=`. Rebuild it unchanged and check it is byte-identical to the original. If it is not byte-identical, explain why (padding) and ensure it still parses.
- [ ] **Step 5: `npm test`, then commit.**

---

### Task 3: Scanner (Python + Node runner) and catalog files

**Files:**
- Create: `scripts/scan-plugin.py` (scans ONE plug-in, prints JSON)
- Create: `src/plugins/scan.js` (walks folders, runs the child per plug-in with a timeout, incremental cache)
- Create: `scripts/scan-setup.js` (creates `.venv-scan` and pip installs `pedalboard`)
- Modify: `package.json` (scripts `scan:setup`, `scan`), `.gitignore` (`.venv-scan/`)
- Test: `test/scan.test.js`

**Interfaces — Produces:**
- `scan-plugin.py <path>` → stdout JSON:
  ```
  {
    "name", "vendor",
    "params": [{ "key", "name", "label", "min", "max", "default", "isBoolean", "isDiscrete" }],
    "capabilities": { "hostParams": bool, "stateRoundTrip": bool, "xmlState": bool },
    "stateKeys": { "<param key>": "<xml attr>" }
  }
  ```
  - `stateRoundTrip`: change one non-bypass param, then `raw_state` → new instance → value preserved.
  - `xmlState`: `raw_state` contains `VC2!`, or `<?xml` inside the VST3PluginState IComponent (decode JUCE base64 if needed). If not decodable, set `xmlState` false.
  - `stateKeys`: for xmlState plug-ins, set each param to a distinct value via the plug-in's own state where possible. If pedalboard changes don't reach the state (Neural DSP), map keys by normalised name matching (`input_gain` ↔ `inputGain`, lowercase + strip `_`/spaces) against the XML attribute names. Record the method used in `stateKeyMethod`.
- `src/plugins/scan.js`:
  - `scanAll({ roots, catalogDir, python, timeoutMs = 60000, runner }) → { scanned, skipped, errors, total }`.
  - It writes `<catalogDir>/<sanitized name>.json` with `{ ...result, path, mtimeMs, size, scannedAt }`, or `{ name, path, scanError }`.
  - It skips files whose path, mtime and size match the existing entry.
  - `runner` is injectable for tests; the default spawns python with `-I` and kills it on timeout.
- `npm run scan:setup` creates the venv; `npm run scan` runs `scanAll` with defaults and prints a summary.

- [ ] **Step 1: Failing tests** (`test/scan.test.js`), using a fake `runner` and a temp dir with fake `.vst3` files:
  - writes one JSON per plug-in;
  - a runner timeout or crash is recorded as `scanError` and the scan continues;
  - an unchanged file is skipped on a second run;
  - a changed mtime is rescanned.
- [ ] **Step 2: Run** and expect the tests to fail.
- [ ] **Step 3: Implement** `scan.js`, `scan-setup.js` and `scan-plugin.py`.
- [ ] **Step 4: Live scan of this machine.** Run `npm run scan:setup && npm run scan`. Expect, and record actual values:
  - Archetype Petrucci X: about 156 params, `xmlState` true, `stateKeys.input_gain === "inputGain"`;
  - MODO BASS: `hostParams` false (opaque);
  - AmpliTube 5: `scanError` or opaque;
  - PreSonus native plug-ins are not in the VST3 folder, so they won't appear. That is expected.
  - Put the summary table in the report.
- [ ] **Step 5: `npm test`, then commit.**

---

### Task 4: Catalog lookup and `plugin_catalog` tool

**Files:**
- Create: `src/plugins/catalog.js`
- Modify: `src/server.js` (tool `plugin_catalog`), `test/server.test.js` (tool list)
- Test: `test/catalog.test.js`

**Interfaces — Produces:**
- `loadCatalog(dir) → Map<name, entry>`.
- `matchPlugin(catalog, studioOneName) → entry | null`:
  - strip a trailing ` <digits>` (Studio One numbers instances: "Archetype Petrucci X 2");
  - try an exact match, case-insensitive;
  - then the longest catalog name that is a prefix of the Studio One name.
- `findParam(entry, query) → param | null` matches by key, exact name, case-insensitive name, then a unique substring. If ambiguous, it throws listing the candidates.
- `searchCatalog(catalog, text) → [{ name, vendor, paramCount, backend }]`, where `backend` = `state` if `stateRoundTrip || xmlState`, else `opaque`.
- Tool `plugin_catalog { query?, plugin? }`. With `plugin`, it returns that entry's params (name, key, range, isBoolean). Without, it returns the search results. It works offline.

- [ ] **Step 1: Failing tests:** matchPlugin with " 2" and " 3" suffixes; prefix match; findParam exact, case-insensitive and ambiguous; searchCatalog backend labels.
- [ ] **Step 2: Implement.** Register the tool and update the server tool list test.
- [ ] **Step 3: `npm test`, then commit.**

---

### Task 5: State backend (read + write via replace-slot)

**Files:**
- Create: `src/plugins/state.js`
- Test: `test/plugin-state.test.js`

**Interfaces — Consumes:** Task 1 wrappers (`listPresets`, `insertPreset`, `slotCommand`), Task 2 vstpreset functions, Task 4 catalog, `call` (`inserts`, `setInsertBypass`, `command`, `song`).

**Interfaces — Produces:**
- `readPluginState(call, { channel, slot }) → { classId, xml|null, raw: Buffer, source: 'update-preset'|'song-save' }`. Source of truth, in order:
  - (a) If the slot's current preset is an MCP-owned preset (tracked in `~/.studio-one-mcp/plugins/owned.json`: channel+slot+name → file), focus the plug-in (Task 6 helper `focusPlugin`), run `Presets/Update Preset`, close the window and read the file.
  - (b) Otherwise use song-save: `call('command', {File/Save})` via `live_save` semantics, unzip the song, and read `Presets/Channels/<channel>/<slot+1> - <name>.vstpreset`. Matching is by the `<n> - ` prefix with n = slot+1, as seen in Studio One's naming. If not found, throw a clear error.
  - Live check required. If (a) shows a dialog or does nothing, drop (a) and document it.
- `writePluginParams(call, { channel, slot, changes: { key: value } , entry }) → { channel, slot, applied: {key: value}, missing: [], backend: 'state', realtime: false }`:
  1. Read the state.
  2. Edit it: for XML, `setXmlAttrs` with `entry.stateKeys`; for binary `stateRoundTrip`, call the Python helper `scripts/apply-state.py <plugin> <stateIn> <changesJson> <stateOut>`.
  3. Build the preset file at `Documents/Studio One/Presets/<vendor>/<name>/studio-one-mcp/<uuid>.vstpreset`.
  4. Run `Presets/Re-Index Presets` and poll `listPresets` (up to 30 s) until `<uuid>` appears.
  5. Remember the old slot's bypass, run `insertPreset(position = slot)`, then `slotCommand Remove` on the old slot (its index after the insert), then restore bypass.
  6. Delete the temp file in `finally`; also delete the empty `studio-one-mcp` folder.
  - Batch: `changes` with several keys go in one round-trip.

- [ ] **Step 1: Failing tests** with a fake bridge, a fake fs dir and a fake listPresets:
  - the XML change is applied;
  - the insert happens before the remove (call order);
  - bypass is restored;
  - the temp file is deleted when insert throws;
  - an unknown key lands in `missing`;
  - polling times out with a clear error.
- [ ] **Step 2: Implement** `state.js` and `scripts/apply-state.py` (pedalboard: load plug-in, set `raw_state`, apply changes by key with raw/normalized/text values, write `raw_state`).
- [ ] **Step 3: Live check** on `mcp-prueba`, channel "Mai Tai", Archetype slot 0:
  - `writePluginParams` `{ input_gain: 6, gate_active: false }`;
  - then `readPluginState`: XML has `inputGain="6"` and `gateActive="false"`;
  - `live_inserts` still shows exactly one Archetype at slot 0;
  - no files are left under `Documents/Studio One/Presets/**/studio-one-mcp`;
  - set the values back to 0/true at the end.
  - Record which read source worked.
- [ ] **Step 4: `npm test`, then commit.**

---

### Task 6: Controller, tools, windows, README

**Files:**
- Create: `src/plugins/controller.js`, `src/plugins/windows.js`
- Modify: `src/server.js`, `test/server.test.js`, `README.md`
- Test: `test/plugin-controller.test.js`

**Interfaces — Produces:**
- `windows.js`:
  - `focusPlugin(call, { channel, slot })` opens the editor via a new bridge op `openPluginEditor` that calls `PreSonus.HostUtils.openEditorAndFocus(this, insertSlotElement, "Insert", false)` (add it to `device/StudioOneMCP/BridgeComponent.js` and `BridgeCore.js` dispatch, null-safe).
  - `closePluginWindows()`: Windows only. It spawns PowerShell to WM_CLOSE every visible window of the "Studio One" process whose title is not "Studio One…" (plug-in windows are titled `<channel> · Inserts · <n> - <name>`). It returns the closed titles. On non-win32 it returns `[]`.
- `controller.js`:
  - `backendFor(insertName, catalog)` returns `native` when there is no catalog match and the bridge `pluginParams` discovery finds names (PreSonus); `state` when the entry is `stateRoundTrip || xmlState`; otherwise `opaque`.
  - `getParams(call, {channel, slot})` → `{ plugin, backend, realtime, params: [{name, key, value|text|null}] }`. For state backends, values come from `readPluginState` via the XML attributes in `stateKeys`.
  - `setParams(call, {channel, slot, changes})` → backend result. On opaque it throws `"<name> does not expose its parameters to hosts; use live_plugin_presets to load a preset instead"`.
- Tools:
  - `live_plugin_params` and `live_set_plugin_param` are extended to route through the controller (keep the native path and output shape for PreSonus; add `backend` and `realtime`). `live_set_plugin_param` also accepts `changes: { name: value }` for batches.
  - `live_plugin_presets { channel?, slot?, plugin?, action: list|load, preset? }`: `load` = `insertPreset` at the slot position + Remove old (same replace-slot flow, bypass restored).
  - `live_add_plugin` gains `preset?`.
  - `live_remove_plugin { channel, slot }`.
  - `live_plugin_window { channel?, slot?, action: open|closeAll }`.
  - `live_plugin_scan {}` runs `scanAll` and returns the summary.
- Track tasks: in `src/tracks.js` `trackTask`, on the error "Track/MCP Track Edit is not available right now", call `closePluginWindows()` once and retry.

- [ ] **Step 1: Failing tests:**
  - backendFor for each case;
  - setParams on opaque gives the helpful error;
  - getParams for state maps XML attrs to names;
  - the trackTask retry after closePluginWindows (inject both);
  - the server tool list.
- [ ] **Step 2: Implement.** Write the README section "Plug-ins" covering scan setup, backends, what realtime means, and the limits: opaque vendors and the ~15 s state changes.
- [ ] **Step 3: `npm test`, then commit.**

---

### Task 7: Live end-to-end and wrap-up

- [ ] Reinstall the device without eval and restart Studio One with `mcp-prueba`. If Studio One is running, save the song with `live_save` first.
- [ ] Through MCP tools only (`node scripts/call-tool.js …`):
  1. `live_plugin_scan` → summary.
  2. `plugin_catalog { plugin: "Archetype Petrucci X" }` → about 156 params.
  3. `live_plugin_params` on Pro EQ (channel "Mai Tai 2", slot 0) → `backend: native`.
  4. `live_set_plugin_param` on Archetype (channel "Mai Tai", slot 0) with `changes {"Input Gain": "6 dB", "Gate Active": false}`, then `live_plugin_params` → shows them; then restore.
  5. `live_plugin_presets list` for Pro EQ → names. `load` "Kick 1" onto Pro EQ slot → `live_inserts` still one Pro EQ in slot 0.
  6. `live_add_plugin` MODO BASS?
     - MODO BASS is an instrument: use `live_add_instrument_track { instrument: "MODO BASS" }`.
     - Then `live_set_plugin_param` on it → helpful opaque error.
     - Then `live_plugin_presets list` → MODO BASS presets if Studio One indexes any (record).
  7. `live_plugin_window open` on Archetype, then `closeAll`.
- [ ] Clean up the test tracks and plug-ins, then `live_save`. Check no files remain under `Documents/Studio One/Presets/**/studio-one-mcp`.
- [ ] Fix any bug found (with a regression test), run `npm test`, then commit.
