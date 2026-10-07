// Plug-in windows. Studio One's Track Edit tasks are unavailable while a plug-in window is open or
// focused, and a modal dialog (e.g. "Save preset") blocks the bridge, so callers close them first.
import { execFile } from 'node:child_process';

// Opens the slot's plug-in window (bridge op, see BridgeComponent.js); it gets the focus only when
// Studio One is not minimized (seen live, 7.2.3).
// An instrument ({ instrument }) opens through its Device/Edit command.
export async function focusPlugin(call, { channel, slot, instrument }) {
  return call('openPluginEditor', instrument !== undefined ? { instrument } : { channel, slot });
}

// Only plug-in editor windows get WM_CLOSE: visible top-level windows of the Studio One process
// titled "<channel> · Inserts · <n> - <plug-in>" (the only kind seen, 7.2.3), optionally only
// those of one channel ($want), and instrument editors, whose title is exactly one of $editors
// ("<n> - <instrument>", n = the InstNN number: "1 - Mai Tai", seen live in 7.2.3). Other windows
// (Console, Browser, Preferences, export / progress dialogs, where WM_CLOSE means Cancel) are left
// alone. Prints the closed titles.
// The script text is constant: the filters (channel and instrument names come from the user's songs)
// arrive only through environment variables (windowsEnv), never interpolated into the script, so no
// quote character in a name (ASCII or U+2018..U+201B, which PowerShell also takes as quotes) can
// end a string literal and inject code.
export const WINDOWS_SCRIPT = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$want = [string]$env:S1MCP_WANT_CHANNEL
$wantInserts = $env:S1MCP_WANT_INSERTS -eq "1"
$editors = @()
if ($env:S1MCP_EDITORS) { $editors = @(ConvertFrom-Json $env:S1MCP_EDITORS | ForEach-Object { $_ } | ForEach-Object { [string]$_ }) }
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
    if (($i -gt 0 -and $wantInserts -and ($want -eq "" -or $w.Value.Substring(0, $i) -eq $want)) -or ($editors -ccontains $w.Value)) {
      [void][S1McpWindows]::PostMessage($w.Key, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
      $w.Value
    }
  }
}
`;

// The script's filters, as environment variables: the channel ("" = every channel), whether insert
// windows are closed at all, and the exact instrument editor titles to close (a JSON array).
export function windowsEnv(channel = '', { inserts = true, editors = [] } = {}) {
  return { S1MCP_WANT_CHANNEL: String(channel ?? ''), S1MCP_WANT_INSERTS: inserts ? '1' : '0', S1MCP_EDITORS: JSON.stringify(editors.map(String)) };
}

const ENCODED_SCRIPT = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');

// The title of an instrument's editor window: "<n> - <name>" (Inst01 "Mai Tai" -> "1 - Mai Tai").
export function instrumentEditorTitle({ index, name }) {
  return Number.isInteger(index) && typeof name === 'string' && name !== '' ? `${index} - ${name}` : null;
}

const runFile = (cmd, args, { env } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).trim()));
    else resolve(stdout);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -> titles of the windows that were sent WM_CLOSE ([] off Windows). `editors`: exact instrument
// editor titles to close as well; `inserts: false` leaves insert windows alone.
export async function closePluginWindows({ channel, editors = [], inserts = true, platform = process.platform, run = runFile, settleMs = 500 } = {}) {
  if (platform !== 'win32') return [];
  let out;
  try {
    out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_SCRIPT], { env: windowsEnv(channel || '', { inserts, editors }) });
  } catch (e) {
    throw new Error(`closing plug-in windows failed: ${e.message}`);
  }
  const titles = String(out).split(/\r?\n/).map((s) => s.replace(/^﻿/, '').trim()).filter(Boolean);
  if (titles.length && settleMs) await sleep(settleMs);
  return titles;
}

// Insert windows (all, or one channel's) plus instrument editors (all of them when no channel is
// given, or only `instrument`'s: its component name or exact title, and then no insert window).
// Instrument editors are told apart by their exact title, so the song's instruments are read first;
// if that read fails (no instrument given), insert windows are still closed.
export async function closeEditors(call, { channel, instrument, ...opts } = {}) {
  let editors = [];
  if (channel === undefined) {
    let list = [];
    if (instrument !== undefined) {
      const all = (await call('instruments', {})) ?? [];
      list = all.filter((x) => x.component === instrument || x.name === instrument);
      if (!list.length) throw new Error(`no instrument named ${instrument} (have: ${all.map((x) => `${x.component} (${x.name})`).join(', ') || 'none'})`);
    } else {
      try { list = (await call('instruments', {})) ?? []; } catch { list = []; }
    }
    editors = list.map(instrumentEditorTitle).filter(Boolean);
  }
  return closePluginWindows({ ...opts, channel, editors, inserts: instrument === undefined });
}
