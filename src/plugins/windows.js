// Plug-in windows. Studio One's Track Edit tasks are unavailable while a plug-in window is open or
// focused, and a modal dialog (e.g. "Save preset") blocks the bridge, so callers close them first.
import { execFile } from 'node:child_process';

// Opens the slot's plug-in window and gives it the focus (bridge op, see BridgeComponent.js).
export async function focusPlugin(call, { channel, slot }) {
  return call('openPluginEditor', { channel, slot });
}

// Only plug-in editor windows get WM_CLOSE: visible top-level windows of the Studio One process
// titled "<channel> · Inserts · <n> - <plug-in>" (the only kind seen, 7.2.3), optionally only
// those of one channel ($want, set by windowsScript). Other windows (Console, Browser, Preferences,
// export / progress dialogs, where WM_CLOSE means Cancel) are left alone. Prints the closed titles.
export const WINDOWS_SCRIPT = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$mark = " " + [char]0x00B7 + " Inserts " + [char]0x00B7 + " "
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class S1McpWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<KeyValuePair<IntPtr,string>> List(int pid) {
    var r = new List<KeyValuePair<IntPtr,string>>();
    EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); r.Add(new KeyValuePair<IntPtr,string>(h, sb.ToString())); }
      return true; }, IntPtr.Zero);
    return r;
  }
}
"@
foreach ($p in Get-Process "Studio One" -ErrorAction SilentlyContinue) {
  foreach ($w in [S1McpWindows]::List($p.Id)) {
    $i = $w.Value.IndexOf($mark)
    if ($i -gt 0 -and ($want -eq "" -or $w.Value.Substring(0, $i) -eq $want)) {
      [void][S1McpWindows]::PostMessage($w.Key, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
      $w.Value
    }
  }
}
`;

// The script with the channel filter ("" = every channel) in front, as a PowerShell literal.
export function windowsScript(channel = '') {
  return `$want = '${String(channel).replace(/'/g, "''")}'\n${WINDOWS_SCRIPT}`;
}

const runFile = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).trim()));
    else resolve(stdout);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -> titles of the windows that were sent WM_CLOSE ([] off Windows).
export async function closePluginWindows({ channel, platform = process.platform, run = runFile, settleMs = 500 } = {}) {
  if (platform !== 'win32') return [];
  const encoded = Buffer.from(windowsScript(channel || ''), 'utf16le').toString('base64');
  let out;
  try {
    out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
  } catch (e) {
    throw new Error(`closing plug-in windows failed: ${e.message}`);
  }
  const titles = String(out).split(/\r?\n/).map((s) => s.replace(/^﻿/, '').trim()).filter(Boolean);
  if (titles.length && settleMs) await sleep(settleMs);
  return titles;
}
