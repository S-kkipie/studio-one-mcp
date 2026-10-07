#!/usr/bin/env node
// studio-one-mcp: MCP server for PreSonus Studio One.
//
// Two kinds of tools:
//  - song_*  read .song files from disk. Always available; reflect the last save.
//  - live_*  talk to a running Studio One through the MCP Bridge device.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readSong, summarizeSong } from './song.js';
import { fileURLToPath } from 'node:url';
import { listSongs, resolveSong, songFolder } from './library.js';
import { bridgeStatus, call } from './bridge.js';
import { midiPort } from './midi.js';
import { arranger, listMacros, runMacro } from './arranger.js';
import { tempo } from './tempo.js';
import { trackEdit, addBus, trackTask, addInstrumentTrack, addFxSend } from './tracks.js';
import { liveEvents } from './events.js';
import { listChords, setChords, extractChords, partsFromChords, clearChords } from './harmony.js';
import { timeSignature } from './signatures.js';
import { writeAutomation } from './automation.js';
import { toSeconds } from './time.js';
import { liveChanges } from './changes.js';
import { recordSetup } from './record.js';
import { snapshot } from './snapshots.js';
import { mixSnapshot } from './mixsnap.js';
import { bounce } from './bounce.js';
import { exportAudio } from './export/export.js';
import { findCommand, commandInfo, runCommand } from './commands/tools.js';
import { diffSongs } from './diff.js';
import { gridBeats } from './grid.js';
import { createPart, writeNotes, writeChords, writeDrums, emptyPartAdd, addsToEmptyPart } from './compose.js';
import { version } from './version.js';
import { defaultCatalogDir } from './plugins/scan.js';
import { loadCatalog, matchPlugin, searchCatalog, entryBackend, stateScaleOf, CATALOG_SCHEMA } from './plugins/catalog.js';
import { getParams, setParams, pluginPresets, addPluginWithPreset, removePlugin, runScan, pluginTarget, instrumentsOverview } from './plugins/controller.js';
import { focusPlugin, closeEditors } from './plugins/windows.js';

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
const guard = (fn) => async (args) => {
  try {
    return json(await fn(args));
  } catch (e) {
    const r = fail(String(e.message || e));
    // Structured error data (e.g. a preset name's candidates) as a second content item, as JSON.
    if (Array.isArray(e?.candidates)) r.content.push({ type: 'text', text: JSON.stringify({ candidates: e.candidates }) });
    return r;
  }
};

// ---- server ---------------------------------------------------------------------

const server = new McpServer({ name: 'studio-one-mcp', version });

server.tool(
  'song_list',
  'List Studio One songs on disk (newest first), from ~/Documents/Studio One/Songs or $STUDIO_ONE_SONGS.',
  { query: z.string().optional().describe('Case-insensitive substring of the song title'), limit: z.number().int().optional() },
  guard((a) => listSongs(a)),
);

server.tool(
  'song_read',
  "Read a Studio One song from its .song file: tempo, time signature, markers, arranger sections, tracks with takes/clips (bar, beat and seconds) and instrument notes, mixer channels with volume/pan/mute/solo, automation mode and plug-in inserts (with each plug-in's saved settings in its own units, for PreSonus plug-ins), automation envelopes that have points, the song notes and channel notes, and media files. Reflects the last save, not unsaved edits. Notes, settings and envelope points are in detail=full.",
  {
    song: z.string().describe('Song title, part of one (newest match wins), or absolute path to a .song file'),
    detail: z.enum(['summary', 'full']).optional().describe('summary (default): one line per track. full: every take and clip.'),
    track: z.string().optional().describe('With detail=full, only include tracks whose name contains this'),
  },
  guard(({ song, detail = 'summary', track }) => {
    const { path, otherMatches } = resolveSong(song);
    const s = readSong(path);
    const out = detail === 'summary' ? summarizeSong(s) : s;
    if (detail !== 'summary' && track) out.tracks = out.tracks.filter((t) => t.name.toLowerCase().includes(track.toLowerCase()));
    if (otherMatches.length) out.otherMatches = otherMatches; // picked the newest; these also matched
    return out;
  }),
);

server.tool(
  'song_history',
  "List a song's autosaves and backups in its History folder (newest first). Each path can be passed to song_read to compare versions.",
  { song: z.string().describe('Song title or .song path') },
  guard(({ song }) => {
    const history = join(songFolder(resolveSong(song).path), 'History');
    if (!existsSync(history)) return [];
    return readdirSync(history)
      .filter((f) => f.endsWith('.song'))
      .map((f) => ({ file: join(history, f), modified: statSync(join(history, f)).mtime.toISOString() }))
      .sort((a, b) => b.modified.localeCompare(a.modified));
  }),
);

server.tool(
  'song_diff',
  "What changed between two saves of a song: tempo, meter, markers, sections, tracks (added, removed, renamed, active take, events, notes), mixer (level, pan, mute, solo, automation mode, output, plug-ins and their saved settings) and automation envelopes. Compares `song` with `against` (default: the newest autosave in the song's History folder), older to newer by file time, so by default it answers \"what have I changed since I saved?\" (or, if the save is newer, since the last autosave). Both take a title or a .song path; paths from song_history work.",
  { song: z.string(), against: z.string().optional() },
  guard(({ song, against }) => {
    const main = resolveSong(song).path;
    let other;
    if (against) other = resolveSong(against).path;
    else {
      const history = join(songFolder(main), 'History');
      const saves = existsSync(history)
        ? readdirSync(history).filter((f) => f.endsWith('.song')).map((f) => join(history, f)).filter((p) => p !== main).sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)
        : [];
      if (!saves.length) throw new Error(`no autosaves to compare ${song} against; pass against`);
      other = saves[0];
    }
    const [from, to] = statSync(other).mtimeMs <= statSync(main).mtimeMs ? [other, main] : [main, other];
    const changes = diffSongs(readSong(from), readSong(to));
    return { from, to, changes: changes.length, diff: changes };
  }),
);

server.tool(
  'plugin_catalog',
  'Offline plug-in catalog (from the scanner). With `plugin`: that plug-in (isInstrument, backend) and its parameters (name, key, label, range in display units, isBoolean, choices for a choice list, settable: false when the scan could not verify how its saved state stores the value). Otherwise: search plug-ins by `query` (name/vendor substring; omit to list all) with isInstrument and backend state/opaque/unavailable.',
  { query: z.string().optional(), plugin: z.string().optional() },
  guard(({ query, plugin }) => {
    const catalog = loadCatalog(defaultCatalogDir());
    if (plugin) {
      const e = matchPlugin(catalog, plugin);
      if (!e) throw new Error(`Plug-in "${plugin}" is not in the catalog (${catalog.size} entries). Use plugin_catalog { query } to search, or run the scanner.`);
      if (e.scanError) return { name: e.name, backend: 'unavailable', scanError: e.scanError };
      const c = e.capabilities ?? {};
      const xml = entryBackend(e) === 'state' && !c.stateRoundTrip;
      return {
        name: e.name, vendor: e.vendor, isInstrument: typeof e.isInstrument === 'boolean' ? e.isInstrument : null, backend: entryBackend(e), capabilities: c,
        ...(e.schema !== CATALOG_SCHEMA ? { note: 'scanned by an older version: run live_plugin_scan' } : {}),
        params: (e.params ?? []).map((p) => ({
          name: p.name, key: p.key, label: p.label || undefined, min: p.min, max: p.max, default: p.default, isBoolean: p.isBoolean,
          ...(p.type === 'choice' && p.choices ? { choices: p.choices } : {}),
          ...(xml ? { settable: !!(e.stateKeys ?? {})[p.key] && !!stateScaleOf(e, p.key) } : {}),
        })),
      };
    }
    return { count: catalog.size, results: searchCatalog(catalog, query) };
  }),
);

server.tool(
  'live_status',
  'Is a running Studio One reachable through the MCP Bridge device? Explains how to fix it if not.',
  {},
  guard(async () => {
    const s = bridgeStatus();
    if (!s.loaded) return { connected: false, ...s };
    try {
      const ping = await call('ping', {}, { timeoutMs: 2500 });
      return { connected: true, midiPort: midiPort(), ping, ...s };
    } catch (e) {
      return { connected: false, error: e.message, ...s };
    }
  }),
);

server.tool(
  'live_channels',
  'List the mixer channels of the song open in Studio One right now, with live volume, pan, mute, solo, record-arm, input monitoring, automation mode, and routing (input and output names; read-only).',
  {},
  guard(() => call('channels')),
);

server.tool(
  'live_set_channel',
  'Change one mixer channel in the running Studio One. Values are Studio One normalised values (volume/pan 0..1, pan 0.5 = centre; mute/solo/recordArmed/monitor 0 or 1). Returns before/after.',
  {
    channel: z.string().describe('Exact channel label as shown in the console'),
    field: z.enum(['volume', 'pan', 'mute', 'solo', 'recordArmed', 'monitor']),
    value: z.number(),
  },
  guard((a) => call('setChannel', a)),
);

server.tool(
  'live_set_automation',
  "Set a mixer channel's automation mode in the running Studio One: off, read, touch, latch or write (live_channels shows each channel's mode). Touch, latch and write record fader and plug-in moves as automation while the song plays. Returns before/after.",
  { channel: z.string(), mode: z.enum(['off', 'read', 'touch', 'latch', 'write']) },
  guard((a) => call('setAutomation', a)),
);

server.tool(
  'live_song',
  'The song open in Studio One right now: title, transport (playing, recording, loop, position, tempo, loop range, precount, preroll), track count and selected tracks. Unlike song_read this includes unsaved changes.',
  {},
  guard(async () => {
    const song = await call('song');
    return { ...song, file: song.fileUrl ? fileURLToPath(song.fileUrl) : null };
  }),
);

server.tool(
  'live_tracks',
  'Tracks of the song open in Studio One right now, with media type, colour, mixer channel, number of takes, selection, and (by default) their events: name, start/end/length in seconds, muted.',
  {
    name: z.string().optional().describe('Only tracks whose name contains this'),
    events: z.boolean().optional().describe('Include events (default true)'),
    max_events: z.number().int().optional().describe('Per track (default 50)'),
  },
  guard(({ name, events, max_events }) => call('tracks', { name, events, maxEvents: max_events })),
);

// Studio One's default note names: middle C (MIDI 60) is C3.
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (p) => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 2}`;

server.tool(
  'live_notes',
  "Notes in an instrument track's parts in the running Studio One, unsaved edits included: pitch (MIDI number and name, middle C = C3 as Studio One shows it by default), velocity 0-127, start/end/length in seconds, and start in quarter-note beats. Read-only.",
  { track: z.string().describe('Exact track name'), max_notes: z.number().int().optional().describe('Default 500') },
  guard(async ({ track, max_notes }) => {
    const r = await call('notes', { track, maxNotes: max_notes });
    for (const p of r.parts) for (const n of p.notes) if (typeof n.pitch === 'number') n.note = noteName(n.pitch);
    return r;
  }),
);

const NOTE_FILTER = z
  .object({
    pitch: z.number().int().optional(),
    pitches: z.array(z.number().int()).optional(),
    from: z.number().optional().describe('Start beat, inclusive'),
    to: z.number().optional().describe('Start beat, exclusive'),
  })
  .optional()
  .describe('Which notes (default: all). Beats as live_notes reports them.');

server.tool(
  'live_edit_notes',
  "Edit the notes of an instrument track's parts in the running Studio One, through the MCP Edit task (installed with the device). Operations run in order: transpose {semitones}, velocity {set 1-127 | add}, move {beats}, length {set beats | scale}, quantize {grid like 1/16, 1/8T (triplet) or 1/8. (dotted), strength 0-1; note starts only, Studio One's own quantize setting is left alone}, delete (needs a filter), add {notes: [{pitch, beat, length, velocity}]}. Each can take a filter (pitch, pitches, from/to beats). Beats are the ones live_notes reports. Returns what each operation touched and the notes afterwards. One live_undo per operation, usually; check with live_notes.",
  {
    track: z.string(),
    ops: z.array(
      z.object({
        op: z.enum(['transpose', 'velocity', 'move', 'length', 'quantize', 'delete', 'add']),
        grid: z.union([z.string(), z.number()]).optional().describe('For quantize: "1/16", "1/8T" (triplet), "1/8." (dotted), or beats'),
        strength: z.number().optional().describe('For quantize: 0..1 (default 1)'),
        filter: NOTE_FILTER,
        semitones: z.number().int().optional(),
        set: z.number().optional(),
        add: z.number().optional(),
        beats: z.number().optional(),
        scale: z.number().optional(),
        notes: z.array(z.object({ pitch: z.number().int(), beat: z.number(), length: z.number(), velocity: z.number().int().optional() })).optional(),
      }),
    ),
  },
  guard(async ({ track, ops }) => {
    if (ops.some((o) => o.op === 'add')) {
      const { parts } = await call('notes', { track, maxNotes: 1 });
      if (!parts || !parts.length) throw new Error(`${track} has no parts; use live_write_notes (it creates one)`);
      const empty = addsToEmptyPart(parts, ops.find((o) => o.op === 'add').notes);
      if (empty) {
        if (ops.length !== 1) throw new Error('the track\'s parts have no notes yet: send the add on its own first (or use live_write_notes), then the other operations');
        const place = emptyPartAdd(parts, ops[0].notes || [], track);
        const r = await trackTask(call, { op: 'addNotes', track, at: place.at, notes: place.notes });
        return { track, applied: [{ op: 'add', count: r.added }], errors: r.errors, note: 'Added through MCP Track Edit (the part had no notes).' };
      }
    }
    const r = await call('editNotes', { track, ops: ops.map((o) => (o.op === 'quantize' ? { ...o, grid: gridBeats(o.grid) } : o)) });
    for (const p of r.parts || []) for (const n of p.notes) if (typeof n.pitch === 'number') n.note = noteName(n.pitch);
    return r;
  }),
);

server.tool(
  'live_select_track',
  'Select a track by exact name in the running Studio One, so that selection-based commands (live_command) act on it. Replaces the selection unless exclusive is false.',
  { name: z.string(), exclusive: z.boolean().optional() },
  guard((a) => call('selectTrack', a)),
);

server.tool(
  'live_transport',
  'Press a transport button in the running Studio One and return the resulting transport state.',
  {
    action: z.enum(['play', 'stop', 'record', 'togglePlay', 'returnToZero', 'rewind', 'forward', 'loopStart', 'loopEnd', 'toggleLoop', 'toggleClick', 'togglePrecount', 'togglePreroll', 'locateSelection']),
  },
  guard((a) => call('transport', a)),
);

server.tool(
  'live_set_transport',
  'Set transport values in the running Studio One: tempo (bpm), playhead position (seconds), loop / precount / preroll on or off. Returns the resulting transport state.',
  {
    tempo: z.number().optional(),
    position_seconds: z.number().optional(),
    position_bars: z.string().optional().describe('Bar position like "9.1.1.0" (bar.beat.sixteenth.tick); alternative to position_seconds'),
    loop: z.boolean().optional(),
    precount: z.boolean().optional(),
    preroll: z.boolean().optional(),
  },
  guard(({ position_seconds, position_bars, ...a }) => call('setTransport', { ...a, positionSeconds: position_seconds, positionBars: position_bars })),
);

// Marker names, live from the marker track (MCP Track Edit task); if the task is
// not there, from the last save by position.
async function markerNames() {
  try {
    return (await trackTask(call, { op: 'markers' })).markers;
  } catch {
    try {
      const { fileUrl } = await call('song');
      return fileUrl && existsSync(fileURLToPath(fileUrl)) ? readSong(fileURLToPath(fileUrl)).markers : [];
    } catch {
      return [];
    }
  }
}

async function liveMarkers(result) {
  const names = await markerNames();
  return {
    ...result,
    markers: result.markers.map((m) => {
      const hit = names.find((x) => Math.abs(x.seconds - m.seconds) < 0.01);
      return { ...m, name: hit ? hit.name : null };
    }),
  };
}

server.tool(
  'live_markers',
  'Markers of the song open in Studio One right now: number, position (seconds and bar display) and name. Briefly moves the playhead to read them and puts it back; refuses while playing. Only markers 1-20 are visible.',
  {},
  guard(async () => liveMarkers(await call('markers'))),
);

server.tool(
  'live_add_marker',
  'Add a marker in the running Studio One at a position (seconds or bars; default: the playhead), optionally named. The playhead is left where it was.',
  { seconds: z.number().optional(), at: z.union([z.number(), z.string()]).optional().describe('Seconds or bars like "9.1.1.0" (instead of seconds)'), name: z.string().optional() },
  guard(async ({ seconds, at, name }) => {
    const where = at !== undefined ? await toSeconds(call, at) : seconds;
    if (!name) return liveMarkers(await call('addMarker', { seconds: where }));
    // Marker/Insert Named takes its name as an argument (no dialog when given).
    const { transport } = await call('song');
    try {
      if (where !== undefined) await call('setTransport', { positionSeconds: where });
      const r = await call('command', { category: 'Marker', name: 'Insert Named', args: ['Name', name] });
      if (!r.executed) throw new Error('Marker/Insert Named did not run');
    } finally {
      await call('setTransport', { positionSeconds: transport.position.seconds });
    }
    return liveMarkers({ added: true, seconds: where ?? transport.position.seconds, name, markers: (await call('markers')).markers });
  }),
);

server.tool(
  'live_rename_marker',
  'Rename a marker in the running Studio One, by number (as live_markers numbers them) or by its current name. One live_undo reverts it.',
  { marker: z.union([z.number().int(), z.string()]), name: z.string() },
  guard(async ({ marker, name }) => {
    const r = await trackTask(call, { op: 'renameMarker', marker, name });
    return { before: r.before, name, markers: await markerNames() };
  }),
);

server.tool(
  'live_delete_marker',
  'Delete a marker in the running Studio One, by number (from live_markers) or by exact position in seconds.',
  { number: z.number().int().optional(), seconds: z.number().optional() },
  guard(async (a) => liveMarkers(await call('deleteMarker', a))),
);

server.tool(
  'live_select_events',
  'Select all events on the named track(s), or on every track, or clear the event selection. Then use live_command for selection-based edits, e.g. Event/Mute Events, Event/Unmute Events, Event/Toggle Mute, Edit/Split at Cursor, Event/Quantize, Event/Transpose Events Up, Track/Activate Next Layer (switch takes), Edit/Undo.',
  {
    track: z.string().optional(),
    tracks: z.array(z.string()).optional(),
    all: z.boolean().optional(),
    none: z.boolean().optional().describe('Deselect all events'),
  },
  guard((a) => call('selectEvents', a)),
);

const TIME = z.union([z.number(), z.string()]).describe('Seconds (number) or a bar position string like "9.1.1.0"');

server.tool(
  'live_set_loop',
  'Set the loop range in the running Studio One (start/end in seconds or as bars like "9.1.1.0"), and optionally turn looping on or off. Returns the transport state.',
  { start: TIME.optional(), end: TIME.optional(), enable: z.boolean().optional() },
  guard((a) => call('setLoop', a)),
);

server.tool(
  'live_takes',
  "A track's takes (layers) in the running Studio One: list them (with their names from the last save), switch to the next/previous take or to take N (goto, 1-based), add an empty take or duplicate the active one (each one live_undo), unpack all takes to separate tracks, or recall a retrospective recording (instrument tracks: what you played while not recording). Returns the number of takes and the names of the clips now playing. Takes do not wrap: next on the last take (or previous on the first) changes nothing.",
  {
    track: z.string(),
    action: z.enum(['list', 'next', 'previous', 'goto', 'add', 'duplicate', 'unpack', 'retrospective']).optional(),
    take: z.number().int().optional().describe('For goto: 1-based take number'),
  },
  guard(async (a) => {
    const r = await call('takes', a);
    if ((a.action || 'list') !== 'list') return r;
    try {
      const { fileUrl } = await call('song');
      const saved = fileUrl && existsSync(fileURLToPath(fileUrl)) ? readSong(fileURLToPath(fileUrl)).tracks.find((t) => t.name === a.track) : null;
      if (saved?.layers) r.saved = { takes: saved.layers.map((l) => l.name), active: saved.layers.findIndex((l) => l.active) + 1 };
    } catch {
      // names are a bonus; the live answer stands without them
    }
    return r;
  }),
);

server.tool(
  'live_save',
  'Save the song open in Studio One (File/Save), or save it as a new version (File/Save New Version) to keep the old one.',
  { new_version: z.boolean().optional() },
  guard(({ new_version }) => call('save', { newVersion: !!new_version })),
);

server.tool(
  'live_undo',
  "Undo the last edit(s) in the running Studio One; returns how many ran (a refused undo counts 0). Check the result rather than counting steps: mixer parameter changes (volume, monitor, plug-in parameters, automation mode...) become undo steps that are recorded late and merge, so an undo can land on one of those instead of the edit you just made. Undo again until your edit is gone.",
  { steps: z.number().int().optional() },
  guard((a) => call('undo', a)),
);

server.tool(
  'live_redo',
  'Redo edit(s) in the running Studio One.',
  { steps: z.number().int().optional() },
  guard((a) => call('redo', a)),
);

server.tool(
  'live_track_state',
  "Toggle a track's arm / monitor / mute / solo, hide it, or duplicate it, by track name; showAll unhides every track. Returns the track's mixer channel afterwards. The track selection is restored. Mute is not on Studio One's undo stack: revert it by toggling again, since live_undo would undo the edit before it.",
  { track: z.string().optional(), action: z.enum(['arm', 'monitor', 'mute', 'solo', 'hide', 'duplicate', 'showAll']) },
  guard((a) => call('trackState', a)),
);

server.tool(
  'live_edit_events',
  'Edit all events on one track in the running Studio One: mute, unmute, toggleMute, quantize, transposeUp/Down (instrument parts), split / trimStart / trimEnd at a time (seconds or bars), merge, delete. Returns the track\'s events afterwards. Use live_undo to revert.',
  {
    track: z.string(),
    action: z.enum(['mute', 'unmute', 'toggleMute', 'quantize', 'transposeUp', 'transposeDown', 'split', 'trimStart', 'trimEnd', 'merge', 'delete']),
    at: TIME.optional().describe('Required for split, trimStart, trimEnd'),
  },
  guard((a) => call('editEvents', a)),
);

server.tool(
  'live_add_track',
  'Add a track to the song open in Studio One: audioMono (default), audioStereo, instrument, folder or automation.',
  { type: z.enum(['audioMono', 'audioStereo', 'instrument', 'folder', 'automation']).optional() },
  guard((a) => call('addTrack', a)),
);

server.tool(
  'live_meters',
  'Peak meters of every mixer channel in dB (-144 = silence). With duration_ms, samples repeatedly (e.g. while playing) and returns the highest peak per channel, plus which channels clipped (above -0.1 dB).',
  { duration_ms: z.number().int().optional() },
  guard(async ({ duration_ms }) => {
    const first = await call('meters');
    if (!duration_ms) return first;
    const peak = new Map(first.map((m) => [m.label, Math.max(m.left ?? -144, m.right ?? -144)]));
    const until = Date.now() + Math.min(duration_ms, 60000);
    while (Date.now() < until) {
      for (const m of await call('meters')) peak.set(m.label, Math.max(peak.get(m.label) ?? -144, m.left ?? -144, m.right ?? -144));
      await new Promise((r) => setTimeout(r, 100));
    }
    const channels = [...peak].map(([label, db]) => ({ label, peakDb: Math.round(db * 10) / 10 }));
    return { durationMs: duration_ms, channels, clipped: channels.filter((c) => c.peakDb > -0.1).map((c) => c.label) };
  }),
);

server.tool(
  'live_inserts',
  'Plug-ins on each mixer channel of the running Studio One (or one channel): slot, plug-in name, bypassed; plus the channel\'s bypass-all switch.',
  { channel: z.string().optional() },
  guard((a) => call('inserts', a)),
);

server.tool(
  'live_plugins',
  'The plug-ins installed in the running Studio One, by name (PreSonus, VST and AU), optionally filtered: audio effects (default; the names live_add_plugin and live_add_send take) or instruments (kind "instrument"; the names live_add_instrument_track takes).',
  { filter: z.string().optional(), kind: z.enum(['effect', 'instrument']).optional() },
  guard((a) => call('plugins', a, { timeoutMs: 10000 })),
);

server.tool(
  'live_add_plugin',
  "Add a plug-in by name (from live_plugins) to a channel's inserts in the running Studio One, optionally loaded with one of its presets (exact name from live_plugin_presets). Returns the channel's inserts afterwards. One live_undo removes it (the add goes through the MCP Track Edit task).",
  {
    channel: z.string().describe('Exact channel label'),
    plugin: z.string().describe('Plug-in name, e.g. "Pro EQ", "Compressor", "Room Reverb"'),
    preset: z.string().optional().describe('Exact preset name from live_plugin_presets'),
  },
  guard((a) => addPluginWithPreset(call, a)),
);

server.tool(
  'live_add_send',
  "Add an effect send to a channel in the running Studio One: Studio One makes a new FX channel with the plug-in (by name, from live_plugins) and a send to it, e.g. a reverb or delay send. Returns the FX channel and the channel's sends (set the level with live_set_send). Sending to an existing bus or FX channel cannot be scripted. Not reliably undone by live_undo, so ask before adding when the user has not clearly asked for it.",
  { channel: z.string().describe('Exact channel label'), plugin: z.string().describe('Effect for the new FX channel, e.g. "Room Reverb", "Analog Delay"') },
  guard((a) => addFxSend(call, a)),
);

server.tool(
  'live_add_instrument_track',
  'Add an instrument track in the running Studio One with a new instance of an instrument (by name, from live_plugins with kind "instrument", e.g. "Mai Tai", "Presence"), optionally named. Returns mixerChannel: the mixer channel of the instrument, the name live_inserts, live_add_plugin and live_plugin_params take (not the track name). mixerChannel may be null when the new channel could not be told apart: then find it with live_inserts. One live_undo removes the track and the instrument.',
  { instrument: z.string(), name: z.string().optional().describe('Track name (default: the instrument name)') },
  guard((a) => addInstrumentTrack(call, a)),
);

const PITCH = z.union([z.number().int(), z.string()]).describe('MIDI number or a name like "C3" (middle C = C3), "Eb4"');

server.tool(
  'live_create_part',
  'Create an empty instrument part on an instrument track in the running Studio One, from bar `bar` for `bars` bars (4/4). The track selection is put back. The undoSteps in the result says how many live_undo steps remove it (the insert, plus one for the position and length when they had to be set).',
  { track: z.string(), bar: z.number().int().describe('1-based bar'), bars: z.number().int().optional().describe('Default 1') },
  guard((a) => createPart(call, a)),
);

server.tool(
  'live_write_notes',
  'Write notes on an instrument track in the running Studio One, starting at bar `bar` (beats relative to that bar, quarter notes, 4/4). Makes a part covering the notes if there is none (create_part: false to refuse); write into an empty area or a part that covers the whole range (a range that overlaps a shorter part is refused). Works on new, empty parts. Pitches as MIDI numbers or names (middle C = C3). Undo with live_undo (check with live_notes); a part it created takes more steps to remove (the partUndoSteps in the result says how many; 0 when no part was made). Read back with live_notes.',
  {
    track: z.string(),
    bar: z.number().int(),
    notes: z.array(z.object({ pitch: PITCH, beat: z.number(), length: z.number(), velocity: z.number().int().optional().describe('1-127, default 100') })),
    create_part: z.boolean().optional(),
  },
  guard(({ create_part, ...a }) => writeNotes(call, { ...a, createPart: create_part ?? true })),
);

server.tool(
  'live_write_chords',
  'Write a chord progression on an instrument track in the running Studio One from bar `bar`. Progression like "Cm7 | Ab | Eb Bb" (| separates bars; several chords in a bar share it) or "C G Am F" (one per bar). Chords: C, Cm, Cdim, Caug, Csus2, Csus4, C6, Cm6, C7, Cmaj7, Cm7, Cm7b5, Cdim7, C9, Cmaj9, Cm9, Cadd9, slash bass C/E. Voicing close|open|drop2, octave of the root (3 = middle C), rhythm sustain|quarters|eighths|arp_up|arp_down. 4/4. Undo with live_undo (check with live_notes); a part it created takes more steps to remove (the partUndoSteps in the result says how many).',
  {
    track: z.string(),
    bar: z.number().int(),
    progression: z.string(),
    bars_per_chord: z.number().int().optional(),
    voicing: z.enum(['close', 'open', 'drop2']).optional(),
    octave: z.number().int().optional(),
    rhythm: z.enum(['sustain', 'quarters', 'eighths', 'arp_up', 'arp_down']).optional(),
    velocity: z.number().int().optional(),
  },
  guard(({ bars_per_chord, ...a }) => writeChords(call, { ...a, barsPerChord: bars_per_chord })),
);

server.tool('live_chords',
  "The running song's chord track: chord names (as Studio One shows them) with start and end in seconds, in time order. from / to (seconds or bars like \"5.1.1.0\") limit it to chords overlapping that range.",
  { from: z.union([z.number(), z.string()]).optional(), to: z.union([z.number(), z.string()]).optional() },
  guard((a) => listChords(call, a)));
server.tool('live_set_chords',
  "Write a chord progression onto the chord track from a bar, e.g. \"G D Em C\" (one chord per bar) or \"Cm7 | Ab | Eb Bb\" (| separates bars). Studio One names the chords itself (it works them out from notes drawn on a temporary track that is removed again), so the result lists what the chord track now shows and any mismatch. replace (default true) first removes chord events overlapping the range. Assumes 4/4. Several undo steps: to take it back, use live_clear_chords on the range.",
  { bar: z.number().int().min(1), progression: z.string(), bars_per_chord: z.number().int().min(1).optional(), replace: z.boolean().optional() },
  guard((a) => setChords(call, { bar: a.bar, progression: a.progression, barsPerChord: a.bars_per_chord, replace: a.replace })));
server.tool('live_extract_chords',
  "Detect the chords in a track (instrument parts, or audio through Studio One's chord detection) and write them to the chord track (Event/Extract to Chord Track on all its events). One live_undo reverts it. Returns the chord track afterwards.",
  { track: z.string() },
  guard((a) => extractChords(call, a)));
server.tool('live_parts_from_chords',
  "Fill an instrument track with parts made from the chord track (one part per chord, close voicings), as Studio One's Insert Instrument Parts from Chord Track does. One live_undo reverts it. Returns the parts added.",
  { track: z.string() },
  guard((a) => partsFromChords(call, a)));
server.tool('live_clear_chords',
  "Remove chord track events overlapping from..to (seconds or bars), or all of them. One live_undo reverts it.",
  { from: z.union([z.number(), z.string()]).optional(), to: z.union([z.number(), z.string()]).optional() },
  guard((a) => clearChords(call, a)));

server.tool(
  'live_write_drums',
  'Write a drum pattern on an instrument track (a drum instrument such as Impact) in the running Studio One from bar `bar`, repeated for `bars` bars. One string per lane: x = hit, X = accent, . = rest, spaces and | ignored; 16 steps = one bar of 16ths by default. Lanes (General MIDI): kick, rim, snare, clap, closed_hat (hat), pedal_hat, open_hat, low_tom, mid_tom, high_tom, crash, ride, or a MIDI note number. Example: { kick: "x...x...x...x...", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." }. 4/4. Undo with live_undo (check with live_notes); a part it created takes more steps to remove (the partUndoSteps in the result says how many).',
  {
    track: z.string(),
    bar: z.number().int(),
    bars: z.number().int().optional(),
    pattern: z.record(z.string(), z.string()),
    steps_per_beat: z.number().int().optional(),
    velocity: z.number().int().optional(),
  },
  guard(({ steps_per_beat, ...a }) => writeDrums(call, { ...a, stepsPerBeat: steps_per_beat })),
);

server.tool(
  'live_bypass_insert',
  'Bypass or un-bypass one plug-in slot on a channel in the running Studio One (slot number from live_inserts), or the whole insert rack with slot "all".',
  { channel: z.string(), slot: z.union([z.number().int(), z.literal('all')]), bypassed: z.boolean() },
  guard((a) => call('setInsertBypass', a)),
);

server.tool(
  'live_sends',
  'Sends on each mixer channel of the running Studio One (or one channel): destination, level (0..1, Studio One normalised) and mute.',
  { channel: z.string().optional() },
  guard((a) => call('sends', a)),
);

server.tool(
  'live_set_send',
  'Set a send level (0..1) and/or mute on a channel in the running Studio One (index from live_sends).',
  { channel: z.string(), index: z.number().int(), level: z.number().optional(), muted: z.boolean().optional() },
  guard((a) => call('setSend', a)),
);

const PLUGIN_NOTE = 'Third-party plug-ins (state backend) are not realtime (a few seconds per call; batch changes). On Windows a read exports the plug-in\'s state through its own Export Preset and a change loads the edited state back through Load Preset File, in place: same instance, slot and bypass, and the song is NOT saved (Studio One\'s preset dialog flashes briefly). It is read-modify-write: a knob turned in the plug-in window during those seconds is overwritten. The result has inPlace: true, and unconfirmed lists changes that did not read back as asked. live_undo does not revert such a change (the load is not an undo step; an undo lands on an earlier edit): set the previous values instead. On other systems a read saves the song (File/Save) and reads the slot from it, and a change saves the song too and replaces the plug-in with a new instance carrying the new settings (same slot and bypass); do NOT use live_undo to revert that: it brings the old instance back next to the new one. Their values are in the units live_plugin_params shows (e.g. 0..100 %), converted to and from the saved state by the scan; a parameter whose conversion the scan could not verify shows value null with unverified: true and cannot be set. A preset load (live_plugin_presets) is in place on Windows when the preset file is found, otherwise (inserts only) it replaces the plug-in with a new instance: either way do NOT use live_undo to revert it; load the previous preset instead. Instruments (live_instruments) take instrument instead of channel + slot. Plug-ins that hide their parameters from hosts (backend opaque) only support presets (live_plugin_presets). After installing plug-ins run live_plugin_scan (it needs `npm run scan:setup` once).';

// The plug-in a tool addresses: an insert (channel + slot) or an instrument, exactly one of them.
const TARGET = {
  channel: z.string().optional().describe('Channel label (with slot): a plug-in on the inserts, from live_inserts'),
  slot: z.number().int().optional().describe('Insert slot (with channel), from live_inserts'),
  instrument: z.string().optional().describe('Instead of channel + slot: an instrument, by name or component (InstNN) from live_instruments'),
};
const targeted = (shape, { optional = false } = {}) => z.object({ ...TARGET, ...shape }).superRefine((a, ctx) => {
  try { pluginTarget(a, { optional }); } catch (e) { ctx.addIssue({ code: 'custom', message: e.message }); }
});

server.registerTool(
  'live_instruments',
  {
    description: "The song's instruments in the running Studio One: instrument (the name live_plugin_params, live_set_plugin_param, live_plugin_presets and live_plugin_window take), component (Inst01…, also accepted), backend (native for PreSonus instruments; state or opaque for third-party ones, as for inserts), classId, and the instrument tracks that play each one. Tracks are mapped from the song's last save (best effort): tracks added or rerouted since then are listed in unmappedTracks.",
    inputSchema: {},
  },
  guard(() => instrumentsOverview(call)),
);

server.registerTool(
  'live_plugin_params',
  {
    description: `Parameters of one plug-in in the running Studio One: an insert (channel + slot from live_inserts) or an instrument (instrument, from live_instruments), with backend (native, state or opaque) and realtime. Native (PreSonus plug-ins and instruments): name, value, display text (e.g. "2.0:1", "-12.0 dB"), range and normalised value, live; names come from their presets and Studio One's remote-control map (instruments have dotted names such as filter.cutoff or masterGain.gain). State (scanned third-party plug-ins): name, key, value in the parameter's display units, label, range (choices for a choice list, whose value is its index). ${PLUGIN_NOTE} To read names Studio One answers to directly, pass them in \`params\`.`,
    inputSchema: targeted({
      filter: z.string().optional().describe('Only parameters whose name (or key) contains this (e.g. "comp", "gain")'),
      params: z.array(z.string()).optional().describe('Exact native parameter names to read instead of the discovered ones'),
    }),
  },
  guard((a) => getParams(call, a)),
);

const PARAM_VALUE = z.union([z.string(), z.number(), z.boolean(), z.object({ normalized: z.number() })]);

server.registerTool(
  'live_set_plugin_param',
  {
    description: `Set parameters of one plug-in in the running Studio One: an insert (channel + slot) or an instrument (instrument, from live_instruments); names or keys from live_plugin_params. One parameter: param plus exactly one of text (as displayed, e.g. "4.0:1", "-12 dB", "Standard"; for third-party plug-ins the value in the units live_plugin_params shows, e.g. "6 dB" or "50 %", and on/off/true/false for on/off parameters only; a choice such as an amp type is its index, as live_plugin_params shows it), normalized (0..1; PreSonus plug-ins only) or value (raw, within min..max). Several at once: changes { name: value } where value is text, a number (raw), a boolean or { normalized } (PreSonus only); for third-party plug-ins a batch is one round-trip, so batch changes. Native results have before/after (set the "before" value to revert); state results list applied and missing. ${PLUGIN_NOTE}`,
    inputSchema: targeted({
      param: z.string().optional(),
      text: z.string().optional(),
      normalized: z.number().optional(),
      value: z.number().optional(),
      changes: z.record(z.string(), PARAM_VALUE).optional().describe('Several parameters at once: { name or key: value }'),
    }),
  },
  guard(({ channel, slot, instrument, param, text, normalized, value, changes }) => {
    const target = pluginTarget({ channel, slot, instrument });
    const given = [text, normalized, value].filter((v) => v !== undefined).length;
    if (changes) {
      if (param !== undefined || given) throw new Error('give either changes, or param with one of text, normalized or value');
      return setParams(call, { ...target, changes });
    }
    if (param === undefined) throw new Error('give param (with one of text, normalized or value) or changes');
    if (given !== 1) throw new Error('give exactly one of text, normalized or value');
    const v = text !== undefined ? text : normalized !== undefined ? { normalized } : value;
    return setParams(call, { ...target, changes: { [param]: v } });
  }),
);

server.registerTool(
  'live_plugin_presets',
  {
    description: "Presets Studio One has indexed for a plug-in: list for an insert (channel + slot), an instrument (instrument, from live_instruments) or a plug-in by name (plugin); load onto an insert or an instrument. On Windows a load finds the preset's file (Studio One's Presets folders, Documents/Studio One/Presets, VST3 preset folders) and loads it in place through the plug-in's own Load Preset File: same instance, slot and bypass, the song is not saved, Studio One's preset dialog flashes briefly (inPlace: true). An instrument only ever gets its synth's part of a preset: its channel's inserts stay as they are. The user's preset folders win over factory ones; a name with several files takes the one directly in the plug-in folder when there is exactly one, else it is refused with the candidates (Folder/Name picks one; ./Name is the file directly in the plug-in folder). list: names that stand for several files are listed as their Folder/Name spellings, with an ambiguous map; instrument names without a preset file in the scanned folders cannot be loaded in place. A Folder/Name whose folder holds no such preset is refused. A file from a subfolder of a plug-in's preset folder can be a whole-plug-in preset (a Fat Channel module preset such as Compressor FET/Bass sets the gate and EQ too): the load then carries a warning. If no file is found, an insert is replaced by a new instance made from the preset at the same position (bypass kept; inPlace: false), and an instrument load fails. Do NOT use live_undo to revert a preset load (an in-place load is not an undo step; after a replace it would bring the old instance back next to the new one): load the previous preset instead. To add a new plug-in with a preset, use live_add_plugin with preset.",
    inputSchema: targeted({
      action: z.enum(['list', 'load']),
      plugin: z.string().optional().describe('For list without a target: plug-in name as in live_plugins'),
      preset: z.string().optional().describe('For load: exact preset name from list; Folder/Name (or ./Name) when the load says several files share the name'),
    }, { optional: true }),
  },
  guard((a) => pluginPresets(call, a)),
);

server.tool(
  'live_remove_plugin',
  "Remove the plug-in in one insert slot of a channel (slot from live_inserts) in the running Studio One. Plug-in windows of that channel are closed first. Returns the channel's inserts afterwards; one live_undo brings the plug-in back with its settings. Ask before removing when the user has not clearly asked for it.",
  { channel: z.string(), slot: z.number().int() },
  guard((a) => removePlugin(call, a)),
);

server.tool(
  'live_plugin_window',
  "Open the editor window of a plug-in (an insert: channel + slot; or an instrument: instrument; it gets the focus only when Studio One is not minimized), or close plug-in editor windows: closeAll closes every insert window and instrument editor, only one channel's insert windows with channel, or only one instrument's editor with instrument. Studio One may refuse track edits while a plug-in window is open; the track-edit retry closes plug-in and instrument editor windows on its own, so closeAll is for tidying up. Closing works on Windows only.",
  { action: z.enum(['open', 'closeAll']), channel: TARGET.channel, slot: TARGET.slot, instrument: TARGET.instrument },
  guard(async ({ action, channel, slot, instrument }) => {
    if (action === 'open') {
      if (instrument === undefined && (channel === undefined || slot === undefined)) throw new Error('open needs channel and slot, or instrument');
      return focusPlugin(call, pluginTarget({ channel, slot, instrument }));
    }
    if (instrument !== undefined && channel !== undefined) throw new Error('closeAll takes channel (its insert windows) or instrument (its editor), not both');
    if (process.platform !== 'win32') return { closed: [], note: 'closing plug-in windows is only supported on Windows' };
    return { closed: await closeEditors(call, { channel, instrument }) };
  }),
);

server.tool(
  'live_plugin_scan',
  '(Re)scan the installed VST3 plug-ins into the plug-in catalog used by live_plugin_params, live_set_plugin_param and plugin_catalog. Only new or changed plug-ins are scanned, each in its own process with a timeout, so a first scan can take minutes and later ones are quick. Run it after installing plug-ins. It needs the scanner\'s Python environment, set up once with `npm run scan:setup` in the studio-one-mcp folder. Returns counts, plug-ins per backend (state, opaque, unavailable) and what was scanned now.',
  {},
  guard(() => runScan()),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.tool(
  'live_record',
  'Record in the running Studio One. This writes a new take into the song, so it only runs with confirm: true, which should mean the user asked for it. Optionally arms a track first, starts from a position (seconds or bars), sets precount, and stops after `seconds`; without `seconds` it keeps recording until live_transport stop.',
  {
    confirm: z.literal(true).describe('Must be true: the user asked to record'),
    track: z.string().optional().describe('Arm this track first (left armed afterwards)'),
    from: TIME.optional(),
    precount: z.boolean().optional(),
    seconds: z.number().optional().describe('Stop after this many seconds (max 600)'),
  },
  guard(async ({ track, from, precount, seconds }) => {
    if (seconds !== undefined && (seconds <= 0 || seconds > 600)) throw new Error('seconds must be 0-600');
    const song = await call('song');
    if (song.transport.playing || song.transport.recording) throw new Error('Studio One is already playing or recording; stop first');
    let armed = null;
    if (track) {
      const t = (await call('tracks', { name: track, events: false })).find((x) => x.name === track);
      if (!t) throw new Error(`no track named ${track}`);
      const ch = (await call('channels')).find((c) => c.label === t.channel);
      if (ch && !ch.recordArmed) await call('trackState', { track, action: 'arm' });
      armed = track;
    }
    const setup = {};
    if (typeof from === 'number') setup.positionSeconds = from;
    if (typeof from === 'string') setup.positionBars = from;
    if (precount !== undefined) setup.precount = precount;
    if (Object.keys(setup).length) await call('setTransport', setup);
    const started = await call('transport', { action: 'record' });
    if (seconds === undefined) return { recording: true, armed, transport: started.transport, note: 'Call live_transport with action "stop" to finish.' };
    await sleep(seconds * 1000);
    const stopped = await call('transport', { action: 'stop' });
    const after = armed ? (await call('tracks', { name: armed })).find((x) => x.name === armed) : null;
    return { recorded: seconds, armed, transport: stopped.transport, track: after };
  }),
);

server.tool(
  'live_command',
  'Run any Studio One command: command "Category/Name" (or category + name), e.g. Transport/Start, Edit/Undo, View/Console, Musical Functions/Transpose. Find names with live_find_command and arguments with live_command_info. args is an object such as {"Mode": "Add/Subtract", "AddValue": 12}: names and named choices are checked against the catalog; arguments you leave out keep the values Studio One last used for that command. A legacy flat [key, value, …] array is also accepted. Most commands act on the current selection (live_select_events / live_select_track). check_only reports whether it is enabled without running it.',
  {
    command: z.string().optional(),
    category: z.string().optional(),
    name: z.string().optional(),
    check_only: z.boolean().optional().describe('Report {enabled} without executing'),
    args: z.union([z.array(z.any()), z.record(z.string(), z.any())]).optional().describe('Object {Arg: value} (checked) or legacy flat [key, value, …]'),
  },
  guard((a) => runCommand(call, a)),
);

server.tool(
  'live_list_commands',
  'Prefer live_find_command (ranked search with arguments). List Studio One commands available to live_command (about 1,400), optionally filtered by a substring. with_state adds whether each is enabled right now; many need a selection or an open editor.',
  { filter: z.string().optional(), with_state: z.boolean().optional() },
  guard(({ filter, with_state }) => call('listCommands', { filter, withState: !!with_state }, { timeoutMs: 15000 })),
);

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

server.tool(
  'live_tempo',
  "Tempo map of the running Studio One (stopped). at: tempo at one or more positions. set: change the tempo of the segment containing a position (default: the playhead). insert: add a tempo change at a position with its bpm. Removing one needs live_undo (usually two steps), and Studio One has refused an undo right after a tempo edit, so check with action at afterwards; setting a segment back is exact. Positions are seconds or bars like \"9.1.1.0\"; the playhead is put back. For the whole saved map, and time signatures, use song_read.",
  {
    action: z.enum(['at', 'set', 'insert']),
    at: z.union([TIME, z.array(TIME)]).optional(),
    bpm: z.number().optional(),
  },
  guard((a) => tempo(call, a)),
);

server.tool(
  'live_bounce',
  "Bounce all events on one track in the running Studio One: inPlace renders them into a single new event (with plug-ins), toNewTrack renders them onto a new track of the same name and mutes the originals. No dialogs; one live_undo reverts it, but the rendered .wav stays in the song's Bounces folder. Exporting a mixdown or stems is not offered: those open dialogs.",
  { track: z.string(), mode: z.enum(['inPlace', 'toNewTrack']).optional() },
  guard((a) => bounce(call, a)),
);

server.tool(
  'live_export',
  "Export the running song's mixdown or stems to audio files through Studio One's own export (offline render; the export dialog flashes briefly; Windows only). kind mixdown|stems; range loop (between the loop locators), song (song start/end markers) or markers (one file per marker range); formats from wav, aif, flac, caf, m4a, ogg, opus, mp3 (mixdown: one or more, all exported; stems: one). Options you leave out keep what the dialog last used, and your export settings are put back afterwards. Stems include the channels ticked in Studio One's stems dialog (all by default; Studio One remembers that per song). Sample rate and bit depth are the dialog's last choice for that format. Files land in the song's Mixdown/Stems folder (existing files are never overwritten: Studio One adds (2)), or are moved to output (a folder, or a file path for a single mixdown). Returns the file paths and sizes. The song must have been saved once. Other Studio One tools wait while an export runs; realtime makes a stems export take as long as the range plays (raise timeout_s for long songs); import_to_track adds the exported audio to the song as a new track.",
  {
    kind: z.enum(['mixdown', 'stems']),
    range: z.enum(['loop', 'song', 'markers']).optional(),
    formats: z.array(z.string()).optional(),
    import_to_track: z.boolean().optional().describe('Import the exported file(s) back into the song: this adds a track to the song.'),
    skip_master_fx: z.boolean().optional().describe("Export before the main bus's insert effects (Studio One's pre-master-FX option)."),
    write_tempo: z.boolean().optional().describe("Write the song tempo into the audio file's metadata."),
    split_mono: z.boolean().optional().describe('Stems only: split stereo channels into two mono files.'),
    realtime: z.boolean().optional().describe('Stems only: render in real time; the export then takes as long as the range plays, so raise timeout_s for long songs.'),
    output: z.string().optional().describe('Absolute path: a folder to move the files into, or a file path (its extension must match the format) for a single mixdown.'),
    timeout_s: z.number().min(10).max(3600).optional().describe('How long the render may take, in seconds (default 600).'),
  },
  guard((a) => exportAudio(call, a)),
);

server.tool(
  'live_mix_snapshot',
  "Save the whole mix of the running song under a name (every channel's volume, pan, mute, solo, input monitoring, and each send's level and mute), restore it later, or list this song's snapshots. Restore sets only what differs. Record-arm and automation mode are not included. Mixer changes are not reverted by one live_undo; restore a snapshot instead.",
  { action: z.enum(['save', 'restore', 'list']), name: z.string().optional() },
  guard((a) => mixSnapshot(call, a)),
);

server.tool(
  'live_plugin_snapshot',
  "Save a plug-in's current settings under a name, restore them onto the same kind of plug-in (any channel), or list saved snapshots. A stand-in for presets that works remotely: it stores every known parameter's raw value (PreSonus plug-ins; names as in live_plugin_params) in the studio-one-mcp data folder. Restore only sets parameters that differ.",
  {
    action: z.enum(['save', 'restore', 'list']),
    channel: z.string().optional(),
    slot: z.number().int().optional(),
    name: z.string().optional(),
    plugin: z.string().optional().describe('For list: only this plug-in'),
  },
  guard((a) => {
    if (a.action !== 'list' && (a.channel === undefined || a.slot === undefined)) throw new Error(`${a.action} needs channel and slot`);
    return snapshot(call, a);
  }),
);

server.tool(
  'live_record_setup',
  'Recording setup in the running Studio One. With no arguments, reads the metronome: click, precount, precount length in bars, preroll. Set any of those, and/or record modes: replace, loopTakes or loopMix, takesToLayers, inputQuantize, noteErase (true/false). Record modes cannot be read back from Studio One, so they are reported as set, not confirmed. Auto Punch: punch off, in, out or both, and punchFrom/punchTo for the range (seconds or bars; Studio One punches between the loop locators, so this sets the loop range without turning looping on). The result shows punch-in and whether any autopunch is on (punch-out alone cannot be read separately once punch-in is on).',
  {
    punch: z.enum(['off', 'in', 'out', 'both']).optional(),
    punchFrom: TIME.optional(),
    punchTo: TIME.optional(),
    click: z.boolean().optional(),
    precount: z.boolean().optional(),
    precountBars: z.number().int().optional().describe('1-16'),
    preroll: z.boolean().optional(),
    replace: z.boolean().optional(),
    loopTakes: z.boolean().optional(),
    loopMix: z.boolean().optional(),
    takesToLayers: z.boolean().optional(),
    inputQuantize: z.boolean().optional(),
    noteErase: z.boolean().optional(),
  },
  guard((a) => recordSetup(call, a)),
);

server.tool(
  'live_add_bus',
  'Create a bus for some tracks (their outputs are routed into it) or a VCA that controls them, in the running Studio One. Returns the new channel and, for a bus, where each track now goes. One live_undo removes it. The track selection is kept.',
  { tracks: z.array(z.string()).describe('Exact track names'), kind: z.enum(['bus', 'vca']).optional() },
  guard((a) => addBus(call, a)),
);

server.tool(
  'live_track_edit',
  'Edit a track by exact name in the running Studio One: rename (and its mixer channel), color ("#rrggbb"), remove, move (reorder: put it just before or after another track; both at the top level, not inside a folder), route (send its channel\'s output to a bus or output, by channel name), folder (move it into a folder track, creating it with create: true; the folder is expanded so the track stays visible to these tools), or renameEvents (name every event on it, numbered in time order if asked). Rename and colour are not on the undo stack; route is set back by routing to the "before" channel the result gives; remove, move, folder and renameEvents undo with live_undo. The track selection is kept. Move, route, folder and renameEvents run through the MCP Track Edit task installed with the device.',
  {
    track: z.string(),
    action: z.enum(['rename', 'color', 'remove', 'move', 'route', 'folder', 'renameEvents']),
    name: z.string().optional().describe('For rename and renameEvents'),
    color: z.string().optional().describe('For color: "#rrggbb"'),
    to: z.string().optional().describe('For route: destination channel name, e.g. "Bus 1" or "Main"'),
    folder: z.string().optional().describe('For folder: folder track name'),
    create: z.boolean().optional().describe('For folder: create the folder track if there is none by that name'),
    numbered: z.boolean().optional().describe('For renameEvents: add (01), (02)… in time order'),
    before: z.string().optional().describe('For move: put the track just before this track'),
    after: z.string().optional().describe('For move: put the track just after this track'),
  },
  guard((a) => trackEdit(call, a)),
);

// Sections of the open song: live from the arranger track (MCP Track Edit task),
// or as of the last save if the task is not there.
async function savedSections() {
  try {
    const { sections } = await trackTask(call, { op: 'sections' });
    const live = sections.map((s) => ({ name: s.name, start: { seconds: s.start, bar: null }, end: { seconds: s.end } }));
    return () => live;
  } catch {
    const { fileUrl } = await call('song');
    const path = fileUrl ? fileURLToPath(fileUrl) : null;
    const sections = path && existsSync(path) ? readSong(path).sections : [];
    return () => sections;
  }
}

server.tool(
  'live_arranger',
  "Arranger sections in the running Studio One. sections: list them (numbered in song order). goto: a section by number or name; while playing it jumps at the arranger's sync point, while stopped it moves the playhead to the section's start. next / previous: step while playing. syncMode: when jumps happen (off = immediately, 1bar, 2bars, 4bars, end of section); changing it is an undo step. createFromMarkers: make sections between markers. Editing (each one live_undo): add {start, end, name}, rename {section, name}, resize {section, end}, move {section, start}, remove {section}; these change only the section, not the events under it. With its content, on every track: copy {section, to} inserts a copy at a position (what follows moves later); delete {section} removes it and everything in it, closing the gap; move {section, to, content: true} does both (two undo steps). Positions are seconds or bars like \"9.1.1.0\". The loop range is kept.",
  {
    action: z.enum(['sections', 'goto', 'next', 'previous', 'syncMode', 'createFromMarkers', 'add', 'rename', 'resize', 'move', 'remove', 'copy', 'delete']),
    section: z.union([z.number().int(), z.string()]).optional().describe('Section number or name (goto jumps while playing only to 1-16)'),
    sync: z.enum(['off', '1bar', '2bars', '4bars', 'end']).optional().describe('For syncMode'),
    name: z.string().optional().describe('For add and rename'),
    start: TIME.optional().describe('For add and move'),
    end: TIME.optional().describe('For add and resize'),
    to: TIME.optional().describe('For copy, and move with content: where it goes (best a section boundary)'),
    content: z.boolean().optional().describe('For move: take the events under the section along'),
  },
  guard(async (a) => arranger(call, await savedSections(), a)),
);

server.tool(
  'live_macros',
  "List the macros in the running Studio One (Macros panel: built-in and your own) by title, optionally filtered; with_state adds whether each can run right now (most act on the selection).",
  { filter: z.string().optional(), with_state: z.boolean().optional() },
  guard(({ filter, with_state }) => listMacros(call, { filter, withState: with_state })),
);

server.tool(
  'live_run_macro',
  'Run a Studio One macro by title (from live_macros), e.g. "Normalize Audio & Set Peaks To -12". Macros are chains of commands that usually act on the selected events or tracks (see live_select_events / live_select_track) and can edit the song; most edits undo with live_undo. check_only reports whether it is enabled without running it.',
  { title: z.string(), check_only: z.boolean().optional() },
  guard(({ title, check_only }) => runMacro(call, { title, checkOnly: check_only })),
);

server.tool(
  'live_events',
  "One event (audio clip or instrument part) on a track in the running Studio One. list: the track's events, numbered in time order, with start/end in seconds and, for audio, gain (dB) and fade lengths. edit {event, and any of: to (new start), end (new end), to_track (move it to another track), gain_db (set), add_gain_db, fade_in / fade_out (seconds, audio)}: one live_undo reverts the whole edit. duplicate {event, times}: copies right after it, times times. copy {event, to, to_track?}: pastes a copy at a position (uses the clipboard). Positions are seconds or bars like \"9.1.1.0\".",
  {
    track: z.string(),
    action: z.enum(['list', 'edit', 'duplicate', 'copy']).optional(),
    event: z.union([z.number().int(), z.string()]).optional().describe('Event number (from list) or name'),
    to: TIME.optional(),
    end: TIME.optional().describe('edit: resize the event to end here (instrument parts), after any move'),
    to_track: z.string().optional(),
    gain_db: z.number().optional(),
    add_gain_db: z.number().optional(),
    fade_in: z.number().optional(),
    fade_out: z.number().optional(),
    times: z.number().int().optional(),
  },
  guard((a) => liveEvents(call, a)),
);

server.tool(
  'live_time_signature',
  'Time signatures in the running Studio One. at: the signature in effect at positions (seconds or bars; default the start). insert {bar, numerator, denominator}: a change at the start of a bar. remove {bar}: the change at that bar. Each insert or remove is one live_undo.',
  {
    action: z.enum(['at', 'insert', 'remove']),
    at: z.union([TIME, z.array(TIME)]).optional(),
    bar: z.number().int().optional(),
    numerator: z.number().int().optional(),
    denominator: z.number().int().optional(),
  },
  guard((a) => timeSignature(call, a)),
);

server.tool(
  'live_write_automation',
  "Write volume or pan automation on a channel in the running Studio One, along points [{at, db}] (volume in dB), [{at, pan}] (-1 left .. 1 right) or [{at, value}] (0..1 as live_set_channel takes it), straight lines between them. Studio One gives scripts no way to add envelope points, so this plays the range once in real time with the channel in Write mode and the fader following the curve (audible, and it replaces that parameter's automation in the range), then leaves the channel in Read. Only runs with confirm: true. For fades inside one clip, prefer live_events fade_in/fade_out.",
  {
    confirm: z.literal(true).describe('Must be true: the user asked for automation to be written'),
    channel: z.string(),
    parameter: z.enum(['volume', 'pan']).optional(),
    points: z.array(z.object({ at: TIME, db: z.number().optional(), pan: z.number().optional(), value: z.number().optional() })),
  },
  guard(({ channel, parameter, points }) => writeAutomation(call, { channel, parameter, points })),
);

server.tool(
  'live_changes',
  "What changed in the song open in Studio One since the previous call: tracks added, removed, renamed or reordered, events added, removed or moved on each track, mixer changes (volume, pan, mute, solo, arm, monitor, automation mode, output, plug-ins), tempo, loop, and markers and arranger sections added, removed, renamed or moved. The first call for a song only takes a look. Changes are net (moved and moved back is no change) and do not say who made them. reset: start over from now.",
  { reset: z.boolean().optional().describe('Forget the previous look and take a new one') },
  guard((a) => liveChanges(call, a)),
);

server.tool(
  'live_eval',
  "Run JavaScript inside Studio One's script engine and return the result (host objects are described to a depth). Globals: Host, PreSonus, component, describe. Only works when the bridge was installed with --allow-eval. Useful for exploring the undocumented object model, e.g. Host.Objects.getObjectByUrl('://studioapp/DocumentManager'). Do not throw, and check that a host member exists (typeof) before calling it: either one pops a modal Scripting Error dialog in Studio One.",
  { code: z.string().describe('Function body; use `return` to send a value back'), depth: z.number().int().optional() },
  guard((a) => call('eval', a, { timeoutMs: 15000 })),
);

await server.connect(new StdioServerTransport());
