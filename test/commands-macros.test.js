import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMacro, readMacroExamples } from '../src/commands/macros.js';

const M = `﻿<?xml version="1.0" encoding="UTF-8"?>
<Macro title="+ 5th &amp; more" group="Transpose" description="">
	<CommandElement category="Musical Functions" name="Transpose">
		<CommandArgument name="Mode" value="0"/>
		<CommandArgument name="AddValue" value="7"/>
	</CommandElement>
	<CommandElement category="Edit" name="Select All"/>
	<CommandElement category="Marker" name="Insert Named">
		<CommandArgument name="Name" value="Chorus"/>
	</CommandElement>
</Macro>`;

test('parseMacro reads steps and typed args', () => {
  assert.deepEqual(parseMacro(M), {
    title: '+ 5th & more',
    steps: [
      { command: 'Musical Functions/Transpose', args: { Mode: 0, AddValue: 7 } },
      { command: 'Edit/Select All', args: {} },
      { command: 'Marker/Insert Named', args: { Name: 'Chorus' } },
    ],
  });
});

test('readMacroExamples groups by command, caps at 5, skips bad files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1mac-'));
  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(dir, `m${i}.studioonemacro`), M.replace('+ 5th &amp; more', `m${i}`).replace('value="7"', `value="${i}"`));
  fs.writeFileSync(path.join(dir, 'bad.studioonemacro'), 'garbage');
  fs.writeFileSync(path.join(dir, 'other.txt'), M);
  const ex = readMacroExamples([dir, path.join(dir, 'missing')]);
  assert.equal(ex['Musical Functions/Transpose'].length, 5);
  assert.deepEqual(ex['Marker/Insert Named'][0].args, { Name: 'Chorus' });
  assert.equal(ex['Edit/Select All'], undefined);
});

test('readMacroExamples dedupes identical args and tolerates prototype-like names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1mac-'));
  const x = (n) => `<Macro title="${n}"><CommandElement category="" name="constructor"><CommandArgument name="A" value="1"/></CommandElement></Macro>`;
  fs.writeFileSync(path.join(dir, 'a.studioonemacro'), x('a'));
  fs.writeFileSync(path.join(dir, 'b.studioonemacro'), x('b'));
  const ex = readMacroExamples([dir]);
  assert.deepEqual(ex.constructor, [{ macro: 'a', args: { A: 1 } }]);
});
