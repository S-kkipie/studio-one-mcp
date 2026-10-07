# Instruments + In-place Preset I/O (P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Control instrument plug-ins like insert effects. Rewrite third-party state I/O to export and load state in place through the plug-in's own preset commands, so there is no song save and no slot replacement.

**Architecture:** New bridge ops address a plug-in either as an insert slot or as an instrument (`Environment/Synths/InstNN`). `presetCommand` runs `component.interpretCommand("Presets", "Export Preset" | "Load Preset File")`, which opens a Windows file dialog. The server fills that dialog concurrently from PowerShell. The state backend and preset loading are rebuilt on this.

**Tech Stack:** Node ≥ 20 ESM, `node --test`, zod. PowerShell (Win32 via Add-Type) for the dialog. Studio One device JS (`device/StudioOneMCP`, modern JS, null-safe).

**Spec:** `docs/superpowers/specs/2026-10-07-instruments-inplace-presets-design.md`. It builds on `docs/superpowers/specs/2026-10-07-plugin-control-design.md` (already merged).

## Global Constraints

- Branch `instruments`. Commit per task. Messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.
- Bridge (`device/StudioOneMCP`) and edit-task code must be null-safe. A JS error in an edit task pops a modal dialog that blocks the bridge. `device/EditTasks/package/*.js` is ES5 only.
- Production code must not depend on `live_eval`. The device stays installed **without** `--allow-eval`. Exploratory probes may temporarily reinstall with eval, but must reinstall without it before the task ends.
- After any change to `device/StudioOneMCP/*`: run `node scripts/install-device.js`, then restart Studio One **minimized**:
  1. `node scripts/call-tool.js live_save '{}'`
  2. PowerShell `(Get-Process "Studio One").CloseMainWindow()`
  3. Wait 8 s.
  4. `Start-Process "C:\Program Files\PreSonus\Studio One 7\Studio One.exe" -ArgumentList '"C:\Users\issac\Documents\Studio One\Songs\mcp-prueba\mcp-prueba.song"' -WindowStyle Minimized`
  5. Wait 35 s, then check `live_status`.
- The user works in other windows on this machine. Never click the Studio One GUI and never bring windows to the foreground deliberately. Close any plug-in editor windows you open (`live_plugin_window closeAll`). Dialog automation uses WM_SETTEXT and BM_CLICK on the dialog's controls only.
- Never modify the user's real songs. Live tests use `mcp-prueba` only. Temp files go under `os.tmpdir()/studio-one-mcp/` and are deleted in `finally`.
- Plug-in operations that change the session run inside the controller's existing serial queue (`serialized()` in `src/plugins/controller.js`).
- Windows dialog facts:
  - class `#32770`, titles "Exportar preset" / "Cargar preset" (Spanish UI; English: "Export Preset" / "Load Preset");
  - filename edit id `0x47C` (fallback: first `Edit` descendant);
  - OK id `1`, Cancel id `2`;
  - the dialog belongs to the Studio One process.
- Instrument components: `Host.Objects.getObjectByUrl("://hostapp/DocumentManager/ActiveDocument/Environment/Synths").find("Inst01")`. `.find("Device")` is the plug-in, and its `.title` is the instrument name. Insert component: the FX component (`pluginOf(...).device.parent`). The preset-command check is `component.interpretCommand("Presets", cmd, true)`.

## Review Focus

1. If the dialog filler fails, the bridge call still returns: the filler clicks Cancel, and the server never hangs past its timeout.
2. A state write must keep the plug-in instance, its slot and channel, and its bypass. That means no replace-slot on the in-place path. Verify that the slot count is unchanged.
3. Temp preset files are always deleted, including on errors.
4. Instrument addressing by name must not hit the wrong instrument, e.g. "Mai Tai" vs "Mai Tai 2". Use an exact match on the device title, or the explicit `InstNN`.
5. No song save on the Windows path. A test asserts that no `save` call is made.

---

### Task 1: Bridge — instrument addressing, target spec, presetCommand

**Files:** modify `device/StudioOneMCP/BridgeComponent.js` and/or `BridgeCore.js` (where `pluginOf`, `pluginParams`, `setPluginParam`, `openPluginEditor` live) and `src/` wrappers (`src/plugins.js` or wherever the bridge call wrappers live). Add tests in the existing bridge/component test files (they use `test/helpers/s1host.js` fakes; extend the fake with a Synths folder).

**Interfaces — Produces:**
- Bridge op `instruments {}` → `[{ index: 1, component: "Inst01", name: "Mai Tai" }]`. Read `Inst01..Inst99`, stop after two consecutive misses. Null-safe.
- Target resolution in the bridge: `resolveTarget({ channel, slot } | { instrument })` → `{ component, device, name }` or `{ error }`.
  - `instrument` may be an exact device title ("Mai Tai 2") or a component name ("Inst02").
  - Title match is exact and case-sensitive first, then case-insensitive. If several match, return an error that lists them.
- `pluginParams`, `setPluginParam` and `openPluginEditor` accept either target shape. The existing `{channel, slot}` behaviour and output are unchanged. For an instrument, `openPluginEditor` uses `component.interpretCommand("Device", "Edit", false)`.
- Bridge op `presetCommand { target, command }` with `command` ∈ {"Export Preset", "Load Preset File"}. It checks availability, then runs `interpretCommand("Presets", command, false)` → `{ ok: true }` or `{ error }`. This call blocks while the dialog is open; that is expected.
- Server wrappers: `listInstruments(call)` and `presetCommand(call, target, command, { timeoutMs })`.

- [ ] Step 1: Failing tests for `instruments`, instrument target resolution (exact vs case-insensitive vs ambiguous), `pluginParams` on an instrument target, and `presetCommand` check-then-run (fake component logs calls).
- [ ] Step 2: Implement. `npm test` → fail 0.
- [ ] Step 3: Live check (install + restart minimized):
  - `instruments` lists Mai Tai, Mai Tai 2, Mai Tai 3, Impact, Mai Tai 4 (or whatever exists);
  - `live_plugin_params` with `{instrument:"Mai Tai"}` returns native params, i.e. names discovered for Mai Tai. If the server tool doesn't accept `instrument` yet, call the bridge op directly via `src/bridge.js call`.
  - Do NOT run presetCommand live yet (Task 2 has the dialog filler).
- [ ] Step 4: Commit.

### Task 2: File-dialog filler + presetio (export/load in place)

**Files:** create `src/plugins/filedialog.js` and `src/plugins/presetio.js`; tests `test/filedialog.test.js` and `test/presetio.test.js`.

**Interfaces — Produces:**
- `fillFileDialog({ path, expect: 'export'|'load', timeoutMs = 8000, platform, run })` → `{ ok, title }` or throws.
  - Static PowerShell script; inputs via environment variables or argv (no interpolation).
  - Poll up to `timeoutMs` for a visible `#32770` window owned by the Studio One process.
  - Set the filename via WM_SETTEXT on id `0x47C` (fallback: first `Edit`), click OK (id 1).
  - Wait up to 3 s for the dialog to close. If a second `#32770` (overwrite confirm) appears, press its "Yes" (id 6) for `expect: 'export'`.
  - If anything fails, click Cancel (id 2) and throw.
  - Non-win32 throws `not supported on this platform`.
- `exportState(call, target, { fill = fillFileDialog, tmpDir })` → `{ ext: '.vstpreset'|'.preset'|'.fxpreset', buf }`:
  - start `presetCommand(call, target, 'Export Preset', { timeoutMs: 30000 })` without awaiting it;
  - run `fill({ path: <tmp>/<uuid>, expect: 'export' })`;
  - await the bridge promise;
  - find the file `<uuid>.*` in the temp dir, read it, delete it in `finally`.
- `loadState(call, target, buf, ext, { fill, tmpDir })`: write `<uuid><ext>`; start the `Load Preset File` command; `fill({ path, expect: 'load' })`; await; delete in `finally`.

- [ ] Step 1: Failing tests:
  - the script has no interpolated user data;
  - the Cancel path on fill failure;
  - presetio ordering: the command is started before the fill and awaited after;
  - the temp file is deleted on success and on error;
  - the extension is detected;
  - a non-Windows error.
- [ ] Step 2: Implement. `npm test`.
- [ ] Step 3: Live check:
  - `exportState` on Pro EQ (`{channel:"Mai Tai 2", slot:0}`) → a `.preset` whose `metainfo.xml` has `Class:Name` Pro EQ;
  - `exportState` on Archetype (`{channel:"Mai Tai", slot:0}`) → a `.vstpreset` containing `inputGain=`;
  - edit Archetype `inputGain` to 2 with the vstpreset helpers, `loadState`, `exportState` again → `inputGain="2"`; the insert count on "Mai Tai" is still 1; restore 0;
  - `exportState` on instrument `{instrument:"Mai Tai"}` → an `.fxpreset`/`.preset` (record the extension).
  - Close any windows that appear (there should be none).
- [ ] Step 4: Commit.

### Task 3: State backend on presetio (no song save, no replace)

**Files:** modify `src/plugins/state.js`, `src/plugins/controller.js`; tests `test/plugin-state.test.js`, `test/plugin-controller.test.js`.

**Interfaces:**
- `readPluginState(call, target, { io })`: on win32 it uses `io.exportState` and returns `{ classId, xml, raw, source: 'export' }`. Otherwise it keeps the song-save path (`source: 'song-save'`).
- `writePluginParams(call, { target, changes, entry }, { io })`: on win32 it does export → edit (existing `stateKeys` / `stateScale` / `boolText` logic) → `io.loadState` → `{ applied, missing, backend: 'state', realtime: false, inPlace: true }`. No re-index, no scratch preset, no replace-slot. Else the previous replace path.
- After the load, export again and verify that the applied keys took effect (cheap, and it catches plug-ins that ignore loads). On a mismatch, report `unconfirmed: [keys]`.
- `target` is `{channel, slot}` or `{instrument}`. The classId check uses the exported preset's class ID against the catalog entry, as now.
- Tool descriptions and README: the third-party change no longer saves the song on Windows. Keep the live_undo warning only where the replace path is still used; for in-place loads, check live whether `live_undo` reverts a preset load and document what happens.

- [ ] Step 1: Failing tests. With fake io:
  - no `save` call;
  - no `insertPreset` or `slotCommand`;
  - verify-after-load reports `unconfirmed`;
  - the instrument target is passed through;
  - the fallback path stays on non-win32.
- [ ] Step 2: Implement. `npm test`.
- [ ] Step 3: Live check:
  - Archetype `live_set_plugin_param` `{"Input Gain":"5 dB"}` → `inPlace: true`; the song file mtime is unchanged and the Studio One title is not marked dirty by a save (record what you can observe);
  - read back 5 dB; restore 0 dB;
  - test `live_undo` once after a write and record whether it reverts the change; restore the value either way.
- [ ] Step 4: Commit.

### Task 4: Instruments in tools, preset load in place, parked fixes, README

**Files:** modify `src/plugins/controller.js`, `src/server.js`, `src/tracks.js`, `README.md`; tests as needed; `test/server.test.js` tool list.

**Interfaces — Produces:**
- `live_plugin_params`, `live_set_plugin_param`, `live_plugin_presets` and `live_plugin_window` accept `instrument` (string) as an alternative to `channel` + `slot`. A zod refinement requires exactly one form.
- `live_instruments {}`: `[{ instrument, component, backend, classId?, tracks: [names] }]`. Tracks come from `live_tracks` by matching the track's instrument channel to the instrument name, best effort.
- Preset load (`live_plugin_presets action: load`) on any target:
  - resolve a preset **file** by name;
  - search Studio One install `Presets/<Vendor>/<Plug-in>/` and `Documents/Studio One/Presets/**`, matching the class's plug-in folder, with case-insensitive file stem = the preset name (the PresetParam list gives the names);
  - if found: `io.loadState` with that file's bytes and extension, in place;
  - if not found and the target is an insert: fall back to the existing `replaceSlot`;
  - if not found and the target is an instrument: error "preset file not found for in-place load".
- Parked fixes:
  - `addPlugin` (no preset), `addInstrumentTrack` and `addFxSend` use the 30 s timeout, and re-read the rack or track list after a thrown call before reporting;
  - `stateChange` accepts on/off/true/false only for boolean params or params with `choices === 2`, otherwise it throws a clear error.
- README: document instruments, the in-place behaviour (no song save on Windows, a brief Studio One file dialog flash), and the remaining limits (opaque vendors, log-scaled params read-only).

- [ ] Step 1: Failing tests:
  - zod target refinement;
  - `live_instruments` mapping;
  - preset file resolution (fake dirs);
  - the in-place load path versus the replace fallback;
  - the parked fixes;
  - the server tool list.
- [ ] Step 2: Implement. `npm test`.
- [ ] Step 3: Commit.

### Task 5: Live end-to-end and wrap-up

- [ ] Restart is not needed unless device files changed after the last restart. Check `live_status`.
- [ ] Through MCP tools (`node scripts/call-tool.js`):
  1. `live_instruments` → lists instruments with backends.
  2. `live_plugin_params {instrument:"Mai Tai"}` → native params; `live_set_plugin_param` one Mai Tai param and restore it.
  3. `live_plugin_presets {instrument:"Impact", action:"list"}` → names; `load` one (in place); confirm the instrument count is unchanged and the Impact channel still exists.
  4. Archetype third-party set/read in place (`inPlace: true`, no song save).
  5. Pro EQ preset "Kick 1" load in place (slot count unchanged).
  6. `live_add_instrument_track {instrument:"MODO BASS"}` → `live_instruments` shows it; `live_plugin_presets` list/load if files exist; `live_set_plugin_param` → opaque explanation; remove the track afterwards (record how).
  7. `live_plugin_window {instrument:"Mai Tai", action:"open"}`, then `closeAll`.
- [ ] Fix bugs found (with regression tests), run `npm test`, commit. Leave the song clean: values restored, no temp files, no windows open, test tracks removed.
