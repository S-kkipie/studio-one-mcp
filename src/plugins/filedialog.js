// Fills Studio One's own "Export Preset" / "Load Preset" file dialog (Windows), so a plug-in's state
// can go out to and come back from a preset file in place. The dialog is driven through its controls
// only (WM_SETTEXT on the filename field, BM_CLICK on OK / Cancel): no window is brought to the
// foreground and no keyboard or mouse input is faked, so the user can keep working in other windows.
import { execFile } from 'node:child_process';

// Static script: the path, the mode and the timeout come from the environment (S1MCP_FD_*), never
// from the script text. Prints one JSON line: {"ok":true,"title":...} or {"ok":false,"error":...,
// "cancelled":bool}. On any failure after the dialog was found it presses Cancel (id 2), so the
// blocked bridge call returns.
export const FILEDIALOG_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$path = $env:S1MCP_FD_PATH
$expect = $env:S1MCP_FD_EXPECT
$timeoutMs = [int]$env:S1MCP_FD_TIMEOUT_MS
function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }
$dlg = [IntPtr]::Zero
try {
Add-Type @"
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
  // Visible top-level dialogs (class #32770) of the given processes.
  public static List<IntPtr> Dialogs(int[] pids) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p);
      if (Array.IndexOf(pids, p) >= 0 && IsWindowVisible(h) && Cls(h) == "#32770") r.Add(h);
      return true; }, IntPtr.Zero);
    return r;
  }
  public static IntPtr Owner(IntPtr h) { return GetWindow(h, 4); }
  public static IntPtr FirstEdit(IntPtr dlg) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dlg, (h, l) => { if (Cls(h) == "Edit") { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static void SetText(IntPtr h, string s) { IntPtr r; SendMessageTimeout(h, 0x000C, IntPtr.Zero, s, SMTO_ABORTIFHUNG, 2000, out r); }
  public static string GetText(IntPtr h) { var sb = new StringBuilder(4096); IntPtr r; SendMessageTimeout(h, 0x000D, (IntPtr)4096, sb, SMTO_ABORTIFHUNG, 2000, out r); return sb.ToString(); }
  // BM_CLICK on the dialog's button; the short timeout keeps a modal follow-up (overwrite confirm)
  // from blocking us. Without such a button: WM_COMMAND(id) to the dialog.
  public static bool Click(IntPtr dlg, int id) {
    IntPtr b = GetDlgItem(dlg, id); IntPtr r;
    if (b != IntPtr.Zero) { SendMessageTimeout(b, 0x00F5, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 500, out r); return true; }
    return PostMessage(dlg, 0x0111, (IntPtr)id, IntPtr.Zero);
  }
  // A task dialog (Vista-style confirm) has no button windows: TDM_CLICK_BUTTON.
  public static bool ClickTask(IntPtr dlg, int id) {
    if (GetDlgItem(dlg, id) != IntPtr.Zero) return Click(dlg, id);
    return PostMessage(dlg, 0x0466, (IntPtr)id, IntPtr.Zero);
  }
}
"@
  if ($expect -ne 'export' -and $expect -ne 'load') { throw "expect must be export or load" }
  if (-not $path) { throw "no path" }
  $pids = [int[]]@(Get-Process "Studio One" -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($pids.Count -eq 0) { Emit @{ ok = $false; error = 'Studio One is not running' }; exit 0 }
  $titles = '^(Exportar preset|Export Preset|Cargar preset|Load Preset)'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    foreach ($h in [S1McpDialog]::Dialogs($pids)) {
      if ([S1McpDialog]::GetDlgItem($h, 0x47C) -ne [IntPtr]::Zero -or [S1McpDialog]::Title($h) -match $titles) { $dlg = $h; break }
    }
    if ($dlg -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 100
  }
  if ($dlg -eq [IntPtr]::Zero) { Emit @{ ok = $false; error = "no file dialog appeared within $timeoutMs ms" }; exit 0 }
  $title = [S1McpDialog]::Title($dlg)
  $edit = [S1McpDialog]::GetDlgItem($dlg, 0x47C)
  if ($edit -eq [IntPtr]::Zero) { $edit = [S1McpDialog]::FirstEdit($dlg) }
  if ($edit -eq [IntPtr]::Zero) { throw "the dialog '$title' has no filename field" }
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
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $answered = @{}
  while ($sw.ElapsedMilliseconds -lt 3000) {
    if (-not [S1McpDialog]::IsWindow($dlg) -or -not [S1McpDialog]::IsWindowVisible($dlg)) { Emit @{ ok = $true; title = $title }; exit 0 }
    foreach ($c in [S1McpDialog]::Dialogs($pids)) {
      if ($c -eq $dlg -or [S1McpDialog]::Owner($c) -ne $dlg -or $answered.ContainsKey([string]$c)) { continue }
      $ask = [S1McpDialog]::Title($c)
      if ($expect -eq 'export') { [void][S1McpDialog]::ClickTask($c, 6); $answered[[string]$c] = 1; $sw.Restart() }
      else { throw "Studio One asked: $ask" }
    }
    Start-Sleep -Milliseconds 100
  }
  throw "the dialog '$title' did not close after OK"
} catch {
  $msg = [string]$_.Exception.Message
  $cancelled = $false
  if ($dlg -ne [IntPtr]::Zero -and [S1McpDialog]::IsWindow($dlg)) {
    # Answer any follow-up dialog first (Cancel; OK when it only has OK), then Cancel the file dialog.
    foreach ($c in [S1McpDialog]::Dialogs($pids)) {
      if ($c -ne $dlg -and [S1McpDialog]::Owner($c) -eq $dlg) {
        [void][S1McpDialog]::ClickTask($c, 2)
        Start-Sleep -Milliseconds 300
        if ([S1McpDialog]::IsWindow($c) -and [S1McpDialog]::IsWindowVisible($c)) { [void][S1McpDialog]::ClickTask($c, 1) }
      }
    }
    Start-Sleep -Milliseconds 200
    [void][S1McpDialog]::Click($dlg, 2)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 2000 -and [S1McpDialog]::IsWindow($dlg) -and [S1McpDialog]::IsWindowVisible($dlg)) { Start-Sleep -Milliseconds 100 }
    $cancelled = -not ([S1McpDialog]::IsWindow($dlg) -and [S1McpDialog]::IsWindowVisible($dlg))
  }
  Emit @{ ok = $false; error = $msg; cancelled = $cancelled }
  exit 0
}
`;

const runFile = (cmd, args, opts) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).trim()));
    else resolve(stdout);
  });
});

// Waits (up to timeoutMs) for Studio One's preset file dialog, types `path` into its filename
// field and presses OK. `expect: 'export'` also answers Yes to an overwrite confirm.
// -> { ok: true, title } or throws (after pressing Cancel when the dialog was there).
export async function fillFileDialog({ path, expect, timeoutMs = 8000, platform = process.platform, run = runFile } = {}) {
  if (platform !== 'win32') throw new Error('Filling the preset file dialog is not supported on this platform (Windows only).');
  if (expect !== 'export' && expect !== 'load') throw new Error(`expect must be 'export' or 'load', not ${expect}`);
  if (typeof path !== 'string' || !path) throw new Error('fillFileDialog needs a path');
  const encoded = Buffer.from(FILEDIALOG_SCRIPT, 'utf16le').toString('base64');
  const env = { ...process.env, S1MCP_FD_PATH: path, S1MCP_FD_EXPECT: expect, S1MCP_FD_TIMEOUT_MS: String(timeoutMs) };
  let out;
  try {
    out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env, timeout: timeoutMs + 20000 });
  } catch (e) {
    throw new Error(`file dialog: the PowerShell filler failed: ${e.message}`);
  }
  const line = String(out).split(/\r?\n/).map((s) => s.replace(/^﻿/, '').trim()).filter((s) => s.startsWith('{')).pop();
  let r = null;
  try { r = line ? JSON.parse(line) : null; } catch { r = null; }
  if (!r) throw new Error(`file dialog: unexpected filler output: ${String(out).trim().slice(0, 300)}`);
  if (r.ok !== true) throw new Error(`file dialog: ${r.error || 'failed'}${r.cancelled ? ' (cancelled)' : ''}`);
  return { ok: true, title: r.title ?? null };
}
