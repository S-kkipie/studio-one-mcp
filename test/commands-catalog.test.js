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
const fakeCall = (live, calls = []) => async (op, args) => { calls.push(op); if (!live) throw new Error('Studio One is not answering'); return op === 'ping' ? { pong: true } : LIVE; };

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
  assert.deepEqual(calls, ['ping'], 'one quick probe only');
});

test('getCatalog with Studio One down and no cache: macro-only with a warning', async () => {
  const c = await getCatalog(fakeCall(false), { file: tmpFile(), install: null, macroDirs: [] });
  assert.equal(c.live, false);
  assert.match(c.warnings.join(' '), /not running/);
});

test('getCatalog: unwritable cache location yields a warning, not a rejection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1cat-'));
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const c = await getCatalog(fakeCall(true), { file: path.join(blocker, 'commands', 'catalog.json'), install: null, macroDirs: [] });
  assert.equal(c.commands.length, 3);
  assert.match(c.warnings.join(' '), /catalog cache not saved/);
});

test('mergeCatalog skips live entries without category or name', () => {
  const c = mergeCatalog({ live: [{ category: '', name: 'X' }, { category: 'A', name: 'B', arguments: '' }], schemas: {}, examples: {}, install: null, warnings: [] });
  assert.deepEqual(c.commands.map((e) => e.command), ['A/B']);
});

import { pickInstall } from '../src/commands/catalog.js';

const OLD_LIVE = [{ category: 'A', name: 'B' }, { category: 'Transport', name: 'Start' }];
const oldCall = async (op) => (op === 'ping' ? { pong: true } : OLD_LIVE);

test('outdated bridge device: detail false, warning, argsKnown false; rebuilt when the device is updated', async () => {
  const c = mergeCatalog({ live: OLD_LIVE, schemas: {}, examples: {}, install: null, warnings: [] });
  assert.equal(c.detail, false);
  assert.match(c.warnings.join(' '), /bridge device is outdated/);
  assert.ok(c.commands.every((e) => e.argsKnown === false));
  assert.equal(mergeCatalog({ live: LIVE, schemas: {}, examples: {}, install: null, warnings: [] }).detail, true);
  const file = tmpFile();
  await getCatalog(oldCall, { file, install: null, macroDirs: [] });
  const calls = [];
  const c2 = await getCatalog(fakeCall(true, calls), { file, install: null, macroDirs: [] });
  assert.ok(calls.includes('listCommands'), 'detail:false cache is rebuilt');
  assert.equal(c2.detail, true);
});

test('refresh with Studio One down returns the cache with refreshFailed', async () => {
  const file = tmpFile();
  await getCatalog(fakeCall(true), { file, install: null, macroDirs: [] });
  const c = await getCatalog(fakeCall(false), { file, install: null, macroDirs: [], refresh: true });
  assert.equal(c.refreshFailed, true);
  assert.equal(c.commands.length, 3);
  assert.match(c.warnings.join(' '), /refresh failed/);
});

test('concurrent getCatalog calls share one listCommands', async () => {
  const file = tmpFile();
  const calls = [];
  const [a, b] = await Promise.all([getCatalog(fakeCall(true, calls), { file, install: null, macroDirs: [] }), getCatalog(fakeCall(true, calls), { file, install: null, macroDirs: [] })]);
  assert.equal(calls.filter((x) => x === 'listCommands').length, 1);
  assert.equal(a, b);
});

test('pickInstall prefers the highest version', () => {
  assert.equal(pickInstall(['C:\PF\Studio One 6', 'C:\PF\Studio One 7', 'C:\PF\Studio One 5']), 'C:\PF\Studio One 7');
  assert.equal(pickInstall(['C:\PF\Studio One 7', 'C:\PF\Fender\Studio Pro 8']), 'C:\PF\Fender\Studio Pro 8');
  assert.equal(pickInstall([]), null);
});
