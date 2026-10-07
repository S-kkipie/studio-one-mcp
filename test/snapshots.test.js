// live_plugin_snapshot over a fake bridge and a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshot } from '../src/snapshots.js';

function bridge() {
  const racks = { Vox: [{ slot: 0, name: 'Fat Channel' }], Gtr: [{ slot: 0, name: 'Fat Channel' }], Keys: [{ slot: 0, name: 'Pro EQ' }] };
  const values = { Vox: { 'opt.compmodel': 0, 'comp.ratio': 5263, 'comp.threshold': 10000 }, Gtr: { 'opt.compmodel': 1, 'comp.ratio': 100, 'comp.threshold': 10000 } };
  const sets = [];
  const call = async (op, a) => {
    if (op === 'inserts') return [{ channel: a.channel, inserts: racks[a.channel] || [] }];
    if (op === 'pluginParams') return { params: a.names.filter((n) => n in values[a.channel]).map((n) => ({ name: n, value: values[a.channel][n] })) };
    if (op === 'setPluginParam') { sets.push(a.param); values[a.channel][a.param] = a.value; return {}; }
    throw new Error(`unexpected ${op}`);
  };
  return { call, values, sets };
}
const names = () => ({ names: ['comp.ratio', 'comp.threshold', 'opt.compmodel', 'gone'] });

test('save, list, restore onto another instance: only differing params, selectors first', async () => {
  const b = bridge();
  const dir = mkdtempSync(join(tmpdir(), 's1snap-'));
  const saved = await snapshot(b.call, { action: 'save', channel: 'Vox', slot: 0, name: 'Warm Vox' }, { dir, names });
  assert.deepEqual([saved.plugin, saved.params], ['Fat Channel', 3]);
  assert.deepEqual((await snapshot(b.call, { action: 'list' }, { dir })).map((s) => [s.plugin, s.name, s.params]), [['Fat Channel', 'Warm Vox', 3]]);
  const r = await snapshot(b.call, { action: 'restore', channel: 'Gtr', slot: 0, name: 'Warm Vox' }, { dir, names });
  assert.deepEqual([r.changed, r.unchanged], [2, 1]);
  assert.deepEqual(b.sets, ['opt.compmodel', 'comp.ratio']);
  assert.deepEqual(b.values.Gtr, b.values.Vox);
});

test('restore needs a snapshot for that plug-in; save needs known names; slot must hold a plug-in', async () => {
  const b = bridge();
  const dir = mkdtempSync(join(tmpdir(), 's1snap-'));
  await snapshot(b.call, { action: 'save', channel: 'Vox', slot: 0, name: 'A' }, { dir, names });
  await assert.rejects(snapshot(b.call, { action: 'restore', channel: 'Keys', slot: 0, name: 'A' }, { dir, names }), /no snapshot "A" for Pro EQ/);
  await assert.rejects(snapshot(b.call, { action: 'save', channel: 'Keys', slot: 0, name: 'B' }, { dir, names: () => ({ names: [] }) }), /no parameter names known/);
  await assert.rejects(snapshot(b.call, { action: 'save', channel: 'Vox', slot: 4, name: 'C' }, { dir, names }), /no plug-in in slot 4/);
  await assert.rejects(snapshot(b.call, { action: 'save', channel: 'Vox', slot: 0 }, { dir, names }), /needs name/);
});

test('a second instance ("Fat Channel 2") saves and restores under its plug-in name', async () => {
  const b = bridge();
  b.values['Gtr 2'] = { 'opt.compmodel': 1, 'comp.ratio': 100, 'comp.threshold': 10000 };
  const call = async (op, a) => (op === 'inserts' && a.channel === 'Gtr 2'
    ? [{ channel: a.channel, inserts: [{ slot: 0, name: 'Fat Channel 2' }] }]
    : b.call(op, a));
  const dir = mkdtempSync(join(tmpdir(), 's1snap-'));
  const canon = (n) => ({ names: names().names, plugin: n.replace(/\s+\d+$/, '') });
  await snapshot(call, { action: 'save', channel: 'Vox', slot: 0, name: 'Warm Vox' }, { dir, names: canon });
  const r = await snapshot(call, { action: 'restore', channel: 'Gtr 2', slot: 0, name: 'Warm Vox' }, { dir, names: canon });
  assert.equal(r.plugin, 'Fat Channel');
  assert.equal(r.changed, 2);
  const s = await snapshot(call, { action: 'save', channel: 'Gtr 2', slot: 0, name: 'Other' }, { dir, names: canon });
  assert.equal(s.plugin, 'Fat Channel');
});
