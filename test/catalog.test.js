import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, matchPlugin, findParam, searchCatalog } from '../src/plugins/catalog.js';

const P = (key, name) => ({ key, name, label: '', min: 0, max: 1, default: 0, isBoolean: false, isDiscrete: false });
const entry = (name, extra = {}) => ({ name, vendor: 'V', params: [], capabilities: {}, ...extra });
const cat = (...es) => new Map(es.map((e) => [e.name, e]));

test('loadCatalog reads json files, tolerates bad files and missing dir', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
  fs.writeFileSync(path.join(d, 'A.json'), JSON.stringify(entry('A')));
  fs.writeFileSync(path.join(d, 'bad.json'), '{nope');
  assert.deepEqual([...loadCatalog(d).keys()], ['A']);
  assert.equal(loadCatalog(path.join(d, 'missing')).size, 0);
});

test('matchPlugin strips instance numbers, case-insensitive, then longest prefix', () => {
  const c = cat(entry('Archetype Petrucci X'), entry('Pro'), entry('Pro-Q'));
  assert.equal(matchPlugin(c, 'Archetype Petrucci X 2').name, 'Archetype Petrucci X');
  assert.equal(matchPlugin(c, 'archetype petrucci x 3').name, 'Archetype Petrucci X');
  assert.equal(matchPlugin(c, 'Archetype Petrucci X').name, 'Archetype Petrucci X');
  assert.equal(matchPlugin(c, 'Pro-Q (x64)').name, 'Pro-Q');
  assert.equal(matchPlugin(c, 'Nope'), null);
});

test('findParam: key, exact, case-insensitive, unique substring, ambiguous', () => {
  const e = entry('X', { params: [P('p1', 'Gain'), P('p2', 'Drive Amount'), P('p3', 'Drive Tone')] });
  assert.equal(findParam(e, 'p1').name, 'Gain');
  assert.equal(findParam(e, 'Gain').key, 'p1');
  assert.equal(findParam(e, 'gain').key, 'p1');
  assert.equal(findParam(e, 'amount').key, 'p2');
  assert.equal(findParam(e, 'zzz'), null);
  assert.throws(() => findParam(e, 'drive'), /Drive Amount.*Drive Tone/);
});

test('searchCatalog labels backends and handles scan errors', () => {
  const c = cat(
    entry('Archetype A', { params: [P('a', 'a')], capabilities: { stateRoundTrip: true } }),
    entry('Archetype B', { capabilities: { xmlState: true } }),
    entry('Archetype C'),
    { name: 'Archetype Broken', path: 'x', scanError: 'boom' },
    entry('Other'),
  );
  const r = searchCatalog(c, 'archetype');
  assert.deepEqual(r.map((x) => [x.name, x.backend]), [['Archetype A', 'state'], ['Archetype B', 'state'], ['Archetype Broken', 'unavailable'], ['Archetype C', 'opaque']]);
  assert.equal(r[0].paramCount, 1);
  assert.equal(r[2].scanError, 'boom');
  assert.equal(searchCatalog(c, '').length, 5);
});

test('matchPlugin rejects loose prefixes', () => {
  assert.equal(matchPlugin(cat(entry('Archetype'), entry('Archetype Petrucci X')), 'Archetype Gojira 2'), null);
  assert.equal(matchPlugin(cat(entry('Pro')), 'Program Thing'), null);
  assert.equal(matchPlugin(cat(entry('Pro')), 'Pro-Q 3'), null);
});

test('matchPlugin prefers exact name even when it ends in a number', () => {
  const c = cat(entry('Pro-Q 3'), entry('Pro-Q'));
  assert.equal(matchPlugin(c, 'Pro-Q 3').name, 'Pro-Q 3');
  assert.equal(matchPlugin(c, 'Pro-Q 3 2').name, 'Pro-Q 3');
});
