// The MCP Track Edit task under node:vm, with a fake host shaped after what
// Studio One's own track scripts use (MixerConsole channel list, DeviceEditFunctions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = (f) => readFileSync(fileURLToPath(new URL(`../device/EditTasks/package/${f}`, import.meta.url)), 'utf8');
const source = pkg('McpTrackEdit.js');
const MAILBOX = 'file:///mb/';

function load(extraHost = {}) {
  const files = new Map();
  const Host = {
    Url: (u) => ({ url: u }),
    IO: {
      File: (u) => ({ exists: () => files.has(u.url) }),
      openTextFile: (u) => { const lines = files.get(u.url).split('\n'); let i = 0; return { readLine: () => lines[i++], close() {} }; },
      createTextFile: (u) => { let buf = ''; return { writeString: (s) => (buf += s), close: () => files.set(u.url, buf) }; },
    },
    Results: { kResultOk: 0 },
    Interfaces: { IEditTask: 'IEditTask' },
    ...extraHost,
  };
  const ctx = vm.createContext({ Host, McpEditConfig: { mailbox: MAILBOX } });
  // include_file loads package files into the same context, as Studio One does.
  ctx.include_file = (f) => { if (f !== 'McpEditConfig.js') vm.runInContext(pkg(f), ctx); };
  vm.runInContext(source, ctx);
  return {
    task: vm.runInContext('createMcpTrackEdit()', ctx),
    request: (ops) => files.set(MAILBOX + 'track-edit-request.json', JSON.stringify({ id: 't1', ops }) + '\n'),
    result: () => JSON.parse(files.get(MAILBOX + 'track-edit-result.json')),
  };
}

function studio() {
  const ch = (label) => ({ label, input: { of: label }, output: null });
  const channels = [ch('Vox'), ch('Gtr'), ch('Bus 1'), ch('Main')];
  const connected = [];
  const folder = { name: 'Band', isFolder: true, children: [] };
  const tracks = [{ name: 'Vox' }, { name: 'Gtr' }, folder];
  const context = {
    mainTrackList: { numTracks: tracks.length, getTrack: (i) => tracks[i] },
    functions: {
      moveToFolder: (f, t) => f.children.push(t.name),
      root: {
        environment: { find: (n) => (n === 'MixerConsole' ? { getChannelList: () => ({ numChannels: channels.length, getChannel: (i) => channels[i] }) } : null) },
        createFunctions: (n) => (n === 'DeviceEditFunctions' ? { connectChannel: (c, input) => connected.push([c.label, input.of]) } : null),
      },
    },
  };
  return { context, connected, folder };
}

test('route connects one channel to another channel\'s input; names must be unique and present', () => {
  const t = load();
  const s = studio();
  t.request([{ op: 'route', channel: 'Vox', to: 'Bus 1' }, { op: 'route', channel: 'Keys', to: 'Main' }, { op: 'route', channel: 'Gtr', to: 'Nowhere' }]);
  t.task.performEdit(s.context);
  const r = t.result().results;
  assert.deepEqual(s.connected, [['Vox', 'Bus 1']]);
  assert.equal(r[0].done, true);
  assert.match(r[1].error, /no channel named Keys/);
  assert.match(r[2].error, /no channel named Nowhere/);
});

test('folder moves named tracks into a folder track; probe describes what it finds', () => {
  const t = load();
  const s = studio();
  t.request([{ op: 'folder', folder: 'Band', tracks: ['Vox', 'Gtr', 'Drums'] }, { op: 'folder', folder: 'Vox', tracks: ['Gtr'] }, { op: 'probe' }]);
  t.task.performEdit(s.context);
  const [folder, notFolder, probe] = t.result().results;
  assert.deepEqual([folder.moved, folder.missing, s.folder.children], [['Vox', 'Gtr'], ['Drums'], ['Vox', 'Gtr']]);
  assert.match(notFolder.error, /no folder track named Vox/);
  assert.deepEqual([probe.channelCount, probe.firstChannels, probe.deviceFunctions, probe.trackCount], [4, ['Vox', 'Gtr', 'Bus 1', 'Main'], { connectChannel: 'function' }, 3]);
});

test('renameEvents names every event in time order (numbered on request); folder create makes and expands it', () => {
  const t = load();
  const s = studio();
  const evs = [{ name: 'b', startTime: { seconds: 4 } }, { name: 'a', startTime: { seconds: 0 } }];
  s.context.mainTrackList = { numTracks: 1, getTrack: () => ({ name: 'Vox', createIterator: () => { let k = 0; return { next: () => evs[k++] || null }; } }) };
  s.context.functions.renameEvent = (e, n) => (e.name = n);
  let added = null;
  const expanded = [];
  s.context.functions.addTrack = (type, at, name) => (added = { type, name, isFolder: 1, children: [] });
  s.context.editor = { model: { folders: { isExpanded: () => false, toggleExpand: (f) => expanded.push(f.name) } } };
  t.request([{ op: 'renameEvents', track: 'Vox', name: 'Lead', numbered: true }, { op: 'folder', folder: 'Band', tracks: ['Vox'], create: true }]);
  t.task.performEdit(s.context);
  const [ren, fold] = t.result().results;
  assert.deepEqual(ren.renamed, ['Lead(01)', 'Lead(02)']);
  assert.deepEqual(evs.map((e) => e.name), ['Lead(02)', 'Lead(01)'], 'the event at 0 s is (01)');
  assert.deepEqual([fold.created, added.type, added.name, expanded, added.children], [true, 'FolderTrack', 'Band', ['Band'], ['Vox']]);
});

test('missing host members are reported, not called', () => {
  const t = load();
  t.request([{ op: 'route', channel: 'A', to: 'B' }, { op: 'folder', folder: 'F', tracks: [] }, { op: 'probe' }]);
  t.task.performEdit({ functions: {} });
  const r = t.result().results;
  assert.match(r[0].error, /no channel named A/);
  assert.match(r[1].error, /no folder track named F/);
  assert.equal(r[2].channelCount, 0);
});

// ---- McpTrackOps.js ----------------------------------------------------------------

// A song for the ops: global tracks first, events with times in beats at 120 bpm.
function song() {
  const t = (s) => ({ seconds: s, musical: s * 2, as: (f) => (f === 2 ? s * 2 : s) });
  const ev = (name, s, e, extra = {}) => ({ name, startTime: t(s), endTime: t(e), start: s * 2, length: (e - s) * 2, offset: 0, timeFormat: 2, ...extra });
  const sig = { getTimeSignature: (ppq) => (ppq >= 32 ? { numerator: 3, denominator: 4 } : { numerator: 4, denominator: 4 }) };
  const markers = { name: 'Marker Track', events: [ev('End', 300, 300, { markerType: 3 }), ev('Start', 0, 0, { markerType: 2, timeContext: sig }), ev('Hook', 4, 4, { markerType: 0 })] };
  const arranger = { name: 'Arranger Track', events: [ev('Chorus', 8, 16), ev('Verse', 0, 8)] };
  const clip = ev('Gtr', 2, 6, { volumeCurve: { level: 1, fadeInLength: 0.01, fadeOutLength: 0.01, fadeInType: 0, fadeOutType: 0 } });
  const tracks = [markers, arranger, { name: 'Vox', mediaType: 'Audio', parentFolderID: '', events: [] }, { name: 'Gtr', mediaType: 'Audio', parentFolderID: '', events: [clip] }];
  for (const tr of tracks) tr.createIterator = () => { let k = 0; return { next: () => tr.events[k++] || null }; };
  const log = [];
  const iter = (list) => { let k = 0; return { done: () => k >= list.length, next: () => list[k++] }; };
  const audio = {
    modifyVolume: (e, db) => { e.volumeCurve.level *= 10 ** (db / 20); log.push(['gain', db]); },
    createFadeIn: (e, type, len) => { e.volumeCurve.fadeInLength = len; log.push(['fadeIn', len]); },
    createFadeOut: (e, type, len) => { e.volumeCurve.fadeOutLength = len; },
  };
  const functions = {
    newMediaTime: () => { const m = { seconds: 0 }; Object.defineProperty(m, 'musical', { get: () => m.seconds * 2 }); m.as = (f) => (f === 2 ? m.seconds * 2 : m.seconds); return m; },
    moveEvent: (e, to) => { const s = to / 2; const len = e.endTime.seconds - e.startTime.seconds; e.startTime = t(s); e.endTime = t(s + len); e.start = to; log.push(['move', to]); },
    resizeEvent: (e, start, offset, len) => { e.length = len; e.endTime = t(e.startTime.seconds + len / 2); log.push(['resize', len]); },
    renameEvent: (e, n) => { e.name = n; log.push(['rename', n]); },
    removeEvent: (e) => { for (const tr of tracks) tr.events = tr.events.filter((x) => x !== e); return 1; },
    transferEvent: (e, dst) => { for (const tr of tracks) tr.events = tr.events.filter((x) => x !== e); dst.events.push(e); log.push(['transfer', dst.name]); },
    addTrack: (type, at, name) => { const f = { name, isFolder: true, parentFolderID: '', events: [], createIterator: () => ({ next: () => null }) }; tracks.splice(at, 0, f); log.push(['addTrack', at]); return f; },
    // Out of a folder to the root lands right after the folder, as on 5.5.2.
    moveToFolder: (folder, track) => {
      tracks.splice(tracks.indexOf(track), 1);
      const anchor = folder === functions.root ? tracks.findIndex((x) => x.isFolder) : tracks.indexOf(folder);
      tracks.splice(anchor + 1, 0, track);
    },
    removeTrack: (f) => tracks.splice(tracks.indexOf(f), 1),
    beginMultiple: () => log.push(['begin']),
    endMultiple: () => log.push(['end']),
  };
  functions.root = { createIterator: () => iter(tracks), createFunctions: (n) => (n === 'AudioFunctions' ? audio : null), environment: null };
  const context = {
    functions,
    editor: { model: { arranger: { getArrangerTrack: () => arranger, addArrangerEvent: (tr, s, e) => { const x = ev('Outro', s.seconds, e.seconds); arranger.events.push(x); return x; } } } },
  };
  return { context, tracks, log, clip, arranger };
}

function run(ops) {
  const t = load();
  const s = song();
  t.request(ops);
  t.task.performEdit(s.context);
  return { results: t.result().results, s };
}

test('markers, sections and signatures read the global tracks in time order', () => {
  const { results } = run([{ op: 'markers' }, { op: 'sections' }, { op: 'signatures', at: [0, 20] }]);
  assert.deepEqual(results[0].markers.map((m) => [m.number, m.name, m.seconds, m.kind]), [[1, 'Start', 0, 'start'], [2, 'Hook', 4, 'marker'], [3, 'End', 300, 'end']]);
  assert.deepEqual(results[1].sections.map((x) => [x.number, x.name, x.start, x.end]), [[1, 'Verse', 0, 8], [2, 'Chorus', 8, 16]]);
  assert.deepEqual(results[2].signatures.map((x) => `${x.numerator}/${x.denominator}@${x.beat}`), ['4/4@0', '3/4@40']);
});

test("editEvent moves (seconds to the event's own beats), sets gain in dB, fades, and transfers", () => {
  const { results, s } = run([{ op: 'editEvent', track: 'Gtr', event: 1, to: 10, gainDb: -6, fadeIn: 0.5, toTrack: 'Vox' }]);
  const r = results[0];
  assert.deepEqual(r.done, ['move', 'gain', 'fadeIn', 'toTrack']);
  assert.deepEqual(s.log.filter(([k]) => k !== 'gain'), [['move', 20], ['fadeIn', 0.5], ['transfer', 'Vox']]);
  assert.equal(r.after.start, 10);
  assert.equal(r.after.gainDb, -6);
  assert.equal(s.tracks.find((t) => t.name === 'Vox').events[0], s.clip);
});

test('editEvent: end resizes the event after the move; an end before the start is an error', () => {
  const { results, s } = run([{ op: 'editEvent', track: 'Gtr', event: 1, to: 10, end: 14 }, { op: 'editEvent', track: 'Gtr', event: 1, end: 1 }]);
  assert.deepEqual(results[0].done, ['move', 'resize']);
  assert.deepEqual(s.log, [['move', 20], ['resize', 8]]);
  assert.equal(results[0].after.end, 14);
  assert.match(results[1].error, /cannot resize/);
});

test('editEvent: an unknown event number or track is an error and nothing changes', () => {
  const { results, s } = run([{ op: 'editEvent', track: 'Gtr', event: 2, to: 1 }, { op: 'editEvent', track: 'Bass', event: 1 }]);
  assert.match(results[0].error, /event 2 does not exist \(there are 1\)/);
  assert.match(results[1].error, /no track named Bass/);
  assert.deepEqual(s.log, []);
});

test('sections: add with a name, rename/resize/move by name or number, remove', () => {
  const { results, s } = run([
    { op: 'addSection', start: 16, end: 24, name: 'Bridge' },
    { op: 'editSection', section: 'Verse', name: 'Intro', end: 4 },
    { op: 'editSection', section: 2, start: 30 },
    { op: 'editSection', section: 'Bridge', remove: true },
  ]);
  assert.equal(results[0].added, 'Bridge');
  assert.deepEqual([results[1].after.name, results[1].after.end], ['Intro', 4]);
  assert.equal(results[2].after.start, 30);
  assert.equal(results[3].removed.name, 'Bridge');
  assert.deepEqual(s.arranger.events.map((e) => e.name).sort(), ['Chorus', 'Intro']);
});

test('moveTrack goes through a temporary folder in one undo group; bad requests are errors', () => {
  const { results, s } = run([{ op: 'moveTrack', track: 'Gtr', before: 'Vox' }]);
  assert.deepEqual(results[0].order, ['Gtr', 'Vox']);
  assert.deepEqual(s.tracks.map((t) => t.name), ['Marker Track', 'Arranger Track', 'Gtr', 'Vox']);
  assert.deepEqual(s.log.map(([k]) => k), ['begin', 'addTrack', 'end']);
  const bad = run([{ op: 'moveTrack', track: 'Gtr' }, { op: 'moveTrack', track: 'Gtr', after: 'Gtr' }]).results;
  assert.match(bad[0].error, /needs before or after/);
  assert.match(bad[1].error, /next to itself/);
});

test('renameMarker by number; the eval probe is off without allowEval', () => {
  const { results, s } = run([{ op: 'renameMarker', marker: 2, name: 'Drop' }, { op: 'eval', code: 'return 1' }]);
  assert.equal(results[0].before.name, 'Hook');
  assert.deepEqual(s.log, [['rename', 'Drop']]);
  assert.match(results[1].error, /eval is disabled/);
});

// An instrument track "Keys" with one part from 4 s to 8 s (beats 8..16 at 120 bpm).
function keysSong() {
  const s = song();
  const t = (sec) => ({ seconds: sec, musical: sec * 2, as: (f) => (f === 2 ? sec * 2 : sec) });
  const notes = [];
  const part = { name: 'Keys', startTime: t(4), endTime: t(8), timeFormat: 2, notes, createSequenceIterator: () => { let k = 0; return { done: () => k >= notes.length, next: () => notes[k++] }; } };
  const keys = { name: 'Keys', mediaType: 'Music', parentFolderID: '', events: [part] };
  keys.createIterator = () => { let k = 0; return { next: () => keys.events[k++] || null }; };
  s.tracks.push(keys);
  const music = {
    createEvent: (kind) => (kind === 'Note' ? { kind } : null),
    insertEvent: (p, n) => { n.part = p; p.notes.push(n); },
    modifyPitch: (n, p) => { n.pitch = p; },
    modifyVelocity: (n, v) => { n.velocity = v; },
    freezeVelocity: (n) => { n.frozen = true; },
    resizeEvent: (n, len) => { n.length = len; },
    moveEvent: (n, at) => { n.at = at; },
  };
  const prev = s.context.functions.root.createFunctions;
  s.context.functions.root.createFunctions = (n) => (n === 'MusicFunctions' ? music : prev(n));
  return { ...s, part, notes };
}

function runKeys(ops) {
  const t = load();
  const s = keysSong();
  t.request(ops);
  t.task.performEdit(s.context);
  return { results: t.result().results, s };
}

test('addNotes writes notes into the part covering `at`, beats relative to `at`, part-relative positions', () => {
  // at = 5 s → song beat 10; part starts at beat 8 → base 2.
  const { results, s } = runKeys([{ op: 'addNotes', track: 'Keys', at: 5, notes: [{ pitch: 60, beat: 0, length: 4, velocity: 127 }, { pitch: 67, beat: 1.5, length: 0.5 }] }]);
  assert.deepEqual(results[0], { op: 'addNotes', track: 'Keys', part: 'Keys', added: 2, errors: [] });
  assert.deepEqual(s.notes.map((n) => [n.pitch, n.at, n.length, Math.round(n.velocity * 127), n.frozen]), [[60, 2, 4, 127, true], [67, 3.5, 0.5, 100, true]]);
});

test('addNotes reports bad notes and still writes the good ones', () => {
  const { results, s } = runKeys([{ op: 'addNotes', track: 'Keys', at: 4, notes: [{ pitch: 128, beat: 0, length: 1 }, { pitch: 60, beat: 0, length: 0 }, { pitch: 62, beat: -1, length: 1 }, { pitch: 64, beat: 0, length: 1, velocity: 300 }] }]);
  assert.equal(results[0].added, 1);
  assert.deepEqual(results[0].errors, ['note 1: pitch must be an integer 0-127', 'note 2: length must be > 0 beats', 'note 3: beat must be >= 0']);
  assert.equal(Math.round(s.notes[0].velocity * 127), 127);
});

test('addNotes: no part at that position, unknown track', () => {
  assert.match(runKeys([{ op: 'addNotes', track: 'Keys', at: 9, notes: [{ pitch: 60, beat: 0, length: 1 }] }]).results[0].error, /no instrument part on Keys at 9 s/);
  assert.match(runKeys([{ op: 'addNotes', track: 'Nope', at: 4, notes: [] }]).results[0].error, /no track named Nope/);
});

test('addNotes: a MusicFunctions without modifyPitch is an error and adds nothing', () => {
  const t = load();
  const s = keysSong();
  const root = s.context.functions.root;
  const prev = root.createFunctions;
  root.createFunctions = (n) => { const m = prev(n); if (n === 'MusicFunctions') delete m.modifyPitch; return m; };
  t.request([{ op: 'addNotes', track: 'Keys', at: 4, notes: [{ pitch: 60, beat: 0, length: 1 }] }]);
  t.task.performEdit(s.context);
  assert.match(t.result().results[0].error, /MusicFunctions are not available/);
  assert.equal(s.notes.length, 0);
});

test('addNotes: all notes are one undo step (begin/end around the loop), even for a bad note', () => {
  const { s } = runKeys([{ op: 'addNotes', track: 'Keys', at: 4, notes: [{ pitch: 60, beat: 0, length: 1 }, { pitch: 999, beat: 0, length: 1 }, { pitch: 62, beat: 1, length: 1 }] }]);
  assert.deepEqual(s.log.map(([k]) => k), ['begin', 'end']);
  assert.equal(s.notes.length, 2);
});

test('addNotes: ends the undo group when a MusicFunctions call throws', () => {
  const t = load();
  const s = keysSong();
  const root = s.context.functions.root;
  const prev = root.createFunctions;
  root.createFunctions = (n) => { const m = prev(n); if (n === 'MusicFunctions') m.modifyPitch = () => { throw new Error('boom'); }; return m; };
  t.request([{ op: 'addNotes', track: 'Keys', at: 4, notes: [{ pitch: 60, beat: 0, length: 1 }] }]);
  try { t.task.performEdit(s.context); } catch { /* the task may let it out */ }
  assert.deepEqual(s.log.map(([k]) => k), ['begin', 'end']);
});

// A second part on Keys: parts at 4-8 s (Keys) and 4-6 s (Short), and one at 4-12 s (Long).
function addPart(s, name, from, to) {
  const t = (sec) => ({ seconds: sec, musical: sec * 2, as: (f) => (f === 2 ? sec * 2 : sec) });
  const notes = [];
  const part = { name, startTime: t(from), endTime: t(to), timeFormat: 2, notes, createSequenceIterator: () => ({ done: () => true, next: () => null }) };
  s.tracks.find((x) => x.name === 'Keys').events.push(part);
  return part;
}

test('addNotes with end: prefers the part that covers the range; among those, the one ending latest', () => {
  const t = load();
  const s = keysSong();
  addPart(s, 'Short', 4, 6);
  const long = addPart(s, 'Long', 4, 12);
  addPart(s, 'Mid', 4, 10);
  t.request([{ op: 'addNotes', track: 'Keys', at: 4, end: 9, notes: [{ pitch: 60, beat: 0, length: 1 }] }]);
  t.task.performEdit(s.context);
  assert.equal(t.result().results[0].part, 'Long');
  assert.equal(long.notes.length, 1);
  assert.equal(s.notes.length, 0);
});

test('addNotes with end: falls back to the latest-ending part at `at` when none covers the range', () => {
  const t = load();
  const s = keysSong();
  addPart(s, 'Short', 4, 6);
  t.request([{ op: 'addNotes', track: 'Keys', at: 4, end: 20, notes: [{ pitch: 60, beat: 0, length: 1 }] }]);
  t.task.performEdit(s.context);
  assert.equal(t.result().results[0].part, 'Keys');
});

test('addNotes: a note that runs past the part end is an error and is skipped', () => {
  // the part is 4 s long = 8 beats at 120 bpm; at = 4 → base 0
  const { results, s } = runKeys([{ op: 'addNotes', track: 'Keys', at: 4, notes: [{ pitch: 60, beat: 6, length: 2 }, { pitch: 62, beat: 7, length: 2 }, { pitch: 64, beat: 8, length: 1 }] }]);
  assert.equal(results[0].added, 1);
  assert.deepEqual(results[0].errors, ['note 2: ends after the part', 'note 3: ends after the part']);
  assert.deepEqual(s.notes.map((n) => n.pitch), [60]);
});

// ---- presets, insert at position, slot commands ----

function deviceSong() {
  const log = [];
  const presetObjs = ['P-kick', 'P-snare'];
  const names = ['Sin preset', 'Kick 1', 'Snare 1'];
  const pl = {
    max: 2, string: '', shouldShowFolders() {}, setMetaInfo(a) { log.push(['meta', a]); },
    set value(i) { this.string = names[i]; },
    getValueAt: (i) => presetObjs[i - 1],
  };
  const host = { Classes: { createInstance: (n) => (n === 'Host:PresetParam' ? pl : null) }, Attributes: (a) => a };
  const slot = { interpretCommand: (c, n, chk) => { log.push(['cmd', c, n, chk]); return 1; } };
  const inserts = { find: (n) => (n === 'FX01' || n === 'FX07' ? slot : null) };
  const channel = { label: 'Vox', find: (n) => (n === 'Inserts' ? inserts : null) };
  const context = {
    functions: {
      root: {
        environment: { find: () => ({ getChannelList: () => ({ numChannels: 1, getChannel: () => channel }) }) },
        createFunctions: () => ({ insertDevice: (f, what, pos) => { log.push(['insert', f === inserts, what, pos]); return { name: 'FX02' }; } }),
      },
    },
  };
  return { host, context, log };
}

function runDevice(ops) {
  const s = deviceSong();
  const t = load(s.host);
  t.request(ops);
  t.task.performEdit(s.context);
  return { results: t.result().results, log: s.log };
}

test('listPresets returns the names without the no-preset entry', () => {
  const { results, log } = runDevice([{ op: 'listPresets', cid: '{X}' }]);
  assert.deepEqual(results[0].presets, [{ index: 1, name: 'Kick 1' }, { index: 2, name: 'Snare 1' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(log[0])), ['meta', ['Class:ID', '{X}']]);
});

test('insertPreset passes the matching preset object and the position to insertDevice', () => {
  const { results, log } = runDevice([{ op: 'insertPreset', channel: 'Vox', cid: '{X}', preset: 'Snare 1', position: 1 }]);
  assert.deepEqual([results[0].channel, results[0].slot], ['Vox', 'FX02']);
  assert.deepEqual(log.filter((l) => l[0] === 'insert'), [['insert', true, 'P-snare', 1]]);
});

test('insertPreset without a preset inserts the class, appending when no position is given', () => {
  const { results, log } = runDevice([{ op: 'insertPreset', channel: 'Vox', cid: '{X}' }]);
  assert.equal(results[0].channel, 'Vox');
  assert.deepEqual(log.filter((l) => l[0] === 'insert'), [['insert', true, '{X}', undefined]]);
});

test('insertPreset with an unknown preset is an error and inserts nothing', () => {
  const { results, log } = runDevice([{ op: 'insertPreset', channel: 'Vox', cid: '{X}', preset: 'Nope', position: 0 }]);
  assert.match(results[0].error, /no preset named/);
  assert.equal(log.filter((l) => l[0] === 'insert').length, 0);
});

test('slotCommand Remove checks the command, then runs it', () => {
  const { results, log } = runDevice([{ op: 'slotCommand', channel: 'Vox', slot: 0, command: 'Remove' }]);
  assert.deepEqual([results[0].channel, results[0].slot, results[0].command, results[0].done], ['Vox', 0, 'Remove', true]);
  assert.deepEqual(log, [['cmd', 'Device', 'Remove', true], ['cmd', 'Device', 'Remove', false]]);
});

test('slotCommand on a missing slot, or an unknown command, is an error', () => {
  const { results } = runDevice([{ op: 'slotCommand', channel: 'Vox', slot: 3, command: 'Remove' }, { op: 'slotCommand', channel: 'Vox', slot: 0, command: 'Explode' }]);
  assert.match(results[0].error, /no plug-in in slot/);
  assert.match(results[1].error, /command must be/);
});

test('slotCommand with a name addresses that FX slot instead of the index', () => {
  const { results, log } = runDevice([{ op: 'slotCommand', channel: 'Vox', command: 'Bypass', name: 'FX07' }, { op: 'slotCommand', channel: 'Vox', command: 'Bypass', name: 'FX09' }]);
  assert.equal(results[0].done, true);
  assert.match(results[1].error, /no plug-in in slot/);
  assert.equal(log.length, 2);
});

// ---- chord track ----
function chordSong(withRemove = true) {
  const s = song();
  const tm = (sec) => ({ seconds: sec });
  const evs = [['Am', 4, 6], ['G', 2, 4], ['C', 0, 2]].map(([n, a, b]) => ({ startTime: tm(a), endTime: tm(b), chord: { name: n } }));
  const removed = [];
  s.context.editor.model.chords = { getChordTrack: () => ({ createIterator: () => { let k = 0; return { next: () => evs[k++] || null }; } }) };
  if (withRemove) s.context.functions.removeEvent = (e) => removed.push(e.chord.name);
  else delete s.context.functions.removeEvent;
  return { s, removed };
}
function runChords(ops, withRemove) {
  const t = load();
  const c = chordSong(withRemove);
  t.request(ops);
  t.task.performEdit(c.s.context);
  return { results: t.result().results, removed: c.removed };
}

test('chords lists the chord track in time order, filtered by range', () => {
  const { results } = runChords([{ op: 'chords' }, { op: 'chords', from: 2, to: 4 }]);
  assert.deepEqual(results[0].chords.map((c) => [c.name, c.start, c.end]), [['C', 0, 2], ['G', 2, 4], ['Am', 4, 6]]);
  assert.deepEqual(results[1].chords.map((c) => c.name), ['G']);
});

test('removeChords removes the chords in range and reports them', () => {
  const { results, removed } = runChords([{ op: 'removeChords', from: 1, to: 3 }]);
  assert.deepEqual(removed.slice().sort(), ['C', 'G']);
  assert.deepEqual(results[0].removed.map((c) => c.name), ['C', 'G']);
});

test('chord ops report a missing chord track or removeEvent', () => {
  const t = load();
  t.request([{ op: 'chords' }]);
  t.task.performEdit({ functions: {} });
  assert.equal(t.result().results[0].error, 'the chord track is not available');
  const { results, removed } = runChords([{ op: 'removeChords' }], false);
  assert.equal(results[0].error, 'removing chord events is not available');
  assert.deepEqual(removed, []);
});

test('chords: a chord touching the range edge (rounded times) is not in the range', () => {
  // Real times: G ends at 7.5789…s, read back rounded as 7.579; the range starts at 7.5789.
  const { results } = runChords([{ op: 'chords', from: 1.9996, to: 4.0004 }]);
  assert.deepEqual(results[0].chords.map((c) => c.name), ['G']);
});

test('markers and signatures find the marker track under a localized name', () => {
  const t = load();
  const s = song();
  s.tracks.find((tr) => tr.name === 'Marker Track').name = 'Pista de macadores'; // as the Spanish 7.2.3 names it
  t.request([{ op: 'markers' }, { op: 'signatures', at: [0, 20] }]);
  t.task.performEdit(s.context);
  const [m, sg] = t.result().results;
  assert.deepEqual(m.markers.map((x) => x.name), ['Start', 'Hook', 'End']);
  assert.deepEqual(sg.signatures.map((x) => `${x.numerator}/${x.denominator}`), ['4/4', '3/4']);
});
