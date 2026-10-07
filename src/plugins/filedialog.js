// Studio One's own "Export Preset" / "Load Preset" file dialog (Windows), driven by the static
// script scripts/preset-dialog.ps1, so a plug-in's state can go out to and come back from a preset
// file in place. Only dialogs that are provably ours are touched: NEW (not in the snapshot taken
// before the command started), of the bridge's Studio One process, with a filename field and a
// file-type filter that names a preset extension. Controls are driven with WM_SETTEXT / BM_CLICK;
// no window is brought to the front and no keyboard or mouse input is faked.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_PATH_CHARS = 240;
export const DIALOG_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'preset-dialog.ps1');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DIALOG_SCRIPT];

// Runs the script; resolves with { stdout, aborted }. An abort kills it and keeps what it printed.
export function runScript(cmd, args, { env, timeout, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve({ stdout: '', aborted: true });
    const child = spawn(cmd, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const onAbort = () => { aborted = true; child.kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = timeout ? setTimeout(() => { timedOut = true; child.kill(); }, timeout) : null;
    child.on('error', (e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (aborted) return resolve({ stdout, aborted: true });
      if (timedOut) return reject(new Error(`timed out after ${timeout} ms`));
      if (code !== 0 && !stdout.trim()) return reject(new Error(String(stderr || `exit code ${code}`).trim()));
      resolve({ stdout, aborted: false });
    });
  });
}

function parseLines(stdout) {
  const lines = [];
  for (const raw of String(stdout).split(/\r?\n/)) {
    const s = raw.replace(/^﻿/, '').trim();
    if (!s.startsWith('{')) continue;
    try { lines.push(JSON.parse(s)); } catch { /* ignore */ }
  }
  return { events: lines.filter((l) => l.event), final: lines.filter((l) => !l.event).pop() ?? null };
}

const notWindows = () => new Error('Filling the preset file dialog is not supported on this platform (Windows only).');

async function exec(run, env, { timeout, signal } = {}) {
  try {
    const r = await run('powershell.exe', PS_ARGS, { env: { ...process.env, ...env }, timeout, ...(signal ? { signal } : {}) });
    return typeof r === 'string' ? { stdout: r, aborted: false } : r;
  } catch (e) {
    throw new Error(`file dialog: the PowerShell helper failed: ${e.message}`);
  }
}

// -> { pid, exclude: [handles] }: the Studio One instance (one process, or the one with a song
// window) and its dialogs open right now.
export async function snapshotDialogs({ platform = process.platform, run = runScript } = {}) {
  if (platform !== 'win32') throw notWindows();
  const { stdout } = await exec(run, { S1MCP_FD_MODE: 'snapshot' }, { timeout: 20000 });
  const r = parseLines(stdout).final;
  if (!r) throw new Error(`file dialog: unexpected snapshot output: ${String(stdout).trim().slice(0, 300)}`);
  if (r.ok !== true) throw new Error(`file dialog: ${r.error || 'snapshot failed'}`);
  const handles = Array.isArray(r.handles) ? r.handles : r.handles == null ? [] : [r.handles];
  return { pid: Number(r.pid), exclude: handles.map(Number) };
}

const envFor = (pid, exclude, timeoutMs) => ({
  S1MCP_FD_PID: String(pid), S1MCP_FD_EXCLUDE: exclude.map((h) => String(Math.trunc(Number(h)))).join(','), S1MCP_FD_TIMEOUT_MS: String(timeoutMs),
});

const fail = (message, props) => Object.assign(new Error(message), props);

// Waits (up to timeoutMs) for a NEW preset file dialog of Studio One process `pid` (handles in
// `exclude` are never touched), types `path` into its filename field and presses OK.
// `expect: 'export'` also answers Yes to an overwrite confirm owned by that dialog. `signal` (the
// bridge call returned) stops it: when OK had been pressed that is success, otherwise a failure
// with `found` telling whether the dialog had been seen.
// -> { ok: true, title } or throws an Error with { found, closed, button, foreign, aborted }.
export async function fillFileDialog({ path: p, expect, pid, exclude = [], timeoutMs = 8000, signal, platform = process.platform, run = runScript } = {}) {
  if (platform !== 'win32') throw notWindows();
  if (expect !== 'export' && expect !== 'load') throw new Error(`expect must be 'export' or 'load', not ${expect}`);
  if (typeof p !== 'string' || !p) throw new Error('fillFileDialog needs a path');
  if (p.length > MAX_PATH_CHARS) throw new Error(`file dialog: the path is longer than ${MAX_PATH_CHARS} characters: ${p.slice(0, 60)}...`);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('fillFileDialog needs the Studio One process id (snapshotDialogs)');
  const env = { S1MCP_FD_MODE: 'fill', S1MCP_FD_PATH: p, S1MCP_FD_EXPECT: expect, ...envFor(pid, exclude, timeoutMs) };
  const { stdout, aborted } = await exec(run, env, { timeout: timeoutMs + 20000, signal });
  const { events, final } = parseLines(stdout);
  const found = events.find((e) => e.event === 'found');
  const pressed = events.some((e) => e.event === 'ok-pressed' || e.event === 'closed');
  if (!final) {
    if (aborted && pressed) return { ok: true, title: found?.title ?? null, aborted: true };
    if (aborted) {
      throw fail(found ? 'file dialog: the preset command returned while its dialog was being filled'
        : 'file dialog: the preset command returned before its dialog was seen', { found: !!found, aborted: true });
    }
    throw fail(`file dialog: unexpected helper output: ${String(stdout).trim().slice(0, 300)}`, { found: !!found });
  }
  if (final.ok === true) return { ok: true, title: final.title ?? found?.title ?? null };
  const props = { found: final.found ?? !!found, closed: !!final.closed, button: final.button ?? null, foreign: !!final.foreign };
  if (final.closed && final.shown != null) {
    // OK went through; Studio One answered with a box, which was acknowledged.
    throw fail(`Studio One showed: ${final.shown}.${expect === 'load' ? ' The preset may have been applied.' : ''}`, props);
  }
  throw fail(`file dialog: ${final.error || 'failed'}${final.button === 'cancel' ? ' (cancelled)' : ''}`, props);
}

// Presses Cancel on every NEW preset file dialog of `pid` for up to timeoutMs (or until `signal`).
// Never OK. -> { cancelled: [titles], failed: [titles still open after the retries] }.
export async function cancelPresetDialogs({ pid, exclude = [], timeoutMs = 10000, signal, platform = process.platform, run = runScript } = {}) {
  if (platform !== 'win32') throw notWindows();
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('cancelPresetDialogs needs the Studio One process id');
  const { stdout } = await exec(run, { S1MCP_FD_MODE: 'cancel', ...envFor(pid, exclude, timeoutMs) }, { timeout: timeoutMs + 20000, signal });
  const { events, final } = parseLines(stdout);
  // failed: preset dialogs that were still open after the bounded Cancel retries.
  const failed = events.filter((e) => e.event === 'cancel-failed').map((e) => e.title);
  if (final && final.cancelled != null) return { cancelled: [].concat(final.cancelled), failed: final.failed != null ? [].concat(final.failed) : failed };
  return { cancelled: events.filter((e) => e.event === 'cancelled').map((e) => e.title), failed };
}
