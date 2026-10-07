// presetio: a plug-in's state out of / into Studio One through its own Export / Load preset commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportState, loadState } from '../src/plugins/presetio.js';

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'presetio-test-'));
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

// A bridge whose presetCommand stays pending until the dialog filler "clicks OK".
function fakeBridge(log, { result = { ok: true }, fail = null } = {}) {
  let pending = null;
  const call = async (op, args, opts) => {
    log.push(['call', op, args, opts]);
    if (op !== 'presetCommand') throw new Error('unexpected op ' + op);
    if (fail) throw new Error(fail);
    pending = deferred();
    return pending.p;
  };
  const release = () => { log.push(['bridge returns']); pending.resolve(result); };
  return { call, release };
}

test('exportState: command started before the fill, awaited after; extension detected; temp file deleted', async () => {
  const tmpDir = freshDir();
  const log = [];
  const bridge = fakeBridge(log);
  const fill = async ({ path: p, expect }) => {
    log.push(['fill', expect]);
    assert.equal(path.dirname(p), tmpDir);
    assert.equal(path.extname(p), '', 'no extension: the plug-in picks it');
    fs.writeFileSync(p + '.vstpreset', Buffer.from('VST3data'));
    bridge.release();
    return { ok: true, title: 'Exportar preset' };
  };
  const r = await exportState(bridge.call, { channel: 'Mai Tai', slot: 0 }, { fill, tmpDir });
  assert.equal(r.ext, '.vstpreset');
  assert.equal(r.buf.toString(), 'VST3data');
  assert.deepEqual(log.map((x) => x[0] === 'call' ? [x[0], x[1], x[2]] : x), [
    ['call', 'presetCommand', { target: { channel: 'Mai Tai', slot: 0 }, command: 'Export Preset' }],
    ['fill', 'export'],
    ['bridge returns'],
  ]);
  assert.equal(log[0][3].timeoutMs, 30000);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('exportState: .preset, .fxpreset and .instrument (an instrument export) are detected too', async () => {
  for (const ext of ['.preset', '.fxpreset', '.instrument']) {
    const tmpDir = freshDir();
    const bridge = fakeBridge([]);
    const fill = async ({ path: p }) => { fs.writeFileSync(p + ext, 'x'); bridge.release(); return { ok: true }; };
    assert.equal((await exportState(bridge.call, { instrument: 'Mai Tai' }, { fill, tmpDir })).ext, ext);
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
    bridge.release(); // the script pressed Cancel, so the command returns
    throw new Error('file dialog: no OK');
  };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, tmpDir }), /no OK/);
  assert.deepEqual(log.map((x) => x[0]), ['call', 'bridge returns']);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('exportState: a bridge error wins over the fill error it caused (no dialog ever opened)', async () => {
  const tmpDir = freshDir();
  const bridge = fakeBridge([], { fail: 'Export Preset is not available for Foo' });
  const fill = async () => { throw new Error('no file dialog appeared within 8000 ms'); };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, tmpDir }), /not available for Foo/);
  fs.rmSync(tmpDir, { recursive: true });
});

test('exportState: an unexpected bridge answer, or no file written, throws', async () => {
  const tmpDir = freshDir();
  let bridge = fakeBridge([], { result: { error: 'weird' } });
  let fill = async ({ path: p }) => { fs.writeFileSync(p + '.preset', 'x'); bridge.release(); return { ok: true }; };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, tmpDir }), /unexpected answer/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  bridge = fakeBridge([]);
  fill = async () => { bridge.release(); return { ok: true }; };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, tmpDir }), /no preset file/);
  bridge = fakeBridge([]);
  fill = async ({ path: p }) => { fs.writeFileSync(p + '.txt', 'x'); bridge.release(); return { ok: true }; };
  await assert.rejects(exportState(bridge.call, { channel: 'X', slot: 0 }, { fill, tmpDir }), /unexpected preset file/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('loadState: writes <uuid><ext>, starts Load Preset File before the fill, awaits after, deletes the file', async () => {
  const tmpDir = freshDir();
  const log = [];
  const bridge = fakeBridge(log);
  let seenPath;
  const fill = async ({ path: p, expect }) => {
    log.push(['fill', expect]);
    seenPath = p;
    assert.equal(path.dirname(p), tmpDir);
    assert.equal(path.extname(p), '.vstpreset');
    assert.equal(fs.readFileSync(p, 'utf8'), 'STATE');
    bridge.release();
    return { ok: true };
  };
  const r = await loadState(bridge.call, { channel: 'Mai Tai', slot: 0 }, Buffer.from('STATE'), '.vstpreset', { fill, tmpDir });
  assert.equal(r.ok, true);
  assert.deepEqual(log.map((x) => x[0] === 'call' ? [x[0], x[1], x[2]] : x), [
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
    fill: async () => { bridge.release(); throw new Error('cancelled'); }, tmpDir,
  }), /cancelled/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  bridge = fakeBridge([], { fail: 'no instrument named Zed' });
  await assert.rejects(loadState(bridge.call, { instrument: 'Zed' }, Buffer.from('x'), '.preset', {
    fill: async () => { throw new Error('no file dialog appeared'); }, tmpDir,
  }), /no instrument named Zed/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});

test('loadState: only preset extensions; never saves the song', async () => {
  const tmpDir = freshDir();
  const ops = [];
  const call = async (op) => { ops.push(op); return { ok: true }; };
  await assert.rejects(loadState(call, { instrument: 'A' }, Buffer.from('x'), '.exe', { fill: async () => ({ ok: true }), tmpDir }), /extension/);
  assert.deepEqual(ops, []);
  await loadState(call, { instrument: 'A' }, Buffer.from('x'), 'preset', { fill: async () => ({ ok: true }), tmpDir });
  assert.deepEqual(ops, ['presetCommand']);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true });
});
