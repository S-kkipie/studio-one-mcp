import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCmdArgs, runCmd } from '../src/commands/cli.js';

const catalog = {
  live: true, warnings: ['w1'], builtAt: 'x',
  commands: [
    { command: 'Musical Functions/Transpose', category: 'Musical Functions', name: 'Transpose', displayName: 'Transpose', displayCategory: 'Musical Functions',
      args: [{ name: 'Mode', type: 'int', choices: [{ value: 0, label: 'Add/Subtract' }, { value: 1, label: 'Set all to' }], examples: [7, 12] }, { name: 'AddValue', type: 'int', min: -24, max: 24, default: 0 }] },
    { command: 'Transport/Start', category: 'Transport', name: 'Start', displayName: 'Start', displayCategory: 'Transport', args: [] },
  ],
};
const getCatalog = async () => catalog;
const mk = (callImpl = async () => ({ enabled: true, executed: true })) => {
  const logs = [], errs = [];
  return { logs, errs, out: { log: (s) => logs.push(s), error: (s) => errs.push(s) }, call: callImpl };
};

test('parseCmdArgs', () => {
  assert.deepEqual(
    parseCmdArgs(['run', 'Musical', 'Functions/Transpose', '--Mode', 'Add/Subtract', '--AddValue', '12', '--check']),
    { sub: 'run', words: ['Musical', 'Functions/Transpose'], flags: { check: true }, cmdArgs: { Mode: 'Add/Subtract', AddValue: '12' } });
  assert.deepEqual(parseCmdArgs(['run', 'A/B', '--Flag', '--X', '1']).cmdArgs, { Flag: true, X: '1' });
  assert.equal(parseCmdArgs(['find', 'x', '--limit', '3', '--state']).flags.limit, '3');
});

test('find prints lines', async () => {
  const t = mk();
  assert.equal(await runCmd(['find', 'transpose', '--state'], { call: t.call, getCatalog, out: t.out }), 0);
  assert.match(t.logs.join('\n'), /Musical Functions\/Transpose — Transpose — .*\[enabled\]/);
});

test('find --json parses', async () => {
  const t = mk();
  assert.equal(await runCmd(['find', 'transpose', '--json'], { call: t.call, getCatalog, out: t.out }), 0);
  assert.equal(JSON.parse(t.logs.join('\n')).results[0].command, 'Musical Functions/Transpose');
});

test('info prints args; unknown is exit 1', async () => {
  const t = mk();
  assert.equal(await runCmd(['info', 'Musical Functions/Transpose'], { call: t.call, getCatalog, out: t.out }), 0);
  const o = t.logs.join('\n');
  assert.match(o, /Mode: int choices: 0=Add\/Subtract, 1=Set all to; examples: 7, 12/);
  assert.match(o, /AddValue: int -24\.\.24 \(default 0\)/);
  const u = mk();
  assert.equal(await runCmd(['info', 'Nope/Zip'], { call: u.call, getCatalog, out: u.out }), 1);
  assert.match(u.errs[0], /^error: no command/);
});

test('run: usage error, not executed, executed', async () => {
  let t = mk();
  assert.equal(await runCmd(['run', 'Nope'], { call: t.call, getCatalog, out: t.out }), 2);
  t = mk(async () => ({ executed: false }));
  assert.equal(await runCmd(['run', 'Transport/Start'], { call: t.call, getCatalog, out: t.out }), 1);
  assert.match(t.logs.join('\n'), /not executed/);
  let payload;
  t = mk(async (_m, p) => { payload = p; return { executed: true }; });
  assert.equal(await runCmd(['run', 'Musical', 'Functions/Transpose', '--Mode', 'Set all to', '--AddValue', '5', '--check'], { call: t.call, getCatalog, out: t.out }), 0);
  assert.equal(payload.checkOnly, true);
  assert.match(t.logs.join('\n'), /^executed/);
});

test('refresh and usage', async () => {
  const t = mk();
  let asked;
  const gc = async (_c, o) => { asked = o; return catalog; };
  assert.equal(await runCmd(['refresh'], { call: t.call, getCatalog: gc, out: t.out }), 0);
  assert.deepEqual(asked, { refresh: true });
  assert.deepEqual(t.logs, ['catalog: 2 commands (live), 1 warnings', 'w1']);
  assert.equal(await runCmd(['help'], { call: t.call, getCatalog, out: t.out }), 0);
  assert.equal(await runCmd([], { call: t.call, getCatalog, out: t.out }), 2);
});
