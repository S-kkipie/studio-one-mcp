// test/commands-search.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, searchCommands, argSummary } from '../src/commands/search.js';

const cat = { commands: [
  { command: 'Musical Functions/Transpose', category: 'Musical Functions', name: 'Transpose', displayCategory: 'Funciones musicales', displayName: 'Transponer', variableArgs: true,
    args: [{ name: 'Mode', type: 'int', min: 0, max: 1, choices: [{ value: 0, label: 'Add/Subtract' }, { value: 1, label: 'Set all to' }] }, { name: 'AddValue', type: 'int', min: -64, max: 64 }, { name: 'Relative', type: 'bool' }], examples: [] },
  { command: 'Musical Functions/Quantize Notes', category: 'Musical Functions', name: 'Quantize Notes', displayCategory: 'Funciones musicales', displayName: 'Cuantizar notas', variableArgs: true, args: [], examples: [] },
  { command: 'Event/Quantize', category: 'Event', name: 'Quantize', displayCategory: 'Evento', displayName: 'Cuantizar', variableArgs: false, args: [], examples: [] },
  { command: 'Track/Duplicate Track', category: 'Track', name: 'Duplicate Track', displayCategory: 'Pista', displayName: 'Duplicar pista', variableArgs: false, args: [], examples: [] },
  { command: 'Transport/Start', category: 'Transport', name: 'Start', displayCategory: 'Transporte', displayName: 'Iniciar', variableArgs: false, args: [], examples: [] },
] };

test('fold lowercases and strips accents', () => {
  assert.equal(fold('Transposición  ÑAÑA/Ok'), 'transposicion nana ok');
});

test('exact command name wins', () => {
  assert.equal(searchCommands(cat, 'Event/Quantize')[0].command, 'Event/Quantize');
});

test('Spanish with accents and synonyms finds the command', () => {
  assert.equal(searchCommands(cat, 'transposición una octava')[0].command, 'Musical Functions/Transpose');
  assert.equal(searchCommands(cat, 'duplicar la pista')[0].command, 'Track/Duplicate Track');
  const q = searchCommands(cat, 'cuantizar notas').map((r) => r.command);
  assert.equal(q[0], 'Musical Functions/Quantize Notes');
  assert.ok(q.includes('Event/Quantize'));
});

test('no match returns empty; limit applies', () => {
  assert.deepEqual(searchCommands(cat, 'zzzz'), []);
  assert.equal(searchCommands(cat, 'musical', { limit: 1 }).length, 1);
});

test('argSummary shows choices, ranges and booleans', () => {
  assert.equal(argSummary(cat.commands[0]), 'Mode(Add/Subtract|Set all to), AddValue(-64..64), Relative(on|off)');
  assert.equal(argSummary(cat.commands[4]), '');
});

test('stopwords are ignored unless the query is only stopwords', () => {
  const r = searchCommands(cat, 'la de el');
  assert.deepEqual(r, []);
  assert.equal(searchCommands(cat, 'iniciar el')[0].command, 'Transport/Start');
});

test('synonyms match whole words only, not prefixes', () => {
  const c = { commands: [{ command: 'Edit/Clipboard Paste', category: 'Edit', name: 'Clipboard Paste', displayCategory: 'Edicion', displayName: 'Pegar', variableArgs: false, args: [], examples: [] }] };
  assert.deepEqual(searchCommands(c, 'region'), []);
  assert.equal(searchCommands(c, 'clip').length, 1);
});

test('a query that names the whole command outranks longer commands containing it', () => {
  const c = { commands: [
    { command: 'Track/Transpose Instrument Tracks', category: 'Track', name: 'Transpose Instrument Tracks', displayCategory: 'Pista', displayName: 'Transponer pistas de instrumentos', args: [{ name: 'Transpose', type: 'int', min: -64, max: 64 }] },
    { command: 'Musical Functions/Transpose', category: 'Musical Functions', name: 'Transpose', displayCategory: 'Funciones musicales', displayName: 'Transponer', args: [] },
  ] };
  assert.equal(searchCommands(c, 'transponer')[0].command, 'Musical Functions/Transpose');
});
