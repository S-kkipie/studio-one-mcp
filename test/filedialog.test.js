// File-dialog filler: a static PowerShell script fills Studio One's Export / Load preset dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillFileDialog, FILEDIALOG_SCRIPT } from '../src/plugins/filedialog.js';

const decode = (args) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

test('fillFileDialog: not supported off Windows, without running anything', async () => {
  let ran = false;
  await assert.rejects(
    fillFileDialog({ path: '/tmp/x', expect: 'export', platform: 'darwin', run: async () => { ran = true; return ''; } }),
    /not supported on this platform/,
  );
  assert.equal(ran, false);
});

test('fillFileDialog: the script is static; path, mode and timeout travel in the environment', async () => {
  const path = "C:\\Temp\\it's $(rm -rf) `x` \"q\"\\a1b2";
  let seen;
  const run = async (cmd, args, opts) => { seen = { cmd, args, opts }; return '{"ok":true,"title":"Exportar preset"}\r\n'; };
  const r = await fillFileDialog({ path, expect: 'export', timeoutMs: 1234, platform: 'win32', run });
  assert.deepEqual(r, { ok: true, title: 'Exportar preset' });
  assert.equal(seen.cmd, 'powershell.exe');
  assert.equal(decode(seen.args), FILEDIALOG_SCRIPT);
  for (const a of seen.args) assert.ok(!a.includes('a1b2'), 'the path is not on the command line');
  assert.ok(!FILEDIALOG_SCRIPT.includes('a1b2'));
  assert.equal(seen.opts.env.S1MCP_FD_PATH, path);
  assert.equal(seen.opts.env.S1MCP_FD_EXPECT, 'export');
  assert.equal(seen.opts.env.S1MCP_FD_TIMEOUT_MS, '1234');
  assert.ok(seen.opts.timeout > 1234, 'the process timeout covers the dialog wait');
});

test('fillFileDialog: rejects a bad expect or an empty path before running', async () => {
  let ran = false;
  const run = async () => { ran = true; return ''; };
  await assert.rejects(fillFileDialog({ path: 'x', expect: 'save', platform: 'win32', run }), /expect/);
  await assert.rejects(fillFileDialog({ path: '', expect: 'load', platform: 'win32', run }), /path/);
  assert.equal(ran, false);
});

test('fillFileDialog: a failure reported by the script (after its Cancel) throws', async () => {
  const run = async () => '{"ok":false,"error":"the filename field did not take the path","cancelled":true}';
  await assert.rejects(fillFileDialog({ path: 'C:\\t\\x', expect: 'load', platform: 'win32', run }), /did not take the path.*cancelled/s);
});

test('fillFileDialog: no dialog, a crashed script, or garbage output throw', async () => {
  await assert.rejects(fillFileDialog({ path: 'C:\\t\\x', expect: 'load', platform: 'win32', run: async () => '{"ok":false,"error":"no file dialog appeared within 8000 ms"}' }), /no file dialog/);
  await assert.rejects(fillFileDialog({ path: 'C:\\t\\x', expect: 'load', platform: 'win32', run: async () => { throw new Error('boom'); } }), /file dialog.*boom/);
  await assert.rejects(fillFileDialog({ path: 'C:\\t\\x', expect: 'load', platform: 'win32', run: async () => 'Add-Type : nope' }), /file dialog/);
});

test('the script: Studio One #32770 dialogs, id 0x47C with an Edit fallback, OK=1, Cancel=2, Yes=6 for export only', () => {
  const s = FILEDIALOG_SCRIPT;
  assert.match(s, /\$env:S1MCP_FD_PATH/);
  assert.match(s, /\$env:S1MCP_FD_EXPECT/);
  assert.match(s, /Get-Process "Studio One"/);
  assert.match(s, /"#32770"/);
  assert.match(s, /0x47C/);
  assert.match(s, /"Edit"/);
  assert.match(s, /0x000C/); // WM_SETTEXT
  assert.match(s, /0x00F5/); // BM_CLICK
  assert.match(s, /Click\(\$dlg, 1\)/);
  assert.match(s, /Click\(\$dlg, 2\)/); // Cancel on failure
  assert.match(s, /\$expect -eq 'export'[^\n]*\n?[^\n]*6/); // overwrite confirm: Yes only when exporting
  assert.ok(!/SetForegroundWindow|SetActiveWindow|SetFocus|mouse_event|SendInput|keybd_event/.test(s), 'never foregrounds or fakes input');
});
