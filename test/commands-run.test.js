// test/commands-run.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCommand, normalizeArgs } from '../src/commands/run.js';

const T = { command: 'Musical Functions/Transpose', args: [
  { name: 'Mode', type: 'int', min: 0, max: 1, choices: [{ value: 0, label: 'Add/Subtract' }, { value: 1, label: 'Set all to' }] },
  { name: 'AddValue', type: 'int', min: -64, max: 64 },
  { name: 'Relative', type: 'bool' },
] };

test('splitCommand splits on the first slash', () => {
  assert.deepEqual(splitCommand('Musical Functions/Transpose'), { category: 'Musical Functions', name: 'Transpose' });
  assert.throws(() => splitCommand('Transpose'), /Category\/Name/);
});

test('legacy flat arrays pass through', () => {
  assert.deepEqual(normalizeArgs(T, ['Mode', 0]), { flat: ['Mode', 0], warnings: [] });
  assert.deepEqual(normalizeArgs(T, undefined), { flat: undefined, warnings: [] });
});

test('object args: canonical names, enum labels, booleans, numeric strings', () => {
  assert.deepEqual(normalizeArgs(T, { mode: 'set all', addvalue: '12', Relative: 'sí' }).flat, ['Mode', 1, 'AddValue', 12, 'Relative', 1]);
  assert.deepEqual(normalizeArgs(T, { Mode: 'add/subtract' }).flat, ['Mode', 0]);
});

test('object args: errors name the valid options', () => {
  assert.throws(() => normalizeArgs(T, { Foo: 1 }), /unknown argument Foo for Musical Functions\/Transpose; valid: Mode, AddValue, Relative/);
  assert.throws(() => normalizeArgs(T, { Mode: 'triple' }), /Mode must be one of: Add\/Subtract \(0\), Set all to \(1\)/);
  assert.throws(() => normalizeArgs(T, { AddValue: 99 }), /AddValue must be between -64 and 64/);
});

test('no schema: passes through with a warning', () => {
  const r = normalizeArgs(null, { Name: 'Chorus' });
  assert.deepEqual(r.flat, ['Name', 'Chorus']);
  assert.match(r.warnings[0], /not checked/);
});
