// Edit groups over a fake bridge and a fake dialog driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listGroups, createGroup, dissolveGroup } from '../src/groups.js';

function bridge({ groups = {}, groupOnCommand = 'beat', enabled = true, dissolveWorks = true } = {}) {
  const g = { ...groups };
  const log = [];
  let selected = [];
  const call = async (op, a = {}, opts = {}) => {
    if (op === 'song') return { transport: { playing: false }, selectedTracks: ['Keys'] };
    if (op === 'trackTask' && a.ops[0].op === 'editGroups') return { results: [{ tracks: ['Kick', 'Snare', 'Keys'].map((name) => ({ name, group: g[name] ?? null })) }] };
    if (op === 'selectTrack') { selected = a.exclusive ? [a.name] : [...selected, a.name]; log.push(`select ${a.name}`); return { selected }; }
    if (op === 'command') {
      const name = `${a.category}/${a.name}`;
      if (a.checkOnly) return { enabled };
      log.push(name);
      if (name === 'Track/Group Selected Tracks') {
        opts.onSent?.();
        await new Promise((r) => setTimeout(r, 5));
        if (groupOnCommand) for (const n of selected) g[n] = groupOnCommand;
        return { executed: true };
      }
      if (name === 'Track/Dissolve Group') { if (dissolveWorks) for (const n of selected) delete g[n]; return { executed: true }; }
    }
    throw new Error(`unexpected ${op}`);
  };
  return { call, log, g };
}
const deps = (over = {}) => ({
  lock: (fn) => fn(),
  studioOnePid: async () => 42,
  windowsSnapshot: async () => ['A1'],
  driveExportDialog: async (o) => ({ ok: true, dialog: { title: 'Añadir Grupo' }, seen: o }),
  ...over,
});

test('listGroups groups tracks by their edit group', async () => {
  const b = bridge({ groups: { Kick: 'Drums', Snare: 'Drums' } });
  assert.deepEqual(await listGroups(b.call), { groups: [{ name: 'Drums', tracks: ['Kick', 'Snare'] }] });
});

test('createGroup selects the tracks, presses OK on the dialog, reports Studio One\'s name, restores the selection', async () => {
  const b = bridge();
  let driven = null;
  const r = await createGroup(b.call, { tracks: ['Kick', 'Snare'] }, deps({ driveExportDialog: async (o) => { driven = o; return { ok: true }; } }));
  assert.equal(r.group, 'beat');
  assert.deepEqual(r.tracks, ['Kick', 'Snare']);
  assert.deepEqual(driven.before, ['A1']);
  assert.equal(driven.pid, 42);
  assert.deepEqual(b.log, ['select Kick', 'select Snare', 'Track/Group Selected Tracks', 'select Keys']);
});

test('createGroup refuses fewer than two tracks, unknown tracks and grouped tracks before any command', async () => {
  const b = bridge({ groups: { Kick: 'Drums' } });
  await assert.rejects(createGroup(b.call, { tracks: ['Snare'] }, deps()), /two or more tracks/);
  await assert.rejects(createGroup(b.call, { tracks: ['Snare', 'Snare'] }, deps()), /duplicates/);
  await assert.rejects(createGroup(b.call, { tracks: ['Snare', 'Nope'] }, deps()), /no track named Nope/);
  await assert.rejects(createGroup(b.call, { tracks: ['Snare', 'Kick'] }, deps()), /Kick is already in group Drums/);
  assert.deepEqual(b.log, []);
});

test('createGroup: no dialog is an error with the selection restored; no group afterwards is an error', async () => {
  const b = bridge();
  await assert.rejects(createGroup(b.call, { tracks: ['Kick', 'Snare'] }, deps({ driveExportDialog: async () => ({ ok: false, reason: 'no dialog' }) })), /dialog did not come up \(no dialog\)/);
  assert.equal(b.log.at(-1), 'select Keys');
  const c = bridge({ groupOnCommand: null });
  await assert.rejects(createGroup(c.call, { tracks: ['Kick', 'Snare'] }, deps()), /did not create a group/);
  const d = bridge({ enabled: false });
  await assert.rejects(createGroup(d.call, { tracks: ['Kick', 'Snare'] }, deps()), /cannot group these tracks/);
});

test('dissolveGroup selects the group\'s tracks, dissolves, verifies; unknown names list the groups', async () => {
  const b = bridge({ groups: { Kick: 'Drums', Snare: 'Drums' } });
  const r = await dissolveGroup(b.call, { group: 'Drums' });
  assert.deepEqual(r, { dissolved: 'Drums', tracks: ['Kick', 'Snare'] });
  assert.deepEqual(b.log, ['select Kick', 'select Snare', 'Track/Dissolve Group', 'select Keys']);
  await assert.rejects(dissolveGroup(bridge({ groups: { Kick: 'Drums' } }).call, { group: 'Vox' }), /no group named Vox; groups: Drums/);
  await assert.rejects(dissolveGroup(bridge({ groups: { Kick: 'Drums' }, dissolveWorks: false }).call, { group: 'Drums' }), /still there/);
  await assert.rejects(dissolveGroup(bridge().call, {}), /needs group/);
});
