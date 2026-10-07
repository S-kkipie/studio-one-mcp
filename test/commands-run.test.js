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

test('numeric validation', () => {
  assert.throws(() => normalizeArgs(T, { AddValue: NaN }), /AddValue must be a finite number/);
  assert.throws(() => normalizeArgs(T, { AddValue: Infinity }), /finite number/);
  assert.throws(() => normalizeArgs(T, { AddValue: 'abc' }), /AddValue must be a number/);
  assert.throws(() => normalizeArgs(T, { AddValue: 1.5 }), /AddValue must be a whole number/);
});

test('choices and bool strictness', () => {
  assert.throws(() => normalizeArgs(T, { Mode: 5 }), /Mode must be one of/);
  assert.deepEqual(normalizeArgs(T, { Mode: 1 }).flat, ['Mode', 1]);
  assert.throws(() => normalizeArgs(T, { Relative: 7 }), /Relative must be/);
  assert.deepEqual(normalizeArgs(T, { Relative: 0 }).flat, ['Relative', 0]);
});

test('duplicate canonical keys throw', () => {
  assert.throws(() => normalizeArgs(T, { mode: 0, MODE: 1 }), /duplicate argument Mode/);
});

test('preset labels from the dialog map to their values', () => {
  const Q = { command: 'Musical Functions/Quantize Notes', args: [{ name: 'Base', type: 'float', min: 0, max: 4, presets: [{ value: 0.25, label: '1/16' }, { value: 0.5, label: '1/8' }] }] };
  assert.deepEqual(normalizeArgs(Q, { Base: '1/16' }).flat, ['Base', 0.25]);
  assert.throws(() => normalizeArgs(Q, { Base: '1/7' }), /Base must be a number or one of: 1\/16, 1\/8/);
});
