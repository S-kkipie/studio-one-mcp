// Plug-in controller: backend selection, reads and writes per backend, presets, removal, the
// Track Edit retry after closing plug-in windows, Studio One's plug-in class list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backendFor, pickBackend, opaqueMessage, getParams, setParams, stateChange, pluginPresets, addPluginWithPreset, removePlugin, runScan,
} from '../src/plugins/controller.js';
import { replaceSlot } from '../src/plugins/state.js';
import { trackTask } from '../src/tracks.js';
import { parsePluginCache, classIdFor } from '../src/plugins/classes.js';

const ARCH = {
  name: 'Archetype Petrucci X', vendor: 'Neural DSP',
  capabilities: { hostParams: true, stateRoundTrip: false, xmlState: true },
  params: [
    { key: 'input_gain', name: 'Input Gain', label: 'dB', min: -24, max: 24 },
    { key: 'gate_active', name: 'Gate Active', min: false, max: true },
    { key: 'no_state', name: 'No State' },
  ],
  stateKeys: { input_gain: 'inputGain', gate_active: 'gateActive' },
};
const MODO = { name: 'MODO BASS', vendor: 'IK', capabilities: { hostParams: false, stateRoundTrip: false, xmlState: false }, params: [{ key: 'bypass', name: 'Bypass' }] };
const GOJIRA = { name: 'Archetype Gojira', capabilities: { hostParams: true, stateRoundTrip: false, xmlState: false }, params: [] };
const BINARY = { name: 'Binary Synth', capabilities: { hostParams: true, stateRoundTrip: true, xmlState: false }, params: [{ key: 'cutoff', name: 'Cutoff' }] };
const BROKEN = { name: 'AmpliTube 5', scanError: 'unsupported plug-in format|details', scanErrorKind: 'error' };
const catalog = new Map([ARCH, MODO, GOJIRA, BINARY, BROKEN].map((e) => [e.name, e]));
const discover = (name) => ({ names: name === 'Pro EQ' ? ['lffreq', 'lfgain', 'hfgain'] : [], sources: [] });

test('backendFor: native, state and opaque', () => {
  assert.equal(backendFor('Pro EQ', catalog, { discover }), 'native');
  assert.equal(backendFor('Archetype Petrucci X', catalog, { discover }), 'state');
  assert.equal(backendFor('Archetype Petrucci X 2', catalog, { discover }), 'state');
  assert.equal(backendFor('Binary Synth', catalog, { discover }), 'state');
  assert.equal(backendFor('MODO BASS', catalog, { discover }), 'opaque');
  assert.equal(backendFor('Archetype Gojira', catalog, { discover }), 'opaque');
  assert.equal(backendFor('AmpliTube 5', catalog, { discover }), 'opaque');
  assert.equal(backendFor('Some Unscanned Synth', catalog, { discover }), 'opaque');
  assert.equal(pickBackend('AmpliTube 5', catalog, { discover }).reason, 'scanError');
  assert.equal(pickBackend('Some Unscanned Synth', catalog, { discover }).reason, 'unknown');
});

// A fake bridge with one channel per plug-in name; logs calls.
function fakeBridge(racks, extra = {}) {
  const log = [];
  const call = async (op, args = {}) => {
    log.push([op, args]);
    if (extra[op]) return extra[op](args);
    if (op === 'inserts') return [{ channel: args.channel, inserts: (racks[args.channel] || []).map((name, slot) => ({ slot, name, bypassed: false })) }];
    if (op === 'pluginParams') return { channel: args.channel, slot: args.slot, plugin: racks[args.channel][args.slot], params: args.names.map((name) => ({ name, value: 1, text: '1', min: 0, max: 2, normalized: 0.5 })), missing: [] };
    if (op === 'setPluginParam') return { channel: args.channel, slot: args.slot, plugin: racks[args.channel][args.slot], param: args.param, before: { value: 0 }, after: { value: args.value ?? args.normalized ?? args.text } };
    throw new Error(`unexpected op ${op}`);
  };
  return { call, log };
}

test('setParams on an opaque plug-in explains what is possible', async () => {
  const { call, log } = fakeBridge({ Bass: ['MODO BASS'], Amp: ['AmpliTube 5'], Syn: ['Some Unscanned Synth'], Goj: ['Archetype Gojira'] });
  await assert.rejects(setParams(call, { channel: 'Bass', slot: 0, changes: { Bypass: 1 } }, { catalog, discover }),
    { message: 'MODO BASS does not expose its parameters to hosts; use live_plugin_presets to load a preset instead' });
  await assert.rejects(setParams(call, { channel: 'Goj', slot: 0, changes: { x: 1 } }, { catalog, discover }),
    { message: 'Archetype Gojira does not expose its parameters to hosts; use live_plugin_presets to load a preset instead' });
  await assert.rejects(setParams(call, { channel: 'Amp', slot: 0, changes: { x: 1 } }, { catalog, discover }), /AmpliTube 5 could not be scanned \(unsupported plug-in format\); re-run live_plugin_scan.*live_plugin_presets/);
  await assert.rejects(setParams(call, { channel: 'Syn', slot: 0, changes: { x: 1 } }, { catalog, discover }), /not in the plug-in catalog: run live_plugin_scan .*npm run scan:setup.*live_plugin_presets/);
  assert.ok(!log.some(([op]) => op === 'setPluginParam'));
  assert.match(opaqueMessage('X', { reason: 'noHostParams' }), /^X does not expose/);
});

test('getParams on a state plug-in maps the XML attributes to parameter names', async () => {
  const { call } = fakeBridge({ Gtr: ['Archetype Petrucci X 2'] });
  let read;
  const readState = async (_c, a) => { read = a; return { xml: '<appModel inputGain="-3.5" gateActive="false" other="1"/>', source: 'song-save', saved: true }; };
  const r = await getParams(call, { channel: 'Gtr', slot: 0 }, { catalog, discover, readState });
  assert.deepEqual(read, { channel: 'Gtr', slot: 0 });
  assert.equal(r.backend, 'state');
  assert.equal(r.realtime, false);
  assert.equal(r.source, 'song-save');
  assert.equal(r.plugin, 'Archetype Petrucci X 2');
  assert.deepEqual(r.params.map((p) => [p.name, p.key, p.value]), [['Input Gain', 'input_gain', -3.5], ['Gate Active', 'gate_active', false]]);
  assert.equal(r.params[0].label, 'dB');
  assert.deepEqual(r.unmapped, ['No State']);
  const f = await getParams(call, { channel: 'Gtr', slot: 0, filter: 'gate' }, { catalog, discover, readState });
  assert.deepEqual(f.params.map((p) => p.key), ['gate_active']);
});

test('getParams: native keeps its output shape plus backend and realtime; opaque returns a note', async () => {
  const { call, log } = fakeBridge({ Voc: ['Pro EQ'], Bass: ['MODO BASS'] });
  const r = await getParams(call, { channel: 'Voc', slot: 0, filter: 'gain' }, { catalog, discover });
  assert.deepEqual(Object.keys(r).sort(), ['backend', 'channel', 'params', 'plugin', 'realtime', 'slot']);
  assert.equal(r.backend, 'native');
  assert.equal(r.realtime, true);
  assert.deepEqual(log.find(([op]) => op === 'pluginParams')[1].names, ['lfgain', 'hfgain']);
  const o = await getParams(call, { channel: 'Bass', slot: 0 }, { catalog, discover });
  assert.equal(o.backend, 'opaque');
  assert.deepEqual(o.params, []);
  assert.match(o.note, /live_plugin_presets/);
  await assert.rejects(getParams(call, { channel: 'Voc', slot: 3 }, { catalog, discover }), /no plug-in in slot 3 on Voc/);
});

test('setParams native: one change keeps the bridge shape, a batch returns results', async () => {
  const { call, log } = fakeBridge({ Voc: ['Pro EQ'] });
  const one = await setParams(call, { channel: 'Voc', slot: 0, changes: { lfgain: '-3 dB' } }, { catalog, discover });
  assert.equal(one.param, 'lfgain');
  assert.equal(one.backend, 'native');
  assert.equal(one.realtime, true);
  const many = await setParams(call, { channel: 'Voc', slot: 0, changes: { lfgain: 2, hfgain: { normalized: 0.25 }, lffreq: true } }, { catalog, discover });
  assert.equal(many.results.length, 3);
  const sets = log.filter(([op]) => op === 'setPluginParam').map(([, a]) => a);
  assert.deepEqual(sets.map(({ param, text, value, normalized }) => ({ param, text, value, normalized })), [
    { param: 'lfgain', text: '-3 dB', value: undefined, normalized: undefined },
    { param: 'lfgain', text: undefined, value: 2, normalized: undefined },
    { param: 'hfgain', text: undefined, value: undefined, normalized: 0.25 },
    { param: 'lffreq', text: undefined, value: 1, normalized: undefined },
  ]);
});

test('setParams state: values converted, one write with the catalog entry', async () => {
  const { call } = fakeBridge({ Gtr: ['Archetype Petrucci X'] });
  let seen;
  const writeParams = async (_c, a) => { seen = a; return { applied: a.changes, missing: [], backend: 'state', realtime: false }; };
  const r = await setParams(call, { channel: 'Gtr', slot: 0, changes: { 'Input Gain': '6 dB', gate_active: 0 } }, { catalog, discover, writeParams });
  assert.equal(seen.entry, ARCH);
  assert.deepEqual(seen.changes, { 'Input Gain': 6, gate_active: false });
  assert.equal(r.backend, 'state');
});

test('stateChange: units stripped, words to booleans, normalized kept', () => {
  assert.equal(stateChange('-12.5 dB'), -12.5);
  assert.equal(stateChange('50%'), 50);
  assert.equal(stateChange('Off'), false);
  assert.equal(stateChange('on'), true);
  assert.equal(stateChange('Clean Channel'), 'Clean Channel');
  assert.equal(stateChange(1, { min: false, max: true }), true);
  assert.equal(stateChange(1, { min: 0, max: 10 }), 1);
  assert.deepEqual(stateChange({ normalized: 0.5 }), { normalized: 0.5 });
});

// A Track Edit fake for presets / insert / remove: results per op.
function taskBridge(racks, handlers) {
  const log = [];
  const call = async (op, args = {}) => {
    log.push([op, args.ops ? args.ops[0] : args]);
    if (op === 'inserts') return [{ channel: args.channel, inserts: racks[args.channel].map((name, slot) => ({ slot, name, bypassed: false })) }];
    if (op === 'insertSlotName') return { channel: args.channel, slot: args.slot, name: `FX0${args.slot + 1}` };
    if (op === 'trackTask') return { results: [handlers[args.ops[0].op](args.ops[0])] };
    throw new Error(`unexpected op ${op}`);
  };
  return { call, log };
}

const PRESETS = { presets: [{ index: 1, name: 'Vocal Air' }, { index: 2, name: 'Kick' }] };

test('live_plugin_presets list: by slot or by plug-in name, through the class ID', async () => {
  const { call, log } = taskBridge({ Voc: ['Pro EQ'] }, { listPresets: () => PRESETS });
  const ids = { 'Pro EQ': '{073C4094-E062-4FB5-8328-74608DD1A3A4}' };
  const r = await pluginPresets(call, { channel: 'Voc', slot: 0, action: 'list' }, { classIdFor: (n) => ids[n] });
  assert.deepEqual(r, { channel: 'Voc', slot: 0, plugin: 'Pro EQ', cid: ids['Pro EQ'], count: 2, presets: ['Vocal Air', 'Kick'] });
  assert.equal(log.find(([op]) => op === 'trackTask')[1].cid, ids['Pro EQ']);
  const byName = await pluginPresets(call, { plugin: 'Pro EQ' }, { classIdFor: (n) => ids[n] });
  assert.equal(byName.count, 2);
  await assert.rejects(pluginPresets(call, { plugin: 'Nope' }, { classIdFor: () => null }), /no class ID for Nope/);
  await assert.rejects(pluginPresets(call, { action: 'list' }, { classIdFor: () => 'x' }), /give channel and slot, or plugin/);
});

test('live_plugin_presets load goes through the shared replace-slot flow', async () => {
  const { call } = taskBridge({ Voc: ['Pro EQ'] }, { listPresets: () => PRESETS });
  let seen;
  const replace = async (_c, a) => { seen = a; return { slotName: 'FX02', plugin: 'Pro EQ', bypassed: true }; };
  const r = await pluginPresets(call, { channel: 'Voc', slot: 0, action: 'load', preset: 'Kick' }, { classIdFor: () => '{C}', replace });
  assert.deepEqual(seen, { channel: 'Voc', slot: 0, cid: '{C}', preset: 'Kick' });
  assert.equal(r.slotName, 'FX02');
  assert.equal(r.bypassed, true);
  assert.equal(r.realtime, false);
  await assert.rejects(pluginPresets(call, { channel: 'Voc', slot: 0, action: 'load', preset: 'Nope' }, { classIdFor: () => '{C}', replace }), /no preset named "Nope"/);
  await assert.rejects(pluginPresets(call, { plugin: 'Pro EQ', action: 'load', preset: 'Kick' }, { classIdFor: () => '{C}', replace }), /load needs channel and slot/);
});

test('replaceSlot: insert first at the same position, remove the old by exact name, restore bypass', async () => {
  const rack = [{ name: 'Pro EQ', fx: 'FX01', bypassed: true }];
  const log = [];
  const call = async (op, args = {}) => {
    log.push(op === 'trackTask' ? args.ops[0].op : op);
    if (op === 'inserts') return [{ channel: 'Voc', inserts: rack.map((s, slot) => ({ slot, name: s.name, bypassed: s.bypassed })) }];
    if (op === 'insertSlotName') return { name: rack[args.slot].fx };
    if (op === 'setInsertBypass') { rack[args.slot].bypassed = args.bypassed; return { after: args.bypassed }; }
    const o = args.ops[0];
    if (o.op === 'insertPreset') { assert.equal(o.position, 0); assert.equal(o.preset, 'Kick'); rack.splice(0, 0, { name: 'Pro EQ 2', fx: 'FX02', bypassed: false }); return { results: [{ slot: 'FX02' }] }; }
    if (o.op === 'slotCommand') { assert.equal(o.name, 'FX01'); rack.splice(rack.findIndex((s) => s.fx === o.name), 1); return { results: [{ done: true }] }; }
    throw new Error(o.op);
  };
  let closed = 0;
  const r = await replaceSlot(call, { channel: 'Voc', slot: 0, cid: '{C}', preset: 'Kick' }, { closeWindows: async () => { closed++; return []; } });
  assert.equal(closed, 1);
  assert.deepEqual(r, { slotName: 'FX02', plugin: 'Pro EQ', bypassed: true });
  assert.deepEqual(rack, [{ name: 'Pro EQ 2', fx: 'FX02', bypassed: true }]);
  assert.ok(log.indexOf('insertPreset') < log.indexOf('slotCommand'));
});

test('live_add_plugin with a preset inserts it from the preset list', async () => {
  const { call, log } = taskBridge({ Voc: ['Pro EQ'] }, { listPresets: () => PRESETS, insertPreset: () => ({ channel: 'Voc', slot: 'FX02' }) });
  const r = await addPluginWithPreset(call, { channel: 'Voc', plugin: 'Pro EQ', preset: 'Kick' }, { classIdFor: () => '{C}' });
  const ins = log.find(([op, a]) => op === 'trackTask' && a.op === 'insertPreset')[1];
  assert.deepEqual({ cid: ins.cid, preset: ins.preset, position: ins.position }, { cid: '{C}', preset: 'Kick', position: undefined });
  assert.equal(r.preset, 'Kick');
  assert.equal(r.slotName, 'FX02');
});

test('live_remove_plugin removes the slot by its exact FX name', async () => {
  const racks = { Voc: ['Pro EQ', 'Compressor'] };
  const { call, log } = taskBridge(racks, { slotCommand: (o) => { racks.Voc.splice(1, 1); return { done: true, name: o.name }; } });
  const r = await removePlugin(call, { channel: 'Voc', slot: 1 }, { closeWindows: async () => [] });
  const cmd = log.find(([op]) => op === 'trackTask')[1];
  assert.deepEqual({ command: cmd.command, name: cmd.name }, { command: 'Remove', name: 'FX02' });
  assert.equal(r.removed, 'Compressor');
  assert.deepEqual(r.inserts.map((i) => i.name), ['Pro EQ']);
  const stuck = taskBridge({ Voc: ['Pro EQ'] }, { slotCommand: () => ({ done: false }) });
  await assert.rejects(removePlugin(stuck.call, { channel: 'Voc', slot: 0 }, { closeWindows: async () => [] }), /did not remove Pro EQ/);
});

test('trackTask: when Track Edit is blocked, close plug-in windows once and retry', async () => {
  let n = 0;
  const call = async () => {
    n++;
    if (n === 1) throw new Error('Studio One: Track/MCP Track Edit is not available right now');
    return { results: [{ ok: true }] };
  };
  let closed = 0;
  const r = await trackTask(call, { op: 'listPresets' }, { closeWindows: async () => { closed++; return ['Voc · Inserts · 1 - Pro EQ']; } });
  assert.deepEqual(r, { ok: true });
  assert.equal(closed, 1);
  assert.equal(n, 2);

  // Still blocked after one retry: the error says why; other errors are not retried.
  let m = 0;
  const blocked = async () => { m++; return { results: [{ error: 'Track/MCP Track Edit is not available right now' }] }; };
  await assert.rejects(trackTask(blocked, { op: 'x' }, { closeWindows: async () => [] }), /not available right now \(a plug-in window or a dialog/);
  assert.equal(m, 2);
  let k = 0;
  let closedOther = 0;
  await assert.rejects(trackTask(async () => { k++; return { results: [{ error: 'no channel named X' }] }; }, { op: 'x' }, { closeWindows: async () => { closedOther++; return []; } }), /no channel named X/);
  assert.equal(k, 1);
  assert.equal(closedOther, 0);
});

test("Studio One's plug-in cache gives class IDs by name, VST3 before VST2", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Settings name="Plugins-es" version="1">
 <Section path="00000000/proeq.dspdef"><Attributes><List x:id="Classes">
  <ClassDescription classID="{073C4094-E062-4FB5-8328-74608DD1A3A4}" category="AudioEffect" name="Pro EQ"/>
 </List></Attributes></Section>
 <Section path="A7C95D0C/Archetype Petrucci X.dll"><Attributes><List x:id="Classes">
  <ClassDescription classID="{5653544E-4A50-5861-7263-686574797065}" category="AudioEffect" name="Archetype Petrucci X"/>
 </List></Attributes></Section>
 <Section path="26628C92/Archetype Petrucci X.vst3"><Attributes><List x:id="Classes">
  <ClassDescription classID="{ABCDEF01-9182-FAEB-4E44-53504E4A5058}" category="AudioEffect" name="Archetype Petrucci X"/>
 </List></Attributes></Section>
</Settings>`;
  const classes = parsePluginCache(xml);
  assert.equal(classes.length, 3);
  assert.equal(classIdFor('Pro EQ', classes), '{073C4094-E062-4FB5-8328-74608DD1A3A4}');
  assert.equal(classIdFor('Archetype Petrucci X', classes), '{ABCDEF01-9182-FAEB-4E44-53504E4A5058}');
  assert.equal(classIdFor('Archetype Petrucci X 2', classes), '{ABCDEF01-9182-FAEB-4E44-53504E4A5058}');
  assert.equal(classIdFor('pro eq', classes), '{073C4094-E062-4FB5-8328-74608DD1A3A4}');
  assert.equal(classIdFor('Nothing', classes), null);
});

test('runScan: tells how to set up Python when the venv is missing; summarises by backend', async () => {
  await assert.rejects(runScan({ exists: () => false, scan: async () => assert.fail('should not scan') }), /npm run scan:setup/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1cat-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(ARCH));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(MODO));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(BROKEN));
  const scan = async ({ onProgress }) => { onProgress(ARCH); return { scanned: 1, skipped: 2, errors: 0, total: 3, pruned: 0 }; };
  const r = await runScan({ exists: () => true, scan, catalogDir: dir });
  assert.deepEqual(r.byBackend, { state: 1, opaque: 1, unavailable: 1 });
  assert.deepEqual(r.scannedNow, [{ name: 'Archetype Petrucci X', backend: 'state' }]);
  assert.equal(r.total, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});
