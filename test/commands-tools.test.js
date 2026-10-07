import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCommand, commandInfo, runCommand } from '../src/commands/tools.js';

const catalog = {
  schema: 1, builtAt: 1, install: null, live: true, warnings: [],
  commands: [
    { command: 'Musical Functions/Transpose', category: 'Musical Functions', name: 'Transpose', displayName: 'Transpose', args: [
      { name: 'Mode', type: 'int', min: 0, max: 1, choices: [{ value: 0, label: 'Add/Subtract' }, { value: 1, label: 'Set all to' }] },
      { name: 'AddValue', type: 'int', min: -64, max: 64 },
    ] },
    { command: 'Transport/Start', category: 'Transport', name: 'Start', displayName: 'Start', args: [], variableArgs: false },
  ],
};
const opts = { getCatalog: async () => catalog };
const fakeCall = (result = { enabled: true }) => {
  const calls = [];
  const fn = async (op, a) => { calls.push([op, a]); return typeof result === 'function' ? result(op, a) : result; };
  fn.calls = calls;
  return fn;
};

test('findCommand with_state adds enabled', async () => {
  const call = fakeCall();
  const r = await findCommand(call, { query: 'transpose', with_state: true }, opts);
  assert.equal(r.results[0].command, 'Musical Functions/Transpose');
  assert.equal(r.results[0].enabled, true);
  assert.equal(r.catalog.commands, 2);
  assert.deepEqual(call.calls[0], ['command', { category: 'Musical Functions', name: 'Transpose', checkOnly: true }]);
});

test('findCommand omits enabled when the check throws', async () => {
  const call = fakeCall(() => { throw new Error('x'); });
  const r = await findCommand(call, { query: 'transpose', with_state: true }, opts);
  assert.equal('enabled' in r.results[0], false);
});

test('commandInfo returns entry with summary and enabled; unknown lists closest', async () => {
  const info = await commandInfo(fakeCall(), { command: 'Musical Functions/Transpose' }, opts);
  assert.equal(info.enabled, true);
  assert.ok(info.argsSummary);
  await assert.rejects(commandInfo(fakeCall(), { command: 'Transpos' }, opts), /no command Transpos; closest:/);
});

test('runCommand normalizes object args', async () => {
  const call = fakeCall({ executed: true });
  const r = await runCommand(call, { command: 'Musical Functions/Transpose', args: { Mode: 'add', AddValue: 12 } }, opts);
  assert.deepEqual(call.calls[0], ['command', { category: 'Musical Functions', name: 'Transpose', checkOnly: false, args: ['Mode', 0, 'AddValue', 12] }]);
  assert.equal(r.command, 'Musical Functions/Transpose');
});

test('runCommand works without a catalog', async () => {
  const call = fakeCall({ executed: true });
  await runCommand(call, { category: 'Transport', name: 'Start' }, { getCatalog: async () => { throw new Error('down'); } });
  assert.equal(call.calls[0][1].name, 'Start');
  await assert.rejects(runCommand(call, {}, opts), /Category\/Name/);
});

test('runCommand notes executed:false', async () => {
  const r = await runCommand(fakeCall({ executed: false }), { command: 'Transport/Start' }, opts);
  assert.match(r.note, /not available in the current context/);
});

test('runCommand with a legacy array or no args never touches the catalog', async () => {
  const call = fakeCall({ executed: true });
  const boom = { getCatalog: async () => { throw new Error('catalog must not be read'); } };
  await runCommand(call, { command: 'Musical Functions/Transpose', args: ['Mode', 0] }, boom);
  assert.deepEqual(call.calls[0][1].args, ['Mode', 0]);
  await runCommand(call, { command: 'Transport/Start' }, boom);
});

test('runCommand rejects unknown arguments and args on zero-arg commands', async () => {
  const call = fakeCall({ executed: true });
  await assert.rejects(runCommand(call, { command: 'Musical Functions/Transpose', args: { Foo: 1 } }, opts), /unknown argument Foo/);
  await assert.rejects(runCommand(call, { command: 'Transport/Start', args: { X: 1 } }, opts), /Transport\/Start takes no arguments/);
  assert.equal(call.calls.length, 0);
});

test('runCommand check_only passes checkOnly: true', async () => {
  const call = fakeCall({ enabled: true });
  await runCommand(call, { command: 'Transport/Start', check_only: true }, opts);
  assert.equal(call.calls[0][1].checkOnly, true);
});

test('runCommand sends canonical casing and warns for commands not in the catalog', async () => {
  const call = fakeCall({ executed: true });
  await runCommand(call, { command: 'musical functions/transpose', args: { mode: 'Set all to' } }, opts);
  assert.equal(call.calls[0][1].category, 'Musical Functions');
  assert.equal(call.calls[0][1].name, 'Transpose');
  const r = await runCommand(fakeCall({ executed: true }), { command: 'Nope/Thing', args: { A: 1 } }, opts);
  assert.deepEqual(r.warnings, ['command not in the catalog: arguments not checked']);
});

test('with_state stops after the first failure; enabled checks use a short timeout', async () => {
  let n = 0;
  const seen = [];
  const call = async (op, a, o) => { n++; seen.push(o); throw new Error('busy'); };
  const r = await findCommand(call, { query: 'transpose start', with_state: true }, opts);
  assert.equal(n, 1);
  assert.deepEqual(seen[0], { timeoutMs: 1500 });
  assert.ok(r.note);
  assert.ok(r.results.every((x) => x.enabled === undefined));
  const info = await commandInfo(call, { command: 'Transport/Start' }, opts);
  assert.match(info.note, /could not ask Studio One/);
});
