// Edit groups in the running Studio One: list them (each track's channel edit group, read through
// the MCP Track Edit task), create one from tracks, dissolve one.
//
// Seen on 7.2.3 (2026-10-07):
//  - Track/Group Selected Tracks opens a modal name dialog (CCLDialogClass, title localized:
//    "Añadir Grupo"). Enter creates the group with Studio One's default name, the tracks' common
//    name part ("beat" for beat95 and beat95(3)). The name field took no posted keys, and
//    channel.editGroup is read-only, so the name cannot be chosen.
//  - Track/Dissolve Group with the group's tracks selected removes it, with no dialog.
import { trackTask } from './tracks.js';
import { withDialogLock } from './dialoglock.js';
import { windowsSnapshot, driveExportDialog, cancelExportDialogs } from './export/dialog.js';
import { findPid } from './export/export.js';

async function groupsOf(call) {
  const { tracks = [] } = await trackTask(call, { op: 'editGroups' });
  const byName = new Map();
  for (const t of tracks) {
    if (!t.group) continue;
    if (!byName.has(t.group)) byName.set(t.group, []);
    byName.get(t.group).push(t.name);
  }
  return { tracks, groups: [...byName].map(([name, members]) => ({ name, tracks: members })) };
}

async function selectTracks(call, names) {
  for (const [i, name] of names.entries()) await call('selectTrack', { name, exclusive: i === 0 });
}

async function restoreSelection(call, names) {
  for (const [i, name] of (names || []).entries()) {
    try { await call('selectTrack', { name, exclusive: i === 0 }); } catch { /* best effort */ }
  }
}

export async function listGroups(call) {
  return { groups: (await groupsOf(call)).groups };
}

export async function createGroup(call, { tracks } = {}, deps = {}) {
  const d = { lock: withDialogLock, studioOnePid: findPid, windowsSnapshot, driveExportDialog, cancelExportDialogs, lateCancelMs: 10000, ...deps };
  if (!Array.isArray(tracks) || tracks.length < 2) throw new Error('create needs two or more tracks');
  if (new Set(tracks).size !== tracks.length) throw new Error('tracks has duplicates');
  const before = await groupsOf(call);
  for (const name of tracks) {
    const hits = before.tracks.filter((t) => t.name === name);
    if (hits.length !== 1) throw new Error(hits.length ? `track name is ambiguous: ${name}` : `no track named ${name}`);
    if (hits[0].group) throw new Error(`${name} is already in group ${hits[0].group}`);
  }
  const song = await call('song');
  return d.lock(async () => {
    const pid = await d.studioOnePid();
    const winBefore = await d.windowsSnapshot(pid);
    try {
      await selectTracks(call, tracks);
      const check = await call('command', { category: 'Track', name: 'Group Selected Tracks', checkOnly: true });
      if (!check?.enabled) throw new Error('Studio One cannot group these tracks right now');
      const abandon = new AbortController();
      let markSent;
      const sent = new Promise((r) => { markSent = r; });
      const settled = call('command', { category: 'Track', name: 'Group Selected Tracks' }, { timeoutMs: 20000, onSent: () => markSent(), signal: abandon.signal })
        .then((value) => ({ value }), (error) => ({ error }));
      let settledYet = false;
      void settled.then(() => { settledYet = true; });
      const first = await Promise.race([sent.then(() => 'sent'), settled.then(() => 'settled')]);
      if (first !== 'sent') {
        const r = await settled;
        throw r.error ?? new Error('the group command returned before it was sent');
      }
      let pressed;
      try {
        pressed = await d.driveExportDialog({ pid, before: winBefore, timeoutMs: 10000, watchMs: 1500 });
      } catch (e) {
        pressed = { ok: false, reason: e.message || String(e) };
      }
      // Enter may have been pressed before an alert showed up: the group can exist even then.
      if (!pressed.ok && pressed.reason === 'alert') {
        try { if ((await groupsOf(call)).groups.some((g) => tracks.every((n) => g.tracks.includes(n)))) pressed = { ok: true }; } catch { /* bridge busy: the failure path below */ }
      }
      if (!pressed.ok) {
        // The command is in the mailbox: a dialog that opens late gets Escape (never Enter) while the
        // command is pending, up to lateCancelMs; then the command is abandoned.
        const stop = new AbortController();
        const watch = d.cancelExportDialogs({ pid, before: winBefore, timeoutMs: d.lateCancelMs, signal: stop.signal }).catch(() => ({ cancelled: [] }));
        let timer;
        await Promise.race([settled, new Promise((r) => { timer = setTimeout(r, d.lateCancelMs); })]);
        clearTimeout(timer);
        stop.abort();
        abandon.abort();
        const { cancelled = [] } = await watch;
        const late = cancelled.length ? '; a late dialog was cancelled' : '';
        const open = settledYet ? '' : '; a Studio One dialog may still be open: close it';
        throw new Error(`the group name dialog did not come up (${pressed.reason})${late}${open}`);
      }
      const c = await settled;
      if (c.error && !/did not answer/.test(String(c.error.message))) throw c.error;
    } finally {
      await restoreSelection(call, song.selectedTracks);
    }
    const after = await groupsOf(call);
    const made = after.groups.find((g) => tracks.every((n) => g.tracks.includes(n)));
    if (!made) throw new Error('Studio One did not create a group (check live_groups list)');
    return {
      group: made.name,
      tracks: made.tracks,
      note: 'Studio One names the group itself (the tracks\' common name, else Grupo 1 / Group 1\u2026); scripts cannot set the name. live_groups dissolve removes it.',
    };
  });
}

export async function dissolveGroup(call, { group } = {}) {
  if (!group) throw new Error('dissolve needs group (a name from live_groups list)');
  const before = await groupsOf(call);
  const g = before.groups.find((x) => x.name === group);
  if (!g) throw new Error(`no group named ${group}${before.groups.length ? `; groups: ${before.groups.map((x) => x.name).join(', ')}` : ' (there are no groups)'}`);
  const song = await call('song');
  let r;
  try {
    await selectTracks(call, g.tracks);
    r = await call('command', { category: 'Track', name: 'Dissolve Group' });
  } finally {
    await restoreSelection(call, song.selectedTracks);
  }
  if (!r?.executed) throw new Error(`Studio One could not dissolve ${group}`);
  const after = await groupsOf(call);
  if (after.groups.some((x) => x.name === group)) throw new Error(`${group} is still there after Dissolve Group`);
  return { dissolved: group, tracks: g.tracks };
}
