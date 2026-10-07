// State backend: read a slot's plug-in state from the saved song, edit it, reload it with replace-slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
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
  schema: 2,
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
  stateScale: { input_gain: 1, gate_active: 1, output_gain: 1, broken: 1 },
};

// A fake Studio One: one channel "Gtr" with an insert rack; every bridge call is logged.
// remove: { FX01: 'error' | 'noop' } makes removing that slot fail with an error, or do nothing (done: false).
function fakeStudio({ bypassed = false, failInsert = false, indexAfter = 1, remove = {} } = {}) {
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
          if (remove[o.name] === 'error') return { results: [{ error: 'Remove is not available' }] };
          if (remove[o.name] === 'noop') return { results: [{ done: false }] };
          const i = rack.findIndex((s) => s.fx === o.name);
          assert.equal(i, o.slot, 'a slot is addressed by its name at its current index');
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

// The song-save + replace-slot path is the non-Windows fallback.
const LINUX = { platform: 'linux' };
const opts = (st, extra = {}) => ({
  platform: 'linux',
  presetsRoot: st.presetsRoot,
  readState: async () => ({ channel: 'Gtr', slot: 0, plugin: 'Archetype Petrucci X', ...parseState(preset()), source: 'song-save' }),
  closeWindows: async (o) => (st.log.push(['closeWindows', o && o.channel ? `closeWindows:${o.channel}` : 'closeWindows']), []),
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

test('writePluginParams: a failed remove of the old instance rolls back (new one removed), keeps the original', async () => {
  const st = fakeStudio({ remove: { FX01: 'error' }, bypassed: true });
  await assert.rejects(writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st)),
    /change was not applied: removing the old instance \(FX01\) failed \(Remove is not available\); the new instance was removed again and the original is unchanged in slot 0/);
  assert.deepEqual(st.rack.map((s) => [s.fx, s.bypassed]), [['FX01', true]]);
  assert.deepEqual(leftovers(st.presetsRoot), []);
  assert.equal(ops(st).at(-1), 'Presets/Re-Index Presets');
});

test('writePluginParams: a remove that reports done:false is a failure, not a success', async () => {
  const st = fakeStudio({ remove: { FX01: 'noop' } });
  await assert.rejects(writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st)), /Studio One did not remove it.*original is unchanged/);
  assert.deepEqual(st.rack.map((s) => s.fx), ['FX01']);
});

test('writePluginParams: a remove that "succeeds" but leaves the rack one longer is a failure too', async () => {
  const st = fakeStudio();
  const call = async (op, args) => {
    if (op === 'trackTask' && args.ops[0].op === 'slotCommand' && args.ops[0].name === 'FX01') { st.log.push(['trackTask', 'slotCommand']); return { results: [{ done: true }] }; }
    return st.call(op, args);
  };
  await assert.rejects(writePluginParams(call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st)), /rack has 2 plug-ins afterwards, expected 1.*original is unchanged/);
  assert.deepEqual(st.rack.map((s) => s.fx), ['FX01']);
});

test('writePluginParams: when the rollback fails too, the new instance is bypassed and the error says so', async () => {
  const st = fakeStudio({ remove: { FX01: 'error', FX02: 'error' } });
  await assert.rejects(writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st)),
    /not applied.*removing the new instance \(FX02\) failed too.*new instance in slot 0 was bypassed/);
  assert.deepEqual(st.rack.map((s) => [s.fx, s.bypassed]), [['FX02', true], ['FX01', false]]);
  assert.deepEqual(leftovers(st.presetsRoot), []);
});

test('writePluginParams: windows of the channel are closed before the read; the result warns about GUI edits', async () => {
  const st = fakeStudio();
  const r = await writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st));
  assert.equal(ops(st)[0], 'closeWindows:Gtr');
  assert.match(r.note, /changes made in its window during the few seconds of the write are lost/);
});

test('writePluginParams: a slot holding another plug-in is refused before editing', async () => {
  const st = fakeStudio();
  const o = opts(st, { readState: async () => ({ channel: 'Gtr', slot: 0, plugin: 'Pro EQ', ...parseState(preset()), source: 'song-save' }) });
  await assert.rejects(writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, o), /holds Pro EQ, not Archetype Petrucci X; nothing changed/);
  await assert.rejects(writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: { ...ENTRY, classId: '073C4094E0624FB5832874608DD1A3A4' } }, opts(st)), /nothing changed/);
  assert.ok(!ops(st).includes('insertPreset'));
});

test('writePluginParams: booleans are true/false where the state spells them so, else 1/0 (APVTS)', async () => {
  const st = fakeStudio();
  const xml = '<S gateActive="true"><PARAM id="bypass" value="0"/><PARAM id="mono" value="1"/></S>';
  const entry = {
    ...ENTRY,
    params: [...ENTRY.params, { key: 'bypass', name: 'Bypass' }, { key: 'mono', name: 'Mono' }],
    stateKeys: { gate_active: 'gateActive', bypass: 'PARAM[id=bypass]@value', mono: 'PARAM[id=mono]@value' },
    stateScale: { gate_active: 1, bypass: 1, mono: 1 },
  };
  const o = opts(st, { readState: async () => ({ channel: 'Gtr', slot: 0, plugin: 'Archetype Petrucci X', ...parseState(preset(xml)), source: 'song-save' }) });
  const r = await writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { gate_active: false, bypass: true, mono: false }, entry }, o);
  assert.deepEqual(r.applied, { gate_active: false, bypass: true, mono: false });
  assert.equal(readJuceXml(parseVstPreset(st.written()).chunks[0].data), '<S gateActive="false"><PARAM id="bypass" value="1"/><PARAM id="mono" value="0"/></S>');
});

test('writePluginParams: the trailing re-index also runs after a poll timeout', async () => {
  const st = fakeStudio({ indexAfter: Infinity });
  let now = 0;
  await assert.rejects(writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st, { now: () => now, sleep: async (ms) => { now += ms; }, pollMs: 1000 })), /did not list/);
  assert.equal(ops(st).filter((x) => x === 'Presets/Re-Index Presets').length, 2);
  assert.equal(ops(st).at(-1), 'Presets/Re-Index Presets');
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
  assert.match(r2.note, /^Nothing was applied/);
  assert.doesNotMatch(r2.note, /replaced/);
});

test('writePluginParams: { normalized } is refused (the state is not linear in it), and so is an unverified key', async () => {
  const st = fakeStudio();
  await assert.rejects(writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: { normalized: 0.75 } }, entry: ENTRY }, opts(st)), /Input Gain: \{ normalized \} is not accepted/);
  const unverified = { ...ENTRY, stateScale: { gate_active: 1 }, unverifiedKeys: ['input_gain'] };
  await assert.rejects(writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 3 }, entry: unverified }, opts(st)), /Input Gain on Archetype Petrucci X cannot be set: the scan could not verify/);
  const old = { ...ENTRY, schema: undefined, stateScale: undefined };
  await assert.rejects(writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 3 }, entry: old }, opts(st)), /older scan.*run live_plugin_scan/);
  assert.ok(!ops(st).includes('insertPreset'));
});

test('writePluginParams: values are converted to the state scale (Archetype keeps 0..1 for a 0..100 %)', async () => {
  const st = fakeStudio();
  const xml = '<appModel inputGain="0" overdriveDrive="0.951" cabPan="0" phaserMode="false"/>';
  const entry = {
    ...ENTRY,
    params: [...ENTRY.params, { key: 'overdrive_drive', name: 'Overdrive Drive', label: '%', min: 0, max: 100 }, { key: 'cab_pan', name: 'Cab Pan', type: 'choice', choices: 101 }, { key: 'phaser_mode', name: 'Phaser Mode', type: 'choice', choices: 2 }],
    stateKeys: { ...ENTRY.stateKeys, overdrive_drive: 'overdriveDrive', cab_pan: 'cabPan', phaser_mode: 'phaserMode' },
    stateScale: { ...ENTRY.stateScale, overdrive_drive: 0.01, cab_pan: { a: 1, b: -50 }, phaser_mode: 1 },
  };
  const o = opts(st, { readState: async () => ({ channel: 'Gtr', slot: 0, plugin: 'Archetype Petrucci X', ...parseState(preset(xml)), source: 'song-save' }) });
  const r = await writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { overdrive_drive: 50, input_gain: -6.5, cab_pan: 60, phaser_mode: 1 }, entry }, o);
  assert.deepEqual(r.applied, { overdrive_drive: 50, input_gain: -6.5, cab_pan: 60, phaser_mode: 1 });
  assert.equal(readJuceXml(parseVstPreset(st.written()).chunks[0].data), '<appModel inputGain="-6.5" overdriveDrive="0.5" cabPan="10" phaserMode="true"/>');
});

// The bridge gives up after its timeout while Studio One goes on: the call has happened, but threw.
const lateAnswer = (st, task) => async (op, args, o) => {
  const r = await st.call(op, args, o);
  if (op === 'trackTask' && args.ops[0].op === task) throw new Error('Studio One did not answer "trackTask" within 30000ms.');
  return r;
};

test('replace slot: an insert that timed out but happened carries on (the rack decides)', async () => {
  const st = fakeStudio({ bypassed: true });
  const r = await writePluginParams(lateAnswer(st, 'insertPreset'), { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st));
  assert.equal(r.slotName, 'FX02');
  assert.equal(r.warning, undefined);
  assert.deepEqual(st.rack.map((s) => [s.fx, s.bypassed]), [['FX02', true]]);
});

test('replace slot: a remove that timed out but happened is a success, not a rollback', async () => {
  const st = fakeStudio();
  const r = await writePluginParams(lateAnswer(st, 'slotCommand'), { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st));
  assert.equal(r.slotName, 'FX02');
  assert.deepEqual(st.rack.map((s) => s.fx), ['FX02']);
  assert.equal(ops(st).filter((x) => x === 'slotCommand').length, 1, 'no rollback remove');
});

test('replace slot: an insert that timed out and did not happen fails with the original error', async () => {
  const st = fakeStudio();
  const call = async (op, args, o) => {
    if (op === 'trackTask' && args.ops[0].op === 'insertPreset') throw new Error('Studio One did not answer "trackTask" within 30000ms.');
    return st.call(op, args, o);
  };
  await assert.rejects(writePluginParams(call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st)), /did not answer "trackTask"/);
  assert.deepEqual(st.rack.map((s) => s.fx), ['FX01']);
});

test('replace slot: the bypass is not restored when the slot does not hold the new instance', async () => {
  const st = fakeStudio({ bypassed: true });
  let moved = false;
  const call = async (op, args, o) => {
    if (moved && op === 'insertSlotName' && args.slot === 0) return { name: 'FX09' };
    const r = await st.call(op, args, o);
    if (op === 'trackTask' && args.ops[0].op === 'slotCommand') moved = true;
    return r;
  };
  const r = await writePluginParams(call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st));
  assert.match(r.warning, /slot 0 now holds FX09, not the new instance FX02; the bypass was not restored/);
  assert.deepEqual(st.rack.map((s) => [s.fx, s.bypassed]), [['FX02', false]]);
});

test('rollback: the new instance is bypassed only if the slot holds it', async () => {
  const st = fakeStudio({ remove: { FX01: 'error', FX02: 'error' } });
  const call = async (op, args, o) => {
    if (op === 'insertSlotName' && args.slot === 0 && st.log.filter(([x, t]) => x === 'trackTask' && t === 'slotCommand').length >= 2) return { name: 'FX07' };
    return st.call(op, args, o);
  };
  await assert.rejects(writePluginParams(call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 }, entry: ENTRY }, opts(st)),
    /removing the new instance \(FX02\) failed too.*slot 0 holds FX07, not the new instance FX02, so nothing was bypassed/);
  assert.deepEqual(st.rack.map((s) => [s.fx, s.bypassed]), [['FX02', false], ['FX01', false]]);
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
  const s = await readPluginState(readCall(f, log), { channel: 'Gtr', slot: 0 }, LINUX);
  assert.deepEqual(log, ['inserts', 'song', 'save']);
  assert.equal(s.source, 'song-save');
  assert.equal(s.classId, CLASS_ID);
  assert.equal(s.cid, CID);
  assert.equal(s.xml, XML);
  assert.equal(s.plugin, 'Archetype Petrucci X');
  assert.ok(Buffer.isBuffer(s.raw));
});

test('findSlotPreset: falls back to the "<slot+1> - " prefix; clear error when absent', async () => {
  const f = songFile({ 'Presets/Channels/Gtr/1 - Archetype Petrucci X.vstpreset': preset() });
  const s = await readPluginState(readCall(f), { channel: 'Gtr', slot: 0 }, LINUX);
  assert.equal(s.presetPath, 'Presets/Channels/Gtr/1 - Archetype Petrucci X.vstpreset');
  const g = songFile({ 'Presets/Channels/Other/1 - X.vstpreset': preset() });
  await assert.rejects(readPluginState(readCall(g), { channel: 'Gtr', slot: 0 }, LINUX), /no saved state for slot 0 of Gtr/);
  assert.equal(typeof findSlotPreset, 'function');
});

test('readPluginState: no .song file (untitled song) is an error and never triggers File/Save', async () => {
  for (const fileUrl of [null, 'file:///C:/x/untitled']) {
    const log = [];
    const call = async (op) => {
      log.push(op);
      if (op === 'inserts') return [{ channel: 'Gtr', inserts: [{ slot: 0, name: 'A', bypassed: false }] }];
      if (op === 'song') return { fileUrl };
      throw new Error(op);
    };
    await assert.rejects(readPluginState(call, { channel: 'Gtr', slot: 0 }, LINUX), /no \.song file yet/);
    assert.ok(!log.includes('save'));
  }
});

test('readPluginState: a missing slot is an error before saving', async () => {
  const log = [];
  await assert.rejects(readPluginState(readCall('nope', log), { channel: 'Gtr', slot: 3 }, LINUX), /no plug-in in slot 3 on Gtr/);
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
  const s = await readPluginState(readCall(f, [], async () => { throw new Error('Studio One: File/Save is not available right now'); }), { channel: 'Gtr', slot: 0 }, LINUX);
  assert.equal(s.saved, false);
  assert.equal(s.xml, XML);
  await assert.rejects(readPluginState(readCall(f, [], async () => { throw new Error('did not answer'); }), { channel: 'Gtr', slot: 0 }, LINUX), /could not save the song.*did not answer/);
});

// ---- in place (Windows): Export Preset -> edit -> Load Preset File, no save, no replace ----------

const XML_OF = (buf) => readJuceXml(parseVstPreset(buf).chunks.find((c) => c.id === 'Comp').data);

// A fake plug-in behind Export/Load Preset: holds a state; loadState sets it (unless `ignoreLoads`).
// `call` logs every bridge op; the song-save / replace ops are not expected.
function inPlace({ state = preset(), ext = '.vstpreset', wrap = (b) => b, ignoreLoads = false, inserts = [{ slot: 0, name: 'Archetype Petrucci X', bypassed: false }] } = {}) {
  const log = [];
  const t = { log, state, loads: [], exports: [] };
  t.call = async (op, args = {}) => {
    log.push(args.ops ? args.ops[0].op : op);
    if (op === 'inserts') return [{ channel: 'Gtr', inserts }];
    throw new Error(`unexpected op ${op}`);
  };
  t.io = {
    exportState: async (call, target) => { t.exports.push(target); return { ext, buf: wrap(t.state) }; },
    loadState: async (call, target, buf, e) => { t.loads.push({ target, buf, ext: e }); if (!ignoreLoads && e === '.vstpreset') t.state = buf; return { ok: true }; },
  };
  return t;
}
const WIN = (t, extra = {}) => ({ platform: 'win32', io: t.io, ...extra });
const FORBIDDEN = ['save', 'song', 'insertPreset', 'slotCommand', 'command', 'listPresets', 'setInsertBypass', 'insertSlotName'];

test('readPluginState (Windows): exports the state in place; never saves the song', async () => {
  const t = inPlace();
  const s = await readPluginState(t.call, { channel: 'Gtr', slot: 0 }, WIN(t));
  assert.equal(s.source, 'export');
  assert.equal(s.classId, CLASS_ID);
  assert.equal(s.cid, CID);
  assert.equal(s.xml, XML);
  assert.equal(s.plugin, 'Archetype Petrucci X');
  assert.ok(Buffer.isBuffer(s.raw));
  assert.deepEqual(t.exports, [{ channel: 'Gtr', slot: 0 }]);
  assert.ok(!t.log.some((o) => FORBIDDEN.includes(o)), t.log.join());
});

test('writePluginParams (Windows): export -> edit -> load in place; no save, no insert/remove, no re-index', async () => {
  const t = inPlace();
  const r = await writePluginParams(t.call, { target: { channel: 'Gtr', slot: 0 }, changes: { input_gain: 6, gate_active: false }, entry: ENTRY }, WIN(t));
  assert.equal(r.inPlace, true);
  assert.equal(r.backend, 'state');
  assert.equal(r.realtime, false);
  assert.equal(r.source, 'export');
  assert.deepEqual(r.applied, { input_gain: 6, gate_active: false });
  assert.deepEqual(r.missing, []);
  assert.equal(r.unconfirmed, undefined);
  assert.equal(r.channel, 'Gtr');
  assert.equal(r.slot, 0);
  assert.equal(t.loads.length, 1);
  assert.equal(t.loads[0].ext, '.vstpreset');
  assert.deepEqual(t.loads[0].target, { channel: 'Gtr', slot: 0 });
  assert.match(XML_OF(t.loads[0].buf), /inputGain="6" gateActive="false" outputGain="0"/);
  assert.equal(parseVstPreset(t.loads[0].buf).classId, CLASS_ID);
  assert.equal(t.exports.length, 2, 'exported again after the load to verify');
  assert.ok(!t.log.some((o) => FORBIDDEN.includes(o)), t.log.join());
  assert.doesNotMatch(r.note || '', /replaced/);
});

test('writePluginParams (Windows): channel/slot arguments still work (same as target)', async () => {
  const t = inPlace();
  const r = await writePluginParams(t.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 2 }, entry: ENTRY }, WIN(t));
  assert.equal(r.inPlace, true);
  assert.deepEqual(t.loads[0].target, { channel: 'Gtr', slot: 0 });
});

test('writePluginParams (Windows): a plug-in that ignores the load is reported as unconfirmed', async () => {
  const t = inPlace({ ignoreLoads: true });
  const r = await writePluginParams(t.call, { target: { channel: 'Gtr', slot: 0 }, changes: { input_gain: 6, output_gain: 0 }, entry: ENTRY }, WIN(t));
  assert.deepEqual(r.unconfirmed, ['input_gain'], 'output_gain was already 0, so it reads back as asked');
  assert.match(r.note, /unconfirmed/);
});

test('writePluginParams (Windows): nothing applicable -> nothing loaded', async () => {
  const t = inPlace();
  const r = await writePluginParams(t.call, { target: { channel: 'Gtr', slot: 0 }, changes: { broken: 1 }, entry: ENTRY }, WIN(t));
  assert.deepEqual(r.applied, {});
  assert.deepEqual(r.missing, ['broken']);
  assert.equal(t.loads.length, 0);
});

test('writePluginParams (Windows): a slot holding another plug-in is refused before loading', async () => {
  const t = inPlace({ state: buildVstPreset({ classId: '0'.repeat(32), chunks: [{ id: 'Comp', data: writeJuceXml(XML) }] }), inserts: [{ slot: 0, name: 'Pro EQ', bypassed: false }] });
  await assert.rejects(writePluginParams(t.call, { target: { channel: 'Gtr', slot: 0 }, changes: { input_gain: 1 }, entry: { ...ENTRY, classId: CLASS_ID } }, WIN(t)), /holds Pro EQ, not Archetype Petrucci X; nothing changed/);
  assert.equal(t.loads.length, 0);
});

// A third-party instrument's export: .instrument zip with the synth part, the channel's insert presets and channel data.
const SYNTH_ID = '{ABCDEF01-9182-FAEB-4E44-53504E4A5058}';
function instrumentZip(synthPreset) {
  const parts = `<?xml version="1.0" encoding="UTF-8"?>
<PresetParts>
	<PresetPart>
		<Attribute id="Class:ID" value="${SYNTH_ID}"/>
		<Attribute id="Class:Name" value="Synth X"/>
		<Attribute id="AudioSynth:IsMainPreset" value="1"/>
		<Attribute id="Preset:DataFile" value="Synth X.vstpreset"/>
		<Attribute id="Preset:DataMimeType" value="application/x-steinberg-vstpreset"/>
	</PresetPart>
	<PresetPart>
		<Attribute id="Class:ID" value="{11111111-2222-3333-4444-555555555555}"/>
		<Attribute id="Class:Name" value="Some FX"/>
		<Attribute id="Inserts:DeviceUID" value="{X}"/>
		<Attribute id="Preset:DataFile" value="Synth X/1 - Some FX.vstpreset"/>
		<Attribute id="Preset:DataMimeType" value="application/x-steinberg-vstpreset"/>
	</PresetPart>
</PresetParts>`;
  const meta = `<?xml version="1.0" encoding="UTF-8"?>
<MetaInformation>
	<Attribute id="Class:ID" value="${SYNTH_ID}"/>
	<Attribute id="Class:Name" value="Synth X"/>
	<Attribute id="Document:Title" value="t"/>
	<Attribute id="Document:MimeType" value="application/x.presonus-instrument"/>
</MetaInformation>`;
  return Buffer.from(zipSync({
    'Synth X.vstpreset': new Uint8Array(synthPreset),
    'Synth X/1 - Some FX.vstpreset': strToU8('FX STATE'),
    '.Channels/Channel0.data': strToU8('<Channel/>'),
    'presetparts.xml': strToU8(parts),
    'metainfo.xml': strToU8(meta),
  }));
}

test('instrument target: only the synth part is read, and written back as a synth-only .preset (inserts and channel untouched)', async () => {
  const t = inPlace({ ext: '.instrument', wrap: instrumentZip });
  // Loading the .preset applies the synth state.
  t.io.loadState = async (call, target, buf, e) => {
    t.loads.push({ target, buf, ext: e });
    t.state = Buffer.from(unzipSync(new Uint8Array(buf))['data.vstpreset']);
    return { ok: true };
  };
  const entry = { ...ENTRY, name: 'Synth X', isInstrument: true, classId: CLASS_ID };
  const s = await readPluginState(t.call, { instrument: 'Synth X' }, WIN(t));
  assert.equal(s.classId, CLASS_ID);
  assert.equal(s.xml, XML);
  assert.equal(s.plugin, 'Synth X');
  assert.equal(s.instrument, 'Synth X');
  const r = await writePluginParams(t.call, { target: { instrument: 'Synth X' }, changes: { input_gain: 6 }, entry }, WIN(t));
  assert.equal(r.inPlace, true);
  assert.equal(r.instrument, 'Synth X');
  assert.equal(r.unconfirmed, undefined);
  const load = t.loads[0];
  assert.deepEqual(load.target, { instrument: 'Synth X' });
  assert.equal(load.ext, '.preset');
  const z = unzipSync(new Uint8Array(load.buf));
  assert.deepEqual(Object.keys(z).sort(), ['data.vstpreset', 'metainfo.xml']);
  const meta = strFromU8(z['metainfo.xml']);
  assert.match(meta, /Document:MimeType" value="application\/x-presonus-preset"/);
  assert.match(meta, /Preset:DataFile" value="data\.vstpreset"/);
  assert.match(meta, /Preset:DataMimeType" value="application\/x-steinberg-vstpreset"/);
  assert.match(meta, /Class:ID" value="\{ABCDEF01/);
  assert.match(XML_OF(Buffer.from(z['data.vstpreset'])), /inputGain="6"/);
  assert.ok(!t.log.some((o) => FORBIDDEN.includes(o)), t.log.join());
  assert.ok(!t.log.includes('inserts'), 'an instrument target never looks at a channel rack');
});

test('a .preset export (PreSonus container around a .vstpreset) is edited inside its container', async () => {
  const meta = '<?xml version="1.0" encoding="UTF-8"?>\n<MetaInformation>\n\t<Attribute id="Class:ID" value="' + CID + '"/>\n\t<Attribute id="Class:Name" value="Archetype Petrucci X"/>\n\t<Attribute id="Preset:DataFile" value="data.vstpreset"/>\n</MetaInformation>';
  const wrap = (b) => Buffer.from(zipSync({ 'data.vstpreset': new Uint8Array(b), 'metainfo.xml': strToU8(meta) }));
  const t = inPlace({ ext: '.preset', wrap });
  t.io.loadState = async (call, target, buf, e) => { t.loads.push({ target, buf, ext: e }); t.state = Buffer.from(unzipSync(new Uint8Array(buf))['data.vstpreset']); return { ok: true }; };
  const r = await writePluginParams(t.call, { target: { channel: 'Gtr', slot: 0 }, changes: { input_gain: 3 }, entry: ENTRY }, WIN(t));
  assert.equal(r.inPlace, true);
  assert.equal(t.loads[0].ext, '.preset');
  const z = unzipSync(new Uint8Array(t.loads[0].buf));
  assert.equal(strFromU8(z['metainfo.xml']), meta);
  assert.match(XML_OF(Buffer.from(z['data.vstpreset'])), /inputGain="3"/);
});

test('fallback: off Windows the song-save + replace path is used, and presetio is never touched', async () => {
  const st = fakeStudio();
  const io = { exportState: async () => { throw new Error('io used'); }, loadState: async () => { throw new Error('io used'); } };
  const r = await writePluginParams(st.call, { channel: 'Gtr', slot: 0, changes: { input_gain: 6 }, entry: ENTRY }, opts(st, { io }));
  assert.equal(r.inPlace, undefined);
  assert.ok(ops(st).includes('insertPreset'));
  await assert.rejects(readPluginState(async () => { throw new Error('x'); }, { instrument: 'Mai Tai' }, { platform: 'linux', io }), /instrument.*Windows/);
});
