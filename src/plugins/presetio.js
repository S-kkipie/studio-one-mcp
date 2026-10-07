// A plug-in's state out of / into Studio One in place, through the plug-in's own Presets commands
// ("Export Preset" / "Load Preset File") and their file dialog. The instance, its slot, its channel
// and its bypass stay as they are, and the song is never saved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { presetCommand } from './controller.js';
import { fillFileDialog, snapshotDialogs, cancelPresetDialogs, MAX_PATH_CHARS } from './filedialog.js';
import { withDialogLock } from '../dialoglock.js';

// .instrument: what Studio One writes for an instrument's Export Preset (7.2.3, Mai Tai).
export const PRESET_EXTS = ['.vstpreset', '.preset', '.fxpreset', '.instrument'];
// What loadState accepts: never an .instrument bundle. Loading one rebuilds the instrument channel's
// whole insert chain (live, 7.2.3: inserts recreated from the bundle, or removed when left out).
export const LOAD_EXTS = PRESET_EXTS.filter((e) => e !== '.instrument');
export const INSTRUMENT_LOAD_REFUSED = "loading an .instrument bundle rebuilds the channel's insert chain; load a synth-only .preset instead";
export const COMMAND_TIMEOUT_MS = 30000;
const STALE_MS = 10 * 60 * 1000;

export const defaultTmpDir = () => path.join(os.tmpdir(), 'studio-one-mcp');

// One dialog flow at a time (shared with live_export): see ../dialoglock.js.
export { withDialogLock };

// Leftovers of a crashed run: files in our temp folder older than 10 minutes, once per folder.
const swept = new Set();
export function sweepStale(tmpDir, { now = Date.now() } = {}) {
  if (swept.has(tmpDir)) return;
  swept.add(tmpDir);
  let names = [];
  try { names = fs.readdirSync(tmpDir); } catch { return; }
  for (const n of names) {
    const p = path.join(tmpDir, n);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && now - st.mtimeMs > STALE_MS) fs.rmSync(p, { force: true });
    } catch { /* best effort */ }
  }
}

function checkPathLength(p) {
  if (p.length > MAX_PATH_CHARS) throw new Error(`The temp preset path is longer than ${MAX_PATH_CHARS} characters (${p}); set TEMP to a shorter folder.`);
}

export const CANCEL_MARGIN_MS = 3000;
export const LATE_CANCEL_MS = 10000;
const isTimeout = (e) => /did not answer/.test(e?.message ?? String(e));
const stillOpenError = (titles) => new Error(`a preset dialog is still open in Studio One (${[...new Set(titles)].join(', ')}); close it`);

// Snapshot the dialogs that are already open, start the bridge call (it blocks while the dialog is
// open), fill the dialog, then await the call.
// - The filler is stopped as soon as the call returns, whatever the answer: then nothing left on
//   screen can be ours.
// - If the filler failed before it found our dialog while the call is still pending, our dialog
//   may still come: a cancel-watch presses Cancel (never OK) on a new preset dialog until the call
//   returns or its time is up.
// - If the call times out (Studio One took too long), a short cancel-watch cancels a late dialog
//   and the operation fails.
// -> { value, missed } (missed: the call returned OK but the filler never saw our dialog).
async function runWithDialog(call, target, command, { fill, snapshot, cancelWatch }, fillArgs) {
  const { pid, exclude } = await snapshot();
  const started = Date.now();
  const stopFill = new AbortController();
  let isSettled = false;
  const settled = presetCommand(call, target, command, { timeoutMs: COMMAND_TIMEOUT_MS })
    .then((value) => ({ value }), (error) => ({ error, timeout: isTimeout(error) }));
  void settled.then(() => { isSettled = true; stopFill.abort(); });
  let fillError = null;
  try { await fill({ ...fillArgs, pid, exclude, timeoutMs: COMMAND_TIMEOUT_MS + 5000, signal: stopFill.signal }); } catch (e) { fillError = e; }
  let lateCancelled = [];
  // Preset dialogs a cancel watch pressed Cancel on but could not close: Studio One stays modal.
  const stillOpen = [];
  const watch = async (args) => {
    const w = await cancelWatch(args);
    stillOpen.push(...[].concat(w.failed ?? []));
    return w;
  };
  if (fillError && !fillError.found && !isSettled) {
    const stopWatch = new AbortController();
    void settled.then(() => stopWatch.abort());
    const timeoutMs = Math.max(0, COMMAND_TIMEOUT_MS - (Date.now() - started)) + CANCEL_MARGIN_MS;
    try { lateCancelled = (await watch({ pid, exclude, timeoutMs, signal: stopWatch.signal })).cancelled; } catch { /* reported below */ }
  }
  const r = await settled;
  if (r.timeout) {
    let w = { cancelled: [] };
    try { w = await watch({ pid, exclude, timeoutMs: LATE_CANCEL_MS }); } catch { /* best effort */ }
    if (stillOpen.length) throw stillOpenError(stillOpen);
    const cancelled = lateCancelled.length + w.cancelled.length > 0;
    throw new Error(cancelled ? 'Studio One took too long; the preset dialog was cancelled'
      : `Studio One took too long; no preset dialog was seen to cancel${fillError ? ` (${fillError.message})` : ''}`);
  }
  if (stillOpen.length) throw stillOpenError(stillOpen);
  if (r.error) throw r.error;
  if (fillError) {
    // The call returned OK although the filler never saw our dialog (it was stopped while
    // waiting): the caller decides (an export counts if its file exists).
    if (fillError.aborted && !fillError.found && r.value?.ok === true) return { value: r.value, missed: true };
    if (lateCancelled.length) throw new Error(`${fillError.message}; the preset dialog came later and was cancelled`);
    throw fillError;
  }
  if (!r.value || r.value.ok !== true) throw new Error(`${command} did not run (Studio One answered ${JSON.stringify(r.value)})`);
  return { value: r.value, missed: false };
}

const removeQuietly = (p) => { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } };

// -> { ext, buf }: the plug-in's current state as the preset file it exports
// (.vstpreset for VST3, .preset for Studio One's own plug-ins, .instrument for an instrument).
export async function exportState(call, target, { fill = fillFileDialog, snapshot = snapshotDialogs, cancelWatch = cancelPresetDialogs, tmpDir = defaultTmpDir() } = {}) {
  return withDialogLock(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    sweepStale(tmpDir);
    const base = randomUUID();
    const stem = path.join(tmpDir, base);
    checkPathLength(stem + '.vstpreset');
    const ours = () => fs.readdirSync(tmpDir).filter((f) => f === base || f.startsWith(base + '.'));
    try {
      const { missed } = await runWithDialog(call, target, 'Export Preset', { fill, snapshot, cancelWatch }, { path: stem, expect: 'export' });
      const files = ours();
      if (!files.length) throw new Error(missed ? 'Export Preset: the preset dialog was never seen and no file was written' : 'Export Preset: Studio One wrote no preset file');
      const file = files[0];
      const ext = path.extname(file).toLowerCase();
      if (!PRESET_EXTS.includes(ext)) throw new Error(`Export Preset: unexpected preset file ${file}`);
      return { ext, buf: fs.readFileSync(path.join(tmpDir, file)) };
    } finally {
      try { for (const f of ours()) removeQuietly(path.join(tmpDir, f)); } catch { /* best effort */ }
    }
  });
}

// Loads `buf` (a preset file of type `ext`) into the plug-in in place.
export async function loadState(call, target, buf, ext, { fill = fillFileDialog, snapshot = snapshotDialogs, cancelWatch = cancelPresetDialogs, tmpDir = defaultTmpDir() } = {}) {
  const e = String(ext || '').toLowerCase();
  const dotted = e.startsWith('.') ? e : '.' + e;
  if (dotted === '.instrument') throw new Error(INSTRUMENT_LOAD_REFUSED);
  if (!LOAD_EXTS.includes(dotted)) throw new Error(`loadState: unsupported preset extension ${ext} (use ${LOAD_EXTS.join(', ')})`);
  return withDialogLock(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    sweepStale(tmpDir);
    const file = path.join(tmpDir, randomUUID() + dotted);
    checkPathLength(file);
    try {
      fs.writeFileSync(file, buf);
      const { missed } = await runWithDialog(call, target, 'Load Preset File', { fill, snapshot, cancelWatch }, { path: file, expect: 'load' });
      if (missed) throw new Error('Load Preset File returned, but its dialog was never seen: the preset was not loaded by us');
      return { ok: true };
    } finally {
      removeQuietly(file);
    }
  });
}
