# Export mixdown and stems (sub-project B) — design

Date: 2026-10-07
Status: direction approved in chat ("ya adelante con b"). Written spec.

## Goal

Let Claude export the running song's **mixdown** or **stems** from Studio One in one tool call, choosing the range, the audio formats and the main options. The tool returns the paths of the files it wrote and, if asked, moves them to a chosen place. The user's own export settings are left as they were.

## Spike facts (2026-10-07, Studio One 7.2.3, Windows) — verified live

| Fact | Consequence |
|---|---|
| `Song/Export Mixdown` and `Song/Export Stems` take no arguments. Each opens Studio One's own modal dialog: class `CCLDialogClass`, owned by the main window, localized title ("Exportar mezcla" / "Exportar Stems"). The dialog has no child windows and no UI Automation children. | The dialog cannot be filled control by control. |
| A `WM_KEYDOWN`/`WM_KEYUP` `VK_RETURN` posted to that dialog presses **OK**, and the export runs offline in seconds. `VK_ESCAPE` cancels. A "Please wait" window (`CCLShadowWindowClass`) shows while rendering. | Drive the dialog with one posted key. |
| The bridge keeps answering other requests while the dialog is open: the pending `command` call is serviced in Studio One's nested modal loop. | Settings can be read and restored around the export through the bridge. |
| `Host.Settings.getAttributes("SongRenderer" \| "SongRenderer.AudioCodec" \| "StemRenderer" \| "StemRenderer.AudioCodec")` returns the **live** settings objects that the dialogs read when they open. They have `getAttribute`, `setAttribute`, `countAttributes`, `getAttributeName(i)` and `getAttributeValue(i)`. Writing `renderRange` = 1 or `wav.selected` = 1 showed up in the next dialog. | Range, formats and options are set before the dialog opens. |
| The renderer attributes are listed below. | These are the options the tool can set. |
| The codec section has three top-level entries, `fileType` (a FileType object with `.extension`), `format` and optional `attributes`, which describe the **current** format; that format is always exported. Every other format is an entry keyed by its extension (`wav`, `aif`, `flac`, `caf`, `m4a`, `ogg`, `opus`, `mp3`), each holding `fileType`, `format`, optional `attributes` and `selected` (0/1; mixdown exports every selected one too). Making WAV current means:<br>1. Store the old current trio under its extension (a new `Host.Attributes(["selected", 0])` with the three set).<br>2. Copy the WAV entry's trio to the top.<br><br>Verified: only WAV was checked. The dialog normalizes the section when it opens or closes (it drops the entry of the current format and adds missing ones). | Format switching, done in the device. |
| `AudioStreamFormat` objects are opaque to scripts (no sample rate or bit depth properties). | Sample rate and bit depth stay whatever the user last chose for that format. |
| The output folder and file name are **per song**, in the `.song` archive's `settings.xml`: `<Section path="SongRenderer"><Attributes fileName="Mixdown" …><Url x:id="mixdown" url="file:///…/Mixdown/"/>`. They are not reachable through `Host.Settings`. The defaults are `<song folder>/Mixdown/Mixdown.<ext>` and `<song folder>/Stems/<song title> - <channel>.<ext>`. | Find the new files by diffing the folders; move them if asked. |
| An existing file is never overwritten and no prompt appears: Studio One writes `Mixdown(2).mp3`. | Diffing finds the new file reliably. |
| An uncaught error in device code pops a modal "Scripting Error" (`#32770`, title "Studio One") that blocks the bridge. | The device code must catch every error. |

**Renderer attributes:**
- **SongRenderer:** `importToTrack`, `realtimeOption`, `closeAfterExport`, `preMasterFX`, `writeAudioTempo`, `renderSpeakerFormatList`, `renderRange`, `overlapActive`, `overlap`.
- **StemRenderer:** `importToTrack`, `realtime`, `closeAfterExport`, `preMasterFX`, `writeAudioTempo`, `renderRange`, `overlapActive`, `overlap`, `splitMono`, `keepSpeakerFormat`.
- **renderRange values:**
  - 0 = between the loop locators;
  - 1 = between the song start/end markers;
  - 2 = each marker (one file per marker range).

## Tool

`live_export { kind: 'mixdown' | 'stems', range?: 'loop' | 'song' | 'markers', formats?: string[], import_to_track?: boolean, skip_master_fx?: boolean, write_tempo?: boolean, split_mono?: boolean (stems), realtime?: boolean (stems), output?: string, timeout_s?: number }`

- **`formats`:**
  - Values are `wav aif flac caf m4a ogg opus mp3`. `aiff` and `vorbis` are accepted as aliases.
  - For a mixdown, one or more formats; every one is exported.
  - For stems, exactly one.
  - If omitted, the user's current choice is used.
- **Omitted options** keep the user's current values. `closeAfterExport` is always forced to 1 during the export, so the dialog closes.
- **`output`:**
  - For a mixdown it is either a file path whose extension matches the single exported format, or a folder.
  - For stems it is a folder.
  - Folders are created. Files are moved: a rename, or copy + unlink across volumes. An existing destination file is never overwritten; it gets a ` (2)` suffix.
- **Returns:** `{ kind, range, formats, files: [{ path, bytes }], seconds, settingsRestored: true, note? }`.
- **Description:**
  - The tool writes audio files: in the song's Mixdown/Stems folder, or in `output`.
  - Stems use the channels ticked in Studio One's stems dialog, which by default is every channel.
  - Sample rate and bit depth are the ones last used in the dialog.
  - Studio One's export dialog flashes briefly.
  - The tool is Windows only.

## Architecture

```
server.js live_export
   │
src/export/export.js   exportAudio(call, opts, deps)
   ├─ validate opts (kind/range/formats/output) ── before touching anything
   ├─ call('song') → song file path (must be saved), title, loop range
   ├─ folders.js  exportFolders(songPath, kind) → [folders to watch]; snapshotFolder / diffSnapshots
   ├─ call('exportSettings', { kind, action:'apply', range, formats, options })
   ├─ dialog.js   windowsBefore() ; driveExportDialog({ pid, before, timeoutMs })  ┐ concurrently
   ├─ call('command', { category:'Song', name:'Export Mixdown'|'Export Stems' }, { timeoutMs }) ┘
   ├─ finally: call('exportSettings', { kind, action:'restore' })
   ├─ diff folders → new files; move to output if asked
   └─ result
```

### Bridge op `exportSettings` (device, no eval)

`exportSettings { kind: 'mixdown'|'stems', action: 'get'|'apply'|'restore', range?, formats?, options? }`. Every path is wrapped in try/catch and returns `fail(...)` instead of throwing.

- **get:** `{ kind, range: 0|1|2, current: 'mp3', selected: ['mp3','wav'] (mixdown: current plus entries with selected=1; stems: [current]), available: [...], options: { importToTrack, preMasterFX, writeAudioTempo, closeAfterExport, realtime|realtimeOption, splitMono?, keepSpeakerFormat? } }`.
- **apply:**
  1. Snapshot every top-level attribute (name → value reference) of the renderer section and the codec section into bridge memory, keyed by kind.
  2. Set `renderRange` (if given), the options (0/1), and `closeAfterExport` = 1.
  3. Apply the formats with the algorithm above, then set `selected` on every entry for a mixdown.
  4. Return `get`.
  - If a requested format has no entry and is not current, fail with "format X is not available".
- **restore:** set every snapshotted name back to its value. Entries added during apply that were not in the snapshot are removed with `removeAttribute` if the object has it; otherwise they are left (the dialog normalizes them). Clear the snapshot, return `get`, and `{ restored: false }` if there was no snapshot.

### Dialog driver (`scripts/export-dialog.ps1`, static; inputs only through env)

Modes:
- **snapshot:** prints `{"windows":["hex",…]}`, the visible top-level windows of PID `S1MCP_XD_PID`.
- **drive:**
  1. Wait up to `S1MCP_XD_TIMEOUT_MS` (default 15000) for a visible `CCLDialogClass` window of that PID that is **not** in `S1MCP_XD_BEFORE` and has an owner. Print `{"event":"dialog","hwnd","title"}`.
  2. Post `VK_RETURN`. Wait up to 5 s for it to close. If it does not, post `VK_ESCAPE` and finish `{"ok":false,"reason":"dialog did not accept OK"}`.
  3. Then watch for `S1MCP_XD_WATCH_MS` (default 4000) for another new `CCLDialogClass` or `#32770` window of the PID: an alert such as "Nothing to export". Post `VK_ESCAPE` to it, which is safer than Enter on a Yes/No box, and finish `{"ok":false,"reason":"alert","title"}`.
  4. Otherwise finish `{"ok":true}`.
  - With no dialog in time: `{"ok":false,"reason":"no dialog"}`.

`src/export/dialog.js` wraps it with `runScript` from `src/plugins/filedialog.js`. Off Windows it throws "Exporting through Studio One's dialog is supported on Windows only".

### Folders (`src/export/folders.js`)

- `exportFolders(songFile, kind, { readSettings })`:
  - Read `settings.xml` from the `.song` archive (`openSongArchive`) and take the `<Url … url="file:///…">` inside `Section path="SongRenderer"` (mixdown) or `"StemRenderer"` (stems).
  - Add the default `<song folder>/Mixdown` or `/Stems`.
  - Return both, de-duplicated and converted to local paths.
- `snapshotFolders(folders) → Map(path → "mtimeMs:size")` covers audio files only (`wav aif aiff flac caf m4a ogg opus mp3`), non-recursive.
- `newFiles(before, after) → [path]` returns files that are new or changed.
- `moveFiles(files, output, { kind }) → [path]` follows the rules in Tool.

## Error handling

- **Validation** happens before any change: unknown format, stems with more than one format, an output extension that does not match, a bad range, or a song that was never saved (no file path) → error.
- **Range check:** `loop` with an empty loop range gives the error "set the loop range first (live_set_loop)".
- **Transport:** if Studio One is playing or recording → "stop playback first".
- **Restore:** settings are restored in `finally`, even when the export fails. A restore failure is reported as a warning, not thrown.
- **Dialog failures:**
  - "no dialog": the command did not open one. Report it with the command result.
  - "alert": Studio One refused, and the result carries the alert title, typically "Nothing to export".
- **Missing files:** if the export ran but no new files are found, the error lists the watched folders and says the dialog may point elsewhere (an unsaved location change).
- **Timeout:** the command call uses `timeout_s` (default 600). On timeout, report that the export may still be running.

## Testing

- **Unit:**
  - **Device op:** the core tests get a fake `Host.Settings` holding codec objects shaped like the real ones. They cover get/apply/restore, the format swap, selected flags, unknown formats, and that it never throws.
  - **PowerShell script:** static checks (env-only inputs, no interpolation, the modes present).
  - **`dialog.js`:** with a fake runner.
  - **Folders:** settings.xml parsing, snapshot/diff, move rules (rename, collision suffix, extension check).
  - **`exportAudio`:** with fake `call` and driver, covering ordering, restore in `finally`, validation before any call, alert, no files, and `output`.
  - **Tool schema.**
- **Live, on `mcp-prueba`:**
  1. A mixdown WAV of the loop to a scratch folder, checking the file exists with a size > 0.
  2. A mixdown with `formats ['mp3','wav']`, giving two files.
  3. Stems as WAV, giving one file per ticked channel.
  4. After each export, the user's dialog settings are back (`exportSettings get` equals the snapshot taken before; MP3, loop range).

## Out of scope

- Choosing which channels go into the stems (the per-song list is not reachable). The tool says to tick them in the dialog once; Studio One remembers them per song.
- Sample rate, bit depth, MP3 bit rate, loudness normalization, publishing.
- macOS dialog automation.
- Export Selection, Export Video, Spatial Audio.
