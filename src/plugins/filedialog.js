// Fills Studio One's own "Export Preset" / "Load Preset" file dialog (Windows), so a plug-in's state
// can go out to and come back from a preset file in place. The dialog is driven through its controls
// only (WM_SETTEXT on the filename field, BM_CLICK on OK / Cancel): no window is brought to the
// foreground and no keyboard or mouse input is faked, so the user can keep working in other windows.
//
// Only dialogs that are NEW are touched: the caller takes a snapshot (snapshotDialogs) of the
// Studio One instance's visible dialogs before it starts the preset command, and the filler ignores
// every handle in that snapshot (the user's own Save As, Import, ... dialogs stay untouched).
import { execFile } from 'node:child_process';

export const MAX_PATH_CHARS = 240;

// Win32 helpers shared by both scripts (static text).
const TYPES = `Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class S1McpDialog {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, string l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, StringBuilder l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  const uint SMTO_ABORTIFHUNG = 2;
  static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static bool Shown(IntPtr h) { return IsWindow(h) && IsWindowVisible(h); }
  // Visible top-level dialogs (class #32770) of one process.
  public static List<IntPtr> Dialogs(int pid) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && Cls(h) == "#32770") r.Add(h);
      return true; }, IntPtr.Zero);
    return r;
  }
  public static IntPtr Owner(IntPtr h) { return GetWindow(h, 4); }
  public static IntPtr FirstEdit(IntPtr dlg) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dlg, (h, l) => { if (Cls(h) == "Edit") { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FileField(IntPtr dlg) { IntPtr e = GetDlgItem(dlg, 0x47C); return e != IntPtr.Zero ? e : FirstEdit(dlg); }
  public static void SetText(IntPtr h, string s) { IntPtr r; SendMessageTimeout(h, 0x000C, IntPtr.Zero, s, SMTO_ABORTIFHUNG, 2000, out r); }
  public static string GetText(IntPtr h) { var sb = new StringBuilder(4096); IntPtr r; SendMessageTimeout(h, 0x000D, (IntPtr)4096, sb, SMTO_ABORTIFHUNG, 2000, out r); return sb.ToString(); }
  // A message box's words: its title and its Static controls (a task dialog's text is not readable).
  public static string Words(IntPtr dlg) {
    var parts = new List<string>(); parts.Add(Title(dlg));
    EnumChildWindows(dlg, (h, l) => { if (Cls(h) == "Static") { var t = GetText(h).Trim(); if (t.Length > 0) parts.Add(t); } return true; }, IntPtr.Zero);
    return String.Join(" | ", parts);
  }
  // BM_CLICK on the dialog's button; the short timeout keeps a modal follow-up (overwrite confirm)
  // from blocking us. Without such a button: WM_COMMAND(id) to the dialog.
  public static bool Click(IntPtr dlg, int id) {
    IntPtr b = GetDlgItem(dlg, id); IntPtr r;
    if (b != IntPtr.Zero) { SendMessageTimeout(b, 0x00F5, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 500, out r); return true; }
    return PostMessage(dlg, 0x0111, (IntPtr)id, IntPtr.Zero);
  }
  // A task dialog (Vista-style) has no button windows: TDM_CLICK_BUTTON.
  public static bool ClickTask(IntPtr dlg, int id) {
    if (GetDlgItem(dlg, id) != IntPtr.Zero) return Click(dlg, id);
    return PostMessage(dlg, 0x0466, (IntPtr)id, IntPtr.Zero);
  }
}
"@
function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }
# Cancel, then OK (a box with only OK), then WM_CLOSE; true when it went away.
function Dismiss($c) {
  [void][S1McpDialog]::ClickTask($c, 2); Start-Sleep -Milliseconds 300
  if ([S1McpDialog]::Shown($c)) { [void][S1McpDialog]::ClickTask($c, 1); Start-Sleep -Milliseconds 300 }
  if ([S1McpDialog]::Shown($c)) { [void][S1McpDialog]::Click($c, 2); Start-Sleep -Milliseconds 300 }
  return -not [S1McpDialog]::Shown($c)
}
`;

// Picks the Studio One instance (exactly one process, or the one whose main window is titled
// "Studio One - <song>") and lists its visible dialogs. -> {"ok":true,"pid":..,"handles":[..]}.
export const SNAPSHOT_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
${TYPES}
try {
  $procs = @(Get-Process "Studio One" -ErrorAction SilentlyContinue)
  if ($procs.Count -gt 1) { $procs = @($procs | Where-Object { $_.MainWindowTitle.StartsWith("Studio One - ") }) }
  if ($procs.Count -eq 0) { Emit @{ ok = $false; error = 'Studio One is not running' }; exit 0 }
  if ($procs.Count -gt 1) { Emit @{ ok = $false; error = 'several Studio One instances are running with a song open; close all but one' }; exit 0 }
  $target = $procs[0].Id
  $handles = @([S1McpDialog]::Dialogs($target) | ForEach-Object { $_.ToInt64() })
  Emit @{ ok = $true; pid = $target; handles = $handles }
} catch { Emit @{ ok = $false; error = [string]$_.Exception.Message } }
`;

// Static filler: the path, mode, process, snapshot and timeout come from the environment
// (S1MCP_FD_*), never from the script text. Prints one JSON line: {"ok":true,"title":...} or
// {"ok":false,"error":...,"cancelled":bool}. It touches only dialogs of process S1MCP_FD_PID that
// are not in S1MCP_FD_EXCLUDE. On a failure after its dialog appeared it presses Cancel (id 2), so
// the blocked bridge call returns; a new box with no filename field that appears instead of the
// file dialog, or right after it closed (an error such as a corrupt preset), is read and dismissed.
export const FILEDIALOG_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$path = $env:S1MCP_FD_PATH
$expect = $env:S1MCP_FD_EXPECT
$timeoutMs = [int]$env:S1MCP_FD_TIMEOUT_MS
$target = [int]$env:S1MCP_FD_PID
$exclude = New-Object 'System.Collections.Generic.HashSet[long]'
foreach ($x in ([string]$env:S1MCP_FD_EXCLUDE).Split(',')) { if ($x.Trim()) { [void]$exclude.Add([long]$x.Trim()) } }
$dlg = [IntPtr]::Zero
${TYPES}
function NewDialogs($skip) { @([S1McpDialog]::Dialogs($target) | Where-Object { -not $exclude.Contains($_.ToInt64()) -and -not $skip.Contains($_.ToInt64()) }) }
try {
  if ($expect -ne 'export' -and $expect -ne 'load') { throw "expect must be export or load" }
  if (-not $path) { throw "no path" }
  if ($target -le 0) { throw "no Studio One process id" }
  $titles = '^(Exportar preset|Export Preset|Cargar preset|Load Preset)'
  $none = New-Object 'System.Collections.Generic.HashSet[long]'
  $firstSeen = @{}
  $box = [IntPtr]::Zero
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    $files = @(); $others = @()
    foreach ($h in (NewDialogs $none)) { if ([S1McpDialog]::FileField($h) -ne [IntPtr]::Zero) { $files += $h } else { $others += $h } }
    if ($files.Count -gt 0) {
      # Prefer the known titles; any new file dialog of this instance will do (other UI languages).
      $pick = @($files | Where-Object { [S1McpDialog]::Title($_) -match $titles })
      $dlg = if ($pick.Count -gt 0) { $pick[0] } else { $files[0] }
      break
    }
    foreach ($h in $others) {
      $k = [string]$h.ToInt64()
      if (-not $firstSeen.ContainsKey($k)) { $firstSeen[$k] = $sw.ElapsedMilliseconds }
      elseif ($sw.ElapsedMilliseconds - $firstSeen[$k] -ge 1500) { $box = $h }
    }
    if ($box -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 100
  }
  if ($box -ne [IntPtr]::Zero) {
    $words = [S1McpDialog]::Words($box)
    $gone = Dismiss $box
    Emit @{ ok = $false; error = "Studio One showed a message instead of the file dialog: $words"; cancelled = $gone }; exit 0
  }
  if ($dlg -eq [IntPtr]::Zero) { Emit @{ ok = $false; error = "no file dialog appeared within $timeoutMs ms" }; exit 0 }
  $title = [S1McpDialog]::Title($dlg)
  $edit = [S1McpDialog]::FileField($dlg)
  # The dialog may still be filling in its default name: set, read back, retry.
  $took = $false
  for ($i = 0; $i -lt 10 -and -not $took; $i++) {
    Start-Sleep -Milliseconds 150
    [S1McpDialog]::SetText($edit, $path)
    Start-Sleep -Milliseconds 100
    $took = ([S1McpDialog]::GetText($edit) -eq $path)
  }
  if (-not $took) { throw "the filename field did not take the path" }
  [void][S1McpDialog]::Click($dlg, 1)
  $answered = New-Object 'System.Collections.Generic.HashSet[long]'
  $closed = $false
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt 3000) {
    if (-not [S1McpDialog]::Shown($dlg)) { $closed = $true; break }
    foreach ($c in (NewDialogs $answered)) {
      if ($c -eq $dlg -or [S1McpDialog]::Owner($c) -ne $dlg) { continue }
      $ask = [S1McpDialog]::Words($c)
      if ($expect -eq 'export') { [void][S1McpDialog]::ClickTask($c, 6); [void]$answered.Add($c.ToInt64()); $sw.Restart() }
      else { throw "Studio One asked: $ask" }
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $closed) { throw "the dialog '$title' did not close after OK" }
  # An error box right after the dialog closed (e.g. a corrupt preset): read it, dismiss it, report it.
  [void]$answered.Add($dlg.ToInt64())
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt 600) {
    foreach ($c in (NewDialogs $answered)) {
      $words = [S1McpDialog]::Words($c)
      $gone = Dismiss $c
      Emit @{ ok = $false; error = "Studio One said after the dialog closed: $words"; cancelled = $gone; closed = $true }; exit 0
    }
    Start-Sleep -Milliseconds 100
  }
  Emit @{ ok = $true; title = $title }
  exit 0
} catch {
  $msg = [string]$_.Exception.Message
  $cancelled = $false
  if ($dlg -ne [IntPtr]::Zero -and [S1McpDialog]::IsWindow($dlg)) {
    # Dismiss any follow-up dialog first, then Cancel the file dialog.
    foreach ($c in [S1McpDialog]::Dialogs($target)) {
      if ($c -ne $dlg -and [S1McpDialog]::Owner($c) -eq $dlg) { [void](Dismiss $c) }
    }
    Start-Sleep -Milliseconds 200
    [void][S1McpDialog]::Click($dlg, 2)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 2000 -and [S1McpDialog]::Shown($dlg)) { Start-Sleep -Milliseconds 100 }
    $cancelled = -not [S1McpDialog]::Shown($dlg)
  }
  Emit @{ ok = $false; error = $msg; cancelled = $cancelled }
  exit 0
}
`;

const runFile = (cmd, args, opts) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts }, (err, stdout, stderr) => {
    if (err) reject(err.name === 'AbortError' ? err : new Error(String(stderr || err.message).trim()));
    else resolve(stdout);
  });
});

const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

function lastJson(out) {
  const line = String(out).split(/\r?\n/).map((s) => s.replace(/^﻿/, '').trim()).filter((s) => s.startsWith('{')).pop();
  try { return line ? JSON.parse(line) : null; } catch { return null; }
}

const notWindows = () => new Error('Filling the preset file dialog is not supported on this platform (Windows only).');

// -> { pid, exclude: [handles] }: the Studio One instance and its dialogs open right now.
export async function snapshotDialogs({ platform = process.platform, run = runFile } = {}) {
  if (platform !== 'win32') throw notWindows();
  let out;
  try { out = await run('powershell.exe', psArgs(SNAPSHOT_SCRIPT), { timeout: 20000 }); } catch (e) {
    throw new Error(`file dialog: the PowerShell snapshot failed: ${e.message}`);
  }
  const r = lastJson(out);
  if (!r) throw new Error(`file dialog: unexpected snapshot output: ${String(out).trim().slice(0, 300)}`);
  if (r.ok !== true) throw new Error(`file dialog: ${r.error || 'snapshot failed'}`);
  const handles = Array.isArray(r.handles) ? r.handles : r.handles == null ? [] : [r.handles];
  return { pid: Number(r.pid), exclude: handles.map(Number) };
}

// Waits (up to timeoutMs) for a NEW file dialog of Studio One process `pid` (not in `exclude`),
// types `path` into its filename field and presses OK. `expect: 'export'` also answers Yes to an
// overwrite confirm. `signal` aborts the wait (the bridge call already failed, no dialog will come).
// -> { ok: true, title } or throws (after pressing Cancel when the dialog was there).
export async function fillFileDialog({ path, expect, pid, exclude = [], timeoutMs = 8000, signal, platform = process.platform, run = runFile } = {}) {
  if (platform !== 'win32') throw notWindows();
  if (expect !== 'export' && expect !== 'load') throw new Error(`expect must be 'export' or 'load', not ${expect}`);
  if (typeof path !== 'string' || !path) throw new Error('fillFileDialog needs a path');
  if (path.length > MAX_PATH_CHARS) throw new Error(`file dialog: the path is longer than ${MAX_PATH_CHARS} characters: ${path.slice(0, 60)}...`);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('fillFileDialog needs the Studio One process id (snapshotDialogs)');
  const env = {
    ...process.env, S1MCP_FD_PATH: path, S1MCP_FD_EXPECT: expect, S1MCP_FD_TIMEOUT_MS: String(timeoutMs),
    S1MCP_FD_PID: String(pid), S1MCP_FD_EXCLUDE: exclude.map((h) => String(Math.trunc(Number(h)))).join(','),
  };
  let out;
  try {
    out = await run('powershell.exe', psArgs(FILEDIALOG_SCRIPT), { env, timeout: timeoutMs + 20000, ...(signal ? { signal } : {}) });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('file dialog: stopped waiting (the preset command already returned)');
    throw new Error(`file dialog: the PowerShell filler failed: ${e.message}`);
  }
  const r = lastJson(out);
  if (!r) throw new Error(`file dialog: unexpected filler output: ${String(out).trim().slice(0, 300)}`);
  if (r.ok !== true) throw new Error(`file dialog: ${r.error || 'failed'}${r.cancelled ? ' (cancelled)' : ''}`);
  return { ok: true, title: r.title ?? null };
}
