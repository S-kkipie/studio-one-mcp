// Plug-in windows: focus through the bridge, close through the OS (Windows only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusPlugin, closePluginWindows, closeEditors, instrumentEditorTitle, WINDOWS_SCRIPT, windowsEnv } from '../src/plugins/windows.js';

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
  const run = async (cmd, args, opts) => { seen = [cmd, args, opts]; return 'Mai Tai – Inserts – 1 - Archetype Petrucci X\r\nGuardar preset\r\n\r\n'; };
  const r = await closePluginWindows({ platform: 'win32', run, settleMs: 0 });
  assert.deepEqual(r, ['Mai Tai – Inserts – 1 - Archetype Petrucci X', 'Guardar preset']);
  assert.equal(seen[0], 'powershell.exe');
  assert.ok(seen[1].includes('-EncodedCommand'));
  const script = Buffer.from(seen[1][seen[1].indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.equal(script, WINDOWS_SCRIPT);
  assert.deepEqual(seen[2].env, { S1MCP_WANT_CHANNEL: '', S1MCP_WANT_INSERTS: '1', S1MCP_EDITORS: '[]' });
});

test('closePluginWindows: the channel filter goes in through the environment, never into the script', async () => {
  let seen;
  const run = async (_cmd, args, opts) => { seen = { script: Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le'), env: opts.env }; return ''; };
  assert.deepEqual(await closePluginWindows({ platform: 'win32', run, channel: "Guy's Amp" }), []);
  assert.equal(seen.script, WINDOWS_SCRIPT);
  assert.deepEqual(seen.env, windowsEnv("Guy's Amp"));
  assert.equal(seen.env.S1MCP_WANT_CHANNEL, "Guy's Amp");
});

// Security: names come from the user's songs. PowerShell takes U+2018..U+201B as single quotes too,
// so interpolating a name into the script could end a literal and run code. The script must stay
// constant, whatever the channel and editor names hold.
test('closePluginWindows: hostile channel and editor names never reach the script text', async () => {
  const hostile = ['Guy\u2019s Amp', "x'; Remove-Item -Recurse C:\ ; '", 'a\u2018; Remove-Item x; \u2019', 'b\u201A$(calc)\u201B', '"; Remove-Item y; "'];
  for (const name of hostile) {
    let seen;
    const run = async (_cmd, args, opts) => { seen = { args, script: Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le'), env: opts.env }; return ''; };
    await closePluginWindows({ platform: 'win32', run, channel: name, editors: [`1 - ${name}`, name] });
    assert.equal(seen.script, WINDOWS_SCRIPT);
    assert.ok(!seen.script.includes(name));
    assert.ok(!seen.args.some((a) => a.includes(name)));
    assert.equal(seen.env.S1MCP_WANT_CHANNEL, name);
    assert.deepEqual(JSON.parse(seen.env.S1MCP_EDITORS), [`1 - ${name}`, name]);
  }
  for (const ch of ['\u2018', '\u2019', '\u201A', '\u201B', 'Remove-Item']) assert.ok(!WINDOWS_SCRIPT.includes(ch));
  assert.match(WINDOWS_SCRIPT, /\$want = \[string\]\$env:S1MCP_WANT_CHANNEL/);
  assert.match(WINDOWS_SCRIPT, /ConvertFrom-Json \$env:S1MCP_EDITORS/);
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
// Inst04 "Impact"'s "4 - Impact"; closeAll used to leave them open (and they may refuse track
// edits; the track-edit retry closes plug-in and instrument editor windows).
test('instrumentEditorTitle: "<InstNN number> - <name>", null without a name', () => {
  assert.equal(instrumentEditorTitle({ index: 1, component: 'Inst01', name: 'Mai Tai' }), '1 - Mai Tai');
  assert.equal(instrumentEditorTitle({ index: 12, component: 'Inst12', name: 'Mai Tai 2' }), '12 - Mai Tai 2');
  assert.equal(instrumentEditorTitle({ index: 3, component: 'Inst03', name: null }), null);
});

const envOf = (opts) => ({ ...opts.env, S1MCP_EDITORS: JSON.parse(opts.env.S1MCP_EDITORS) });
const INSTS = [{ index: 1, component: 'Inst01', name: 'Mai Tai' }, { index: 2, component: 'Inst02', name: "Guy's Synth" }, { index: 4, component: 'Inst04', name: null }];

test('closeEditors: closes insert windows and every instrument editor by exact title', async () => {
  let seen;
  const call = async (op) => (assert.equal(op, 'instruments'), INSTS);
  const r = await closeEditors(call, { platform: 'win32', settleMs: 0, run: async (_c, _a, o) => { seen = envOf(o); return '1 - Mai Tai\r\n'; } });
  assert.deepEqual(r, ['1 - Mai Tai']);
  assert.deepEqual(seen, { S1MCP_WANT_CHANNEL: '', S1MCP_WANT_INSERTS: '1', S1MCP_EDITORS: ['1 - Mai Tai', "2 - Guy's Synth"] });
});

test('closeEditors: one instrument closes only its editor; one channel only its insert windows', async () => {
  let seen;
  const run = async (_c, _a, o) => { seen = envOf(o); return ''; };
  await closeEditors(async () => INSTS, { platform: 'win32', run, instrument: 'Inst02' });
  assert.deepEqual(seen, { S1MCP_WANT_CHANNEL: '', S1MCP_WANT_INSERTS: '0', S1MCP_EDITORS: ["2 - Guy's Synth"] });
  await closeEditors(async () => INSTS, { platform: 'win32', run, instrument: 'Mai Tai' });
  assert.deepEqual(seen.S1MCP_EDITORS, ['1 - Mai Tai']);
  let asked = false;
  await closeEditors(async () => { asked = true; return INSTS; }, { platform: 'win32', run, channel: 'Gtr' });
  assert.equal(asked, false);
  assert.deepEqual(seen, { S1MCP_WANT_CHANNEL: 'Gtr', S1MCP_WANT_INSERTS: '1', S1MCP_EDITORS: [] });
  await assert.rejects(closeEditors(async () => INSTS, { platform: 'win32', run, instrument: 'Mai Tai 9' }), /no instrument named Mai Tai 9/);
});

test('closeEditors: insert windows are still closed when the instruments cannot be read', async () => {
  let seen;
  const r = await closeEditors(async () => { throw new Error('bridge down'); }, { platform: 'win32', settleMs: 0, run: async (_c, _a, o) => { seen = envOf(o); return ''; } });
  assert.deepEqual(r, []);
  assert.deepEqual(seen, { S1MCP_WANT_CHANNEL: '', S1MCP_WANT_INSERTS: '1', S1MCP_EDITORS: [] });
});
