// live_export orchestrator over a fake bridge and fake dialog driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportAudio } from '../src/export/export.js';
import { snapshotFolders } from '../src/export/folders.js';

function setup({ playing = false, loop = [0, 10], fileUrl, cmdFails, restoreFails, writeFile = true, driver, currentRange = 0 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
  const calls = [];
  const call = async (op, a) => {
    calls.push([op, a]);
    if (op === 'song') {
      return {
        title: 'x',
        fileUrl: fileUrl === undefined ? pathToFileURL(path.join(tmp, 'x.song')).href : fileUrl || undefined,
        transport: { playing, recording: false, loopRange: { start: { seconds: loop[0] }, end: { seconds: loop[1] } } },
      };
    }
    if (op === 'exportSettings') {
      if (a.action === 'restore') {
        if (restoreFails) throw new Error('boom');
        return { restored: true };
      }
      if (a.action === 'get') return { range: currentRange };
      return { range: 0, selected: ['wav'] };
    }
    if (op === 'command') {
      if (cmdFails) throw new Error('command failed');
      if (writeFile) fs.writeFileSync(path.join(tmp, 'Mixdown.wav'), 'RIFFdata');
      return { executed: true };
    }
    throw new Error(`unexpected ${op}`);
  };
  const deps = {
    studioOnePid: async () => 1,
    windowsSnapshot: async () => { calls.push(['windowsSnapshot']); return ['A']; },
    driveExportDialog: driver ?? (async () => ({ ok: true })),
    exportFolders: () => [tmp],
    snapshotFolders,
  };
  return { tmp, calls, call, deps };
}

const names = (calls) => calls.map(([op, a]) => (op === 'exportSettings' ? `${op}:${a.action}` : op));

test('happy path: song, apply, command, restore; windows snapshot before command', async () => {
  const s = setup();
  const r = await exportAudio(s.call, { kind: 'mixdown', range: 'loop' }, s.deps);
  assert.deepEqual(names(s.calls), ['song', 'windowsSnapshot', 'exportSettings:apply', 'command', 'exportSettings:restore']);
  assert.ok(r.files[0].path.endsWith('Mixdown.wav'));
  assert.ok(r.files[0].bytes > 0);
  assert.equal(r.range, 'loop');
  assert.equal(r.settingsRestored, true);
  assert.equal(r.note, undefined);
});

test('validation errors make no bridge call', async () => {
  for (const o of [
    { kind: 'mixdown', formats: ['xyz'] },
    { kind: 'stems', formats: ['wav', 'mp3'] },
    { kind: 'mixdown', split_mono: true },
    { kind: 'mixdown', realtime: true },
    { kind: 'mixdown', formats: ['mp3'], output: 'x.wav' },
    { kind: 'mixdown', timeout_s: 5 },
    {},
  ]) {
    const s = setup();
    await assert.rejects(exportAudio(s.call, o, s.deps));
    assert.equal(s.calls.length, 0, JSON.stringify(o));
  }
  const s = setup();
  await assert.rejects(exportAudio(s.call, { kind: 'stems', split_mono: false, formats: ['wav', 'mp3'] }, s.deps), /exactly one|one format/);
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', split_mono: true }, s.deps), /only for stems/);
});

test('aliases map to the 8 names', async () => {
  const s = setup();
  await exportAudio(s.call, { kind: 'mixdown', range: 'song', formats: ['AIFF'] }, s.deps);
  assert.deepEqual(s.calls.find(([, a]) => a?.action === 'apply')[1].formats, ['aif']);
});

test('playing: refuses before any exportSettings call', async () => {
  const s = setup({ playing: true });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), /stop playback first/);
  assert.ok(!names(s.calls).some((n) => n.startsWith('exportSettings')));
});

test('unsaved song', async () => {
  const s = setup({ fileUrl: '' });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), /save the song once first/);
});

test('driver alert: refused, restore still called', async () => {
  const s = setup({ driver: async () => ({ ok: false, reason: 'alert', title: 'Studio One' }) });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), /refused the export/);
  assert.equal(names(s.calls).at(-1), 'exportSettings:restore');
});

test('driver no dialog and other reasons', async () => {
  let s = setup({ driver: async () => ({ ok: false, reason: 'no dialog' }) });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), /did not open the export dialog; if an export dialog appears, cancel it/);
  s = setup({ driver: async () => ({ ok: false, reason: 'weird' }) });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), /export dialog: weird/);
});

test('command throws: restore called, error propagated', async () => {
  const s = setup({ cmdFails: true });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), /command failed/);
  assert.equal(names(s.calls).at(-1), 'exportSettings:restore');
});

test('no new files: error lists the folder', async () => {
  const s = setup({ writeFile: false });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), (e) => e.message.includes(s.tmp) && /no new files/.test(e.message));
});

test('output folder: the file is moved there', async () => {
  const s = setup();
  const out = path.join(s.tmp, 'out');
  const r = await exportAudio(s.call, { kind: 'mixdown', range: 'song', output: out }, s.deps);
  assert.equal(r.files[0].path, path.join(out, 'Mixdown.wav'));
  assert.ok(fs.existsSync(r.files[0].path));
  assert.ok(!fs.existsSync(path.join(s.tmp, 'Mixdown.wav')));
});

test('restore rejects: result carries a note', async () => {
  const s = setup({ restoreFails: true });
  const r = await exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps);
  assert.match(r.note, /could not restore/);
  assert.equal(r.settingsRestored, false);
});

test('empty loop with range loop: error, no apply', async () => {
  const s = setup({ loop: [4, 4] });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'loop' }, s.deps), /set the loop range first/);
  assert.ok(!s.calls.some(([, a]) => a?.action === 'apply'));
});

test('range omitted: current range 0 with empty loop is refused via a read-only get', async () => {
  const s = setup({ loop: [0, 0], currentRange: 0 });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown' }, s.deps), /set the loop range first/);
  assert.deepEqual(names(s.calls), ['song', 'exportSettings:get']);
  const t = setup({ loop: [0, 0], currentRange: 1 });
  await exportAudio(t.call, { kind: 'mixdown' }, t.deps);
});

test('no dialog while the command never resolves: rejects promptly, restore ran', async () => {
  const s = setup({ driver: async () => ({ ok: false, reason: 'no dialog' }) });
  const inner = s.call;
  const call = (op, a, o) => (op === 'command' ? (s.calls.push([op, a]), new Promise(() => {})) : inner(op, a, o));
  await assert.rejects(exportAudio(call, { kind: 'mixdown', range: 'song' }, s.deps), /did not open the export dialog/);
  assert.equal(names(s.calls).at(-1), 'exportSettings:restore');
});

test('apply rejects: restore still called, error propagated', async () => {
  const s = setup();
  const inner = s.call;
  const call = async (op, a, o) => {
    if (op === 'exportSettings' && a.action === 'apply') { s.calls.push([op, a]); throw new Error('apply broke'); }
    return inner(op, a, o);
  };
  await assert.rejects(exportAudio(call, { kind: 'mixdown', range: 'song' }, s.deps), /apply broke/);
  assert.equal(names(s.calls).at(-1), 'exportSettings:restore');
});

test('off Windows without an injected pid: refuses before any call', async () => {
  const s = setup();
  const { studioOnePid, ...deps } = s.deps;
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, { ...deps, platform: 'linux' }), /supported on Windows only/);
  assert.equal(s.calls.length, 0);
});

test('wave and aac are not aliases', async () => {
  const s = setup();
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', formats: ['wave'] }, s.deps), /unknown format/);
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', formats: ['aac'] }, s.deps), /unknown format/);
});
