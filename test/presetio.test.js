// presetio: a plug-in's state out of / into Studio One through its own Export / Load preset commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportState, loadState, sweepStale, withDialogLock, COMMAND_TIMEOUT_MS } from '../src/plugins/presetio.js';

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'presetio-test-'));
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
const SNAP = { pid: 4242, exclude: [111, 222] };

// A bridge whose presetCommand stays pending until the dialog filler "clicks OK".
function fakeBridge(log, { result = { ok: true, ran: 1 }, fail = null } = {}) {
  let pending = null;
  const call = async (op, args, opts) => {
    log.push(['call', op, args, opts]);
    if (op !== 'presetCommand') throw new Error('unexpected op ' + op);
    if (fail) throw new Error(fail);
    pending = deferred();
    return pending.p;
  };
  const release = (r = result) => { log.push(['bridge returns']); pending.resolve(r); };
  return { call, release };
}
const snapshotInto = (log, snap = SNAP) => async () => { log.push(['snapshot']); return snap; };

test('exportState: snapshot, then the command, then the fill (with the snapshot), then the answer; temp file deleted', async () => {
  const tmpDir = freshDir();
  const log = [];
  const bridge = fakeBridge(log);
  let fillArgs;
  const fill = async (a) => {
    fillArgs = a;
    log.push(['fill', a.expect]);
    assert.equal(path.dirname(a.path), tmpDir);
    assert.equal(path.extname(a.path), '', 'no extension: the plug-in picks it');
    fs.writeFileSync(a.path + '.vstpreset', Buffer.from('VST3data'));
    bridge.release();
    return { ok: true, title: 'Exportar preset' };
  };
  const r = await exportState(bridge.call, { channel: 'Mai Tai', slot: 0 }, { fill, snapshot: snapshotInto(log), tmpDir });
  assert.equal(r.ext, '.vstpreset');
  assert.equal(r.buf.toString(), 'VST3data');
  assert.deepEqual(log.map((x) => x[0] === 'call' ? [x[0], x[1], x[2]] : x), [
    ['snapshot'],
    ['call', 'presetCommand', { target: { channel: 'Mai Tai', slot: 0 }, command: 'Export Preset' }],
    ['fill', 'export'],
    ['bridge returns'],
  ]);
  assert.equal(log[1][3].timeoutMs, COMMAND_TIMEOUT_MS);
  // The snapshot's process and handles go to the filler, which only touches NEW dialogs of that process.
  assert.equal(fillArgs.pid, 4242);
  assert.deepEqual(fillArgs.exclude, [111, 222]);
  // The fill waits at least as long as the command can block (a late dialog is still handled).
  assert.ok(fillArgs.timeoutMs >= COMMAND_TIMEOUT_MS);
  assert.ok(fillArgs.signal && !fillArgs.signal.aborted);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('exportState: .preset, .fxpreset and .instrument (an instrument export) are detected too', async () => {
  for (const ext of ['.preset', '.fxpreset', '.instrument']) {
    const tmpDir = freshDir();
    const bridge = fakeBridge([]);
    const fill = async ({ path: p }) => { fs.writeFileSync(p + ext, 'x'); bridge.release(); return { ok: true }; };
    assert.equal((await exportState(bridge.call, { instrument: 'Mai Tai' }, { fill, snapshot: snapshotInto([]), tmpDir })).ext, ext);
    assert.deepEqual(fs.readdirSync(tmpDir), []);
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('exportState: a fill failure throws after the bridge returns, and leaves no file', async () => {
  const tmpDir = freshDir();
  const log = [];
  const bridge = fakeBridge(log);
  const fill = async ({ path: p }) => {
    fs.writeFileSync(p + '.preset', 'partial');
    bridge.release({ ok: false, ran: 0 }); // the script pressed Cancel, so the command returns
    throw new Error('file dialog: no OK');
  };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, snapshot: snapshotInto(log), tmpDir }), /no OK/);
  assert.deepEqual(log.map((x) => x[0]), ['snapshot', 'call', 'bridge returns']);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('exportState: a bridge error stops the waiting filler and wins over its error', async () => {
  const tmpDir = freshDir();
  const bridge = fakeBridge([], { fail: 'Export Preset is not available for Foo' });
  let aborted = false;
  const fill = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('file dialog: stopped waiting')); });
  });
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, snapshot: snapshotInto([]), tmpDir }), /not available for Foo/);
  assert.equal(aborted, true);
  fs.rmSync(tmpDir, { recursive: true });
});

test('exportState: a bridge timeout does not stop the filler (a late dialog still gets handled)', async () => {
  const tmpDir = freshDir();
  const bridge = fakeBridge([], { fail: 'Studio One did not answer "presetCommand" within 30000ms.' });
  let signalSeen;
  const fill = async ({ signal }) => { await new Promise((r) => setTimeout(r, 20)); signalSeen = signal.aborted; throw new Error('file dialog: cancelled it'); };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, snapshot: snapshotInto([]), tmpDir }), /did not answer/);
  assert.equal(signalSeen, false);
  fs.rmSync(tmpDir, { recursive: true });
});

test('exportState: a snapshot failure stops before the command', async () => {
  const log = [];
  const bridge = fakeBridge(log);
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, {
    fill: async () => ({ ok: true }), snapshot: async () => { throw new Error('file dialog: several Studio One instances'); }, tmpDir: freshDir(),
  }), /several/);
  assert.deepEqual(log, []);
});

test('exportState: a not-run answer, no file written, or a strange file throws', async () => {
  const tmpDir = freshDir();
  let bridge = fakeBridge([], { result: { ok: false, ran: 0 } });
  let fill = async ({ path: p }) => { fs.writeFileSync(p + '.preset', 'x'); bridge.release(); return { ok: true }; };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, snapshot: snapshotInto([]), tmpDir }), /did not run.*"ran":0/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  bridge = fakeBridge([]);
  fill = async () => { bridge.release(); return { ok: true }; };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, snapshot: snapshotInto([]), tmpDir }), /no preset file/);
  bridge = fakeBridge([]);
  fill = async ({ path: p }) => { fs.writeFileSync(p + '.txt', 'x'); bridge.release(); return { ok: true }; };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, snapshot: snapshotInto([]), tmpDir }), /unexpected preset file/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('exportState: a temp folder path that is too long fails before the command', async () => {
  const log = [];
  const bridge = fakeBridge(log);
  const tmpDir = path.join(freshDir(), 'x'.repeat(200));
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill: async () => ({ ok: true }), snapshot: snapshotInto(log), tmpDir }), /longer than 240/);
  assert.deepEqual(log, []);
  fs.rmSync(path.dirname(tmpDir), { recursive: true });
});

test('loadState: writes <uuid><ext>, snapshot, command, fill, answer; deletes the file', async () => {
  const tmpDir = freshDir();
  const log = [];
  const bridge = fakeBridge(log);
  let seenPath;
  const fill = async ({ path: p, expect, pid }) => {
    log.push(['fill', expect]);
    seenPath = p;
    assert.equal(pid, 4242);
    assert.equal(path.dirname(p), tmpDir);
    assert.equal(path.extname(p), '.vstpreset');
    assert.equal(fs.readFileSync(p, 'utf8'), 'STATE');
    bridge.release();
    return { ok: true };
  };
  const r = await loadState(bridge.call, { channel: 'Mai Tai', slot: 0 }, Buffer.from('STATE'), '.vstpreset', { fill, snapshot: snapshotInto(log), tmpDir });
  assert.equal(r.ok, true);
  assert.deepEqual(log.map((x) => x[0] === 'call' ? [x[0], x[1], x[2]] : x), [
    ['snapshot'],
    ['call', 'presetCommand', { target: { channel: 'Mai Tai', slot: 0 }, command: 'Load Preset File' }],
    ['fill', 'load'],
    ['bridge returns'],
  ]);
  assert.ok(!fs.existsSync(seenPath));
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('loadState: the temp file is deleted on a fill error and on a bridge error', async () => {
  const tmpDir = freshDir();
  let bridge = fakeBridge([]);
  await assert.rejects(loadState(bridge.call, { instrument: 'Mai Tai' }, Buffer.from('x'), '.preset', {
    fill: async () => { bridge.release({ ok: false, ran: 0 }); throw new Error('cancelled'); }, snapshot: snapshotInto([]), tmpDir,
  }), /cancelled/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  bridge = fakeBridge([], { fail: 'no instrument named Zed' });
  await assert.rejects(loadState(bridge.call, { instrument: 'Zed' }, Buffer.from('x'), '.preset', {
    fill: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('stopped')))), snapshot: snapshotInto([]), tmpDir,
  }), /no instrument named Zed/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('loadState: only preset extensions; never saves the song', async () => {
  const tmpDir = freshDir();
  const ops = [];
  const call = async (op) => { ops.push(op); return { ok: true, ran: 1 }; };
  const snapshot = snapshotInto([]);
  await assert.rejects(loadState(call, { instrument: 'A' }, Buffer.from('x'), '.exe', { fill: async () => ({ ok: true }), snapshot, tmpDir }), /extension/);
  assert.deepEqual(ops, []);
  await loadState(call, { instrument: 'A' }, Buffer.from('x'), 'preset', { fill: async () => ({ ok: true }), snapshot, tmpDir });
  assert.deepEqual(ops, ['presetCommand']);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('two concurrent dialog flows run one after the other (dialog lock)', async () => {
  const tmpDir = freshDir();
  const log = [];
  const bridge = fakeBridge(log);
  const fill = async ({ path: p, expect }) => {
    log.push(['fill start', expect]);
    await new Promise((r) => setTimeout(r, 30));
    if (expect === 'export') fs.writeFileSync(p + '.preset', 'x');
    log.push(['fill end', expect]);
    bridge.release();
    return { ok: true };
  };
  const snapshot = snapshotInto(log);
  const a = exportState(bridge.call, { channel: 'A', slot: 0 }, { fill, snapshot, tmpDir });
  const b = loadState(bridge.call, { channel: 'B', slot: 0 }, Buffer.from('y'), '.preset', { fill, snapshot, tmpDir });
  await Promise.all([a, b]);
  assert.deepEqual(log.map((x) => x[0] === 'call' ? x[2].command : x.join(' ')), [
    'snapshot', 'Export Preset', 'fill start export', 'fill end export', 'bridge returns',
    'snapshot', 'Load Preset File', 'fill start load', 'fill end load', 'bridge returns',
  ]);
  // A failing flow does not jam the lock.
  await assert.rejects(withDialogLock(async () => { throw new Error('x'); }), /x/);
  assert.equal(await withDialogLock(async () => 7), 7);
  fs.rmSync(tmpDir, { recursive: true });
});

test('sweepStale removes our temp files older than 10 minutes, once per folder', () => {
  const tmpDir = freshDir();
  const old = path.join(tmpDir, 'old.vstpreset');
  const recent = path.join(tmpDir, 'new.preset');
  fs.writeFileSync(old, 'x');
  fs.writeFileSync(recent, 'y');
  const t = Date.now();
  fs.utimesSync(old, new Date(t - 11 * 60 * 1000), new Date(t - 11 * 60 * 1000));
  sweepStale(tmpDir, { now: t });
  assert.deepEqual(fs.readdirSync(tmpDir), ['new.preset']);
  fs.utimesSync(recent, new Date(t - 20 * 60 * 1000), new Date(t - 20 * 60 * 1000));
  sweepStale(tmpDir, { now: t }); // second use: no sweep
  assert.deepEqual(fs.readdirSync(tmpDir), ['new.preset']);
  fs.rmSync(tmpDir, { recursive: true });
});
