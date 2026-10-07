// Plug-in windows: focus through the bridge, close through the OS (Windows only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusPlugin, closePluginWindows, closeEditors, instrumentEditorTitle, WINDOWS_SCRIPT, windowsScript } from '../src/plugins/windows.js';

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
  assert.equal(script, `$want = ''\n$wantInserts = $true\n$editors = @()\n${WINDOWS_SCRIPT}`);
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
  assert.match(WINDOWS_SCRIPT, /\$i -gt 0 -and \$wantInserts -and \(\$want -eq "" -or \$w\.Value\.Substring\(0, \$i\) -eq \$want\)/);
  assert.match(WINDOWS_SCRIPT, /\$editors -ccontains \$w\.Value/); // instrument editors: exact, case-sensitive title
  assert.doesNotMatch(WINDOWS_SCRIPT, /StartsWith/);
  assert.match(WINDOWS_SCRIPT, /0x10/); // WM_CLOSE
  assert.match(WINDOWS_SCRIPT, /IsWindowVisible/);
});

test('closePluginWindows: a PowerShell failure is an error with its message', async () => {
  const run = async () => { throw new Error('boom'); };
  await assert.rejects(closePluginWindows({ platform: 'win32', run }), /closing plug-in windows failed: boom/);
});

// Live (7.2.3, Windows): Inst01 "Mai Tai"'s editor is a top-level window titled "1 - Mai Tai",
// Inst04 "Impact"'s "4 - Impact"; closeAll used to leave them open (and they block track edits).
test('instrumentEditorTitle: "<InstNN number> - <name>", null without a name', () => {
  assert.equal(instrumentEditorTitle({ index: 1, component: 'Inst01', name: 'Mai Tai' }), '1 - Mai Tai');
  assert.equal(instrumentEditorTitle({ index: 12, component: 'Inst12', name: 'Mai Tai 2' }), '12 - Mai Tai 2');
  assert.equal(instrumentEditorTitle({ index: 3, component: 'Inst03', name: null }), null);
});

const decode = (args) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
const INSTS = [{ index: 1, component: 'Inst01', name: 'Mai Tai' }, { index: 2, component: 'Inst02', name: "Guy's Synth" }, { index: 4, component: 'Inst04', name: null }];

test('closeEditors: closes insert windows and every instrument editor by exact title', async () => {
  let seen;
  const call = async (op) => (assert.equal(op, 'instruments'), INSTS);
  const r = await closeEditors(call, { platform: 'win32', settleMs: 0, run: async (_c, a) => { seen = decode(a); return '1 - Mai Tai\r\n'; } });
  assert.deepEqual(r, ['1 - Mai Tai']);
  assert.ok(seen.startsWith("$want = ''\n$wantInserts = $true\n$editors = @('1 - Mai Tai', '2 - Guy''s Synth')\n"));
});

test('closeEditors: one instrument closes only its editor; one channel only its insert windows', async () => {
  let seen;
  const run = async (_c, a) => { seen = decode(a); return ''; };
  await closeEditors(async () => INSTS, { platform: 'win32', run, instrument: 'Inst02' });
  assert.ok(seen.startsWith("$want = ''\n$wantInserts = $false\n$editors = @('2 - Guy''s Synth')\n"));
  await closeEditors(async () => INSTS, { platform: 'win32', run, instrument: 'Mai Tai' });
  assert.ok(seen.includes("$editors = @('1 - Mai Tai')\n"));
  let asked = false;
  await closeEditors(async () => { asked = true; return INSTS; }, { platform: 'win32', run, channel: 'Gtr' });
  assert.equal(asked, false);
  assert.ok(seen.startsWith("$want = 'Gtr'\n$wantInserts = $true\n$editors = @()\n"));
  await assert.rejects(closeEditors(async () => INSTS, { platform: 'win32', run, instrument: 'Mai Tai 9' }), /no instrument named Mai Tai 9/);
});

test('closeEditors: insert windows are still closed when the instruments cannot be read', async () => {
  let seen;
  const r = await closeEditors(async () => { throw new Error('bridge down'); }, { platform: 'win32', settleMs: 0, run: async (_c, a) => { seen = decode(a); return ''; } });
  assert.deepEqual(r, []);
  assert.ok(seen.startsWith("$want = ''\n$wantInserts = $true\n$editors = @()\n"));
});
