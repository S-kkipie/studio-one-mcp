# Command Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search, inspect and run any of Studio One's ~1,429 commands, with validated arguments. This works through 2 new MCP tools plus an extended `live_command` and a `cmd` CLI, not one tool per command.

**Architecture:**
- `src/commands/*` builds a JSON catalog from three sources:
  - the running Studio One (bridge `listCommands {detail:true}`);
  - the edit-task script packages in the install (argument types, ranges, enum labels);
  - the user's macro files (real argument examples).
- The catalog is cached at `~/.studio-one-mcp/commands/catalog.json`.
- Search, schema lookup and argument normalisation are pure functions over that catalog, shared by `server.js` and `cli.js`.

**Tech Stack:** Node ESM (node ≥ 18), `node:zlib`, `node:test`, zod, MCP SDK; device scripts are ES5 (Studio One JS engine).

**Spec:** `docs/superpowers/specs/2026-10-07-command-catalog-design.md`

## Global Constraints

- Device code (`device/StudioOneMCP/*.js`) is ES5 only: `var`, no arrow functions, no template literals, no `let`/`const` inside functions it adds. Match the surrounding style in BridgeCore.js. (The existing file uses `const`/arrows in places; new code may match those methods exactly.)
- Never one MCP tool per command. The new tools are exactly `live_find_command` and `live_command_info`; `live_command` is extended.
- The catalog file is `join(dataDir, 'commands', 'catalog.json')`, with `dataDir` from `src/paths.js`. Catalog `schema: 1`.
- The install dir comes from `studioOneApps()[0]` (`src/paths.js`; `STUDIO_ONE_APP` overrides). Packages live in `<install>/Scripts/*.package`.
- The macro dirs are `~/Documents/Studio One/Macros` and `~/Documents/Studio Pro/Macros`; whichever exist. Env `STUDIO_ONE_MACROS` (path.delimiter-separated) overrides.
- Tests read source files only after `.replace(/\r\n/g, '\n')` (core.autocrlf checkouts).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.
- `npm test` must stay green (currently 403 pass).

## Review Focus

1. **A Spanish query with accents** ("transposición", "cuantizar") must still match. Fold accents and use synonyms. Covered in Task 6 tests.
2. **The same arg name in two forms of one script file** (e.g. `Mode` in TransposeDialog and VelocityDialog live in the same skin) must not take the wrong form's enum labels. Choices are scoped to the form named by that source file's `runDialog("XDialog")`. Covered in Task 2 tests.
3. **Studio One is not running:** `find`/`info` must work from the cache and must not hang for 5 s per call. Use one status probe with a short timeout. Covered in Task 5 tests.
4. **Old flat-array `args` to `live_command`** must keep working unchanged (backward compatibility). Covered in Task 7 tests.
5. **A package that fails to parse** (corrupt or new format) must not break the catalog. It is skipped and noted in `warnings`. Covered in Task 2 tests.

---

### Task 1: Package reader (`src/commands/packages.js`)

**Files:**
- Create: `src/commands/packages.js`
- Test: `test/commands-packages.test.js`

**Interfaces:**
- Produces: `readPackage(buf: Buffer) → Map<string, Buffer>` (file name → uncompressed bytes), and `buildPackage(files: {name, data}[]) → Buffer` (test helper, exported so other tests can make fixtures).

The format, verified on Studio One 7.2.3:
- The file is ASCII `PACKAGEF`, then each file's zlib stream back to back (the first one at offset 8).
- Then comes a directory, which repeats per file:
  - ASCII `File`;
  - u32le type (2);
  - the UTF-16LE name, ended by `00 00`;
  - 9 bytes (a date);
  - u64le offset, u64le compressed size and u64le uncompressed size.
- The tail is a 16-byte id, then u32 0, u32 1, u32 64, and finally `PACKAGEF`.

The reader does not rely on the tail. It scans for `File` + `02 00 00 00` markers after the last stream. Simplest robust approach: scan the whole buffer for the marker, parse the entry, and accept it only if `offset + csize <= buf.length` and the name is non-empty.

- [ ] **Step 1: Write the failing test**

```js
// test/commands-packages.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPackage, buildPackage } from '../src/commands/packages.js';

test('readPackage returns every file by name', () => {
  const buf = buildPackage([
    { name: 'classfactory.xml', data: Buffer.from('<ClassFactory/>') },
    { name: 'Transpose.js', data: Buffer.from('parameters.addInteger (-64, 64, "AddValue");') },
  ]);
  const files = readPackage(buf);
  assert.deepEqual([...files.keys()], ['classfactory.xml', 'Transpose.js']);
  assert.equal(files.get('Transpose.js').toString(), 'parameters.addInteger (-64, 64, "AddValue");');
});

test('readPackage rejects a non-package buffer', () => {
  assert.throws(() => readPackage(Buffer.from('hello world')), /not a Studio One package/);
});

test('readPackage skips an entry whose stream is corrupt', () => {
  const buf = buildPackage([{ name: 'a.js', data: Buffer.from('ok') }, { name: 'b.js', data: Buffer.from('fine') }]);
  buf[8 + 2] ^= 0xff; // damage the first stream's deflate data
  const files = readPackage(buf);
  assert.equal(files.has('a.js'), false);
  assert.equal(files.get('b.js').toString(), 'fine');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/commands-packages.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// src/commands/packages.js
// Studio One's script packages (<install>/Scripts/*.package): "PACKAGEF", the
// files as zlib streams, then a directory: per file "File", u32 type, UTF-16LE
// name ended by 00 00, 9 bytes (date), u64 offset, u64 compressed, u64 size.
import zlib from 'node:zlib';

const MAGIC = Buffer.from('PACKAGEF');
const MARK = Buffer.from([0x46, 0x69, 0x6c, 0x65, 0x02, 0x00, 0x00, 0x00]); // "File" + u32 2

export function readPackage(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(MAGIC)) throw new Error('not a Studio One package');
  const files = new Map();
  let i = 8;
  while ((i = buf.indexOf(MARK, i)) >= 0) {
    let j = i + 8;
    let name = '';
    while (j + 1 < buf.length && buf.readUInt16LE(j) !== 0) { name += String.fromCharCode(buf.readUInt16LE(j)); j += 2; }
    j += 2 + 9;
    if (j + 24 > buf.length) break;
    const offset = Number(buf.readBigUInt64LE(j));
    const csize = Number(buf.readBigUInt64LE(j + 8));
    i = j + 24;
    if (!name || offset < 8 || offset + csize > buf.length) continue;
    try { files.set(name, zlib.inflateSync(buf.subarray(offset, offset + csize))); } catch { /* corrupt entry: skip */ }
  }
  return files;
}

// Builds a package in the same layout (tests and fixtures).
export function buildPackage(files) {
  const streams = [];
  const dir = [];
  let offset = 8;
  for (const f of files) {
    const z = zlib.deflateSync(f.data);
    streams.push(z);
    const name = Buffer.from(f.name + '\0', 'utf16le');
    const nums = Buffer.alloc(24);
    nums.writeBigUInt64LE(BigInt(offset), 0);
    nums.writeBigUInt64LE(BigInt(z.length), 8);
    nums.writeBigUInt64LE(BigInt(f.data.length), 16);
    dir.push(MARK, name, Buffer.from([0xe9, 0x07, 7, 0x1d, 0x12, 0x16, 3, 0, 0]), nums);
    offset += z.length;
  }
  return Buffer.concat([MAGIC, ...streams, ...dir, Buffer.alloc(28), MAGIC]);
}
```

- [ ] **Step 4: Run the tests and check they pass.** Run `node --test test/commands-packages.test.js`. Expected: 3 pass.
- [ ] **Step 5: Smoke-check on the real install** (Windows only, not a test): `node -e "import('./src/commands/packages.js').then(m=>{const f=m.readPackage(require('fs').readFileSync('C:/Program Files/PreSonus/Studio One 7/Scripts/musicedit.package'));console.log([...f.keys()].join(', '))})"` must list `classfactory.xml`, `Transpose.js`, … If the install is missing, skip.
- [ ] **Step 6: Commit.** `git add src/commands/packages.js test/commands-packages.test.js && git commit -m "Commands: read Studio One script packages"` (with trailer).

---

### Task 2: Edit-task argument schemas (`src/commands/schemas.js`)

**Files:**
- Create: `src/commands/schemas.js`
- Test: `test/commands-schemas.test.js`

**Interfaces:**
- Consumes: `readPackage`, `buildPackage` (Task 1).
- Produces:
  - `parseClassFactory(xml: string) → [{ classID, subCategory, name, sourceFile, args: string|null }]`;
  - `parseScriptArgs(js: string) → { args: [{ name, type, min?, max?, default? }], dialog: string|null }`, where `type` is one of `'int' | 'float' | 'bool' | 'string' | 'list' | 'menu' | 'velocity' | 'beats' | 'color' | 'param'`;
  - `parseSkinForms(xml: string) → { [formName]: { [argName]: { choices: [{value:number,label}], presets: [{value,label}] } } }`;
  - `schemasFromPackageFiles(files: Map<string,Buffer>) → { [classIDUpper]: { task: name, subCategory, args: [...] } }`;
  - `extractEditTaskSchemas(installDir) → { schemas, warnings: string[] }`.

Rules:

1. **Class factory.**
   - Parse every `<ScriptClass ...>…</ScriptClass>` and read its attributes with a regex.
   - `args` is the value of `<Attribute id="arguments" value="..."/>`, or null.
   - Uppercase the `classID` (with braces) for joining.
2. **Script args.**
   - Find each `parameters.add<Kind>?(` call (an optional `context.` prefix and whitespace before `(` are allowed), then extract the argument text up to the matching `)` by counting parentheses.
   - The arg **name** is the last string literal in the call (`"AddValue"`).
     - If there is none (a `parameters.add(Host.Classes.createInstance("Media:VelocityParam"))` call), take the assignment target `this.X =` / `_this.X =` / `var x =` just before the call. Then use `X.name = "Name"` if the source has one, else `X` itself.
     - A `Media:` class literal is never a name.
   - **Type** by kind:
     - `addInteger` → int, `addFloat` → float, `addParam` → bool, `addString` → string, `addList` → list, `addMenu` → menu, `addColor` → color;
     - `add` with `Media:VelocityParam` → velocity;
     - `add` with `Media:BeatListParam*` → beats;
     - any other `add` → param.
   - `min` and `max` are the first two numeric expressions for int/float. Evaluate simple literals: `-64`, `0.25`, `1. / 480.` and `+24.`. Allow only `[-+0-9.\s/*]` and evaluate with `Function`. Otherwise use null.
   - **Default:** the assignment target's `X.default = <number>` or `X.value = <number>` (first numeric literal assignment), if present.
   - **Dialog:** the first `runDialog\s*\(\s*"(\w+)"`.
   - De-duplicate args by name, keeping the first.
3. **Skin forms.**
   - For each `<Form name="F" ...>…</Form>`:
     - `<RadioButton name="A" value="V" title="T"/>` → `choices`;
     - `<ToolButton name="A" value="V" title="T"/>` → `presets`.
   - De-duplicate by value.
4. **Join** (`schemasFromPackageFiles`):
   - For each ScriptClass with a sourceFile present in the package, parse that file's args and attach `choices` and `presets` from **that file's dialog form only**.
   - Look up skins in every `*.xml` file in the package except classfactory.xml.
5. **`extractEditTaskSchemas(installDir)`:**
   - For every `<installDir>/Scripts/*.package`, run `readPackage` → `schemasFromPackageFiles` and merge.
   - A thrown error adds `"<file>: <message>"` to warnings.
   - A missing installDir gives `{schemas:{}, warnings:['no Studio One install found']}`.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run them to see them fail.** `node --test test/commands-schemas.test.js`
- [ ] **Step 3: Implement `src/commands/schemas.js`** following the Rules above. Keep the functions pure except `extractEditTaskSchemas`, which uses `fs.existsSync`/`readdirSync`/`readFileSync`. The attribute regex for a tag: `/(\w+)="([^"]*)"/g`. For `parseScriptArgs`, the target-assignment lookback is the text between the previous `;`/newline and the call: `/(?:(?:this|_this)\.(\w+)|var\s+(\w+))\s*=\s*(?:<[^>]*>\s*)?$/`. Output arg objects carry only the keys that are set: no `min: undefined` (the test uses deepEqual).
- [ ] **Step 4: Run the tests and check they pass.**
- [ ] **Step 5: Smoke-check on the real install** (Windows; skip if absent): `node -e "import('./src/commands/schemas.js').then(m=>{const r=m.extractEditTaskSchemas('C:/Program Files/PreSonus/Studio One 7');console.log(Object.keys(r.schemas).length, r.warnings);console.log(JSON.stringify(Object.values(r.schemas).find(s=>s.task==='Transpose'),null,1))})"`. Expected: Transpose with `Mode` choices `Add/Subtract`, `Set all to`, and AddValue -64..64.
- [ ] **Step 6: Commit** "Commands: extract edit-task argument schemas from script packages".

---

### Task 3: Macro examples (`src/commands/macros.js`)

**Files:**
- Create: `src/commands/macros.js`
- Test: `test/commands-macros.test.js`

**Interfaces:**
- Produces:
  - `parseMacro(xml) → { title, steps: [{ command: 'Cat/Name', args: {name: value} }] }`;
  - `readMacroExamples(dirs: string[]) → { [command]: [{ macro: title, args }] }` (at most 5 examples per command; argument-less steps skipped);
  - `macroDirs() → string[]` (honours `STUDIO_ONE_MACROS`).
- Values: numeric strings (`/^-?\d+(\.\d+)?$/`) become numbers; everything else stays a string.
- XML attribute values are unescaped (`&amp; &lt; &gt; &quot; &apos;`).
- Files are read as UTF-8 with the BOM stripped. Unreadable or unparsable files are skipped.

- [ ] **Step 1: Write the failing test**

```js
// test/commands-macros.test.js
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
  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(dir, `m${i}.studioonemacro`), M.replace('+ 5th &amp; more', `m${i}`));
  fs.writeFileSync(path.join(dir, 'bad.studioonemacro'), 'garbage');
  fs.writeFileSync(path.join(dir, 'other.txt'), M);
  const ex = readMacroExamples([dir, path.join(dir, 'missing')]);
  assert.equal(ex['Musical Functions/Transpose'].length, 5);
  assert.deepEqual(ex['Marker/Insert Named'][0].args, { Name: 'Chorus' });
  assert.equal(ex['Edit/Select All'], undefined);
});
```

- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Implement** (regex over `<Macro ...>`, `<CommandElement ...(/>|>…</CommandElement>)`, `<CommandArgument .../>`). Read files in sorted name order so the output is stable.
- [ ] **Step 4: Run the tests and check they pass.**
- [ ] **Step 5: Commit** "Commands: macro files as argument examples".

---

### Task 4: Bridge `listCommands { detail }` (device)

**Files:**
- Modify: `device/StudioOneMCP/BridgeCore.js` (the `listCommands` method, ~line 215)
- Modify: `test/helpers/s1host.js` (fake command entries: add `displayName`, `displayCategory`, `classID` and `arguments` when the test table supplies them; read the helper to see how the table is built)
- Test: `test/core.test.js` (add a test next to `listCommands: all, filtered, and with enabled state`)

**Interfaces:**
- Produces: the bridge op `listCommands { filter?, withState?, detail? }`. With `detail: true` each entry also has `displayCategory`, `displayName`, `classID` (strings, `""` when missing) and `arguments` (string, `""` when missing).
- The filter also matches `displayName` when `detail` is set.

Implementation (inside the existing loop, after `entry` is built):

```js
            if (args.detail) {
                entry.displayCategory = c.displayCategory ? String(c.displayCategory) : "";
                entry.displayName = c.displayName ? String(c.displayName) : "";
                entry.classID = c.classID ? String(c.classID) : "";
                entry.arguments = c.arguments ? String(c.arguments) : "";
            }
```

The filter check moves after this block and matches `(category + " " + name + " " + (displayName || ""))`.

- [ ] **Step 1: Write a failing test** in core.test.js. Give a fake command `displayName: 'Transponer'`, `classID: '{X}'`, `arguments: '...'`, using whatever shape the helper's table accepts, and extend the helper if needed. Assert that `ask('listCommands', { detail: true, filter: 'transponer' }).result` has one entry with those fields. Assert also that without `detail` the entries keep exactly `{category, name}` (the existing test already covers this).
- [ ] **Step 2: Run it to see it fail.** `node --test test/core.test.js`
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run the full suite.** `npm test`: green.
- [ ] **Step 5: Commit** "Bridge: listCommands detail (display names, class IDs, declared arguments)".

---

### Task 5: Catalog build, cache and load (`src/commands/catalog.js`)

**Files:**
- Create: `src/commands/catalog.js`
- Test: `test/commands-catalog.test.js`

**Interfaces:**
- Consumes: `extractEditTaskSchemas` (Task 2), `readMacroExamples`, `macroDirs` (Task 3), bridge `listCommands {detail:true}` (Task 4).
- Produces:
  - `CATALOG_SCHEMA = 1`;
  - `catalogFile()`, which returns `join(dataDir, 'commands', 'catalog.json')`;
  - `mergeCatalog({ live: entry[]|null, schemas, examples, install, warnings }) → catalog`;
  - `getCatalog(call, { refresh = false, now = Date.now(), file = catalogFile(), install = studioOneApps()[0] ?? null, macroDirs: dirs = macroDirs() } = {}) → Promise<catalog>`;
  - `findEntry(catalog, command: string) → entry|null`. Matching is exact, then case-insensitive on `Cat/Name`.

Catalog shape:

```js
{ schema: 1, builtAt: ISOString, install: string|null, live: boolean, warnings: string[],
  commands: [{ command: 'Cat/Name', category, name, displayCategory, displayName,
               variableArgs: boolean, args: [{ name, type, min?, max?, default?, choices?, presets?, examples? }],
               examples: [{ macro, args }] }] }
```

Merge rules:

1. The base list is `live` when non-null. With no live data (`live: null`), only commands seen in macro examples are listed (their category and name come from the `Cat/Name` key, and their display fields are `""`), and the catalog has `live: false`.
2. For each live entry:
   - `arguments === '...'` → `variableArgs: true`, and the schema comes from `schemas[classID.toUpperCase()]`;
   - a comma list → args `[{ name, type: 'unknown' }]` for each trimmed name.
3. Macro examples are attached as `examples`. Any argument name seen in examples but not yet in `args` is added as `{ name, type: 'unknown' }`. For each arg, `examples` holds up to 5 distinct observed values.
4. Commands are sorted by `command`.

`getCatalog`:
- Read the cache file if it exists and has `schema === 1`.
- Use it unless:
  - `refresh` is set, or
  - the cache is older than 24 h, or has `live: false`, and Studio One answers.
- "Studio One answers" means `call('listCommands', { detail: true }, { timeoutMs: 15000 })` resolves. Before that, probe once with `call('status', {}, { timeoutMs: 1500 })`, and if the probe throws, treat Studio One as not running.
- Not running with a cache: return the cache.
- Not running with no cache: build with `live: null` (macro-only), save it, and return it with a warning `'Studio One not running: catalog has only macro commands; it is rebuilt once Studio One answers'`.
- Save with `mkdirSync(..., {recursive:true})`, then write the file atomically (to `.tmp`, then rename).

- [ ] **Step 1: Write the failing tests**

```js
// test/commands-catalog.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeCatalog, getCatalog, findEntry } from '../src/commands/catalog.js';

const LIVE = [
  { category: 'Musical Functions', name: 'Transpose', displayCategory: 'Funciones musicales', displayName: 'Transponer', classID: '{abc-1}', arguments: '...' },
  { category: 'Marker', name: 'Insert Named', displayCategory: 'Marcador', displayName: 'Insertar con nombre', classID: '', arguments: 'Name' },
  { category: 'Transport', name: 'Start', displayCategory: 'Transporte', displayName: 'Iniciar', classID: '', arguments: '' },
];
const SCHEMAS = { '{ABC-1}': { task: 'Transpose', subCategory: 'MusicEdit', args: [{ name: 'Mode', type: 'int', min: 0, max: 1, choices: [{ value: 0, label: 'Add/Subtract' }, { value: 1, label: 'Set all to' }] }, { name: 'AddValue', type: 'int', min: -64, max: 64 }] } };
const EXAMPLES = { 'Musical Functions/Transpose': [{ macro: '+ 5th', args: { Mode: 0, AddValue: 7, Extra: 'x' } }] };

test('mergeCatalog joins live, script schema and macro examples', () => {
  const c = mergeCatalog({ live: LIVE, schemas: SCHEMAS, examples: EXAMPLES, install: 'X', warnings: [] });
  assert.equal(c.live, true);
  assert.deepEqual(c.commands.map((e) => e.command), ['Marker/Insert Named', 'Musical Functions/Transpose', 'Transport/Start']);
  const t = findEntry(c, 'musical functions/transpose');
  assert.equal(t.variableArgs, true);
  assert.equal(t.displayName, 'Transponer');
  assert.deepEqual(t.args.map((a) => a.name), ['Mode', 'AddValue', 'Extra']);
  assert.deepEqual(t.args.find((a) => a.name === 'AddValue').examples, [7]);
  assert.deepEqual(findEntry(c, 'Marker/Insert Named').args, [{ name: 'Name', type: 'unknown' }]);
  assert.equal(findEntry(c, 'Nope/Nope'), null);
});

test('mergeCatalog without live data lists only macro commands', () => {
  const c = mergeCatalog({ live: null, schemas: SCHEMAS, examples: EXAMPLES, install: null, warnings: [] });
  assert.equal(c.live, false);
  assert.deepEqual(c.commands.map((e) => e.command), ['Musical Functions/Transpose']);
});

function tmpFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's1cat-')), 'commands', 'catalog.json'); }
const fakeCall = (live, calls = []) => async (op, args) => { calls.push(op); if (!live) throw new Error('Studio One is not answering'); return op === 'status' ? { ok: true } : LIVE; };

test('getCatalog builds from Studio One, caches, and reuses the cache', async () => {
  const file = tmpFile();
  const calls = [];
  const c1 = await getCatalog(fakeCall(true, calls), { file, install: null, macroDirs: [] });
  assert.equal(c1.commands.length, 3);
  assert.ok(fs.existsSync(file));
  calls.length = 0;
  const c2 = await getCatalog(fakeCall(true, calls), { file, install: null, macroDirs: [] });
  assert.deepEqual(calls, [], 'fresh cache: no bridge calls');
  assert.equal(c2.commands.length, 3);
});

test('getCatalog: stale cache rebuilds only when Studio One answers', async () => {
  const file = tmpFile();
  await getCatalog(fakeCall(true), { file, install: null, macroDirs: [] });
  const later = Date.now() + 25 * 3600e3;
  const calls = [];
  const offline = await getCatalog(fakeCall(false, calls), { file, install: null, macroDirs: [], now: later });
  assert.equal(offline.commands.length, 3, 'old cache still served');
  assert.deepEqual(calls, ['status'], 'one quick probe only');
});

test('getCatalog with Studio One down and no cache: macro-only with a warning', async () => {
  const c = await getCatalog(fakeCall(false), { file: tmpFile(), install: null, macroDirs: [] });
  assert.equal(c.live, false);
  assert.match(c.warnings.join(' '), /not running/);
});
```

- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** `install: null` means: skip `extractEditTaskSchemas`, with no warning. The schemas come from `extractEditTaskSchemas(install)` when `install` is set.
- [ ] **Step 4: Run the tests and check they pass.**
- [ ] **Step 5: Commit** "Commands: catalog merge and cache".

---

### Task 6: Search (`src/commands/search.js`, `src/commands/synonyms.js`)

**Files:**
- Create: `src/commands/search.js`, `src/commands/synonyms.js`
- Test: `test/commands-search.test.js`

**Interfaces:**
- Produces:
  - `fold(s) → string`: lowercase, NFD with combining marks removed, and non-alphanumerics turned into spaces;
  - `searchCommands(catalog, query, { limit = 10 } = {}) → [{ command, displayName, args: string, score }]`;
  - `argSummary(entry) → string`, e.g. `"Mode(Add/Subtract|Set all to), AddValue(-64..64), SetValue(0..127)"`. Types with no range show just the name; booleans show `Name(on|off)`.
- `SYNONYMS` is an object from a folded token to an array of folded tokens. It works both ways: build a lookup where each word maps to its group.

`synonyms.js` must contain at least these groups (folded):

```js
export const SYNONYM_GROUPS = [
  ['transpose', 'transponer', 'transposicion', 'transportar', 'tono', 'semitono', 'octava', 'octave'],
  ['quantize', 'cuantizar', 'cuantizacion', 'cuantiza', 'quantise'],
  ['track', 'pista', 'pistas', 'tracks'],
  ['duplicate', 'duplicar', 'copiar', 'clonar'],
  ['delete', 'borrar', 'eliminar', 'remove', 'quitar'],
  ['velocity', 'velocidad', 'dinamica'],
  ['length', 'duracion', 'largo', 'longitud'],
  ['humanize', 'humanizar'],
  ['mute', 'silenciar', 'mutear', 'enmudecer'],
  ['solo', 'solista'],
  ['split', 'dividir', 'cortar', 'partir'],
  ['merge', 'unir', 'combinar', 'fusionar'],
  ['marker', 'marcador', 'marca'],
  ['loop', 'bucle', 'ciclo'],
  ['zoom', 'acercar', 'alejar', 'ampliar'],
  ['select', 'seleccionar', 'seleccion', 'selection'],
  ['note', 'notes', 'nota', 'notas'],
  ['event', 'events', 'evento', 'eventos', 'clip', 'region', 'parte'],
  ['insert', 'insertar', 'agregar', 'anadir', 'add'],
  ['export', 'exportar', 'render', 'renderizar', 'mixdown', 'bounce'],
  ['record', 'grabar', 'grabacion'],
  ['play', 'start', 'reproducir', 'iniciar', 'tocar'],
  ['stop', 'parar', 'detener'],
  ['undo', 'deshacer'],
  ['redo', 'rehacer'],
  ['save', 'guardar'],
  ['open', 'abrir'],
  ['console', 'mezclador', 'mixer', 'consola'],
  ['tempo', 'bpm', 'velocidad del tema'],
  ['random', 'randomize', 'aleatorio', 'aleatorizar'],
  ['reverse', 'invertir', 'revertir', 'mirror', 'espejo'],
  ['color', 'colour', 'colorear'],
  ['rename', 'renombrar', 'nombre'],
  ['fade', 'fundido'],
  ['normalize', 'normalizar'],
  ['chord', 'acorde', 'acordes', 'chords', 'armonia', 'harmony'],
  ['scale', 'escala'],
];
```

Scoring for each entry, with `q` = the folded query tokens (empty tokens dropped):
- If the folded query equals `fold(entry.command)`, or the raw query equals the command case-insensitively → 100.
- Otherwise, for each token `t`, take `alts = [t, ...synonyms(t)]`. If any alt is a word of the folded name (a word `startsWith(alt)` with `alt.length >= 3`, or equals it) → +3. Do the same for displayName → +3, for the category or displayCategory → +1, and for arg names or choice labels → +1. Each token counts at most once per field.
- If the folded whole query (length ≥ 4) is a substring of the folded name or displayName → +5.
- Drop entries with score 0. Sort by score desc, then by `command.length` asc, then by `command` asc.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and check they pass.**
- [ ] **Step 5: Commit** "Commands: ranked search with Spanish synonyms".

---

### Task 7: Argument normalisation (`src/commands/run.js`)

**Files:**
- Create: `src/commands/run.js`
- Test: `test/commands-run.test.js`

**Interfaces:**
- Consumes: `fold` (Task 6), `findEntry` (Task 5).
- Produces:
  - `splitCommand(s) → { category, name }`. Split on the **first** `/` (names may contain `/`? No, but categories never do). An error if there is no `/`.
  - `normalizeArgs(entry|null, args) → { flat: any[]|undefined, warnings: string[] }`.

Rules:
- `args` undefined → `{ flat: undefined, warnings: [] }`.
- `args` an array → passed through unchanged (legacy flat form).
- `args` a plain object:
  - `entry` null or with no `args` known → flat pairs in insertion order, with the warning `'arguments not checked: no schema for this command'`.
  - Each key is matched against the entry's arg names, first exactly, then case-insensitively. An unknown key throws `Error("unknown argument X for Cat/Name; valid: A, B, C")`.
  - **Values:**
    - **bool:** `true` → 1 and `false` → 0. The strings `'on'`/`'true'`/`'yes'`/`'si'`/`'sí'` → 1, and `'off'`/`'false'`/`'no'` → 0. Numbers pass through.
    - **choices present and value is a string:** match against `fold(label)`, exactly first, then by unique prefix. A match maps to the choice's value. No match throws `Error("Mode must be one of: Add/Subtract (0), Set all to (1)")`.
    - **int/float with a numeric string:** converted to a number.
    - **Range:** a number outside `[min, max]` for int/float throws `Error("AddValue must be between -64 and 64")`.
    - **Everything else** passes through.
  - Output: `flat = [name1, v1, name2, v2, …]`, using the schema's canonical names.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and check they pass.**
- [ ] **Step 5: Commit** "Commands: validate and normalise command arguments".

---

### Task 8: MCP tools (`src/server.js`)

**Files:**
- Modify: `src/server.js`: the `live_command` (~line 726) and `live_list_commands` (~line 738) blocks; add the two new tools right after them.
- Create: `src/commands/tools.js` (handlers, testable without the server)
- Test: `test/commands-tools.test.js`; update `test/server.test.js` (the expected tool-name list gets `live_command_info` and `live_find_command`, kept in the sorted position the list already uses).

**Interfaces:**
- Consumes: `getCatalog`, `findEntry` (Task 5); `searchCommands`, `argSummary` (Task 6); `splitCommand`, `normalizeArgs` (Task 7).
- Produces (in `src/commands/tools.js`):
  - `findCommand(call, { query, limit, with_state, refresh }, opts?) → { results, catalog: { commands, builtAt, live, warnings } }`. With `with_state`, each result gets `enabled` from `call('command', {category, name, checkOnly: true})`. If that throws, `enabled` is omitted and a note is added once.
  - `commandInfo(call, { command }, opts?)`:
    - found → `{ ...entry, argsSummary, enabled? }`;
    - not found → throws `Error("no command X; closest: A, B, C, D, E")`, with the suggestions from `searchCommands(catalog, command, {limit:5})`.
  - `runCommand(call, { command, category, name, args, check_only }, opts?)`:
    - Resolve the category and name from `command` or from the pair; at least one form is required.
    - Look up the entry (the catalog may be missing → entry null).
    - `normalizeArgs`.
    - `call('command', { category, name, checkOnly, args: flat })`.
    - Return `{ command, ...result, warnings? }`. When `executed === false`, add `note: 'not available in the current context (needs a selection or an open editor?)'`.
  - `opts` = `{ getCatalog }` for injecting a fake in tests. It defaults to the real `getCatalog`.

Tool registrations (use the same `server.tool(name, description, shape, guard(...))` style as neighbours):

```js
server.tool(
  'live_find_command',
  'Search Studio One\'s ~1,400 commands (menus, context menus, Musical Functions, audio/track/event edits) in plain English or Spanish, e.g. "transponer una octava", "quantize 16ths", "duplicate track". Returns the best matches as Category/Name with a short argument summary; with_state adds whether each can run right now (many need a selection or open editor). Then use live_command_info for a command\'s full arguments and live_command to run it. The catalog is built from the running Studio One and cached; refresh rebuilds it.',
  { query: z.string(), limit: z.number().int().min(1).max(50).optional(), with_state: z.boolean().optional(), refresh: z.boolean().optional() },
  guard((a) => findCommand(call, a)),
);

server.tool(
  'live_command_info',
  'Full description of one Studio One command (Category/Name from live_find_command): its arguments with type, range, default, named choices (e.g. Mode: Add/Subtract | Set all to) and preset values, real examples from your macros, and whether it can run right now.',
  { command: z.string() },
  guard((a) => commandInfo(call, a)),
);
```

`live_command` becomes:

```js
server.tool(
  'live_command',
  'Run any Studio One command: command "Category/Name" (or category + name), e.g. Transport/Start, Edit/Undo, View/Console, Musical Functions/Transpose. Find names with live_find_command and arguments with live_command_info. args is an object such as {"Mode": "Add/Subtract", "AddValue": 12}: names and named choices are checked against the catalog; arguments you leave out keep the values Studio One last used for that command. A legacy flat [key, value, …] array is also accepted. Most commands act on the current selection (live_select_events / live_select_track). check_only reports whether it is enabled without running it.',
  {
    command: z.string().optional(),
    category: z.string().optional(),
    name: z.string().optional(),
    check_only: z.boolean().optional().describe('Report {enabled} without executing'),
    args: z.union([z.array(z.any()), z.record(z.any())]).optional().describe('Object {Arg: value} (checked) or legacy flat [key, value, …]'),
  },
  guard((a) => runCommand(call, a)),
);
```

`live_list_commands`' description gets the prefix: `'Prefer live_find_command (ranked search with arguments). '`.

- [ ] **Step 1: Write the failing tests** in `test/commands-tools.test.js`, with a fake `call` that records ops and a fake `getCatalog` returning a small catalog (reuse the Transpose entry from Task 7 plus `Transport/Start`). Cover:
  - `findCommand` with `with_state` adds `enabled` (the fake `command` op returns `{enabled: true}`);
  - `commandInfo` for an unknown command throws with "closest:";
  - `runCommand({ command: 'Musical Functions/Transpose', args: { Mode: 'add', AddValue: 12 } })` calls `command` with `{ category: 'Musical Functions', name: 'Transpose', checkOnly: false, args: ['Mode', 0, 'AddValue', 12] }`;
  - `runCommand({ category: 'Transport', name: 'Start' })` works when `getCatalog` throws, so the catalog is optional for running;
  - `executed: false` gets the note.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement `src/commands/tools.js` and the server changes.** In `runCommand`, catch catalog errors (`getCatalog` rejecting → entry null), so running never depends on the catalog.
- [ ] **Step 4: Run `npm test` and check it is green** (server.test.js lists the new tools).
- [ ] **Step 5: Commit** "Tools: live_find_command, live_command_info; live_command takes Category/Name and checked object args".

---

### Task 9: CLI `cmd` (`src/cli.js`, `src/commands/cli.js`)

**Files:**
- Create: `src/commands/cli.js` (`parseCmdArgs(argv) → { sub, words, flags, cmdArgs }`, `runCmd(argv, { call, getCatalog, out }) → exitCode`)
- Modify: `src/cli.js` (add `cmd` to usage and dispatch: `else if (cmd === 'cmd') { const { runCmd } = await import('./commands/cli.js'); const { call } = await import('./bridge.js'); process.exit(await runCmd(rest, { call })); }`)
- Modify: `README.md` (short "Commands" section: the MCP tools and the CLI, 10–20 lines)
- Test: `test/commands-cli.test.js`

**Interfaces:**
- Consumes: `findCommand`, `commandInfo`, `runCommand` (Task 8), `getCatalog` (Task 5).

Behaviour:

```
studio-one-mcp cmd find <words…> [--limit N] [--state] [--json]
studio-one-mcp cmd info <Category/Name> [--json]
studio-one-mcp cmd run <Category/Name> [--Arg value …] [--check] [--json]
studio-one-mcp cmd refresh [--json]
studio-one-mcp cmd help
```

- **Parsing:**
  - Words before the first `--flag` form the query or command. Flags known to the CLI are `--limit`, `--state`, `--json` and `--check`.
  - In `run`, every other `--Name value` pair becomes `cmdArgs[Name] = value` (a string; `run.js` converts it).
  - A `--Name` with no value, or followed by another `--x`, becomes `true`.
- **Text output:**
  - `find` prints one line per result: `Cat/Name — displayName — args`, plus `[enabled]`/`[disabled]` with `--state`.
  - `info` prints the command, then the display name, then one line per arg: `  Name: type min..max (default d) choices: 0=Add/Subtract, 1=Set all to; examples: 7, 12`.
  - `run` prints `executed`/`not executed` and any note or warnings.
  - `refresh` prints `catalog: N commands (live|macro-only), M warnings`.
- **Exit codes:**
  - 0 = OK;
  - 1 = error, printed to stderr as `error: <message>`;
  - 2 = usage error;
  - `run` with `executed: false` → 1.
- `--json` prints the raw result object as JSON.
- `help` or no subcommand prints usage and exits 0 for `help`, 2 otherwise.

- [ ] **Step 1: Write the failing tests:**
  - `parseCmdArgs(['run','Musical','Functions/Transpose','--Mode','Add/Subtract','--AddValue','12','--check'])` → `{ sub:'run', words:['Musical','Functions/Transpose'], flags:{check:true}, cmdArgs:{Mode:'Add/Subtract', AddValue:'12'} }`;
  - `runCmd(['find','transponer'], { call: fake, getCatalog: fakeCat, out })` returns 0 and the output contains `Musical Functions/Transpose`;
  - `runCmd(['run','Nope'], …)` returns 2 (no `/`, usage error from `splitCommand`);
  - `runCmd(['run','Transport/Start'], …)` with the fake call returning `executed:false` returns 1;
  - `--json` output parses as JSON.

  `out` is `{ log: fn, error: fn }`, collected in arrays.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** `runCmd` joins `words` with spaces to form the command, so names with spaces work unquoted.
- [ ] **Step 4: Run `npm test` and check it is green.**
- [ ] **Step 5: Commit** "CLI: studio-one-mcp cmd find|info|run|refresh".

---

### Task 10 (controller, not a subagent): Live verification

- Run `node scripts/install-device.js` (no eval). Restart Studio One, open `mcp-prueba`, and keep it minimized.
- `studio-one-mcp cmd refresh` → ≥ 1,400 commands, live.
- `cmd info "Musical Functions/Transpose"` → Mode choices.
- `cmd find transponer octava` → Transpose in the top 3.
- Select notes in a part (`live_select_events` + the editor), then run `Musical Functions/Transpose {Mode: "Add/Subtract", AddValue: 12}`. Check with `live_notes` that the pitches rose by 12, then `live_undo`.
- Record the results in the ledger.
