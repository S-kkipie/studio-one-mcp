// Preset file dialog helper: static PowerShell script (scripts/preset-dialog.ps1) + Node wrappers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fillFileDialog, snapshotDialogs, cancelPresetDialogs, runScript, DIALOG_SCRIPT } from '../src/plugins/filedialog.js';

// Normalise line endings: git may check the script out with CRLF (core.autocrlf).
const SCRIPT = fs.readFileSync(DIALOG_SCRIPT, 'utf8').replace(/\r\n/g, '\n');
const base = { pid: 4242, exclude: [65552, 131090] };
const win = { platform: 'win32' };

test('not supported off Windows, without running anything', async () => {
  let ran = false;
  const run = async () => { ran = true; return ''; };
  await assert.rejects(fillFileDialog({ ...base, path: '/tmp/x', expect: 'export', platform: 'darwin', run }), /not supported on this platform/);
  await assert.rejects(snapshotDialogs({ platform: 'linux', run }), /not supported on this platform/);
  await assert.rejects(cancelPresetDialogs({ ...base, platform: 'linux', run }), /not supported on this platform/);
  assert.equal(ran, false);
});

test('fill: the script file is static; path, mode, process, snapshot and timeout travel in the environment', async () => {
  const path = "C:\\Temp\\it's $(rm -rf) `x` \"q\"\\a1b2";
  let seen;
  const run = async (cmd, args, opts) => { seen = { cmd, args, opts }; return '{"event":"found","title":"Exportar preset"}\r\n{"ok":true,"title":"Exportar preset"}\r\n'; };
  const r = await fillFileDialog({ ...base, ...win, path, expect: 'export', timeoutMs: 1234, run });
  assert.deepEqual(r, { ok: true, title: 'Exportar preset' });
  assert.equal(seen.cmd, 'powershell.exe');
  assert.deepEqual(seen.args.slice(-2), ['-File', DIALOG_SCRIPT]);
  for (const a of seen.args) assert.ok(!a.includes('a1b2'), 'the path is not on the command line');
  assert.ok(!SCRIPT.includes('a1b2'));
  assert.equal(seen.opts.env.S1MCP_FD_MODE, 'fill');
  assert.equal(seen.opts.env.S1MCP_FD_PATH, path);
  assert.equal(seen.opts.env.S1MCP_FD_EXPECT, 'export');
  assert.equal(seen.opts.env.S1MCP_FD_TIMEOUT_MS, '1234');
  assert.equal(seen.opts.env.S1MCP_FD_PID, '4242');
  assert.equal(seen.opts.env.S1MCP_FD_EXCLUDE, '65552,131090');
  assert.ok(seen.opts.timeout > 1234, 'the process timeout covers the dialog wait');
});

test('fill: rejects bad input before running', async () => {
  let ran = false;
  const run = async () => { ran = true; return ''; };
  await assert.rejects(fillFileDialog({ ...base, ...win, path: 'x', expect: 'save', run }), /expect/);
  await assert.rejects(fillFileDialog({ ...base, ...win, path: '', expect: 'load', run }), /path/);
  await assert.rejects(fillFileDialog({ ...base, ...win, path: 'C:\\' + 'x'.repeat(240), expect: 'load', run }), /longer than 240/);
  await assert.rejects(fillFileDialog({ ...win, path: 'C:\\t\\x', expect: 'load', run }), /process id/);
  assert.equal(ran, false);
});

const fillWith = (out, extra = {}) => fillFileDialog({ ...base, ...win, path: 'C:\\t\\x', expect: 'load', run: async () => out, ...extra });

test('fill: failures carry found / closed / button / foreign; "(cancelled)" only when Cancel was pressed', async () => {
  await assert.rejects(fillWith('{"ok":false,"found":true,"error":"the filename field did not take the path","cancelled":true,"button":"cancel"}'),
    (e) => /did not take the path \(cancelled\)$/.test(e.message) && e.found === true && e.button === 'cancel');
  await assert.rejects(fillWith('{"ok":false,"found":false,"foreign":true,"error":"a new dialog \'Guardar como\' is not a preset file dialog; it was left alone"}'),
    (e) => /Guardar como.*left alone$/.test(e.message) && e.found === false && e.foreign === true);
  await assert.rejects(fillWith('{"ok":false,"found":false,"error":"no preset file dialog appeared within 8000 ms"}'), (e) => e.found === false);
});

test('fill: a box after a load that went through: "Studio One showed: ... may have been applied", no "(cancelled)"', async () => {
  const out = '{"event":"found","title":"Cargar preset"}\n{"event":"ok-pressed"}\n{"event":"closed"}\n{"ok":false,"found":true,"closed":true,"shown":"The preset is damaged","button":"ok","error":"Studio One showed: The preset is damaged"}';
  await assert.rejects(fillWith(out), (e) => e.message === 'Studio One showed: The preset is damaged. The preset may have been applied.' && e.closed && e.button === 'ok');
  await assert.rejects(fillWith(out, { expect: 'export' }), (e) => e.message === 'Studio One showed: The preset is damaged.');
});

test('fill: stopped by the signal: success once OK was pressed, else a failure that says whether the dialog was seen', async () => {
  const stopped = (stdout) => fillFileDialog({ ...base, ...win, path: 'C:\\t\\x', expect: 'export', run: async () => ({ stdout, aborted: true }) });
  assert.deepEqual(await stopped('{"event":"found","title":"Exportar preset"}\n{"event":"ok-pressed"}\n'), { ok: true, title: 'Exportar preset', aborted: true });
  await assert.rejects(stopped(''), (e) => e.found === false && e.aborted === true && /before its dialog was seen/.test(e.message));
  await assert.rejects(stopped('{"event":"found","title":"Exportar preset"}\n'), (e) => e.found === true && e.aborted === true);
});

test('fill: a crashed helper or garbage output throws', async () => {
  await assert.rejects(fillWith(null, { run: async () => { throw new Error('boom'); } }), /helper failed: boom/);
  await assert.rejects(fillWith('Add-Type : nope'), /unexpected helper output/);
});

test('snapshot: runs the script in snapshot mode; pid and handles back', async () => {
  let env;
  const run = async (_c, _a, opts) => { env = opts.env; return '{"ok":true,"pid":9876,"handles":[1,2,3]}'; };
  assert.deepEqual(await snapshotDialogs({ ...win, run }), { pid: 9876, exclude: [1, 2, 3] });
  assert.equal(env.S1MCP_FD_MODE, 'snapshot');
  assert.deepEqual(await snapshotDialogs({ ...win, run: async () => '{"ok":true,"pid":9876,"handles":[]}' }), { pid: 9876, exclude: [] });
  await assert.rejects(snapshotDialogs({ ...win, run: async () => '{"ok":false,"error":"several Studio One instances are running"}' }), /several/);
});

test('cancel watch: cancel mode with the snapshot; reports cancelled titles, also when stopped early', async () => {
  let env;
  const run = async (_c, _a, opts) => { env = opts.env; return '{"event":"cancelled","title":"Exportar preset"}\n{"ok":true,"cancelled":["Exportar preset"]}'; };
  assert.deepEqual(await cancelPresetDialogs({ ...base, ...win, timeoutMs: 5000, run }), { cancelled: ['Exportar preset'], failed: [] });
  assert.equal(env.S1MCP_FD_MODE, 'cancel');
  assert.equal(env.S1MCP_FD_EXCLUDE, '65552,131090');
  assert.equal(env.S1MCP_FD_TIMEOUT_MS, '5000');
  assert.deepEqual(await cancelPresetDialogs({ ...base, ...win, run: async () => ({ stdout: '{"event":"cancelled","title":"Cargar preset"}\n', aborted: true }) }), { cancelled: ['Cargar preset'], failed: [] });
  assert.deepEqual(await cancelPresetDialogs({ ...base, ...win, run: async () => '{"ok":true,"cancelled":[]}' }), { cancelled: [], failed: [] });
});

test('runScript: an abort kills the process and keeps what it printed', async () => {
  const ac = new AbortController();
  const p = runScript(process.execPath, ['-e', 'console.log(JSON.stringify({event:"found"})); setTimeout(() => {}, 20000)'], { env: process.env, timeout: 30000, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 400));
  ac.abort();
  const r = await p;
  assert.equal(r.aborted, true);
  assert.match(r.stdout, /"event":"found"/);
  const done = await runScript(process.execPath, ['-e', 'console.log("{}")'], { env: process.env, timeout: 30000 });
  assert.deepEqual(done, { stdout: '{}\n', aborted: false });
});

test('the script: only NEW dialogs of the given process that pass the preset-filter check', () => {
  const s = SCRIPT;
  for (const v of ['MODE', 'PATH', 'EXPECT', 'TIMEOUT_MS', 'PID', 'EXCLUDE']) assert.match(s, new RegExp(`\\$env:S1MCP_FD_${v}`));
  assert.match(s, /-not \$exclude\.Contains\(\$h\.ToInt64\(\)\)/);      // snapshot handles are never touched
  assert.match(s, /Dialogs\(\$target\)/);                              // only the bridge's Studio One process
  assert.match(s, /StartsWith\("Studio One - "\)/);                    // instance choice (snapshot mode)
  assert.match(s, /\\\*\\\.\(vstpreset\|preset\|fxpreset\|instrument\)/); // the positive discriminator
  assert.match(s, /0x0146/); assert.match(s, /0x0148/);                // combo items (CB_GETCOUNT / CB_GETLBTEXT)
  assert.match(s, /if \(IsPresetDialog \$h\) \{ \$dlg = \$h; break \}/); // fill: only a preset dialog is taken
  assert.match(s, /if \(IsPresetDialog \$h\) \{\s*\n\s*\$t = /);          // cancel: only a preset dialog is cancelled
  assert.match(s, /left alone/);
  assert.match(s, /0x47C/); assert.match(s, /"Edit"/);
  assert.match(s, /0x000C/); assert.match(s, /0x00F5/);               // WM_SETTEXT, BM_CLICK
  assert.match(s, /\$expect -eq 'export'[^\n]*ClickTask\(\$c, 6\)/);   // overwrite confirm: Yes only when exporting
  assert.match(s, /BoxShaped\(\$c\)/);                                  // error boxes: message-box shaped...
  assert.match(s, /\$o -ne \$dlg\.ToInt64\(\) -and \$o -ne \$dlgOwner/); // ...owned by our dialog or its owner
  // Post-close box: owned by our dialog -> OK before Cancel; owned by Studio One's main window -> Cancel before OK.
  const post = s.slice(s.indexOf("$words = [S1McpDialog]::Words($c)\n      $button"));
  assert.match(post, /if \(\$o -eq \$dlg\.ToInt64\(\)\) \{[^}]*Click\(\$c, 1\)\) \{ \$button = 'ok' \} elseif \(\[S1McpDialog\]::Click\(\$c, 2\)\)/);
  assert.match(post, /\} else \{[^}]*Click\(\$c, 2\)\) \{ \$button = 'cancel' \} elseif \(\[S1McpDialog\]::Click\(\$c, 1\)\)/);
  assert.ok(!/SetForegroundWindow|SetActiveWindow|SetFocus|mouse_event|SendInput|keybd_event/.test(s), 'never foregrounds or fakes input');
  // Cancel mode never presses OK.
  const cancelBlock = s.slice(s.indexOf("if ($mode -eq 'cancel')"), s.indexOf("if ($mode -ne 'fill')"));
  assert.ok(cancelBlock.includes('Click($h, 2)') && !/Click\(\$h, 1\)|Click\(\$h, 6\)/.test(cancelBlock));
});

test('the script: the export field is a VISIBLE Edit, 0x3E9 first, then 0x47C, then the first visible Edit', () => {
  const s = SCRIPT;
  const m = /public static IntPtr ExportField\(IntPtr dlg\) \{([\s\S]*?)\n  \}/.exec(s);
  assert.ok(m, 'ExportField exists');
  const body = m[1];
  const i3e9 = body.indexOf('0x3E9');
  const i47c = body.indexOf('0x47C');
  const iFirst = body.indexOf('FirstVisible');
  assert.ok(i3e9 >= 0 && i47c > i3e9 && iFirst > i47c, 'order 0x3E9, 0x47C, first visible Edit');
  assert.match(body, /VisibleEditWithId\(dlg, 0x3E9\)/);
  assert.match(s, /static IntPtr VisibleEditWithId\(IntPtr dlg, int id\) \{\s*\n[^\n]*IsWindowVisible/);
  assert.match(s, /public static IntPtr FirstVisible\(IntPtr dlg, string cls\) \{[^\n]*IsWindowVisible/);
  // The fill uses it for export dialogs.
  assert.match(s, /\$edit = if \(\$expect -eq 'export'\) \{ \[S1McpDialog\]::ExportField\(\$dlg\) \}/);
});

test('the script: cancel mode marks a dialog done only once it is gone, with bounded retries', () => {
  const s = SCRIPT;
  const cancelBlock = s.slice(s.indexOf("if ($mode -eq 'cancel')"), s.indexOf("if ($mode -ne 'fill')"));
  assert.match(cancelBlock, /\$tries/);
  assert.match(cancelBlock, /Shown\(\$h\)/);
  const click = cancelBlock.indexOf('Click($h, 2)');
  const shown = cancelBlock.indexOf('Shown($h)', click);
  const done = cancelBlock.indexOf('$done.Add', click);
  assert.ok(click >= 0 && shown > click && done > shown, 'Shown re-check between Click and done');
  assert.match(cancelBlock, /-ge \$maxTries/);
});

test('cancel watch: dialogs it could not close come back as failed (final JSON, or the events when stopped early)', async () => {
  const base = { pid: 4242, exclude: [] };
  const win = { platform: 'win32' };
  const out = '{"event":"cancelled","title":"Cargar preset"}\n{"event":"cancel-failed","title":"Exportar preset"}\n{"ok":true,"cancelled":["Cargar preset"],"failed":["Exportar preset"]}';
  assert.deepEqual(await cancelPresetDialogs({ ...base, ...win, run: async () => out }), { cancelled: ['Cargar preset'], failed: ['Exportar preset'] });
  assert.deepEqual(await cancelPresetDialogs({ ...base, ...win, run: async () => ({ stdout: '{"event":"cancel-failed","title":"Exportar preset"}\n', aborted: true }) }), { cancelled: [], failed: ['Exportar preset'] });
  // PowerShell's ConvertTo-Json writes a one-item array as a string.
  assert.deepEqual(await cancelPresetDialogs({ ...base, ...win, run: async () => '{"ok":true,"cancelled":[],"failed":"Exportar preset"}' }), { cancelled: [], failed: ['Exportar preset'] });
  const s = SCRIPT.slice(SCRIPT.indexOf("if ($mode -eq 'cancel')"), SCRIPT.indexOf("if ($mode -ne 'fill')"));
  assert.match(s, /\$failed \+= \$t/);
  assert.match(s, /Emit @\{ ok = \$true; cancelled = \$titles; failed = \$failed \}/);
});
