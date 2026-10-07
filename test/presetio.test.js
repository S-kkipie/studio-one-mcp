// presetio: a plug-in's state out of / into Studio One through its own Export / Load preset commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportState, loadState, sweepStale, withDialogLock, COMMAND_TIMEOUT_MS, CANCEL_MARGIN_MS, LATE_CANCEL_MS } from '../src/plugins/presetio.js';

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'presetio-test-'));
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
const SNAP = { pid: 4242, exclude: [111, 222] };
const TIMEOUT_MSG = 'Studio One did not answer "presetCommand" within 30000ms.';

// A bridge whose presetCommand stays pending until release() / reject().
function fakeBridge(log, { result = { ok: true, ran: 1 }, fail = null } = {}) {
  let pending = null;
  const call = async (op, args, opts) => {
    log.push(['call', op, args, opts]);
    if (op !== 'presetCommand') throw new Error('unexpected op ' + op);
    if (fail !== null) throw fail instanceof Error || typeof fail !== 'string' ? fail : new Error(fail);
    pending = deferred();
    return pending.p;
  };
  const release = (r = result) => { log.push(['bridge returns']); pending.resolve(r); };
  const reject = (e) => { log.push(['bridge fails']); pending.reject(e); };
  return { call, release, reject };
}
const snapshotInto = (log, snap = SNAP) => async () => { log.push(['snapshot']); return snap; };
// A cancel watch that must not run.
const noWatch = async () => { throw new Error('cancel watch must not run'); };
const blockUntilAborted = (onAbort, props = { found: false, aborted: true }) => ({ signal }) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => { onAbort(); reject(Object.assign(new Error('file dialog: stopped'), props)); });
});
const deps = (log, extra = {}) => ({ snapshot: snapshotInto(log), cancelWatch: noWatch, ...extra });

test('exportState: snapshot, command, fill (with the snapshot), answer; temp file deleted', async () => {
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
  const r = await exportState(bridge.call, { channel: 'Mai Tai', slot: 0 }, { fill, ...deps(log), tmpDir });
  assert.equal(r.ext, '.vstpreset');
  assert.equal(r.buf.toString(), 'VST3data');
  assert.deepEqual(log.map((x) => x[0] === 'call' ? [x[0], x[1], x[2]] : x), [
    ['snapshot'],
    ['call', 'presetCommand', { target: { channel: 'Mai Tai', slot: 0 }, command: 'Export Preset' }],
    ['fill', 'export'],
    ['bridge returns'],
  ]);
  assert.equal(log[1][3].timeoutMs, COMMAND_TIMEOUT_MS);
  assert.equal(fillArgs.pid, 4242);
  assert.deepEqual(fillArgs.exclude, [111, 222]);
  assert.ok(fillArgs.timeoutMs >= COMMAND_TIMEOUT_MS);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('exportState: .preset, .fxpreset and .instrument (an instrument export) are detected too', async () => {
  for (const ext of ['.preset', '.fxpreset', '.instrument']) {
    const tmpDir = freshDir();
    const bridge = fakeBridge([]);
    const fill = async ({ path: p }) => { fs.writeFileSync(p + ext, 'x'); bridge.release(); return { ok: true }; };
    assert.equal((await exportState(bridge.call, { instrument: 'Mai Tai' }, { fill, ...deps([]), tmpDir })).ext, ext);
    assert.deepEqual(fs.readdirSync(tmpDir), []);
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('N1: the filler is stopped as soon as the bridge answers, whatever the answer', async () => {
  for (const answer of [{ ok: true, ran: 1 }, { ok: false, ran: 0 }, new Error('Export Preset is not available for Foo'), 'a string rejection']) {
    const tmpDir = freshDir();
    const bridge = fakeBridge([]);
    let aborted = false;
    const fill = (a) => { setTimeout(() => (answer instanceof Error || typeof answer === 'string' ? bridge.reject(answer) : bridge.release(answer)), 10); return blockUntilAborted(() => { aborted = true; })(a); };
    await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, ...deps([]), tmpDir }));
    assert.equal(aborted, true, `aborted on ${JSON.stringify(String(answer?.message ?? JSON.stringify(answer)))}`);
    assert.deepEqual(fs.readdirSync(tmpDir), []);
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('N1: answered OK but the dialog was never seen: export fails without a file, counts with one; load fails', async () => {
  const tmpDir = freshDir();
  let bridge = fakeBridge([]);
  let fill = (a) => { setTimeout(() => bridge.release(), 10); return blockUntilAborted(() => {})(a); };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, ...deps([]), tmpDir }), /never seen and no file was written/);
  bridge = fakeBridge([]);
  fill = (a) => { setTimeout(() => { fs.writeFileSync(a.path + '.preset', 'late'); bridge.release(); }, 10); return blockUntilAborted(() => {})(a); };
  assert.equal((await exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, ...deps([]), tmpDir })).buf.toString(), 'late');
  bridge = fakeBridge([]);
  fill = (a) => { setTimeout(() => bridge.release(), 10); return blockUntilAborted(() => {})(a); };
  await assert.rejects(loadState(bridge.call, { channel: 'X', slot: 0 }, Buffer.from('x'), '.preset', { fill, ...deps([]), tmpDir }), /never seen/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('F2: a bridge timeout stops the filler (never OK) and a 10 s cancel watch cancels the late dialog', async () => {
  const tmpDir = freshDir();
  const bridge = fakeBridge([]);
  let aborted = false;
  const watches = [];
  const cancelWatch = async (a) => { watches.push(a); return { cancelled: ['Exportar preset'] }; };
  const fill = (a) => { setTimeout(() => bridge.reject(new Error(TIMEOUT_MSG)), 10); return blockUntilAborted(() => { aborted = true; })(a); };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, ...deps([], { cancelWatch }), tmpDir }), /^Error: Studio One took too long; the preset dialog was cancelled$/);
  assert.equal(aborted, true);
  assert.equal(watches.length, 1);
  assert.equal(watches[0].timeoutMs, LATE_CANCEL_MS);
  assert.equal(watches[0].pid, 4242);
  assert.deepEqual(watches[0].exclude, [111, 222]);
  // Nothing was there to cancel: still a failure.
  const b2 = fakeBridge([]);
  const fill2 = (a) => { setTimeout(() => b2.reject(new Error(TIMEOUT_MSG)), 10); return blockUntilAborted(() => {})(a); };
  await assert.rejects(exportState(b2.call, { channel: 'X', slot: 0 }, { fill: fill2, ...deps([], { cancelWatch: async () => ({ cancelled: [] }) }), tmpDir }), /took too long; no preset dialog was seen/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('F2: a fill failure before our dialog was found, call still pending: cancel watch until the call returns', async () => {
  const tmpDir = freshDir();
  const bridge = fakeBridge([]);
  const watches = [];
  const cancelWatch = (a) => new Promise((resolve) => {
    watches.push(a);
    // Our dialog shows up late; the watch cancels it, so the call returns.
    setTimeout(() => bridge.release({ ok: true, ran: 1 }), 10);
    a.signal.addEventListener('abort', () => resolve({ cancelled: ['Cargar preset'] }));
  });
  const fill = async () => { throw Object.assign(new Error("file dialog: a new dialog 'Guardar como' is not a preset file dialog; it was left alone"), { found: false, foreign: true }); };
  await assert.rejects(loadState(bridge.call, { channel: 'X', slot: 0 }, Buffer.from('x'), '.vstpreset', { fill, ...deps([], { cancelWatch }), tmpDir }),
    /Guardar como.*left alone; the preset dialog came later and was cancelled/);
  assert.equal(watches.length, 1);
  assert.ok(watches[0].timeoutMs <= COMMAND_TIMEOUT_MS + CANCEL_MARGIN_MS && watches[0].timeoutMs > CANCEL_MARGIN_MS);
  assert.equal(watches[0].signal.aborted, true, 'the watch stops when the call returns');
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('a fill failure after our dialog was found (it pressed Cancel) runs no cancel watch', async () => {
  const tmpDir = freshDir();
  const log = [];
  const bridge = fakeBridge(log);
  const fill = async ({ path: p }) => {
    fs.writeFileSync(p + '.preset', 'partial');
    bridge.release({ ok: true, ran: 1 }); // Cancel also answers ran: 1
    throw Object.assign(new Error('file dialog: the filename field did not take the path (cancelled)'), { found: true, button: 'cancel' });
  };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, ...deps(log), tmpDir }), /did not take the path \(cancelled\)$/);
  assert.deepEqual(log.map((x) => x[0]), ['snapshot', 'call', 'bridge returns']);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('a bridge error wins over the fill error it caused', async () => {
  const tmpDir = freshDir();
  const bridge = fakeBridge([], { fail: 'Export Preset is not available for Foo' });
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill: blockUntilAborted(() => {}), ...deps([]), tmpDir }), /not available for Foo/);
  fs.rmSync(tmpDir, { recursive: true });
});

test('a non-Error rejection from the bridge is reported, not left unhandled', async () => {
  const tmpDir = freshDir();
  const bridge = fakeBridge([], { fail: { weird: true } });
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill: blockUntilAborted(() => {}), ...deps([]), tmpDir }), (e) => e.weird === true);
  fs.rmSync(tmpDir, { recursive: true });
});

test('a snapshot failure stops before the command', async () => {
  const log = [];
  const bridge = fakeBridge(log);
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, {
    fill: async () => ({ ok: true }), cancelWatch: noWatch, snapshot: async () => { throw new Error('file dialog: several Studio One instances'); }, tmpDir: freshDir(),
  }), /several/);
  assert.deepEqual(log, []);
});

test('exportState: a not-run answer, no file written, or a strange file throws', async () => {
  const tmpDir = freshDir();
  let bridge = fakeBridge([], { result: { ok: false, ran: 0 } });
  let fill = async ({ path: p }) => { fs.writeFileSync(p + '.preset', 'x'); bridge.release(); return { ok: true }; };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, ...deps([]), tmpDir }), /did not run.*"ran":0/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  bridge = fakeBridge([]);
  fill = async () => { bridge.release(); return { ok: true }; };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, ...deps([]), tmpDir }), /wrote no preset file/);
  bridge = fakeBridge([]);
  fill = async ({ path: p }) => { fs.writeFileSync(p + '.txt', 'x'); bridge.release(); return { ok: true }; };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, ...deps([]), tmpDir }), /unexpected preset file/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('a temp folder path that is too long fails before the command', async () => {
  const log = [];
  const bridge = fakeBridge(log);
  const tmpDir = path.join(freshDir(), 'x'.repeat(200));
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill: async () => ({ ok: true }), ...deps(log), tmpDir }), /longer than 240/);
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
    assert.equal(path.extname(p), '.vstpreset');
    assert.equal(fs.readFileSync(p, 'utf8'), 'STATE');
    bridge.release();
    return { ok: true };
  };
  const r = await loadState(bridge.call, { channel: 'Mai Tai', slot: 0 }, Buffer.from('STATE'), '.vstpreset', { fill, ...deps(log), tmpDir });
  assert.equal(r.ok, true);
  assert.deepEqual(log.map((x) => x[0] === 'call' ? [x[0], x[1], x[2]] : x), [
    ['snapshot'],
    ['call', 'presetCommand', { target: { channel: 'Mai Tai', slot: 0 }, command: 'Load Preset File' }],
    ['fill', 'load'],
    ['bridge returns'],
  ]);
  assert.ok(!fs.existsSync(seenPath));
  fs.rmSync(tmpDir, { recursive: true });
});

test('loadState: the temp file is deleted on a fill error and on a bridge error', async () => {
  const tmpDir = freshDir();
  let bridge = fakeBridge([]);
  await assert.rejects(loadState(bridge.call, { instrument: 'Mai Tai' }, Buffer.from('x'), '.preset', {
    fill: async () => { bridge.release({ ok: true, ran: 1 }); throw Object.assign(new Error('cancelled'), { found: true }); }, ...deps([]), tmpDir,
  }), /cancelled/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  bridge = fakeBridge([], { fail: 'no instrument named Zed' });
  await assert.rejects(loadState(bridge.call, { instrument: 'Zed' }, Buffer.from('x'), '.preset', { fill: blockUntilAborted(() => {}), ...deps([]), tmpDir }), /no instrument named Zed/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('loadState: only preset extensions; never saves the song', async () => {
  const tmpDir = freshDir();
  const ops = [];
  const call = async (op) => { ops.push(op); return { ok: true, ran: 1 }; };
  await assert.rejects(loadState(call, { instrument: 'A' }, Buffer.from('x'), '.exe', { fill: async () => ({ ok: true }), ...deps([]), tmpDir }), /extension/);
  assert.deepEqual(ops, []);
  await loadState(call, { instrument: 'A' }, Buffer.from('x'), 'preset', { fill: async () => ({ ok: true }), ...deps([]), tmpDir });
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
  const a = exportState(bridge.call, { channel: 'A', slot: 0 }, { fill, ...deps(log), tmpDir });
  const b = loadState(bridge.call, { channel: 'B', slot: 0 }, Buffer.from('y'), '.preset', { fill, ...deps(log), tmpDir });
  await Promise.all([a, b]);
  assert.deepEqual(log.map((x) => x[0] === 'call' ? x[2].command : x.join(' ')), [
    'snapshot', 'Export Preset', 'fill start export', 'fill end export', 'bridge returns',
    'snapshot', 'Load Preset File', 'fill start load', 'fill end load', 'bridge returns',
  ]);
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
  sweepStale(tmpDir, { now: t });
  assert.deepEqual(fs.readdirSync(tmpDir), ['new.preset']);
  fs.rmSync(tmpDir, { recursive: true });
});
