// File-dialog filler: static PowerShell scripts fill Studio One's Export / Load preset dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillFileDialog, snapshotDialogs, FILEDIALOG_SCRIPT, SNAPSHOT_SCRIPT } from '../src/plugins/filedialog.js';

const decode = (args) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
const base = { pid: 4242, exclude: [65552, 131090] };

test('not supported off Windows, without running anything', async () => {
  let ran = false;
  const run = async () => { ran = true; return ''; };
  await assert.rejects(fillFileDialog({ ...base, path: '/tmp/x', expect: 'export', platform: 'darwin', run }), /not supported on this platform/);
  await assert.rejects(snapshotDialogs({ platform: 'linux', run }), /not supported on this platform/);
  assert.equal(ran, false);
});

test('fillFileDialog: the script is static; path, mode, process, snapshot and timeout travel in the environment', async () => {
  const path = "C:\\Temp\\it's $(rm -rf) `x` \"q\"\\a1b2";
  let seen;
  const run = async (cmd, args, opts) => { seen = { cmd, args, opts }; return '{"ok":true,"title":"Exportar preset"}\r\n'; };
  const r = await fillFileDialog({ ...base, path, expect: 'export', timeoutMs: 1234, platform: 'win32', run });
  assert.deepEqual(r, { ok: true, title: 'Exportar preset' });
  assert.equal(seen.cmd, 'powershell.exe');
  assert.equal(decode(seen.args), FILEDIALOG_SCRIPT);
  for (const a of seen.args) assert.ok(!a.includes('a1b2'), 'the path is not on the command line');
  assert.ok(!FILEDIALOG_SCRIPT.includes('a1b2'));
  assert.equal(seen.opts.env.S1MCP_FD_PATH, path);
  assert.equal(seen.opts.env.S1MCP_FD_EXPECT, 'export');
  assert.equal(seen.opts.env.S1MCP_FD_TIMEOUT_MS, '1234');
  assert.equal(seen.opts.env.S1MCP_FD_PID, '4242');
  assert.equal(seen.opts.env.S1MCP_FD_EXCLUDE, '65552,131090');
  assert.ok(seen.opts.timeout > 1234, 'the process timeout covers the dialog wait');
});

test('the scripts fit on a command line (-EncodedCommand)', () => {
  for (const s of [FILEDIALOG_SCRIPT, SNAPSHOT_SCRIPT]) assert.ok(Buffer.from(s, 'utf16le').toString('base64').length < 30000);
});

test('fillFileDialog: rejects bad input before running', async () => {
  let ran = false;
  const run = async () => { ran = true; return ''; };
  await assert.rejects(fillFileDialog({ ...base, path: 'x', expect: 'save', platform: 'win32', run }), /expect/);
  await assert.rejects(fillFileDialog({ ...base, path: '', expect: 'load', platform: 'win32', run }), /path/);
  await assert.rejects(fillFileDialog({ ...base, path: 'C:\\' + 'x'.repeat(240), expect: 'load', platform: 'win32', run }), /longer than 240/);
  await assert.rejects(fillFileDialog({ path: 'C:\\t\\x', expect: 'load', platform: 'win32', run }), /process id/);
  assert.equal(ran, false);
});

test('fillFileDialog: a failure reported by the script (after its Cancel) throws', async () => {
  const run = async () => '{"ok":false,"error":"the filename field did not take the path","cancelled":true}';
  await assert.rejects(fillFileDialog({ ...base, path: 'C:\\t\\x', expect: 'load', platform: 'win32', run }), /did not take the path.*cancelled/s);
  const run2 = async () => '{"ok":false,"error":"Studio One said after the dialog closed: Error | The preset is corrupt","cancelled":true,"closed":true}';
  await assert.rejects(fillFileDialog({ ...base, path: 'C:\\t\\x', expect: 'load', platform: 'win32', run: run2 }), /preset is corrupt/);
});

test('fillFileDialog: no dialog, a crashed script, garbage output, or an abort throw', async () => {
  const f = (run) => fillFileDialog({ ...base, path: 'C:\\t\\x', expect: 'load', platform: 'win32', run });
  await assert.rejects(f(async () => '{"ok":false,"error":"no file dialog appeared within 8000 ms"}'), /no file dialog/);
  await assert.rejects(f(async () => { throw new Error('boom'); }), /file dialog.*boom/);
  await assert.rejects(f(async () => 'Add-Type : nope'), /file dialog/);
  const ac = new AbortController();
  let gotSignal;
  const p = fillFileDialog({ ...base, path: 'C:\\t\\x', expect: 'load', platform: 'win32', signal: ac.signal,
    run: (_c, _a, opts) => new Promise((_, rej) => { gotSignal = opts.signal; opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }) });
  ac.abort();
  await assert.rejects(p, /stopped waiting/);
  assert.equal(gotSignal, ac.signal);
});

test('snapshotDialogs: runs the static snapshot script; pid and handles back', async () => {
  let seen;
  const run = async (cmd, args) => { seen = decode(args); return '{"ok":true,"pid":9876,"handles":[1,2,3]}'; };
  assert.deepEqual(await snapshotDialogs({ platform: 'win32', run }), { pid: 9876, exclude: [1, 2, 3] });
  assert.equal(seen, SNAPSHOT_SCRIPT);
  assert.deepEqual(await snapshotDialogs({ platform: 'win32', run: async () => '{"ok":true,"pid":9876,"handles":[]}' }), { pid: 9876, exclude: [] });
  await assert.rejects(snapshotDialogs({ platform: 'win32', run: async () => '{"ok":false,"error":"several Studio One instances are running"}' }), /several/);
});

test('the snapshot script: one instance, or the one with a song window; else an error', () => {
  const s = SNAPSHOT_SCRIPT;
  assert.match(s, /Get-Process "Studio One"/);
  assert.match(s, /StartsWith\("Studio One - "\)/);
  assert.match(s, /several Studio One instances/);
  assert.match(s, /Dialogs\(\$target\)/);
});

test('the filler script: only NEW dialogs of the given process; 0x47C / Edit; OK=1, Cancel=2, Yes=6 for export only', () => {
  const s = FILEDIALOG_SCRIPT;
  for (const v of ['PATH', 'EXPECT', 'TIMEOUT_MS', 'PID', 'EXCLUDE']) assert.match(s, new RegExp(`\\$env:S1MCP_FD_${v}`));
  assert.match(s, /-not \$exclude\.Contains\(\$_\.ToInt64\(\)\)/); // snapshot handles are never touched
  assert.match(s, /Dialogs\(\$target\)/);                        // only the bridge's Studio One process
  assert.ok(!/Get-Process/.test(s), 'the filler does not pick processes itself');
  assert.match(s, /"#32770"/);
  assert.match(s, /0x47C/);
  assert.match(s, /"Edit"/);
  assert.match(s, /0x000C/); // WM_SETTEXT
  assert.match(s, /0x00F5/); // BM_CLICK
  assert.match(s, /Click\(\$dlg, 1\)/);
  assert.match(s, /Click\(\$dlg, 2\)/); // Cancel on failure
  assert.match(s, /\$expect -eq 'export'[^\n]*ClickTask\(\$c, 6\)/); // overwrite confirm: Yes only when exporting
  assert.match(s, /after the dialog closed/);                    // error box after close: read, dismiss, report
  assert.match(s, /"Static"/);
  assert.ok(!/SetForegroundWindow|SetActiveWindow|SetFocus|mouse_event|SendInput|keybd_event/.test(s), 'never foregrounds or fakes input');
});
