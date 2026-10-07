// Drives the mailbox client against a fake device that behaves like
// BridgeComponent.js: heartbeat in status.json, answer request.json once per id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bridgeStatus, call, placeRequest } from '../src/bridge.js';

function fakeDevice(dir, handle) {
  let lastId = null;
  const beat = () => writeFileSync(join(dir, 'status.json'), '\uFEFF' + JSON.stringify({ protocol: 1, session: 'abc', heartbeat: Date.now() }));
  beat();
  const timer = setInterval(() => {
    beat();
    let req;
    try {
      req = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
    } catch {
      return;
    }
    if (req.id === lastId) return;
    lastId = req.id;
    let res;
    try {
      res = { id: req.id, ok: true, result: handle(req.op, req.args) };
    } catch (e) {
      res = { id: req.id, ok: false, error: e.message };
    }
    writeFileSync(join(dir, 'response.json'), '\uFEFF' + JSON.stringify(res) + '\n');
  }, 30);
  return () => clearInterval(timer);
}

test('status: not loaded, loaded, closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 's1mb-'));
  assert.equal(bridgeStatus(dir).loaded, false);
  writeFileSync(join(dir, 'status.json'), '\uFEFF' + JSON.stringify({ protocol: 1, heartbeat: 1 }));
  assert.equal(bridgeStatus(dir).loaded, true);
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ protocol: 1, closed: true }));
  assert.match(bridgeStatus(dir).reason, /closed/);
});

test('round trip, sequential requests, and device errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's1mb-'));
  const stop = fakeDevice(dir, (op, args) => {
    if (op === 'boom') throw new Error('nope');
    return { op, args };
  });
  try {
    let nudges = 0;
    const opts = { dir, nudge: () => nudges++ };
    const [a, b] = await Promise.all([call('ping', {}, opts), call('echo', { x: 1 }, opts)]);
    assert.ok(nudges >= 2, 'each request rings the doorbell');
    assert.deepEqual(a, { op: 'ping', args: {} });
    assert.deepEqual(b, { op: 'echo', args: { x: 1 } });
    await assert.rejects(call('boom', {}, opts), /Studio One: nope/);
  } finally {
    stop();
  }
});

test('times out with a helpful message when nobody answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's1mb-'));
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ protocol: 1, heartbeat: 1 }));
  let nudges = 0;
  await assert.rejects(call('ping', {}, { dir, timeoutMs: 400, nudge: () => nudges++ }), /did not answer "ping" within 400ms/);
  assert.ok(nudges >= 2, 'keeps ringing while waiting');
});

test('a doorbell failure (no MIDI port) surfaces as the error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's1mb-'));
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ protocol: 1, heartbeat: 1 }));
  await assert.rejects(call('ping', {}, { dir, nudge: () => { throw new Error('No MIDI output matching "IAC"'); } }), /No MIDI output/);
  // and the queue is not poisoned for the next call
  await assert.rejects(call('ping', {}, { dir, timeoutMs: 100, nudge: () => {} }), /did not answer/);
});

test('placeRequest retries a rename Windows refuses while Studio One holds request.json, then gives up', async () => {
  const locked = (n) => {
    let left = n;
    return () => { if (left-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); };
  };
  const sleeps = [];
  await placeRequest('a.tmp', 'request.json', { rename: locked(3), sleep: async (ms) => sleeps.push(ms) });
  assert.equal(sleeps.length, 3);
  await assert.rejects(placeRequest('a.tmp', 'request.json', { rename: locked(Infinity), waitMs: 0, sleep: async () => {} }), /EPERM/);
  await assert.rejects(placeRequest('a.tmp', 'request.json', { rename: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, sleep: async () => assert.fail('no retry') }), /ENOENT/);
});

test('onSent fires once the request is in the mailbox, in queue order, before the answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's1mb-'));
  const log = [];
  const stop = fakeDevice(dir, (op) => { log.push(`answer:${op}`); return op; });
  try {
    const opts = (name) => ({ dir, nudge: () => {}, onSent: () => {
      log.push(`sent:${name}`);
      assert.equal(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')).op, name);
    } });
    const a = call('first', {}, opts('first')).then((r) => { log.push(`done:${r}`); });
    const b = call('second', {}, opts('second')).then((r) => { log.push(`done:${r}`); });
    await Promise.all([a, b]);
    assert.deepEqual(log, ['sent:first', 'answer:first', 'done:first', 'sent:second', 'answer:second', 'done:second']);
    // a throwing hook does not break the call
    assert.equal(await call('third', {}, { dir, nudge: () => {}, onSent: () => { throw new Error('hook'); } }), 'third');
  } finally {
    stop();
  }
});

test('signal: an abort stops waiting and frees the queue; a queued aborted call never sends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's1mb-'));
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ protocol: 1, heartbeat: 1 }));
  const ac = new AbortController();
  const t0 = Date.now();
  const pending = call('slow', {}, { dir, timeoutMs: 60000, nudge: () => {}, signal: ac.signal });
  let sent = false;
  const dropped = call('dropped', {}, { dir, nudge: () => {}, signal: ac.signal, onSent: () => { sent = true; } });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(pending, /"slow" was abandoned/);
  await assert.rejects(dropped, /"dropped" was abandoned/);
  assert.equal(sent, false);
  assert.ok(Date.now() - t0 < 5000);
  await assert.rejects(call('next', {}, { dir, timeoutMs: 100, nudge: () => {} }), /did not answer "next"/);
});
