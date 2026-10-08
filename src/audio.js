// Audio in the running song: import a file by path, and run Studio One's audio commands
// (transients, Audio Bend quantize, normalize, reverse, merge, Event FX) on one event or
// on every event of an audio track.
//
// Seen on 7.2.3 (2026-10-07):
//  - AudioFunctions.importFile(url, MediaTime, track|null, 0) (the device op importAudio) imports
//    with no dialog. The file is copied into the song's Media folder; with no track a new track
//    named after the file is made, and an empty audio track is renamed after the file.
//  - With the song's "stretch audio files to song tempo" on, Studio One detects a tempo for the
//    file and stretches the clip (an 8 s WAV became 10.1 s at 95 BPM).
//  - The commands in ACTIONS ran with no dialog on a selection. Reverse renders a new file into
//    the song's Bounces folder.
import fs from 'node:fs/promises';
import path from 'node:path';
import { trackTask } from './tracks.js';
import { toSeconds } from './time.js';
import { liveEvents } from './events.js';

const ACTIONS = {
  detect_transients: 'Audio/Detect Transients',
  quantize: 'Event/Quantize',
  quantize_50: 'Event/Quantize 50%',
  apply_bend: 'Audio/Apply Audio Bend',
  remove_bend_markers: 'Audio/Remove Bend Markers',
  normalize: 'Audio/Normalize Audio',
  reverse: 'Audio/Reverse Audio',
  merge: 'Audio/Merge to Audio Part',
  event_fx: 'Audio/Insert Event FX',
  render_event_fx: 'Audio/Render Event FX',
};
export const AUDIO_ACTIONS = Object.keys(ACTIONS);

// Seconds of audio in a RIFF/WAVE file, from its fmt byte rate and data size; null otherwise.
export function wavSeconds(buf) {
  if (!buf || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let byteRate = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 20 <= buf.length) byteRate = buf.readUInt32LE(pos + 16);
    // 0 and 0xFFFFFFFF are what streaming writers leave when the length was unknown.
    if (id === 'data') return byteRate && size > 0 && size < 0xFFFFFFFF ? size / byteRate : null;
    pos += 8 + size + (size % 2);
  }
  return null;
}

async function readHead(file) {
  const h = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await h.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await h.close();
  }
}

async function ensureStopped(call) {
  const song = await call('song');
  if (song.transport?.playing || song.transport?.recording) throw new Error('stop playback first');
  return song;
}

function oneTrack(list, name) {
  const hits = list.filter((t) => t.name === name);
  if (hits.length !== 1) throw new Error(hits.length ? `track name is ambiguous: ${name}` : `no track named ${name}`);
  return hits[0];
}

const round = (x) => Math.round(x * 1000) / 1000;

export async function importAudio(call, { file, track, at } = {}, deps = {}) {
  const fsx = deps.fs ?? fs;
  const head = deps.readHead ?? readHead;
  if (typeof file !== 'string' || !file) throw new Error('file is required (absolute path)');
  if (!path.isAbsolute(file) && !/^[A-Za-z]:[\\/]/.test(file)) throw new Error(`file must be an absolute path: ${file}`);
  let st;
  try { st = await fsx.stat(file); } catch { throw new Error(`no such file: ${file}`); }
  if (!st.isFile()) throw new Error(`not a file: ${file}`);
  await ensureStopped(call);
  const before = await call('tracks', { events: true, maxEvents: 500 });
  if (track !== undefined && oneTrack(before, track).mediaType !== 'Audio') throw new Error(`${track} is not an audio track`);
  const seconds = (await toSeconds(call, at ?? 0)) ?? 0;

  const op = { op: 'importAudio', file: file.replace(/\\/g, '/'), at: seconds };
  if (track !== undefined) op.track = track;
  try {
    await trackTask(call, op, { timeoutMs: 30000 });
  } catch (e) {
    if (/did not answer/.test(String(e.message))) e.message += ' (it may still be importing: check live_tracks before trying again)';
    throw e;
  }

  const after = await call('tracks', { events: true, maxEvents: 500 });
  const key = (t, e) => `${t}|${e.name}|${e.start}`;
  const seen = new Set();
  for (const t of before) for (const e of t.events || []) seen.add(key(t.name, e));
  let hit = null;
  for (const t of after) {
    for (const e of t.events || []) {
      if (seen.has(key(t.name, e))) continue;
      if (!hit || Math.abs(e.start - seconds) < Math.abs(hit.event.start - seconds)) hit = { track: t.name, event: e };
    }
  }
  if (!hit) return { imported: true, file, note: 'imported, but the new clip could not be identified; check live_tracks' };

  const res = { track: hit.track, event: { name: hit.event.name, start: hit.event.start, end: hit.event.end, length: hit.event.length } };
  if (after.filter((t) => t.name === hit.track).length > 1) res.warning = `more than one track is named ${hit.track}: rename one before addressing it by name`;
  if (track === undefined) res.newTrack = !before.some((t) => t.name === hit.track);
  else {
    res.newTrack = false;
    if (hit.track !== track) {
      if (!after.some((t) => t.name === track)) res.renamedFrom = track;
      else res.warning = `the clip landed on ${hit.track}, not on ${track}`;
    }
  }
  if (/\.wave?$/i.test(file)) {
    let secs = null;
    try { secs = wavSeconds(await head(file)); } catch { secs = null; }
    if (secs !== null) {
      res.fileSeconds = round(secs);
      if (typeof hit.event.length === 'number' && Math.abs(hit.event.length - secs) > 0.02 * secs) {
        res.stretched = true;
        res.note = 'Studio One stretched the clip to the song tempo (the song\'s "stretch audio files to song tempo" option, with a tempo it detected for the file). Turn that off in Song Setup, or set the track to not follow tempo, to keep the original length.';
      }
    }
  }
  return res;
}

// Rendering commands on long clips take a while; the bridge's default answer time is 5 s.
const COMMAND_TIMEOUT_MS = 120000;

export async function processAudio(call, { track, action, event: which, plugin, preset, tail } = {}) {
  const event = typeof which === 'string' && /^\d+$/.test(which) ? Number(which) : which;
  const command = ACTIONS[action];
  if (!command) throw new Error(`action must be one of ${AUDIO_ACTIONS.join(', ')}`);
  if (action === 'event_fx' && !plugin) throw new Error('event_fx needs plugin (an effect name from live_plugins)');
  if (tail !== undefined && (typeof tail !== 'number' || !(tail >= 0 && tail <= 30))) throw new Error('tail must be 0 to 30 seconds');
  const song = await ensureStopped(call);
  if (oneTrack(await call('tracks', { events: false }), track).mediaType !== 'Audio') throw new Error(`${track} is not an audio track`);

  const payload = { category: command.split('/')[0], name: command.slice(command.indexOf('/') + 1) };
  let fx = null;
  if (action === 'event_fx') {
    fx = await trackTask(call, { op: 'pluginClass', plugin });
    payload.args = ['mode', 1, 'cid', fx.cls, 'preset', preset ?? '', 'tail', tail ?? 2];
  }
  let r;
  try {
    if (event !== undefined) await trackTask(call, { op: 'selectEvent', track, event });
    else await call('selectEvents', { tracks: [track] });
    try {
      r = await call('command', payload, { timeoutMs: COMMAND_TIMEOUT_MS });
    } catch (e) {
      if (/did not answer/.test(String(e.message))) e.message += ` (${command} may still be running: check live_events before trying again)`;
      throw e;
    }
  } finally {
    try { await call('selectEvents', { none: true }); } catch { /* best effort */ }
    for (const [i, name] of (song.selectedTracks || []).entries()) {
      try { await call('selectTrack', { name, exclusive: i === 0 }); } catch { /* best effort */ }
    }
  }
  if (!r?.executed) throw new Error(`Studio One could not run ${command} on ${event !== undefined ? `event ${event} of ` : ''}${track}`);
  const { events } = await liveEvents(call, { track });
  return { track, action, command, ...(fx ? { plugin: fx.name } : {}), events };
}
