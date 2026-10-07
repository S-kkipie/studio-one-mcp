// Plug-in windows: focus through the bridge, close through the OS (Windows only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusPlugin, closePluginWindows, WINDOWS_SCRIPT, windowsScript } from '../src/plugins/windows.js';

test('focusPlugin asks the bridge to open and focus the slot editor', async () => {
  const calls = [];
  const call = async (op, args) => (calls.push([op, args]), { channel: args.channel, slot: args.slot, plugin: 'X', opened: true });
  const r = await focusPlugin(call, { channel: 'Gtr', slot: 2 });
  assert.deepEqual(calls, [['openPluginEditor', { channel: 'Gtr', slot: 2 }]]);
  assert.equal(r.opened, true);
});

test('closePluginWindows: [] off Windows, without running anything', async () => {
  let ran = false;
  const r = await closePluginWindows({ platform: 'darwin', run: async () => { ran = true; return ''; } });
  assert.deepEqual(r, []);
  assert.equal(ran, false);
});

test('closePluginWindows: runs PowerShell and returns the closed titles', async () => {
  let seen;
  const run = async (cmd, args) => { seen = [cmd, args]; return 'Mai Tai – Inserts – 1 - Archetype Petrucci X\r\nGuardar preset\r\n\r\n'; };
  const r = await closePluginWindows({ platform: 'win32', run, settleMs: 0 });
  assert.deepEqual(r, ['Mai Tai – Inserts – 1 - Archetype Petrucci X', 'Guardar preset']);
  assert.equal(seen[0], 'powershell.exe');
  assert.ok(seen[1].includes('-EncodedCommand'));
  const script = Buffer.from(seen[1][seen[1].indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.equal(script, `$want = ''\n${WINDOWS_SCRIPT}`);
});

test('closePluginWindows: an optional channel filter goes into the script as a quoted literal', async () => {
  let seen;
  const run = async (_cmd, args) => { seen = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le'); return ''; };
  assert.deepEqual(await closePluginWindows({ platform: 'win32', run, channel: "Guy's Amp" }), []);
  assert.equal(seen, windowsScript("Guy's Amp"));
  assert.ok(seen.startsWith("$want = 'Guy''s Amp'\n"));
});

test('the PowerShell script closes only "<channel> · Inserts · ..." plug-in editor windows', () => {
  assert.match(WINDOWS_SCRIPT, /Get-Process "Studio One"/);
  assert.match(WINDOWS_SCRIPT, /\$mark = " " \+ \[char\]0x00B7 \+ " Inserts " \+ \[char\]0x00B7 \+ " "/);
  assert.match(WINDOWS_SCRIPT, /\$i -gt 0 -and \(\$want -eq "" -or \$w\.Value\.Substring\(0, \$i\) -eq \$want\)/);
  assert.doesNotMatch(WINDOWS_SCRIPT, /StartsWith/);
  assert.match(WINDOWS_SCRIPT, /0x10/); // WM_CLOSE
  assert.match(WINDOWS_SCRIPT, /IsWindowVisible/);
});

test('closePluginWindows: a PowerShell failure is an error with its message', async () => {
  const run = async () => { throw new Error('boom'); };
  await assert.rejects(closePluginWindows({ platform: 'win32', run }), /closing plug-in windows failed: boom/);
});
