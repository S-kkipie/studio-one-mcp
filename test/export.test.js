// live_export orchestrator over a fake bridge and fake dialog driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportAudio, findPid } from '../src/export/export.js';
import { withDialogLock } from '../src/dialoglock.js';
import { snapshotFolders } from '../src/export/folders.js';

function setup({ playing = false, loop = [0, 10], fileUrl, cmdFails, restoreFails, restoreResult, writeFile = true, driver, currentRange = 0, current = 'wav', selected, pending = false, cmd } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
  const calls = [];
  const call = async (op, a, o) => {
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
        return restoreResult ?? { restored: true, settings: { range: currentRange, current, selected: selected ?? [current], pending: false } };
      }
      if (a.action === 'get') return { range: currentRange, current, selected: selected ?? [current], pending };
      return { range: 0, selected: ['wav'] };
    }
    if (op === 'command') {
      if (cmd) return cmd(o, tmp);
      o?.onSent?.();
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
    cancelExportDialogs: async (args) => { calls.push(['cancelWatch', args]); return { cancelled: [] }; },
    exportFolders: () => [tmp],
    snapshotFolders,
    lateCancelMs: 200,
    settleMs: 200,
  };
  return { tmp, calls, call, deps };
}

// A command that is sent but never answers on its own; it rejects once abandoned (signal).
const hanging = (o) => {
  o?.onSent?.();
  return new Promise((_, reject) => {
    if (o?.signal) o.signal.addEventListener('abort', () => reject(new Error('"command" was abandoned before Studio One answered')), { once: true });
  });
};

const names = (calls) => calls.map(([op, a]) => (op === 'exportSettings' ? `${op}:${a.action}` : op));

test('happy path: song, get, apply, command, restore; windows snapshot before command', async () => {
  const s = setup();
  const r = await exportAudio(s.call, { kind: 'mixdown', range: 'loop' }, s.deps);
  assert.deepEqual(names(s.calls), ['song', 'exportSettings:get', 'windowsSnapshot', 'exportSettings:apply', 'command', 'exportSettings:restore']);
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
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), /^Error: Studio One did not open the export dialog in time; any late export dialog was cancelled$/);
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
  assert.match(r.note, /could not be put back yet \(boom\); the next live_export puts them back/);
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

test('no dialog while the command never answers: late cancel watch, command abandoned, restore ran, bounded', async () => {
  const s = setup({ driver: async () => ({ ok: false, reason: 'no dialog' }), cmd: hanging });
  const t0 = Date.now();
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), /did not open the export dialog in time; any late export dialog was cancelled/);
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual(names(s.calls).slice(-3), ['command', 'cancelWatch', 'exportSettings:restore']);
  const watch = s.calls.find(([op]) => op === 'cancelWatch')[1];
  assert.equal(watch.pid, 1);
  assert.deepEqual(watch.before, ['A']);
  assert.equal(watch.timeoutMs, 200);
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

test('the whole export runs inside the shared dialog lock', async () => {
  const s = setup();
  let release;
  const held = withDialogLock(() => new Promise((r) => { release = r; }));
  const p = exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.calls.length, 0, 'nothing runs while another dialog flow holds the lock');
  release();
  await held;
  await p;
  assert.equal(names(s.calls).at(-1), 'exportSettings:restore');
  const t = setup();
  let inLock = 0;
  await exportAudio(t.call, { kind: 'mixdown', range: 'song' }, { ...t.deps, lock: (fn) => { inLock++; return fn(); } });
  assert.equal(inLock, 1);
});

test('the dialog driver starts only once the command is sent', async () => {
  const log = [];
  const s = setup({
    cmd: async (o, tmp) => {
      await new Promise((r) => setTimeout(r, 50));
      log.push('sent');
      o.onSent();
      fs.writeFileSync(path.join(tmp, 'Mixdown.wav'), 'RIFF');
      await new Promise((r) => setTimeout(r, 20));
      return { executed: true };
    },
    driver: async () => { log.push('drive'); return { ok: true }; },
  });
  await exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps);
  assert.deepEqual(log, ['sent', 'drive']);
});

test('a command that fails before it is sent: no driver, restore ran', async () => {
  let drove = false;
  const s = setup({ cmd: async () => { throw new Error('Studio One bridge not loaded: x'); }, driver: async () => { drove = true; return { ok: true }; } });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), /bridge not loaded/);
  assert.equal(drove, false);
  assert.equal(names(s.calls).at(-1), 'exportSettings:restore');
});

test('other driver failures also watch for a late dialog; the watch stops once the command settles', async () => {
  let stopped = false;
  const s = setup({
    driver: async () => ({ ok: false, reason: 'dialog did not accept OK' }),
    cmd: (o) => { o.onSent(); return new Promise((r) => setTimeout(() => r({ executed: false }), 50)); },
  });
  s.deps.cancelExportDialogs = ({ signal }) => new Promise((r) => {
    signal.addEventListener('abort', () => { stopped = true; r({ cancelled: ['Export Mixdown'] }); }, { once: true });
  });
  s.deps.lateCancelMs = 10000;
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), /^Error: export dialog: dialog did not accept OK; a late export dialog was cancelled$/);
  assert.equal(stopped, true);
});

test('command timeout: says it may still be running and where files go', async () => {
  const s = setup({ cmd: async (o) => { o.onSent(); throw new Error('Studio One did not answer "command" within 30000ms. Is it running'); } });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song', timeout_s: 30 }, s.deps),
    (e) => e.message.startsWith('the export did not finish within timeout_s (30 s): it may still be running; files go to ') && e.message.includes(s.tmp));
  assert.equal(names(s.calls).at(-1), 'exportSettings:restore');
});

test('alert: files written anyway are listed in the error', async () => {
  const s = setup({ driver: async () => ({ ok: false, reason: 'alert', title: 'Studio One' }) });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps),
    (e) => /refused the export/.test(e.message) && e.message.includes('files written anyway: ') && e.message.includes('Mixdown.wav'));
  const t = setup({ writeFile: false, driver: async () => ({ ok: false, reason: 'alert', title: 'Studio One' }) });
  await assert.rejects(exportAudio(t.call, { kind: 'mixdown', range: 'song' }, t.deps), (e) => !e.message.includes('written anyway'));
});

test('alert while the command hangs: bounded, restore ran', async () => {
  const s = setup({ driver: async () => ({ ok: false, reason: 'alert', title: 'x' }), cmd: hanging });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), /refused the export/);
  assert.equal(names(s.calls).at(-1), 'exportSettings:restore');
});

test('settingsRestored follows restore: restored false is reported', async () => {
  const s = setup({ restoreResult: { restored: false } });
  const r = await exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps);
  assert.equal(r.settingsRestored, false);
  assert.match(r.note, /no saved copy/);
});

test('restore failing after a failed export is added to the error', async () => {
  const s = setup({ cmdFails: true, restoreFails: true });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), /command failed; your export settings could not be put back yet/);
});

test('pending settings from an interrupted export are restored before apply', async () => {
  const s = setup({ pending: true });
  const r = await exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps);
  assert.deepEqual(names(s.calls), ['song', 'exportSettings:get', 'exportSettings:restore', 'windowsSnapshot', 'exportSettings:apply', 'command', 'exportSettings:restore']);
  assert.match(r.note, /interrupted export were put back first/);
  assert.equal(r.settingsRestored, true);
});

test('output must be absolute; a file output must match the current format when formats is omitted', async () => {
  let s = setup();
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song', output: 'out' }, s.deps), /absolute path/);
  assert.equal(s.calls.length, 0);
  s = setup({ current: 'wav' });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song', output: path.join(s.tmp, 'a.mp3') }, s.deps), /\.mp3 does not match the format wav \(the export dialog's current choice/);
  assert.ok(!names(s.calls).includes('exportSettings:apply'));
  s = setup({ current: 'wav', selected: ['wav', 'mp3'] });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song', output: path.join(s.tmp, 'a.wav') }, s.deps), /several formats/);
  // aiff and aif are the same format
  s = setup({ current: 'aif', cmd: (o, tmp) => { o.onSent(); fs.writeFileSync(path.join(tmp, 'Mixdown.aif'), 'FORM'); return { executed: true }; } });
  const r = await exportAudio(s.call, { kind: 'mixdown', range: 'song', output: path.join(s.tmp, 'out', 'a.aiff') }, s.deps);
  assert.equal(r.files[0].path, path.join(s.tmp, 'out', 'a.aiff'));
});

test('a song URL that is not a file: URL counts as unsaved', async () => {
  const s = setup({ fileUrl: 'untitled://song' });
  await assert.rejects(exportAudio(s.call, { kind: 'mixdown', range: 'song' }, s.deps), /save the song once first/);
});

test('findPid: the preset helper picks the instance; tasklist is the fallback', async () => {
  assert.equal(await findPid({ snapshot: async () => ({ pid: 42, exclude: [] }), fallback: async () => 7 }), 42);
  assert.equal(await findPid({ snapshot: async () => { throw new Error('file dialog: Studio One is not running'); }, fallback: async () => 7 }), 7);
  await assert.rejects(findPid({ snapshot: async () => { throw new Error('file dialog: several Studio One instances are running with a song open; close all but one'); }, fallback: async () => 7 }), /^Error: several Studio One instances/);
});
