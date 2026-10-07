// test/commands-schemas.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPackage } from '../src/commands/packages.js';
import { parseClassFactory, parseScriptArgs, parseSkinForms, schemasFromPackageFiles, extractEditTaskSchemas } from '../src/commands/schemas.js';

const FACTORY = `<ClassFactory>
  <ScriptClass classID="{abc-1}" category="EditTask" subCategory="MusicEdit" name="Transpose" sourceFile="Transpose.js" functionName="createInstance">
    <Attribute id="arguments" value="..."/>
  </ScriptClass>
  <ScriptClass classID="{abc-2}" category="EditTask" subCategory="MusicEdit" name="Velocity" sourceFile="Velocity.js" functionName="createInstance"/>
</ClassFactory>`;

const TRANSPOSE = `
  return context.runDialog ("TransposeDialog", MusicEdit.kPackageID);
  this.AddValue = parameters.addInteger (-64, 64, "AddValue");
  this.SetValue = parameters.addInteger (0, 127, "SetValue");
  this.SetValue.value = 60;
  this.Mode = context.parameters.addInteger(0, 1, "Mode");
  this.Len = parameters.addFloat(1. / 480., 2, "Value");
  this.VelocityFrom = parameters.add(Host.Classes.createInstance("Media:VelocityParam"));
  this.VelocityFrom.name = "VelocityFrom";
  this.VelocityFrom.default = 0.2;
  this.Grid = parameters.add(Host.Classes.createInstance("Media:BeatListParamZero"));
  var relative = parameters.addParam ("Relative")
  this.AddValue = parameters.addInteger (-64, 64, "AddValue");
`;

const SKIN = `<Skin>
  <Form name="VelocityDialog" title="Velocity">
    <RadioButton name="Mode" value="0" title="Add"/>
    <RadioButton name="Mode" value="1" title="Multiply"/>
  </Form>
  <Form name="TransposeDialog" title="Transpose">
    <RadioButton name="Mode" value="0" title="Add/Subtract"/>
    <RadioButton name="Mode" value="1" title="Set all to"/>
    <ToolButton name="AddValue" value="12" title="+1 Oct"/>
    <ToolButton name="AddValue" value="12" title="+1 Oct"/>
  </Form>
</Skin>`;

test('parseClassFactory reads script classes', () => {
  assert.deepEqual(parseClassFactory(FACTORY), [
    { classID: '{ABC-1}', subCategory: 'MusicEdit', name: 'Transpose', sourceFile: 'Transpose.js', args: '...' },
    { classID: '{ABC-2}', subCategory: 'MusicEdit', name: 'Velocity', sourceFile: 'Velocity.js', args: null },
  ]);
});

test('parseScriptArgs: kinds, ranges, defaults, names, dialog', () => {
  const r = parseScriptArgs(TRANSPOSE);
  assert.equal(r.dialog, 'TransposeDialog');
  const by = Object.fromEntries(r.args.map((a) => [a.name, a]));
  assert.deepEqual(r.args.map((a) => a.name), ['AddValue', 'SetValue', 'Mode', 'Value', 'VelocityFrom', 'Grid', 'Relative']);
  assert.deepEqual(by.AddValue, { name: 'AddValue', type: 'int', min: -64, max: 64 });
  assert.equal(by.SetValue.default, 60);
  assert.ok(Math.abs(by.Value.min - 1 / 480) < 1e-12);
  assert.deepEqual(by.VelocityFrom, { name: 'VelocityFrom', type: 'velocity', default: 0.2 });
  assert.equal(by.Grid.type, 'beats');
  assert.equal(by.Relative.type, 'bool');
});

test('parseSkinForms scopes choices to each form and de-duplicates', () => {
  const f = parseSkinForms(SKIN);
  assert.deepEqual(f.TransposeDialog.Mode.choices, [{ value: 0, label: 'Add/Subtract' }, { value: 1, label: 'Set all to' }]);
  assert.deepEqual(f.VelocityDialog.Mode.choices.map((c) => c.label), ['Add', 'Multiply']);
  assert.deepEqual(f.TransposeDialog.AddValue.presets, [{ value: 12, label: '+1 Oct' }]);
});

test('schemasFromPackageFiles joins class, script and its own dialog form', () => {
  const files = new Map([
    ['classfactory.xml', Buffer.from(FACTORY)],
    ['Transpose.js', Buffer.from(TRANSPOSE)],
    ['skin.xml', Buffer.from(SKIN)],
  ]);
  const s = schemasFromPackageFiles(files);
  assert.equal(s['{ABC-1}'].task, 'Transpose');
  const mode = s['{ABC-1}'].args.find((a) => a.name === 'Mode');
  assert.deepEqual(mode.choices.map((c) => c.label), ['Add/Subtract', 'Set all to']);
  assert.equal(s['{ABC-2}'], undefined, 'Velocity.js is not in the package');
});

test('extractEditTaskSchemas reads Scripts/*.package and survives a bad one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1cmd-'));
  fs.mkdirSync(path.join(dir, 'Scripts'));
  fs.writeFileSync(path.join(dir, 'Scripts', 'musicedit.package'), buildPackage([
    { name: 'classfactory.xml', data: Buffer.from(FACTORY) },
    { name: 'Transpose.js', data: Buffer.from(TRANSPOSE) },
    { name: 'skin.xml', data: Buffer.from(SKIN) },
  ]));
  fs.writeFileSync(path.join(dir, 'Scripts', 'broken.package'), 'nope');
  const { schemas, warnings } = extractEditTaskSchemas(dir);
  assert.ok(schemas['{ABC-1}']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /broken\.package/);
  assert.deepEqual(extractEditTaskSchemas(path.join(dir, 'nope')), { schemas: {}, warnings: ['no Studio One install found'] });
});

test('hardening: self-closing Form, boolean defaults, __proto__ keys', () => {
  const f = parseSkinForms('<Skin><Form name="A" title="x"/><Form name="B"><RadioButton name="M" value="1" title="One"/></Form><Form name="__proto__"><RadioButton name="__proto__" value="1" title="P"/></Form></Skin>');
  assert.equal(f.A, undefined);
  assert.deepEqual(f.B.M.choices, [{ value: 1, label: 'One' }]);
  assert.equal(({}).choices, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal(Object.prototype.M, undefined);
  const r = parseScriptArgs('this.On = parameters.addParam ("On");\nthis.On.default = true;\nthis.Off = parameters.addParam ("Off");\nthis.Off.value = false;\n');
  assert.equal(r.args[0].default, true);
  assert.equal(r.args[1].default, false);
});
