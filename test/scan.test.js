import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAll } from '../src/plugins/scan.js';

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
  const root = path.join(base, 'VST3');
  const catalogDir = path.join(base, 'catalog');
  fs.mkdirSync(path.join(root, 'Vendor'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Bundle.vst3', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Alpha.vst3'), 'aaaa');
  fs.writeFileSync(path.join(root, 'Vendor', 'Beta.vst3'), 'bb');
  fs.writeFileSync(path.join(root, 'Contents.vst3.zip'), 'zip');
  fs.writeFileSync(path.join(root, 'Bundle.vst3', 'Contents', 'Inner.vst3'), 'x');
  return { base, root, catalogDir };
}
const okRunner = async ({ path: p }) => ({
  name: path.basename(p, '.vst3'), vendor: 'V', params: [],
  capabilities: { hostParams: false, stateRoundTrip: false, xmlState: false }, stateKeys: {},
});
const entries = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

test('writes one JSON per plug-in (files and bundles, no zips, no nesting in bundles)', async () => {
  const { root, catalogDir } = setup();
  const r = await scanAll({ roots: [root], catalogDir, runner: okRunner });
  assert.deepEqual(entries(catalogDir), ['Alpha.json', 'Beta.json', 'Bundle.json']);
  assert.equal(r.total, 3);
  assert.equal(r.scanned, 3);
  const a = JSON.parse(fs.readFileSync(path.join(catalogDir, 'Alpha.json'), 'utf8'));
  assert.equal(a.name, 'Alpha');
  assert.equal(a.path, path.join(root, 'Alpha.vst3'));
  assert.equal(a.size, 4);
  assert.ok(a.mtimeMs > 0 && a.scannedAt);
});

test('runner crash/timeout is recorded as scanError and scan continues', async () => {
  const { root, catalogDir } = setup();
  const runner = async (args) => {
    if (args.path.endsWith('Alpha.vst3')) throw new Error('timeout after 10ms');
    return okRunner(args);
  };
  const r = await scanAll({ roots: [root], catalogDir, runner });
  assert.equal(r.errors, 1);
  assert.equal(r.scanned, 3);
  const a = JSON.parse(fs.readFileSync(path.join(catalogDir, 'Alpha.json'), 'utf8'));
  assert.match(a.scanError, /timeout/);
  assert.equal(a.name, 'Alpha');
  assert.ok(fs.existsSync(path.join(catalogDir, 'Beta.json')));
});

test('unchanged file is skipped on second run', async () => {
  const { root, catalogDir } = setup();
  await scanAll({ roots: [root], catalogDir, runner: okRunner });
  let calls = 0;
  const r = await scanAll({ roots: [root], catalogDir, runner: async (a) => { calls++; return okRunner(a); } });
  assert.equal(calls, 0);
  assert.equal(r.skipped, 3);
  assert.equal(r.scanned, 0);
});

test('changed mtime is rescanned', async () => {
  const { root, catalogDir } = setup();
  await scanAll({ roots: [root], catalogDir, runner: okRunner });
  const f = path.join(root, 'Alpha.vst3');
  const t = new Date(Date.now() + 60000);
  fs.utimesSync(f, t, t);
  const seen = [];
  const r = await scanAll({ roots: [root], catalogDir, runner: async (a) => { seen.push(path.basename(a.path)); return okRunner(a); } });
  assert.deepEqual(seen, ['Alpha.vst3']);
  assert.equal(r.scanned, 1);
  assert.equal(r.skipped, 2);
});
