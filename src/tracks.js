// Track edits by name: rename and recolour (through the track's mixer channel),
// remove (Song/Remove Track on a selection of one). Seen on 5.5.2:
//  - rename and colour are not on the undo stack: the result carries "before";
//  - Remove Track is one undo step and asked nothing for an empty track;
//  - Track/Group Selected Tracks opens a name dialog, so grouping is not offered.

import { closePluginWindows } from './plugins/windows.js';

const hex = (rgb) => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
export const toArgb = (color) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color));
  if (!m) throw new Error('color must be "#rrggbb"');
  return (0xff000000 | parseInt(m[1], 16)) | 0;
};

async function findTrack(call, name) {
  const tracks = await call('tracks', { name, events: false });
  const hits = tracks.filter((t) => t.name === name);
  if (hits.length !== 1) throw new Error(hits.length ? `track name is ambiguous: ${name}` : `no track named ${name}`);
  return hits[0];
}

async function restoreSelection(call, names) {
  for (const [i, name] of names.entries()) await call('selectTrack', { name, exclusive: i === 0 }).catch(() => {});
}

// A bus (the tracks' outputs are routed into it) or a VCA (controlling them) for
// some tracks, through Track/Add Bus|VCA for Selected Channels: no dialog, one
// undo step (checked on 5.5.2). The track selection is put back.
export async function addBus(call, { tracks, kind = 'bus' }) {
  const cmd = { bus: 'Add Bus for Selected Channels', vca: 'Add VCA for Selected Channels' }[kind];
  if (!cmd) throw new Error('kind must be bus or vca');
  if (!Array.isArray(tracks) || !tracks.length) throw new Error('tracks: one or more track names');
  const chans = [];
  for (const name of tracks) chans.push((await findTrack(call, name)).channel);
  const { selectedTracks } = await call('song');
  const before = new Set((await call('channels')).map((c) => c.label));
  let r;
  try {
    for (const [i, name] of tracks.entries()) await call('selectTrack', { name, exclusive: i === 0 });
    r = await call('command', { category: 'Track', name: cmd });
  } finally {
    await restoreSelection(call, selectedTracks);
  }
  if (!r.executed) throw new Error(`Track/${cmd} did not run`);
  const after = await call('channels');
  const added = after.filter((c) => !before.has(c.label)).map((c) => c.label);
  const routed = after.filter((c) => chans.includes(c.label)).map((c) => ({ channel: c.label, output: c.output }));
  return { kind, added, ...(kind === 'bus' ? { routed } : {}), note: 'One live_undo removes it (and puts the routing back).' };
}

const TASK_BLOCKED = /Track\/MCP Track Edit is not available right now/;

async function trackTaskOnce(call, op, timeoutMs) {
  const { results } = await (timeoutMs ? call('trackTask', { ops: [op] }, { timeoutMs }) : call('trackTask', { ops: [op] }));
  const r = results[0] || {};
  if (r.error) throw new Error(r.error);
  return r;
}

// One operation through the MCP Track Edit task; its error, if any, becomes ours. Studio One
// disables Track Edit tasks while a plug-in window is open or focused: then the plug-in windows are
// closed once and the operation is tried again. `timeoutMs` overrides the bridge's 5 s answer time
// (inserting or removing a plug-in instance can take longer).
export async function trackTask(call, op, { closeWindows = closePluginWindows, timeoutMs } = {}) {
  try {
    return await trackTaskOnce(call, op, timeoutMs);
  } catch (e) {
    if (!TASK_BLOCKED.test(String(e.message))) throw e;
    try {
      await closeWindows();
    } catch {
      e.message += ' (a plug-in window may be open in Studio One and closing it failed: close it and try again)';
      throw e;
    }
    try {
      return await trackTaskOnce(call, op, timeoutMs);
    } catch (e2) {
      if (TASK_BLOCKED.test(String(e2.message))) e2.message += ' (a plug-in window or a dialog may still be open in Studio One: close it and try again)';
      throw e2;
    }
  }
}

export async function trackEdit(call, { track, action, name, color, to, folder, create, numbered, before, after }) {
  const t = await findTrack(call, track);
  switch (action) {
    case 'move': {
      if ((before === undefined) === (after === undefined)) throw new Error('move needs exactly one of before or after (a track name)');
      const r = await trackTask(call, { op: 'moveTrack', track, before, after });
      return { track, ...(before ? { before } : { after }), order: r.order, note: 'One live_undo puts it back.' };
    }
    case 'route': {
      if (!to) throw new Error('route needs to (a bus or output channel name)');
      if (!t.channel) throw new Error(`${track} has no mixer channel to route`);
      const before = (await call('channels')).find((c) => c.label === t.channel)?.output ?? null;
      await trackTask(call, { op: 'route', channel: t.channel, to });
      const after = (await call('channels')).find((c) => c.label === t.channel)?.output ?? null;
      return { track, channel: t.channel, before, after, note: 'Route back to the "before" channel to undo.' };
    }
    case 'folder': {
      if (!folder) throw new Error('folder needs folder (a folder track name)');
      const r = await trackTask(call, { op: 'folder', folder, tracks: [track], create: !!create });
      if (r.missing?.length) throw new Error(`${track} could not be moved`);
      return { track, folder, created: !!r.created, note: 'live_undo reverts it (and the folder, if it was created: one more undo).' };
    }
    case 'renameEvents': {
      if (!name) throw new Error('renameEvents needs name');
      const before = (await call('tracks', { name: track })).find((x) => x.name === track)?.events.map((e) => e.name) ?? [];
      const r = await trackTask(call, { op: 'renameEvents', track, name, numbered: !!numbered });
      return { track, before, after: r.renamed, note: 'live_undo reverts it.' };
    }
    case 'rename': {
      if (!name) throw new Error('rename needs name');
      if (!t.channel) throw new Error(`${track} has no mixer channel to rename through`);
      await call('setChannelLabel', { channel: t.channel, name });
      return { renamed: { before: track, after: (await findTrack(call, name)).name }, note: 'Not on the undo stack: rename back to undo.' };
    }
    case 'color': {
      if (!t.channel) throw new Error(`${track} has no mixer channel to colour through`);
      const before = t.color;
      const r = await call('setChannelColor', { channel: t.channel, argb: toArgb(color) });
      return { track, before, after: hex(r.after), note: 'Not on the undo stack: set the "before" colour to undo.' };
    }
    case 'remove': {
      const { selectedTracks } = await call('song');
      await call('selectTrack', { name: track });
      const r = await call('command', { category: 'Song', name: 'Remove Track' });
      await restoreSelection(call, selectedTracks.filter((n) => n !== track));
      if (!r.executed) throw new Error('Song/Remove Track did not run');
      return { removed: track, trackCount: (await call('song')).trackCount, note: 'live_undo brings it back.' };
    }
    default:
      throw new Error(`unknown action ${action}`);
  }
}

// Adding a plug-in instance (an insert, an instrument, an FX channel) loads the plug-in: the answer can
// take longer than the bridge's usual 5 s, and an answer that times out may still have done it. So these
// calls get INSTANCE_TIMEOUT_MS, and after a thrown call the song is read again before reporting.
const slow = () => ({ timeoutMs: INSTANCE_TIMEOUT_MS });
const lateNote = (e) => `Studio One did not answer in time (${e.message}), but the song shows the change: it was made`;

// An instrument track with a new instance of an instrument (live_plugins with
// kind instrument lists them). One undo step removes both (checked on 5.5.2).
// The instrument's mixer channel (the label live_inserts and live_add_plugin take) is not the track's
// channel label, so it is found as the one channel that is new after the add.
export async function addInstrumentTrack(call, { instrument, name }) {
  const labels = async (opts) => (await (opts ? call('inserts', {}, opts) : call('inserts', {}))).map((c) => c.channel);
  const before = await labels().catch(() => null);
  const freshOf = (after) => {
    const left = [...before];
    return after.filter((l) => {
      const i = left.indexOf(l);
      if (i < 0) return true;
      left.splice(i, 1);
      return false;
    });
  };
  let r;
  let warning;
  let after = null;
  try {
    r = await trackTask(call, { op: 'addInstrumentTrack', instrument, name }, { timeoutMs: INSTANCE_TIMEOUT_MS });
  } catch (e) {
    // The rack decides: exactly one new instrument channel means the track was added.
    after = before ? await labels(slow()).catch(() => null) : null;
    if (!after || freshOf(after).length !== 1) throw e;
    r = { track: null, instrument, channel: null, connected: null };
    warning = `${lateNote(e)}; check the track name with live_tracks`;
  }
  let mixerChannel = null;
  if (before) {
    const fresh = freshOf(after ?? await labels().catch(() => []));
    if (fresh.length === 1) mixerChannel = fresh[0];
  }
  return { track: r.track, instrument: r.instrument, channel: r.channel, mixerChannel, connected: r.connected, ...(warning ? { warning } : {}), note: "mixerChannel is the instrument's channel for live_inserts, live_add_plugin and live_plugin_params; it may be null (the new channel could not be told apart): then find it with live_inserts. One live_undo removes the track and the instrument." };
}

const rackOf = async (call, channel, opts) => {
  const [rack] = await (opts ? call('inserts', { channel }, opts) : call('inserts', { channel }));
  return rack ? rack.inserts : null;
};

// A plug-in on a channel's inserts, through DeviceEditFunctions like Studio One's
// own Insert FX task: unlike the insert folder's own insertDeviceClass, this is
// on the undo stack.
export async function addPlugin(call, { channel, plugin }) {
  const before = await rackOf(call, channel).catch(() => null);
  let r;
  let warning;
  try {
    r = await trackTask(call, { op: 'addPlugin', channel, plugin }, { timeoutMs: INSTANCE_TIMEOUT_MS });
  } catch (e) {
    // Only effects can go on inserts; an instrument name is not found among them.
    if (/^no plug-in named /.test(String(e.message))) {
      const inst = await call('plugins', { kind: 'instrument', filter: plugin }).catch(() => null);
      if (inst?.plugins?.includes(plugin)) throw new Error(`${plugin} is an instrument, not an insert effect: add it with live_add_instrument_track`);
      throw e;
    }
    // The rack decides: one more insert, at the end, means it was added.
    const after = before ? await rackOf(call, channel, slow()).catch(() => null) : null;
    if (!after || after.length !== before.length + 1) throw e;
    r = { added: after[after.length - 1].name };
    warning = lateNote(e);
  }
  const inserts = await rackOf(call, channel);
  return { channel, added: r.added, inserts, ...(warning ? { warning } : {}), note: 'One live_undo removes it.' };
}

// An effect on a channel's sends: Studio One makes an FX channel with the plug-in
// and a send to it. Sending to an existing bus or FX channel is not reachable
// from scripts on 5.5.2, and this did not come off with one undo.
export async function addFxSend(call, { channel, plugin }) {
  const before = new Set((await call('channels')).map((c) => c.label));
  let r;
  let warning;
  let fx;
  try {
    r = await trackTask(call, { op: 'addFxSend', channel, plugin }, { timeoutMs: INSTANCE_TIMEOUT_MS });
  } catch (e) {
    // The mixer decides: a new channel means the FX channel was made.
    const after = await call('channels', {}, slow()).catch(() => null);
    fx = after ? after.filter((c) => !before.has(c.label)).map((c) => c.label) : [];
    if (!fx.length) throw e;
    r = { added: plugin };
    warning = lateNote(e);
  }
  if (!fx) fx = (await call('channels')).filter((c) => !before.has(c.label)).map((c) => c.label);
  const [s] = await call('sends', { channel });
  return { channel, plugin: r.added, fxChannel: fx[0] ?? null, sends: s ? s.sends : [], ...(warning ? { warning } : {}), note: 'Not reliably undone by live_undo: remove the send and FX channel in Studio One, or mute the send with live_set_send.' };
}

// Presets of a plug-in class, insert (a class or one of its presets) at a slot, and
// Remove / Bypass / Edit on a slot, through the MCP Track Edit task.
export async function listPresets(call, cid) {
  return trackTask(call, { op: 'listPresets', cid });
}

// Creating or removing an instance loads or unloads the plug-in: allow it this long to answer.
export const INSTANCE_TIMEOUT_MS = 30000;

export async function insertPreset(call, { channel, cid, preset, position }) {
  return trackTask(call, { op: 'insertPreset', channel, cid, preset, position }, { timeoutMs: INSTANCE_TIMEOUT_MS });
}

// `name` (the slot insertPreset returned, e.g. "FX02") addresses a slot exactly; the FXnn names are in
// creation order, not by position, so `slot` alone is only reliable when nothing was inserted before another.
export async function slotCommand(call, { channel, slot, command, name }) {
  return trackTask(call, { op: 'slotCommand', channel, slot, command, name }, command === 'Remove' ? { timeoutMs: INSTANCE_TIMEOUT_MS } : undefined);
}
