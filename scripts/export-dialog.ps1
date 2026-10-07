# Studio One export dialog helper (Windows). Static script: every input comes from the
# environment (S1MCP_XD_*), never from the command line or the script text.
#
#   S1MCP_XD_MODE  snapshot | drive | cancel
#   snapshot: S1MCP_XD_PID. -> {"windows":["HEX",...]}  (visible top-level windows of that process)
#   drive:    S1MCP_XD_PID, S1MCP_XD_BEFORE (comma-separated hex handles from a snapshot),
#             S1MCP_XD_TIMEOUT_MS (wait for the dialog), S1MCP_XD_WATCH_MS (watch after OK).
#             Waits for a NEW export dialog (class CCLDialogClass, visible, of that process, owned by
#             a window that is disabled, i.e. the dialog is modal), posts Enter (OK) to it, then watches: if a new alert (CCLDialogClass or #32770, not the
#             export dialog) shows up once the dialog is gone, it is cancelled with Escape and reported.
#             Lines {"event":"dialog","hwnd":..,"title":..}, then one final {"ok":...} line.
#   cancel:   S1MCP_XD_PID, S1MCP_XD_BEFORE, S1MCP_XD_TIMEOUT_MS. For that long (or until killed),
#             posts Escape (Cancel, never Enter) to every NEW modal CCLDialogClass of that process,
#             as drive would pick it: a late export dialog. Lines {"event":"cancelled","title":..},
#             then {"ok":true}.
#
# Keys are posted to the dialog's own window (PostMessage): no window is brought to the front and
# no global keyboard or mouse input is faked. The "please wait" window (CCLShadowWindowClass) is ignored.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class S1McpExport {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static bool Shown(IntPtr h) { return IsWindow(h) && IsWindowVisible(h); }
  public static IntPtr Owner(IntPtr h) { return GetWindow(h, 4); }
  // A modal dialog: owned, and its owner (Studio One's main window) is disabled while it is open.
  public static bool Modal(IntPtr h) { var o = Owner(h); return o != IntPtr.Zero && IsWindow(o) && !IsWindowEnabled(o); }
  public static List<IntPtr> Windows(int pid) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) r.Add(h);
      return true; }, IntPtr.Zero);
    return r;
  }
  // Key down, 30 ms, key up, posted to this window only.
  public static void Press(IntPtr h, int vk) {
    PostMessage(h, 0x100, (IntPtr)vk, (IntPtr)0x1);
    System.Threading.Thread.Sleep(30);
    PostMessage(h, 0x101, (IntPtr)vk, unchecked((IntPtr)(long)0xC0000001L));
  }
}
"@

function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function Hex($h) { $h.ToInt64().ToString('X') }
$VK_RETURN = 0x0D
$VK_ESCAPE = 0x1B
$mode = [string]$env:S1MCP_XD_MODE

try {
  $target = 0
  if (-not [int]::TryParse([string]$env:S1MCP_XD_PID, [ref]$target) -or $target -le 0) { Emit @{ ok = $false; reason = 'bad input' }; exit 0 }
  if ($mode -eq 'snapshot') {
    $list = @([S1McpExport]::Windows($target) | ForEach-Object { Hex $_ })
    Emit @{ windows = $list }
    exit 0
  }
  if ($mode -ne 'drive' -and $mode -ne 'cancel') { Emit @{ ok = $false; reason = 'bad input' }; exit 0 }
  $timeoutMs = 0; $watchMs = 0
  if (-not [int]::TryParse([string]$env:S1MCP_XD_TIMEOUT_MS, [ref]$timeoutMs)) { Emit @{ ok = $false; reason = 'bad input' }; exit 0 }
  if ($mode -eq 'drive' -and -not [int]::TryParse([string]$env:S1MCP_XD_WATCH_MS, [ref]$watchMs)) { Emit @{ ok = $false; reason = 'bad input' }; exit 0 }
  $before = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($x in ([string]$env:S1MCP_XD_BEFORE).Split(',')) { $t = $x.Trim().ToUpper(); if ($t) { [void]$before.Add($t) } }
  function IsNew($h) { -not $before.Contains((Hex $h)) }
  function IsExportDialog($h) { (IsNew $h) -and [S1McpExport]::Cls($h) -eq 'CCLDialogClass' -and [S1McpExport]::Modal($h) }

  if ($mode -eq 'cancel') {
    # Escape only; a dialog that is still open 2 s after its Escape gets another one.
    $pressed = @{}
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
      foreach ($h in [S1McpExport]::Windows($target)) {
        if (-not (IsExportDialog $h)) { continue }
        $k = Hex $h
        if ($pressed.ContainsKey($k) -and $sw.ElapsedMilliseconds - $pressed[$k] -lt 2000) { continue }
        $first = -not $pressed.ContainsKey($k)
        $pressed[$k] = $sw.ElapsedMilliseconds
        $ct = [S1McpExport]::Title($h)
        [S1McpExport]::Press($h, $VK_ESCAPE)
        if ($first) { Emit @{ event = 'cancelled'; hwnd = $k; title = $ct } }
      }
      Start-Sleep -Milliseconds 100
    }
    Emit @{ ok = $true }
    exit 0
  }

  # 1. Wait for the export dialog: new, CCLDialogClass, and modal (its owner is disabled), so a
  #    non-modal window of the same class is never sent Enter.
  $dlg = [IntPtr]::Zero
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs -and $dlg -eq [IntPtr]::Zero) {
    foreach ($h in [S1McpExport]::Windows($target)) {
      if (IsExportDialog $h) { $dlg = $h; break }
    }
    if ($dlg -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
  }
  if ($dlg -eq [IntPtr]::Zero) { Emit @{ ok = $false; reason = 'no dialog' }; exit 0 }
  $title = [S1McpExport]::Title($dlg)
  Emit @{ event = 'dialog'; hwnd = (Hex $dlg); title = $title }

  # 2. Press OK (Enter) on that dialog.
  [S1McpExport]::Press($dlg, $VK_RETURN)

  # 3a. The dialog must close (up to 5 s); otherwise cancel it.
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt 5000 -and [S1McpExport]::Shown($dlg)) { Start-Sleep -Milliseconds 100 }
  if ([S1McpExport]::Shown($dlg)) {
    [S1McpExport]::Press($dlg, $VK_ESCAPE)
    Emit @{ ok = $false; reason = 'dialog did not accept OK'; title = $title }
    exit 0
  }

  # 3b. Fresh timer: a new alert after the dialog closed is Studio One refusing (Escape, never Enter).
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $watchMs) {
    foreach ($h in [S1McpExport]::Windows($target)) {
      if ($h -eq $dlg -or -not (IsNew $h)) { continue }
      $c = [S1McpExport]::Cls($h)
      if ($c -eq 'CCLDialogClass' -or $c -eq '#32770') {
        $at = [S1McpExport]::Title($h)
        [S1McpExport]::Press($h, $VK_ESCAPE)
        Emit @{ ok = $false; reason = 'alert'; title = $at }
        exit 0
      }
    }
    Start-Sleep -Milliseconds 100
  }
  Emit @{ ok = $true }
  exit 0
} catch {
  Emit @{ ok = $false; reason = [string]$_.Exception.Message }
  exit 0
}
