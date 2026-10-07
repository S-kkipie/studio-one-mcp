# Studio One preset file dialog helper (Windows). Static script: every input comes from the
# environment (S1MCP_FD_*), never from the command line or the script text.
#
#   S1MCP_FD_MODE  snapshot | fill | cancel
#   snapshot: picks the Studio One instance and lists its visible dialogs.
#             -> {"ok":true,"pid":N,"handles":[...]}
#   fill:     S1MCP_FD_PID, S1MCP_FD_EXCLUDE (handles from the snapshot), S1MCP_FD_PATH,
#             S1MCP_FD_EXPECT (export|load), S1MCP_FD_TIMEOUT_MS. Waits for a NEW preset file
#             dialog of that process, types the path, presses OK. Progress lines
#             {"event":"found"|"ok-pressed"|"closed"} then one final {"ok":...} line.
#   cancel:   S1MCP_FD_PID, S1MCP_FD_EXCLUDE, S1MCP_FD_TIMEOUT_MS. Presses Cancel on every NEW
#             preset file dialog of that process until the time is up (or the caller kills it).
#             Lines {"event":"cancelled","title":...}, then {"ok":true,"cancelled":[...]}.
#
# A dialog is ours only when it is NEW (not in the snapshot), belongs to the bridge's Studio One
# process, has a filename field, and its file-type filter names a preset extension. Any other
# dialog is never filled and never clicked. Controls are driven with WM_SETTEXT / BM_CLICK only:
# no window is brought to the front and no keyboard or mouse input is faked.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

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
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, string l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, StringBuilder l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  const uint SMTO_ABORTIFHUNG = 2;
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static bool Shown(IntPtr h) { return IsWindow(h) && IsWindowVisible(h); }
  public static List<IntPtr> Dialogs(int pid) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && Cls(h) == "#32770") r.Add(h);
      return true; }, IntPtr.Zero);
    return r;
  }
  public static IntPtr Owner(IntPtr h) { return GetWindow(h, 4); }
  public static List<IntPtr> Kids(IntPtr dlg) {
    var r = new List<IntPtr>();
    EnumChildWindows(dlg, (h, l) => { r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
  public static IntPtr FirstOf(IntPtr dlg, string cls) {
    foreach (var h in Kids(dlg)) if (Cls(h) == cls) return h;
    return IntPtr.Zero;
  }
  // Load dialogs: 0x47C (an Edit inside the ComboBoxEx). Export (Vista save) dialogs: the first Edit (0x3E9).
  public static IntPtr FileField(IntPtr dlg) {
    foreach (var h in Kids(dlg)) if (Cls(h) == "Edit" && GetDlgCtrlIdOf(h) == 0x47C) return h;
    IntPtr e = GetDlgItem(dlg, 0x47C);
    if (e != IntPtr.Zero && Cls(e) == "Edit") return e;
    return FirstOf(dlg, "Edit");
  }
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  static int GetDlgCtrlIdOf(IntPtr h) { return GetDlgCtrlID(h); }
  public static string GetText(IntPtr h) { var sb = new StringBuilder(4096); IntPtr r; SendMessageTimeout(h, 0x000D, (IntPtr)4096, sb, SMTO_ABORTIFHUNG, 2000, out r); return sb.ToString(); }
  public static void SetText(IntPtr h, string s) { IntPtr r; SendMessageTimeout(h, 0x000C, IntPtr.Zero, s, SMTO_ABORTIFHUNG, 2000, out r); }
  static long Send(IntPtr h, uint m, long w) { IntPtr r; SendMessageTimeout(h, m, (IntPtr)w, IntPtr.Zero, SMTO_ABORTIFHUNG, 2000, out r); return r.ToInt64(); }
  // Every file-type filter the dialog shows: cmb1 (0x470) on load dialogs, an id-0 ComboBox on
  // export dialogs; the text and the items of each ComboBox.
  public static string Filters(IntPtr dlg) {
    var parts = new List<string>();
    foreach (var h in Kids(dlg)) {
      if (Cls(h) != "ComboBox") continue;
      parts.Add(GetText(h));
      long n = Send(h, 0x0146, 0);
      for (int i = 0; i < n && i < 32; i++) { var sb = new StringBuilder(1024); IntPtr r; SendMessageTimeout(h, 0x0148, (IntPtr)i, sb, SMTO_ABORTIFHUNG, 2000, out r); parts.Add(sb.ToString()); }
    }
    return String.Join(" ;; ", parts);
  }
  // Message-box shaped: Static and Button children, no Edit.
  public static bool BoxShaped(IntPtr dlg) {
    bool st = false, bt = false, ed = false;
    foreach (var h in Kids(dlg)) { var c = Cls(h); if (c == "Static") st = true; else if (c == "Button") bt = true; else if (c == "Edit") ed = true; }
    return st && bt && !ed;
  }
  public static string Words(IntPtr dlg) {
    var parts = new List<string>();
    foreach (var h in Kids(dlg)) if (Cls(h) == "Static" && IsWindowVisible(h)) { var t = GetText(h).Trim(); if (t.Length > 0) parts.Add(t); }
    return parts.Count > 0 ? String.Join(" ", parts) : Title(dlg);
  }
  // BM_CLICK on the dialog's button (short timeout: a modal follow-up must not block us).
  public static bool Click(IntPtr dlg, int id) {
    IntPtr b = GetDlgItem(dlg, id); IntPtr r;
    if (b == IntPtr.Zero) return false;
    SendMessageTimeout(b, 0x00F5, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 500, out r);
    return true;
  }
  // Follow-ups owned by our file dialog may be task dialogs (no button windows): TDM_CLICK_BUTTON.
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static bool ClickTask(IntPtr dlg, int id) {
    if (Click(dlg, id)) return true;
    return PostMessage(dlg, 0x0466, (IntPtr)id, IntPtr.Zero);
  }
}
"@

function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
$presetFilter = '\*\.(vstpreset|preset|fxpreset|instrument)\b'
$knownTitles = '^(Exportar preset|Export Preset|Cargar preset|Load Preset)'
$mode = [string]$env:S1MCP_FD_MODE

if ($mode -eq 'snapshot') {
  try {
    $procs = @(Get-Process "Studio One" -ErrorAction SilentlyContinue)
    if ($procs.Count -gt 1) { $procs = @($procs | Where-Object { $_.MainWindowTitle.StartsWith("Studio One - ") }) }
    if ($procs.Count -eq 0) { Emit @{ ok = $false; error = 'Studio One is not running' }; exit 0 }
    if ($procs.Count -gt 1) { Emit @{ ok = $false; error = 'several Studio One instances are running with a song open; close all but one' }; exit 0 }
    $target = $procs[0].Id
    $handles = @([S1McpDialog]::Dialogs($target) | ForEach-Object { $_.ToInt64() })
    Emit @{ ok = $true; pid = $target; handles = $handles }
  } catch { Emit @{ ok = $false; error = [string]$_.Exception.Message } }
  exit 0
}

$target = [int]$env:S1MCP_FD_PID
$timeoutMs = [int]$env:S1MCP_FD_TIMEOUT_MS
$exclude = New-Object 'System.Collections.Generic.HashSet[long]'
foreach ($x in ([string]$env:S1MCP_FD_EXCLUDE).Split(',')) { if ($x.Trim()) { [void]$exclude.Add([long]$x.Trim()) } }
function IsNew($h) { -not $exclude.Contains($h.ToInt64()) }
# A preset file dialog: a filename field and a file-type filter naming a preset extension.
function IsPresetDialog($h) {
  ([S1McpDialog]::FileField($h) -ne [IntPtr]::Zero) -and ([S1McpDialog]::Filters($h) -match $presetFilter)
}

if ($mode -eq 'cancel') {
  $done = New-Object 'System.Collections.Generic.HashSet[long]'
  $titles = @()
  if ($target -le 0) { Emit @{ ok = $false; error = 'no Studio One process id' }; exit 0 }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    foreach ($h in [S1McpDialog]::Dialogs($target)) {
      if (-not (IsNew $h) -or $done.Contains($h.ToInt64())) { continue }
      if (IsPresetDialog $h) {
        $t = [S1McpDialog]::Title($h)
        [void][S1McpDialog]::Click($h, 2)
        [void]$done.Add($h.ToInt64())
        $titles += $t
        Emit @{ event = 'cancelled'; title = $t }
      }
    }
    Start-Sleep -Milliseconds 100
  }
  Emit @{ ok = $true; cancelled = $titles }
  exit 0
}

if ($mode -ne 'fill') { Emit @{ ok = $false; error = "unknown mode $mode" }; exit 0 }

$path = $env:S1MCP_FD_PATH
$expect = $env:S1MCP_FD_EXPECT
$dlg = [IntPtr]::Zero
$dlgOwner = 0
try {
  if ($expect -ne 'export' -and $expect -ne 'load') { throw "expect must be export or load" }
  if (-not $path) { throw "no path" }
  if ($target -le 0) { throw "no Studio One process id" }
  $firstSeen = @{}
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs -and $dlg -eq [IntPtr]::Zero) {
    foreach ($h in [S1McpDialog]::Dialogs($target)) {
      if (-not (IsNew $h)) { continue }
      $k = [string]$h.ToInt64()
      if (-not $firstSeen.ContainsKey($k)) { $firstSeen[$k] = $sw.ElapsedMilliseconds }
      if (IsPresetDialog $h) { $dlg = $h; break }
      # Not (yet) a preset dialog: give it a second to fill in its controls, then give up on it.
      # It is never filled and never clicked.
      $age = $sw.ElapsedMilliseconds - $firstSeen[$k]
      $hasField = [S1McpDialog]::FileField($h) -ne [IntPtr]::Zero
      if ($age -ge 1000 -and $hasField) {
        Emit @{ ok = $false; found = $false; foreign = $true; error = "a new dialog '$([S1McpDialog]::Title($h))' is not a preset file dialog; it was left alone" }; exit 0
      }
      if ($age -ge 1500 -and -not $hasField) {
        Emit @{ ok = $false; found = $false; foreign = $true; error = "Studio One showed '$([S1McpDialog]::Title($h))' instead of the preset dialog; it was left open" }; exit 0
      }
    }
    if ($dlg -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
  }
  if ($dlg -eq [IntPtr]::Zero) { Emit @{ ok = $false; found = $false; error = "no preset file dialog appeared within $timeoutMs ms" }; exit 0 }
  $title = [S1McpDialog]::Title($dlg)
  $dlgOwner = [S1McpDialog]::Owner($dlg).ToInt64()
  Emit @{ event = 'found'; title = $title; known = ($title -match $knownTitles); filters = [S1McpDialog]::Filters($dlg) }
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
  if (-not [S1McpDialog]::Click($dlg, 1)) { throw "the dialog has no OK button" }
  Emit @{ event = 'ok-pressed' }
  $answered = New-Object 'System.Collections.Generic.HashSet[long]'
  $closed = $false
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt 3000) {
    if (-not [S1McpDialog]::Shown($dlg)) { $closed = $true; break }
    foreach ($c in [S1McpDialog]::Dialogs($target)) {
      # Only follow-ups owned by our file dialog.
      if ($c -eq $dlg -or -not (IsNew $c) -or $answered.Contains($c.ToInt64()) -or [S1McpDialog]::Owner($c) -ne $dlg) { continue }
      if ($expect -eq 'export') { [void][S1McpDialog]::ClickTask($c, 6); [void]$answered.Add($c.ToInt64()); $sw.Restart() }
      else { throw "Studio One asked: $([S1McpDialog]::Words($c))" }
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $closed) { throw "the dialog '$title' did not close after OK" }
  Emit @{ event = 'closed' }
  # While the bridge call is still pending (the caller kills this script when it returns): a new
  # message box owned by our dialog or by its owner is Studio One's answer (e.g. a corrupt preset).
  [void]$answered.Add($dlg.ToInt64())
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt 3000) {
    foreach ($c in [S1McpDialog]::Dialogs($target)) {
      if (-not (IsNew $c) -or $answered.Contains($c.ToInt64())) { continue }
      $o = [S1McpDialog]::Owner($c).ToInt64()
      if (($o -ne $dlg.ToInt64() -and $o -ne $dlgOwner) -or -not [S1McpDialog]::BoxShaped($c)) { continue }
      $words = [S1McpDialog]::Words($c)
      $button = $null
      if ([S1McpDialog]::Click($c, 1)) { $button = 'ok' } elseif ([S1McpDialog]::Click($c, 2)) { $button = 'cancel' }
      Emit @{ ok = $false; found = $true; closed = $true; shown = $words; button = $button; error = "Studio One showed: $words" }; exit 0
    }
    Start-Sleep -Milliseconds 100
  }
  Emit @{ ok = $true; title = $title }
  exit 0
} catch {
  $msg = [string]$_.Exception.Message
  $cancelled = $false
  if ($dlg -ne [IntPtr]::Zero -and [S1McpDialog]::IsWindow($dlg)) {
    # Follow-ups owned by our dialog first (Cancel, else OK), then Cancel our dialog.
    foreach ($c in [S1McpDialog]::Dialogs($target)) {
      if ($c -ne $dlg -and [S1McpDialog]::Owner($c) -eq $dlg) {
        [void][S1McpDialog]::ClickTask($c, 2); Start-Sleep -Milliseconds 300
        if ([S1McpDialog]::Shown($c)) { [void][S1McpDialog]::ClickTask($c, 1); Start-Sleep -Milliseconds 300 }
      }
    }
    [void][S1McpDialog]::Click($dlg, 2)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 2000 -and [S1McpDialog]::Shown($dlg)) { Start-Sleep -Milliseconds 100 }
    $cancelled = -not [S1McpDialog]::Shown($dlg)
  }
  Emit @{ ok = $false; found = ($dlg -ne [IntPtr]::Zero); error = $msg; cancelled = $cancelled; button = $(if ($cancelled) { 'cancel' } else { $null }) }
  exit 0
}
