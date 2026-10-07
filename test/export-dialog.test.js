import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXPORT_SCRIPT, windowsSnapshot, driveExportDialog, cancelExportDialogs } from '../src/export/dialog.js';

const script = readFileSync(EXPORT_SCRIPT, 'utf8').replace(/\r\n/g, '\n');

test('script reads its inputs from env and stays safe', () => {
  for (const v of ['S1MCP_XD_MODE', 'S1MCP_XD_PID', 'S1MCP_XD_BEFORE']) assert.ok(script.includes(`$env:${v}`), v);
  assert.ok(script.includes('CCLDialogClass') && script.includes('#32770'));
  assert.doesNotMatch(script, /Invoke-Expression|\biex\b/i);
  assert.doesNotMatch(script, /SetForegroundWindow|SendInput|keybd_event/);
  assert.ok(/0x0D/i.test(script) && /0x1B/i.test(script));
});

test('driveExportDialog passes env and parses the result', async () => {
  let seen;
  const run = async (cmd, args, opts) => {
    seen = opts;
    return { stdout: '{"event":"dialog","hwnd":"C","title":"Exportar mezcla"}\r\n{"ok":true}\r\n', aborted: false };
  };
  const r = await driveExportDialog({ pid: 123, before: ['A', 'B'] }, { run, platform: 'win32' });
  assert.deepEqual(r, { ok: true, dialog: { hwnd: 'C', title: 'Exportar mezcla' } });
  const e = seen.env;
  assert.equal(e.S1MCP_XD_MODE, 'drive');
  assert.equal(e.S1MCP_XD_PID, '123');
  assert.equal(e.S1MCP_XD_BEFORE, 'A,B');
  assert.equal(e.S1MCP_XD_TIMEOUT_MS, '15000');
  assert.equal(e.S1MCP_XD_WATCH_MS, '4000');
  assert.equal(seen.timeout, 29000);
});

test('alert and missing result', async () => {
  const alert = async () => ({ stdout: '{"ok":false,"reason":"alert","title":"Studio One"}', aborted: false });
  assert.deepEqual(await driveExportDialog({ pid: 1 }, { run: alert, platform: 'win32' }), { ok: false, reason: 'alert', title: 'Studio One' });
  const none = async () => ({ stdout: '', aborted: false });
  assert.deepEqual(await driveExportDialog({ pid: 1 }, { run: none, platform: 'win32' }), { ok: false, reason: 'no result from the dialog helper' });
});

test('windowsSnapshot parses windows; off Windows rejects', async () => {
  const run = async (c, a, o) => { assert.equal(o.env.S1MCP_XD_MODE, 'snapshot'); return { stdout: '{"windows":["A","B"]}', aborted: false }; };
  assert.deepEqual(await windowsSnapshot(5, { run, platform: 'win32' }), ['A', 'B']);
  await assert.rejects(windowsSnapshot(5, { platform: 'darwin' }), /Windows only/);
  await assert.rejects(driveExportDialog({ pid: 5 }, { platform: 'darwin' }), /Windows only/);
});

test('final result ignores snapshot lines; aborted run', async () => {
  const run = async () => ({ stdout: '{"ok":true}\n{"windows":["A"]}\n', aborted: false });
  assert.deepEqual(await driveExportDialog({ pid: 1 }, { run, platform: 'win32' }), { ok: true });
  const ab = async () => ({ stdout: '{"ok":true}', aborted: true });
  assert.deepEqual(await driveExportDialog({ pid: 1 }, { run: ab, platform: 'win32' }), { ok: false, reason: 'aborted' });
});

test('script has the two-phase wait', () => {
  assert.ok(script.includes('dialog did not accept OK') && script.includes('5000'));
});

test('drive and cancel only touch modal dialogs (owner disabled)', () => {
  assert.ok(script.includes('IsWindowEnabled') && script.includes('Modal('));
  assert.match(script, /function IsExportDialog\(\$h\) \{[^}]*Modal\(\$h\)/);
  assert.ok(script.includes("$mode -eq 'cancel'"));
  const cancel = script.slice(script.indexOf("if ($mode -eq 'cancel') {"), script.indexOf('# 1. Wait for the export dialog'));
  assert.doesNotMatch(cancel, /VK_RETURN/);
  assert.match(cancel, /VK_ESCAPE/);
});

test('cancelExportDialogs passes env and the signal, collects cancelled titles', async () => {
  let seen;
  const ac = new AbortController();
  const run = async (cmd, args, opts) => {
    seen = opts;
    return { stdout: '{"event":"cancelled","hwnd":"C","title":"Exportar mezcla"}\n', aborted: true };
  };
  const r = await cancelExportDialogs({ pid: 9, before: ['A'], timeoutMs: 20000, signal: ac.signal }, { run, platform: 'win32' });
  assert.deepEqual(r, { cancelled: ['Exportar mezcla'] });
  assert.equal(seen.env.S1MCP_XD_MODE, 'cancel');
  assert.equal(seen.env.S1MCP_XD_PID, '9');
  assert.equal(seen.env.S1MCP_XD_BEFORE, 'A');
  assert.equal(seen.env.S1MCP_XD_TIMEOUT_MS, '20000');
  assert.equal(seen.signal, ac.signal);
  await assert.rejects(cancelExportDialogs({ pid: 9 }, { platform: 'linux' }), /Windows only/);
});
