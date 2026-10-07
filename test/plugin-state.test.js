// State backend: read a slot's plug-in state from the saved song, edit it, reload it with replace-slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { buildVstPreset, parseVstPreset, readJuceXml, writeJuceXml } from '../src/plugins/vstpreset.js';
import { execFileSync } from 'node:child_process';
import { readPluginState, writePluginParams, findSlotPreset, braceClassId, APPLY_STATE_SCRIPT } from '../src/plugins/state.js';
import { defaultPython } from '../src/plugins/scan.js';

const CLASS_ID = 'ABCDEF019182FAEB4E4453504E4A5058';
const CID = '{ABCDEF01-9182-FAEB-4E44-53504E4A5058}';
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<appModel inputGain="0" gateActive="true" outputGain="0"><parameters/></appModel>';

const preset = (xml = XML) => buildVstPreset({
  classId: CLASS_ID,
  chunks: [
    { id: 'Comp', data: writeJuceXml(xml) },
    { id: 'Cont', data: Buffer.alloc(0) },
    { id: 'Info', data: Buffer.from('<MetaInfo/>', 'utf8') },
  ],
});

const ENTRY = {
  name: 'Archetype Petrucci X',
  vendor: 'Neural DSP',
  capabilities: { hostParams: true, stateRoundTrip: false, xmlState: true },
  params: [
    { key: 'input_gain', name: 'Input Gain', min: -24, max: 24 },
    { key: 'gate_active', name: 'Gate Active', min: false, max: true },
    { key: 'output_gain', name: 'Output Gain', min: -24, max: 24 },
    { key: 'no_state', name: 'No State' },
  ],
  stateKeys: { input_gain: 'inputGain', gate_active: 'gateActive', output_gain: 'outputGain', broken: 'notInXml' },
};

// A fake Studio One: one channel "Gtr" with an insert rack; every bridge call is logged.
function fakeStudio({ bypassed = false, failInsert = false, indexAfter = 1, failRemove = false } = {}) {
  const log = [];
  const rack = [{ name: 'Archetype Petrucci X', fx: 'FX01', bypassed }];
  let fxCount = 1;
  let polls = 0;
  const indexed = new Set();
  let written = null; // preset file seen in the presets folder when re-indexing
  const st = { log, rack, written: () => written, presetsRoot: fs.mkdtempSync(path.join(os.tmpdir(), 's1state-')) };
  st.call = async (op, args = {}) => {
    log.push([op, args.ops ? args.ops[0].op : args.category ? `${args.category}/${args.name}` : undefined]);
    switch (op) {
      case 'inserts': return [{ channel: 'Gtr', bypassAll: false, inserts: rack.map((s, i) => ({ slot: i, name: s.name, bypassed: s.bypassed })) }];
      case 'insertSlotName': return { channel: 'Gtr', slot: args.slot, name: rack[args.slot].fx };
      case 'setInsertBypass': rack[args.slot].bypassed = args.bypassed; return { after: args.bypassed };
      case 'command': {
        if (args.name === 'Re-Index Presets') {
          const dir = path.join(st.presetsRoot, 'Neural DSP', 'Archetype Petrucci X', 'studio-one-mcp');
          for (const f of fs.readdirSync(dir)) { indexed.add(path.basename(f, '.vstpreset')); written = fs.readFileSync(path.join(dir, f)); }
          throw new Error('Studio One did not answer "command" within 5000ms.');
        }
        return { executed: true };
      }
      case 'trackTask': {
        const o = args.ops[0];
        if (o.op === 'listPresets') {
          assert.equal(o.cid, CID);
          polls++;
          return { results: [{ presets: polls >= indexAfter ? [...indexed].map((name, i) => ({ index: i + 1, name })) : [] }] };
        }
        if (o.op === 'insertPreset') {
          if (failInsert) return { results: [{ error: 'Studio One did not add the plug-in' }] };
          assert.equal(o.cid, CID);
          fxCount++;
          rack.splice(o.position, 0, { name: 'Archetype Petrucci X 2', fx: `FX0${fxCount}`, bypassed: false, preset: o.preset });
          return { results: [{ channel: 'Gtr', slot: `FX0${fxCount}` }] };
        }
        if (o.op === 'slotCommand') {
          if (failRemove) return { results: [{ error: 'Remove is not available' }] };
          const i = rack.findIndex((s) => s.fx === o.name);
          assert.equal(i, o.slot, 'the old slot is addressed at its index after the insert');
          rack.splice(i, 1);
          return { results: [{ done: true }] };
        }
        throw new Error(`unexpected task ${o.op}`);
      }
      default: throw new Error(`unexpected op ${op}`);
    }
  };
  return st;
}

const opts = (st, extra = {}) => ({
  presetsRoot: st.presetsRoot,
  readState: async () => ({ channel: 'Gtr', slot: 0, plugin: 'Archetype Petrucci X', ...parseState(preset()), source: 'song-save' }),
  closeWindows: async () => (st.log.push(['closeWindows']), []),
  sleep: async () => {},
  pollMs: 0,
  uuid: () => 'u-1',
  ...extra,
});

function parseState(buf) {
  const p = parseVstPreset(buf);
  return { classId: p.classId, xml: readJuceXml(p.chunks[0].data), raw: buf };
}

const ops = (st) => st.log.map((l) => l[1] || l[0]);
const leftovers = (root) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); out.push(f); if (e.isDirectory()) walk(f); } };
  walk(root);
  return out;
};

test('writePluginParams: edits the XML, inserts the new instance before removing the old one, cleans up', async () => {
  const st = fakeStudio();
  const r = await writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 6, gate_active: false }, entry: ENTRY }, opts(st));
  assert.deepEqual(r.applied, { input_gain: 6, gate_active: false });
  assert.deepEqual(r.missing, []);
  assert.equal(r.backend, 'state');
  assert.equal(r.realtime, false);
  const xml = readJuceXml(parseVstPreset(st.written()).chunks[0].data);
  assert.match(xml, /inputGain="6" gateActive="false" outputGain="0"/);
  assert.equal(parseVstPreset(st.written()).classId, CLASS_ID);
  const order = ops(st);
  assert.ok(order.indexOf('insertPreset') < order.indexOf('slotCommand'), 'insert before remove');
  assert.ok(order.indexOf('closeWindows') < order.indexOf('insertPreset'), 'plug-in windows closed before track tasks');
  assert.deepEqual(st.rack.map((s) => [s.fx, s.preset]), [['FX02', 'u-1']]);
  assert.deepEqual(leftovers(st.presetsRoot), [], 'temp preset and the folders made for it are gone');
  assert.equal(order.lastIndexOf('Presets/Re-Index Presets'), order.length - 1, 're-indexed after deleting so the preset does not linger');
});

test('writePluginParams: restores the bypass of the replaced slot', async () => {
  const st = fakeStudio({ bypassed: true });
  await writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st));
  assert.equal(st.rack.length, 1);
  assert.equal(st.rack[0].bypassed, true);
  assert.ok(ops(st).indexOf('setInsertBypass') > ops(st).indexOf('slotCommand'));
});

test('writePluginParams: the temp file is deleted when the insert throws, and the old plug-in stays', async () => {
  const st = fakeStudio({ failInsert: true });
  await assert.rejects(writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st)), /did not add the plug-in/);
  assert.deepEqual(leftovers(st.presetsRoot), []);
  assert.deepEqual(st.rack.map((s) => s.fx), ['FX01']);
  assert.ok(!ops(st).includes('slotCommand'), 'nothing removed');
});

test('writePluginParams: a failed remove after a good insert says both instances are there', async () => {
  const st = fakeStudio({ failRemove: true });
  await assert.rejects(writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st)), /new instance is in slot 0.*old one.*slot 1.*Remove is not available/);
  assert.deepEqual(leftovers(st.presetsRoot), []);
});

test('writePluginParams: unknown keys land in missing; parameter names resolve to keys; nothing applicable = no replace', async () => {
  const st = fakeStudio();
  const r = await writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { 'Output Gain': -3, nope: 1, no_state: 2, broken: 1 }, entry: ENTRY }, opts(st));
  assert.deepEqual(r.applied, { 'Output Gain': -3 });
  assert.deepEqual(r.missing, ['nope', 'no_state', 'broken']);
  assert.match(readJuceXml(parseVstPreset(st.written()).chunks[0].data), /outputGain="-3"/);

  const st2 = fakeStudio();
  const r2 = await writePluginParams(st2.call, { channel: 'Gtr', slot: 0, changes: { nope: 1 }, entry: ENTRY }, opts(st2));
  assert.deepEqual(r2.applied, {});
  assert.deepEqual(r2.missing, ['nope']);
  assert.ok(!ops(st2).includes('insertPreset'));
});

test('writePluginParams: { normalized } values become real units from the catalog range', async () => {
  const st = fakeStudio();
  const r = await writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: { normalized: 0.75 } }, entry: ENTRY }, opts(st));
  assert.deepEqual(r.applied, { input_gain: 12 });
  assert.match(readJuceXml(parseVstPreset(st.written()).chunks[0].data), /inputGain="12"/);
});

test('writePluginParams: polling the preset list times out with a clear error, and cleans up', async () => {
  const st = fakeStudio({ indexAfter: Infinity });
  let now = 0;
  await assert.rejects(
    writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st, { timeoutMs: 30000, pollMs: 1000, now: () => now, sleep: async (ms) => { now += ms; } })),
    /Re-Index Presets did not list the new preset u-1 within 30 s/,
  );
  assert.deepEqual(leftovers(st.presetsRoot), []);
  assert.ok(!ops(st).includes('insertPreset'));
});

test('writePluginParams: an opaque plug-in is refused before anything happens', async () => {
  const st = fakeStudio();
  const entry = { ...ENTRY, capabilities: { xmlState: false, stateRoundTrip: false }, stateKeys: {} };
  await assert.rejects(writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry }, opts(st)), /no editable state/);
});

test('writePluginParams: binary state goes through the Python helper', async () => {
  const st = fakeStudio();
  const entry = { ...ENTRY, path: 'C:/x.vst3', capabilities: { xmlState: false, stateRoundTrip: true }, stateKeys: {} };
  let seen;
  const runPython = async (args) => {
    seen = args;
    const changes = JSON.parse(fs.readFileSync(args[3], 'utf8'));
    assert.deepEqual(changes, { input_gain: 6, nope: 1 });
    assert.ok(parseVstPreset(fs.readFileSync(args[2])).classId === CLASS_ID);
    fs.writeFileSync(args[4], JSON.stringify({ comp: Buffer.from('BINARY').toString('base64'), cont: Buffer.from('C').toString('base64'), applied: ['input_gain'], missing: ['nope'] }));
  };
  const r = await writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 6, nope: 1 }, entry }, opts(st, { runPython }));
  assert.match(seen[0], /apply-state\.py$/);
  assert.equal(seen[1], 'C:/x.vst3');
  assert.deepEqual(r.applied, { input_gain: 6 });
  assert.deepEqual(r.missing, ['nope']);
  const out = parseVstPreset(st.written());
  assert.equal(out.chunks.find((c) => c.id === 'Comp').data.toString(), 'BINARY');
  assert.equal(out.chunks.find((c) => c.id === 'Cont').data.toString(), 'C');
  for (const f of seen.slice(2)) assert.equal(fs.existsSync(f), false, 'python temp files removed');
});

// ---- reading -------------------------------------------------------------------

const MIXER = `<?xml version="1.0" encoding="UTF-8"?>
<AudioMixer><Attributes x:id="channels"><ChannelGroup name="AudioTrack">
<AudioTrackChannel label="Gtr"><Attributes x:id="Inserts">
<Attributes name="FX02"><String x:id="presetPath" text="Presets/Channels/Gtr/2 - Archetype Petrucci X.vstpreset"/></Attributes>
<Attributes x:id="Presets"/>
</Attributes></AudioTrackChannel>
</ChannelGroup></Attributes></AudioMixer>`;

function songFile(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1song-'));
  const f = path.join(dir, 'x.song');
  fs.writeFileSync(f, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : new Uint8Array(v)]))));
  return f;
}

function readCall(file, log = [], save = async () => ({ executed: true })) {
  return async (op) => {
    log.push(op);
    if (op === 'inserts') return [{ channel: 'Gtr', inserts: [{ slot: 0, name: 'Archetype Petrucci X', bypassed: false }] }];
    if (op === 'save') return save();
    if (op === 'song') return { fileUrl: pathToFileURL(file).href };
    throw new Error(op);
  };
}

test('readPluginState: saves the song and reads the slot preset the mixer names', async () => {
  const f = songFile({ 'Devices/audiomixer.xml': MIXER, 'Presets/Channels/Gtr/2 - Archetype Petrucci X.vstpreset': preset() });
  const log = [];
  const s = await readPluginState(readCall(f, log), { channel: 'Gtr', slot: 0 });
  assert.deepEqual(log, ['inserts', 'save', 'song']);
  assert.equal(s.source, 'song-save');
  assert.equal(s.classId, CLASS_ID);
  assert.equal(s.cid, CID);
  assert.equal(s.xml, XML);
  assert.equal(s.plugin, 'Archetype Petrucci X');
  assert.ok(Buffer.isBuffer(s.raw));
});

test('findSlotPreset: falls back to the "<slot+1> - " prefix; clear error when absent', async () => {
  const f = songFile({ 'Presets/Channels/Gtr/1 - Archetype Petrucci X.vstpreset': preset() });
  const s = await readPluginState(readCall(f), { channel: 'Gtr', slot: 0 });
  assert.equal(s.presetPath, 'Presets/Channels/Gtr/1 - Archetype Petrucci X.vstpreset');
  const g = songFile({ 'Presets/Channels/Other/1 - X.vstpreset': preset() });
  await assert.rejects(readPluginState(readCall(g), { channel: 'Gtr', slot: 0 }), /no saved state for slot 0 of Gtr/);
  assert.equal(typeof findSlotPreset, 'function');
});

test('readPluginState: a missing slot is an error before saving', async () => {
  const log = [];
  await assert.rejects(readPluginState(readCall('nope', log), { channel: 'Gtr', slot: 3 }), /no plug-in in slot 3 on Gtr/);
  assert.deepEqual(log, ['inserts']);
});

test('braceClassId formats a 32-hex VST3 class id the way Studio One names it', () => {
  assert.equal(braceClassId(CLASS_ID), CID);
  assert.equal(braceClassId(CID), CID);
});

test('apply-state.py --selftest: JUCE base64 and raw_state wrapping round-trip', { skip: !fs.existsSync(defaultPython()) && 'no .venv-scan' }, () => {
  const out = execFileSync(defaultPython(), ['-I', APPLY_STATE_SCRIPT, '--selftest'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), { ok: true });
});

test('readPluginState: a greyed-out File/Save (nothing unsaved) reads the file as it is; other save errors fail', async () => {
  const f = songFile({ 'Devices/audiomixer.xml': MIXER, 'Presets/Channels/Gtr/2 - Archetype Petrucci X.vstpreset': preset() });
  const s = await readPluginState(readCall(f, [], async () => { throw new Error('Studio One: File/Save is not available right now'); }), { channel: 'Gtr', slot: 0 });
  assert.equal(s.saved, false);
  assert.equal(s.xml, XML);
  await assert.rejects(readPluginState(readCall(f, [], async () => { throw new Error('did not answer'); }), { channel: 'Gtr', slot: 0 }), /could not save the song.*did not answer/);
});
