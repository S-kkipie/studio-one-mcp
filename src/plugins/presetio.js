// A plug-in's state out of / into Studio One in place, through the plug-in's own Presets commands
// ("Export Preset" / "Load Preset File") and their file dialog. The instance, its slot, its channel
// and its bypass stay as they are, and the song is never saved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { presetCommand } from './controller.js';
import { fillFileDialog, snapshotDialogs, MAX_PATH_CHARS } from './filedialog.js';

// .instrument: what Studio One writes for an instrument's Export Preset (7.2.3, Mai Tai).
export const PRESET_EXTS = ['.vstpreset', '.preset', '.fxpreset', '.instrument'];
export const COMMAND_TIMEOUT_MS = 30000;
const STALE_MS = 10 * 60 * 1000;

export const defaultTmpDir = () => path.join(os.tmpdir(), 'studio-one-mcp');

// One file dialog at a time. Separate from the controller's serialized() queue, so a caller that
// already holds that queue cannot deadlock against this one.
let dialogQueue = Promise.resolve();
export function withDialogLock(fn) {
  const p = dialogQueue.then(fn, fn);
  dialogQueue = p.catch(() => {});
  return p;
}

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

// Snapshot the dialogs that are already open, start the bridge call (it blocks while the dialog is
// open), fill the dialog, then await the call. The fill waits as long as the call can take, so a
// late dialog is still handled; when the call fails first (e.g. "not available": no dialog will
// come) the fill is stopped. When the fill fails, the filler has pressed Cancel, so the call still
// returns. A bridge error explains more than the fill error it caused.
async function runWithDialog(call, target, command, { fill, snapshot }, fillArgs) {
  const { pid, exclude } = await snapshot();
  const stop = new AbortController();
  const pending = presetCommand(call, target, command, { timeoutMs: COMMAND_TIMEOUT_MS });
  const settled = pending.then((value) => ({ value }), (error) => {
    // A timeout means Studio One may still open the dialog: let the filler go on to handle it.
    if (!/did not answer/.test(error.message)) stop.abort();
    return { error };
  });
  let fillError = null;
  try { await fill({ ...fillArgs, pid, exclude, timeoutMs: COMMAND_TIMEOUT_MS + 5000, signal: stop.signal }); } catch (e) { fillError = e; }
  const r = await settled;
  if (r.error) throw r.error;
  if (fillError) throw fillError;
  if (!r.value || r.value.ok !== true) throw new Error(`${command} did not run (Studio One answered ${JSON.stringify(r.value)})`);
  return r.value;
}

const removeQuietly = (p) => { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } };

// -> { ext, buf }: the plug-in's current state as the preset file it exports
// (.vstpreset for VST3, .preset for Studio One's own plug-ins, .instrument for an instrument).
export async function exportState(call, target, { fill = fillFileDialog, snapshot = snapshotDialogs, tmpDir = defaultTmpDir() } = {}) {
  return withDialogLock(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    sweepStale(tmpDir);
    const base = randomUUID();
    const stem = path.join(tmpDir, base);
    checkPathLength(stem + '.vstpreset');
    const ours = () => fs.readdirSync(tmpDir).filter((f) => f === base || f.startsWith(base + '.'));
    try {
      await runWithDialog(call, target, 'Export Preset', { fill, snapshot }, { path: stem, expect: 'export' });
      const files = ours();
      if (!files.length) throw new Error('Export Preset: Studio One wrote no preset file');
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
export async function loadState(call, target, buf, ext, { fill = fillFileDialog, snapshot = snapshotDialogs, tmpDir = defaultTmpDir() } = {}) {
  const e = String(ext || '').toLowerCase();
  const dotted = e.startsWith('.') ? e : '.' + e;
  if (!PRESET_EXTS.includes(dotted)) throw new Error(`loadState: unsupported preset extension ${ext} (use ${PRESET_EXTS.join(', ')})`);
  return withDialogLock(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    sweepStale(tmpDir);
    const file = path.join(tmpDir, randomUUID() + dotted);
    checkPathLength(file);
    try {
      fs.writeFileSync(file, buf);
      await runWithDialog(call, target, 'Load Preset File', { fill, snapshot }, { path: file, expect: 'load' });
      return { ok: true };
    } finally {
      removeQuietly(file);
    }
  });
}
