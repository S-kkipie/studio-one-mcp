// Drives Studio One's export dialog (Windows) through the static script scripts/export-dialog.ps1:
// posts OK (Enter) to the one new export dialog of the Studio One process, and reports an alert
// that follows. Keys go to that window only; nothing is brought to the front.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from '../plugins/filedialog.js';

export const EXPORT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'export-dialog.ps1');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', EXPORT_SCRIPT];

const notWindows = () => new Error("Exporting through Studio One's dialog is supported on Windows only");

function parseLines(stdout) {
  const lines = [];
  for (const raw of String(stdout).split(/\r?\n/)) {
    const s = raw.replace(/^﻿/, '').trim();
    if (!s.startsWith('{')) continue;
    try { lines.push(JSON.parse(s)); } catch { /* ignore */ }
  }
  return { events: lines.filter((l) => l.event), final: lines.filter((l) => !l.event && !('windows' in l)).pop() ?? null };
}

async function exec(run, env, timeout) {
  const r = await run('powershell.exe', PS_ARGS, { env: { ...process.env, ...env }, timeout });
  return typeof r === 'string' ? r : r.stdout;
}

// -> handles (hex strings) of the visible top-level windows of process `pid`.
export async function windowsSnapshot(pid, { run = runScript, platform = process.platform } = {}) {
  if (platform !== 'win32') throw notWindows();
  const stdout = await exec(run, { S1MCP_XD_MODE: 'snapshot', S1MCP_XD_PID: String(pid) }, 20000);
  const final = String(stdout).split(/\r?\n/).map((l) => { try { return JSON.parse(l.trim()); } catch { return null; } }).filter((o) => o && 'windows' in o).pop();
  if (!final) throw new Error(`export dialog: unexpected snapshot output: ${String(stdout).trim().slice(0, 300)}`);
  return [].concat(final.windows).map(String);
}

// Waits for a new export dialog (not in `before`), presses OK, watches for an alert.
// -> { ok: true, dialog } | { ok: false, reason, title?, dialog? }
export async function driveExportDialog({ pid, before = [], timeoutMs = 15000, watchMs = 4000 } = {}, { run = runScript, platform = process.platform } = {}) {
  if (platform !== 'win32') throw notWindows();
  const env = {
    S1MCP_XD_MODE: 'drive', S1MCP_XD_PID: String(pid), S1MCP_XD_BEFORE: before.join(','),
    S1MCP_XD_TIMEOUT_MS: String(timeoutMs), S1MCP_XD_WATCH_MS: String(watchMs),
  };
  const r = await run('powershell.exe', PS_ARGS, { env: { ...process.env, ...env }, timeout: timeoutMs + watchMs + 10000 });
  if (r && typeof r === 'object' && r.aborted) return { ok: false, reason: 'aborted' };
  const stdout = typeof r === 'string' ? r : r.stdout;
  const { events, final } = parseLines(stdout);
  if (!final) return { ok: false, reason: 'no result from the dialog helper' };
  const d = events.find((e) => e.event === 'dialog');
  const dialog = d ? { hwnd: d.hwnd, title: d.title } : undefined;
  return { ...final, ...(dialog ? { dialog } : {}) };
}
