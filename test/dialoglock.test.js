import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDialogLock } from '../src/dialoglock.js';
import { withDialogLock as presetLock } from '../src/plugins/presetio.js';

test('presetio re-exports the shared dialog lock', () => {
  assert.equal(presetLock, withDialogLock);
});

test('one dialog flow at a time, a failure does not block the next', async () => {
  const log = [];
  const slow = (name, ms, fail) => withDialogLock(async () => {
    log.push(`start:${name}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end:${name}`);
    if (fail) throw new Error(name);
    return name;
  });
  const a = slow('a', 50, true);
  const b = slow('b', 10);
  await assert.rejects(a, /a/);
  assert.equal(await b, 'b');
  assert.deepEqual(log, ['start:a', 'end:a', 'start:b', 'end:b']);
});
