// A plug-in's state out of / into Studio One in place, through the plug-in's own Presets commands
// ("Export Preset" / "Load Preset File") and their file dialog. The instance, its slot, its channel
// and its bypass stay as they are, and the song is never saved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { presetCommand } from './controller.js';
import { fillFileDialog } from './filedialog.js';

// .instrument: what Studio One writes for an instrument's Export Preset (7.2.3, Mai Tai).
export const PRESET_EXTS = ['.vstpreset', '.preset', '.fxpreset', '.instrument'];
const COMMAND_TIMEOUT_MS = 30000;

export const defaultTmpDir = () => path.join(os.tmpdir(), 'studio-one-mcp');

// The bridge call blocks while the dialog is open: start it, fill the dialog, then await it. When
// the fill fails the filler has pressed Cancel, so the call still returns; a bridge error (e.g.
// "not available", which means no dialog ever opened) explains more than the fill error.
async function runWithDialog(call, target, command, fill, fillArgs) {
  const pending = presetCommand(call, target, command, { timeoutMs: COMMAND_TIMEOUT_MS });
  const settled = pending.then((value) => ({ value }), (error) => ({ error }));
  let fillError = null;
  try { await fill(fillArgs); } catch (e) { fillError = e; }
  const r = await settled;
  if (r.error) throw r.error;
  if (fillError) throw fillError;
  if (!r.value || r.value.ok !== true) throw new Error(`${command}: unexpected answer from Studio One: ${JSON.stringify(r.value)}`);
  return r.value;
}

const removeQuietly = (p) => { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } };

// -> { ext, buf }: the plug-in's current state as the preset file it exports
// (.vstpreset for VST3, .preset for Studio One's own plug-ins, ...).
export async function exportState(call, target, { fill = fillFileDialog, tmpDir = defaultTmpDir() } = {}) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const base = randomUUID();
  const stem = path.join(tmpDir, base);
  const ours = () => fs.readdirSync(tmpDir).filter((f) => f === base || f.startsWith(base + '.'));
  try {
    await runWithDialog(call, target, 'Export Preset', fill, { path: stem, expect: 'export' });
    const files = ours();
    if (!files.length) throw new Error('Export Preset: Studio One wrote no preset file');
    const file = files[0];
    const ext = path.extname(file).toLowerCase();
    if (!PRESET_EXTS.includes(ext)) throw new Error(`Export Preset: unexpected preset file ${file}`);
    return { ext, buf: fs.readFileSync(path.join(tmpDir, file)) };
  } finally {
    try { for (const f of ours()) removeQuietly(path.join(tmpDir, f)); } catch { /* best effort */ }
  }
}

// Loads `buf` (a preset file of type `ext`) into the plug-in in place.
export async function loadState(call, target, buf, ext, { fill = fillFileDialog, tmpDir = defaultTmpDir() } = {}) {
  const e = String(ext || '').toLowerCase();
  const dotted = e.startsWith('.') ? e : '.' + e;
  if (!PRESET_EXTS.includes(dotted)) throw new Error(`loadState: unsupported preset extension ${ext} (use ${PRESET_EXTS.join(', ')})`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, randomUUID() + dotted);
  try {
    fs.writeFileSync(file, buf);
    await runWithDialog(call, target, 'Load Preset File', fill, { path: file, expect: 'load' });
    return { ok: true };
  } finally {
    removeQuietly(file);
  }
}
