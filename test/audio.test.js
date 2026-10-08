// Audio import and audio commands over a fake bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wavSeconds, importAudio, processAudio, AUDIO_ACTIONS } from '../src/audio.js';

// A WAV header (no samples): wavSeconds reads the chunk sizes only.
function wav({ rate = 44100, channels = 2, bits = 16, seconds = 2, extra = false } = {}) {
  const byteRate = rate * channels * bits / 8;
  const data = Math.round(byteRate * seconds);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(byteRate, 16); fmt.writeUInt16LE(channels * bits / 8, 20); fmt.writeUInt16LE(bits, 22);
  const chunks = [fmt];
  if (extra) { const l = Buffer.alloc(14); l.write('LIST', 0); l.writeUInt32LE(5, 4); chunks.push(l); } // odd size + pad byte
  const dh = Buffer.alloc(8); dh.write('data', 0); dh.writeUInt32LE(data, 4); chunks.push(dh);
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12); head.write('RIFF', 0); head.writeUInt32LE(4 + body.length + data, 4); head.write('WAVE', 8);
  return Buffer.concat([head, body]);
}

test('wavSeconds: duration from fmt and data, skipping other chunks; null when not a WAV', () => {
  assert.equal(wavSeconds(wav({ seconds: 2 })), 2);
  assert.equal(wavSeconds(wav({ rate: 48000, channels: 1, bits: 24, seconds: 1.5 })), 1.5);
  assert.equal(wavSeconds(wav({ seconds: 3, extra: true })), 3);
  assert.equal(wavSeconds(Buffer.from('not a wav file at all')), null);
  assert.equal(wavSeconds(null), null);
});

function bridge({ before, after, playing = false, importError } = {}) {
  const log = [];
  let imported = false;
  const call = async (op, a = {}) => {
    if (op === 'song') { log.push('song'); return { transport: { playing }, selectedTracks: ['Vox'] }; }
    if (op === 'tracks') { log.push('tracks'); return imported ? after : before; }
    if (op === 'trackTask') {
      const o = a.ops[0];
      log.push(o);
      if (o.op === 'importAudio') {
        if (importError) return { results: [{ error: importError }] };
        imported = true;
        return { results: [{ imported: true }] };
      }
    }
    throw new Error(`unexpected ${op}`);
  };
  return { call, log, ops: () => log.filter((x) => typeof x === 'object') };
}
const fileOk = { fs: { stat: async () => ({ isFile: () => true }) } };
const withHead = (secs) => ({ ...fileOk, readHead: async () => wav({ seconds: secs }) });

test('importAudio onto a new track: forward slashes, the new clip from the diff, stretch flagged', async () => {
  const vox = { name: 'Vox', mediaType: 'Audio', events: [] };
  const b = bridge({
    before: [vox],
    after: [vox, { name: 'beat', mediaType: 'Audio', events: [{ name: 'beat', start: 5.053, end: 15.158, length: 10.105 }] }],
  });
  const r = await importAudio(b.call, { file: 'C:\\s\\beat.wav', at: 5.053 }, withHead(8));
  assert.deepEqual(b.ops(), [{ op: 'importAudio', file: 'C:/s/beat.wav', at: 5.053 }]);
  assert.equal(r.track, 'beat');
  assert.equal(r.newTrack, true);
  assert.deepEqual(r.event, { name: 'beat', start: 5.053, end: 15.158, length: 10.105 });
  assert.equal(r.fileSeconds, 8);
  assert.equal(r.stretched, true);
  assert.match(r.note, /stretched/);
});

test('importAudio onto an empty audio track that Studio One renames after the file', async () => {
  const b = bridge({
    before: [{ name: 'Pista 2', mediaType: 'Audio', events: [] }],
    after: [{ name: 'beat', mediaType: 'Audio', events: [{ name: 'beat', start: 0, end: 2, length: 2 }] }],
  });
  const r = await importAudio(b.call, { file: 'C:/s/beat.wav', track: 'Pista 2' }, withHead(2));
  assert.equal(b.ops()[0].track, 'Pista 2');
  assert.equal(b.ops()[0].at, 0);
  assert.equal(r.track, 'beat');
  assert.equal(r.renamedFrom, 'Pista 2');
  assert.equal(r.newTrack, false);
  assert.equal(r.fileSeconds, 2);
  assert.equal(r.stretched, undefined);
});

test('importAudio checks the path, the file, the track and the transport before importing', async () => {
  const keys = { name: 'Keys', mediaType: 'Music', events: [] };
  const noFile = { fs: { stat: async () => { throw new Error('ENOENT'); } } };
  const dir = { fs: { stat: async () => ({ isFile: () => false }) } };
  for (const [args, deps, re, opts] of [
    [{ file: 'beat.wav' }, fileOk, /absolute path/],
    [{}, fileOk, /file is required/],
    [{ file: 'C:/s/none.wav' }, noFile, /no such file/],
    [{ file: 'C:/s' }, dir, /not a file/],
    [{ file: 'C:/s/beat.wav', track: 'Keys' }, fileOk, /Keys is not an audio track/],
    [{ file: 'C:/s/beat.wav', track: 'Nope' }, fileOk, /no track named Nope/],
    [{ file: 'C:/s/beat.wav' }, fileOk, /stop playback first/, { playing: true }],
  ]) {
    const b = bridge({ before: [keys], after: [keys], ...(opts || {}) });
    await assert.rejects(importAudio(b.call, args, deps), re);
    assert.equal(b.ops().length, 0, `no device call for ${re}`);
  }
});

test('importAudio: a clip it cannot find is reported, not thrown; non-WAV files get no fileSeconds', async () => {
  const vox = { name: 'Vox', mediaType: 'Audio', events: [] };
  let headRead = false;
  const b = bridge({ before: [vox], after: [vox] });
  const r = await importAudio(b.call, { file: 'C:/s/song.mp3' }, { ...fileOk, readHead: async () => { headRead = true; return null; } });
  assert.equal(r.imported, true);
  assert.match(r.note, /could not be identified/);
  assert.equal(r.fileSeconds, undefined);
  assert.equal(headRead, false);
});

test('importAudio passes the device error through', async () => {
  const vox = { name: 'Vox', mediaType: 'Audio', events: [] };
  const b = bridge({ before: [vox], after: [vox], importError: 'importFile is not available' });
  await assert.rejects(importAudio(b.call, { file: 'C:/s/beat.wav' }, fileOk), /importFile is not available/);
});

function procBridge({ executed = true, mediaType = 'Audio', selectError } = {}) {
  const log = [];
  const call = async (op, a = {}) => {
    if (op === 'song') return { transport: { playing: false }, selectedTracks: ['Vox', 'Gtr'] };
    if (op === 'tracks') return [{ name: 'Drums', mediaType }, { name: 'Vox', mediaType: 'Audio' }];
    if (op === 'trackTask') {
      const o = a.ops[0];
      log.push(`task ${o.op}${o.event !== undefined ? ` ${o.event}` : ''}`);
      if (o.op === 'pluginClass') return { results: [o.plugin === 'Pro EQ' ? { cls: '{EQ}', name: 'Pro EQ' } : { error: `no plug-in named ${o.plugin}` }] };
      if (o.op === 'selectEvent') return { results: [selectError ? { error: selectError } : { selected: {} }] };
      if (o.op === 'events') return { results: [{ events: [{ number: 1, name: 'beat' }] }] };
    }
    if (op === 'selectEvents') { log.push(a.none ? 'deselect' : `selectEvents ${a.tracks.join(',')}`); return {}; }
    if (op === 'selectTrack') { log.push(`selectTrack ${a.name} ${a.exclusive}`); return {}; }
    if (op === 'command') { log.push(`command ${a.category}/${a.name}${a.args ? ` ${JSON.stringify(a.args)}` : ''}`); return { executed }; }
    throw new Error(`unexpected ${op}`);
  };
  return { call, log };
}

test('processAudio: all events of the track, the mapped command, selection restored, events back', async () => {
  const b = procBridge();
  const r = await processAudio(b.call, { track: 'Drums', action: 'quantize' });
  assert.deepEqual(b.log, ['selectEvents Drums', 'command Event/Quantize', 'deselect', 'selectTrack Vox true', 'selectTrack Gtr false', 'task events']);
  assert.equal(r.command, 'Event/Quantize');
  assert.deepEqual(r.events, [{ number: 1, name: 'beat' }]);
});

test('processAudio: one event, and every action maps to a command', async () => {
  const b = procBridge();
  await processAudio(b.call, { track: 'Drums', action: 'reverse', event: 2 });
  assert.deepEqual(b.log.slice(0, 2), ['task selectEvent 2', 'command Audio/Reverse Audio']);
  assert.deepEqual(AUDIO_ACTIONS, ['detect_transients', 'quantize', 'quantize_50', 'apply_bend', 'remove_bend_markers', 'normalize', 'reverse', 'merge', 'melodyne', 'event_fx', 'render_event_fx']);
});

test('processAudio event_fx: class ID by name, Insert Event FX args; plugin required; tail range', async () => {
  const b = procBridge();
  const r = await processAudio(b.call, { track: 'Drums', action: 'event_fx', plugin: 'Pro EQ', tail: 4 });
  assert.ok(b.log.includes('command Audio/Insert Event FX ["mode",1,"cid","{EQ}","preset","","tail",4]'));
  assert.equal(r.plugin, 'Pro EQ');
  await assert.rejects(processAudio(procBridge().call, { track: 'Drums', action: 'event_fx' }), /needs plugin/);
  await assert.rejects(processAudio(procBridge().call, { track: 'Drums', action: 'event_fx', plugin: 'Pro EQ', tail: 40 }), /tail must be 0 to 30/);
  await assert.rejects(processAudio(procBridge().call, { track: 'Drums', action: 'event_fx', plugin: 'Nope' }), /no plug-in named Nope/);
});

test('processAudio refuses unknown actions and non-audio tracks before selecting anything', async () => {
  const b = procBridge({ mediaType: 'Music' });
  await assert.rejects(processAudio(b.call, { track: 'Drums', action: 'quantize' }), /Drums is not an audio track/);
  await assert.rejects(processAudio(b.call, { track: 'Drums', action: 'explode' }), /action must be one of/);
  await assert.rejects(processAudio(b.call, { track: 'Nope', action: 'quantize' }), /no track named Nope/);
  assert.deepEqual(b.log, []);
});

test('processAudio: executed false and a bad event are errors, and the selection is still restored', async () => {
  const b = procBridge({ executed: false });
  await assert.rejects(processAudio(b.call, { track: 'Drums', action: 'normalize' }), /could not run Audio\/Normalize Audio on Drums/);
  assert.ok(b.log.includes('selectTrack Vox true'));
  const c = procBridge({ selectError: 'event 5 does not exist (there are 1)' });
  await assert.rejects(processAudio(c.call, { track: 'Drums', action: 'normalize', event: 5 }), /event 5 does not exist/);
  assert.ok(c.log.includes('deselect') && c.log.includes('selectTrack Vox true'));
});
