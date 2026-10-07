// Plug-in controller: backend selection, reads and writes per backend, presets, removal, the
// Track Edit retry after closing plug-in windows, Studio One's plug-in class list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backendFor, pickBackend, opaqueMessage, getParams, setParams, stateChange, pluginPresets, addPluginWithPreset, removePlugin, runScan,
} from '../src/plugins/controller.js';
import { replaceSlot, writePluginParams, readPluginState } from '../src/plugins/state.js';
import { exportState, loadState } from '../src/plugins/presetio.js';
import { buildVstPreset, writeJuceXml, parseVstPreset, readJuceXml } from '../src/plugins/vstpreset.js';
import { trackTask } from '../src/tracks.js';
import { parsePluginCache, classIdFor } from '../src/plugins/classes.js';

const ARCH = {
  schema: 2,
  name: 'Archetype Petrucci X', vendor: 'Neural DSP',
  capabilities: { hostParams: true, stateRoundTrip: false, xmlState: true },
  params: [
    { key: 'input_gain', name: 'Input Gain', label: 'dB', min: -24, max: 24 },
    { key: 'gate_active', name: 'Gate Active', min: false, max: true },
    { key: 'no_state', name: 'No State' },
  ],
  stateKeys: { input_gain: 'inputGain', gate_active: 'gateActive' },
  stateScale: { input_gain: 1, gate_active: 1 },
};
const MODO = { name: 'MODO BASS', vendor: 'IK', capabilities: { hostParams: false, stateRoundTrip: false, xmlState: false }, params: [{ key: 'bypass', name: 'Bypass' }] };
const GOJIRA = { name: 'Archetype Gojira', capabilities: { hostParams: true, stateRoundTrip: false, xmlState: false }, params: [] };
const BINARY = { name: 'Binary Synth', capabilities: { hostParams: true, stateRoundTrip: true, xmlState: false }, params: [{ key: 'cutoff', name: 'Cutoff' }] };
const BROKEN = { name: 'AmpliTube 5', scanError: 'unsupported plug-in format|details', scanErrorKind: 'error' };
// An XML state whose attributes could not be mapped to any parameter: nothing to edit.
const UNMAPPED = { name: 'Fortin Unmapped', capabilities: { hostParams: true, stateRoundTrip: false, xmlState: true }, params: [{ key: 'gain', name: 'Gain' }], stateKeys: {} };
const catalog = new Map([ARCH, MODO, GOJIRA, BINARY, BROKEN, UNMAPPED].map((e) => [e.name, e]));
const discover = (name) => ({ names: name === 'Pro EQ' ? ['lffreq', 'lfgain', 'hfgain'] : [], sources: [] });
const pluginClass = (name) => ({ 'New VST3 Synth': { file: 'ABC/New VST3 Synth.vst3' }, 'Old VST2 Synth': { file: 'DEF/Old VST2 Synth.dll' } })[name] ?? null;

test('backendFor: native, state and opaque', () => {
  assert.equal(backendFor('Pro EQ', catalog, { discover, pluginClass }), 'native');
  assert.equal(backendFor('Archetype Petrucci X', catalog, { discover, pluginClass }), 'state');
  assert.equal(backendFor('Archetype Petrucci X 2', catalog, { discover, pluginClass }), 'state');
  assert.equal(backendFor('Binary Synth', catalog, { discover, pluginClass }), 'state');
  assert.equal(backendFor('MODO BASS', catalog, { discover, pluginClass }), 'opaque');
  assert.equal(backendFor('Archetype Gojira', catalog, { discover, pluginClass }), 'opaque');
  assert.equal(backendFor('AmpliTube 5', catalog, { discover, pluginClass }), 'opaque');
  assert.equal(backendFor('Some Unscanned Synth', catalog, { discover, pluginClass }), 'opaque');
  assert.equal(pickBackend('AmpliTube 5', catalog, { discover, pluginClass }).reason, 'scanError');
  assert.equal(pickBackend('Some Unscanned Synth', catalog, { discover, pluginClass }).reason, 'unscanned');
  assert.equal(pickBackend('New VST3 Synth', catalog, { discover, pluginClass }).reason, 'unscanned');
  assert.equal(pickBackend('Old VST2 Synth', catalog, { discover, pluginClass }).reason, 'unsupported');
  assert.deepEqual(pickBackend('Fortin Unmapped', catalog, { discover, pluginClass }), { backend: 'opaque', entry: UNMAPPED, reason: 'noState' });
});

test('backendFor: PreSonus names win over a catalog entry of the same name', () => {
  const clash = new Map([['Pro EQ', { name: 'Pro EQ', capabilities: { hostParams: true, xmlState: true } }]]);
  assert.equal(backendFor('Pro EQ', clash, { discover, pluginClass }), 'native');
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
  await assert.rejects(setParams(call, { channel: 'Bass', slot: 0, changes: { Bypass: 1 } }, { catalog, discover, pluginClass }),
    { message: 'MODO BASS does not expose its parameters to hosts; use live_plugin_presets to load a preset instead' });
  await assert.rejects(setParams(call, { channel: 'Goj', slot: 0, changes: { x: 1 } }, { catalog, discover, pluginClass }),
    { message: "Archetype Gojira's parameters could not be mapped to its saved state; use live_plugin_presets to load a preset instead" });
  const old = fakeBridge({ V2: ['Old VST2 Synth'] });
  await assert.rejects(setParams(old.call, { channel: 'V2', slot: 0, changes: { x: 1 } }, { catalog, discover, pluginClass }),
    { message: 'Old VST2 Synth is not supported for parameter control (only VST3 plug-ins are scanned); use live_plugin_presets to load a preset instead' });
  await assert.rejects(setParams(call, { channel: 'Amp', slot: 0, changes: { x: 1 } }, { catalog, discover, pluginClass }), /AmpliTube 5 could not be scanned \(unsupported plug-in format\); re-run live_plugin_scan.*live_plugin_presets/);
  await assert.rejects(setParams(call, { channel: 'Syn', slot: 0, changes: { x: 1 } }, { catalog, discover, pluginClass }), /not in the plug-in catalog: run live_plugin_scan .*npm run scan:setup.*live_plugin_presets/);
  assert.ok(!log.some(([op]) => op === 'setPluginParam'));
  assert.match(opaqueMessage('X', { reason: 'noHostParams' }), /^X does not expose/);
});

test('getParams on a state plug-in maps the XML attributes to parameter names', async () => {
  const { call } = fakeBridge({ Gtr: ['Archetype Petrucci X 2'] });
  let read;
  const readState = async (_c, a) => { read = a; return { xml: '<appModel inputGain="-3.5" gateActive="false" other="1"/>', source: 'song-save', saved: true }; };
  const r = await getParams(call, { channel: 'Gtr', slot: 0 }, { catalog, discover, pluginClass, readState });
  assert.deepEqual(read, { channel: 'Gtr', slot: 0 });
  assert.equal(r.backend, 'state');
  assert.equal(r.realtime, false);
  assert.equal(r.source, 'song-save');
  assert.equal(r.plugin, 'Archetype Petrucci X 2');
  assert.deepEqual(r.params.map((p) => [p.name, p.key, p.value]), [['Input Gain', 'input_gain', -3.5], ['Gate Active', 'gate_active', false]]);
  assert.equal(r.params[0].label, 'dB');
  assert.deepEqual(r.unmapped, ['No State']);
  const f = await getParams(call, { channel: 'Gtr', slot: 0, filter: 'gate' }, { catalog, discover, pluginClass, readState });
  assert.deepEqual(f.params.map((p) => p.key), ['gate_active']);
});

test('getParams: native keeps its output shape plus backend and realtime; opaque returns a note', async () => {
  const { call, log } = fakeBridge({ Voc: ['Pro EQ'], Bass: ['MODO BASS'] });
  const r = await getParams(call, { channel: 'Voc', slot: 0, filter: 'gain' }, { catalog, discover, pluginClass });
  assert.deepEqual(Object.keys(r).sort(), ['backend', 'channel', 'params', 'plugin', 'realtime', 'slot']);
  assert.equal(r.backend, 'native');
  assert.equal(r.realtime, true);
  assert.deepEqual(log.find(([op]) => op === 'pluginParams')[1].names, ['lfgain', 'hfgain']);
  const o = await getParams(call, { channel: 'Bass', slot: 0 }, { catalog, discover, pluginClass });
  assert.equal(o.backend, 'opaque');
  assert.deepEqual(o.params, []);
  assert.match(o.note, /live_plugin_presets/);
  await assert.rejects(getParams(call, { channel: 'Voc', slot: 3 }, { catalog, discover, pluginClass }), /no plug-in in slot 3 on Voc \(live_inserts lists the slots; for an instrument itself give instrument instead/);
});

test('setParams native: one change keeps the bridge shape, a batch returns results', async () => {
  const { call, log } = fakeBridge({ Voc: ['Pro EQ'] });
  const one = await setParams(call, { channel: 'Voc', slot: 0, changes: { lfgain: '-3 dB' } }, { catalog, discover, pluginClass });
  assert.equal(one.param, 'lfgain');
  assert.equal(one.backend, 'native');
  assert.equal(one.realtime, true);
  const many = await setParams(call, { channel: 'Voc', slot: 0, changes: { lfgain: 2, hfgain: { normalized: 0.25 }, lffreq: true } }, { catalog, discover, pluginClass });
  assert.equal(many.results.length, 3);
  const sets = log.filter(([op]) => op === 'setPluginParam').map(([, a]) => a);
  assert.deepEqual(sets.map(({ param, text, value, normalized }) => ({ param, text, value, normalized })), [
    { param: 'lfgain', text: '-3 dB', value: undefined, normalized: undefined },
    { param: 'lfgain', text: undefined, value: 2, normalized: undefined },
    { param: 'hfgain', text: undefined, value: undefined, normalized: 0.25 },
    { param: 'lffreq', text: undefined, value: 1, normalized: undefined },
  ]);
});

test('setParams state: an unknown parameter, an unverified scale or { normalized } fail before Studio One is touched', async () => {
  const { call, log } = fakeBridge({ Gtr: ['Archetype Petrucci X'] });
  const writeParams = async () => assert.fail('must not write');
  const deps = { catalog, discover, pluginClass, writeParams };
  await assert.rejects(setParams(call, { channel: 'Gtr', slot: 0, changes: { 'Fuzz Amount': 3 } }, deps), { message: 'no parameter Fuzz Amount on Archetype Petrucci X (live_plugin_params lists them)' });
  await assert.rejects(setParams(call, { channel: 'Gtr', slot: 0, changes: { 'Fuzz Amount': '3 dB' } }, deps), { message: 'no parameter Fuzz Amount on Archetype Petrucci X (live_plugin_params lists them)' });
  await assert.rejects(setParams(call, { channel: 'Gtr', slot: 0, changes: { input_gain: { normalized: 0.5 } } }, deps), /Input Gain: \{ normalized \} is not accepted/);
  const half = new Map([[ARCH.name, { ...ARCH, stateScale: { gate_active: 1 }, unverifiedKeys: ['input_gain'] }]]);
  await assert.rejects(setParams(call, { channel: 'Gtr', slot: 0, changes: { input_gain: 3 } }, { ...deps, catalog: half }), /Input Gain on Archetype Petrucci X cannot be set: the scan could not verify/);
  const old = new Map([[ARCH.name, { ...ARCH, schema: undefined, stateScale: undefined }]]);
  await assert.rejects(setParams(call, { channel: 'Gtr', slot: 0, changes: { input_gain: 3 } }, { ...deps, catalog: old }), /older scan.*run live_plugin_scan/);
  assert.ok(log.every(([op]) => op === 'inserts'));
});

test('setParams state: values converted, one write with the catalog entry', async () => {
  const { call } = fakeBridge({ Gtr: ['Archetype Petrucci X'] });
  let seen;
  const writeParams = async (_c, a) => { seen = a; return { applied: a.changes, missing: [], backend: 'state', realtime: false }; };
  const r = await setParams(call, { channel: 'Gtr', slot: 0, changes: { 'Input Gain': '6 dB', gate_active: 0 } }, { catalog, discover, pluginClass, writeParams });
  assert.equal(seen.entry, ARCH);
  assert.deepEqual(seen.changes, { 'Input Gain': 6, gate_active: false });
  assert.equal(r.backend, 'state');
});

test('setParams state: a wrong unit or an out-of-range value fails before Studio One is touched', async () => {
  const { call, log } = fakeBridge({ Gtr: ['Archetype Petrucci X'] });
  const writeParams = async () => assert.fail('must not write');
  await assert.rejects(setParams(call, { channel: 'Gtr', slot: 0, changes: { 'Input Gain': '2 kHz' } }, { catalog, discover, pluginClass, writeParams }),
    { message: 'Input Gain is in dB; "2 kHz" not understood' });
  await assert.rejects(setParams(call, { channel: 'Gtr', slot: 0, changes: { input_gain: 30 } }, { catalog, discover, pluginClass, writeParams }),
    { message: 'Input Gain must be within -24..24 dB; got 30' });
  assert.deepEqual(log.map(([op]) => op), ['inserts', 'inserts']);
});

test('setParams state, binary flavour: text passes unchanged to the plug-in', async () => {
  const { call } = fakeBridge({ Syn: ['Binary Synth'] });
  let seen;
  await setParams(call, { channel: 'Syn', slot: 0, changes: { cutoff: '2 kHz' } }, { catalog, discover, pluginClass, writeParams: async (_c, a) => { seen = a; return {}; } });
  assert.deepEqual(seen.changes, { cutoff: '2 kHz' });
});

test('stateChange: units must match the catalog label, words to booleans, normalized refused, choices range-checked', () => {
  const hz = { name: 'Freq', label: 'Hz', min: 20, max: 20000 };
  const pct = { name: 'Mix', label: '%', min: 0, max: 100 };
  const unit = { name: 'Amount', label: '', min: 0, max: 1 };
  const sec = { name: 'Release', label: 's', min: 0, max: 5 };
  assert.equal(stateChange('-12.5 dB', { name: 'Gain', label: 'dB', min: -24, max: 24 }), -12.5);
  assert.equal(stateChange('2 kHz', hz), 2000);
  assert.equal(stateChange('440 hz', hz), 440);
  assert.equal(stateChange('250 ms', sec), 0.25);
  assert.equal(stateChange('50%', pct), 50, 'in the parameter units; the state scale is applied when writing');
  assert.throws(() => stateChange('50%', unit), { message: 'Amount is unitless; "50%" not understood' });
  assert.throws(() => stateChange('2 kHz', { name: 'Gain', label: 'dB', min: -24, max: 24 }), /Gain is in dB; "2 kHz" not understood/);
  assert.throws(() => stateChange('30000 Hz', hz), /Freq must be within 20\.\.20000 Hz; got 30000/);
  assert.throws(() => stateChange(-1, unit), /Amount must be within 0\.\.1; got -1/);
  assert.equal(stateChange('2 kHz', hz, { binary: true }), '2 kHz');
  assert.equal(stateChange('Off', { name: 'Gate', isBoolean: true }), false);
  assert.equal(stateChange('on', { name: 'Gate', min: false, max: true }), true);
  assert.equal(stateChange('true', { name: 'Mode', type: 'choice', choices: 2 }), true, 'a choice of two is on/off');
  assert.equal(stateChange('Clean Channel', undefined, { binary: true }), 'Clean Channel');
  assert.equal(stateChange(1, { min: false, max: true }), true);
  assert.equal(stateChange(1, { min: 0, max: 10 }), 1);
  // A linear 0..1 of the catalog range is wrong for log tapers and for states that keep 0..1 themselves.
  assert.throws(() => stateChange({ normalized: 0.5 }, pct), { message: "Mix: { normalized } is not accepted for third-party plug-ins (their saved state is not a linear 0..1 of the range); give the value in the parameter's units, as live_plugin_params shows it" });
  assert.throws(() => stateChange({ normalized: 0.5 }, pct, { binary: true }), /not accepted/);
  const amp = { name: 'Amp Type', type: 'choice', choices: 4, min: null, max: null };
  assert.equal(stateChange(3, amp), 3);
  assert.equal(stateChange('0', amp), 0);
  assert.throws(() => stateChange(4, amp), { message: 'Amp Type is a choice of 4 (0..3, as live_plugin_params shows it); got 4' });
  assert.throws(() => stateChange(1.5, amp), /choice of 4/);
});

test('stateChange: XML state refuses non-numeric text instead of writing it (live: "Clean" became Amp Type 0)', () => {
  const enumP = { name: 'Amp Type', label: '', min: null, max: null, isDiscrete: true };
  assert.throws(() => stateChange('Clean', enumP), {
    message: `Amp Type takes a number in this plug-in's saved state (range not known: read the current value with live_plugin_params); "Clean" is not a number`,
  });
  assert.throws(() => stateChange('loud', { name: 'Input Gain', label: 'dB', min: -24, max: 24 }),
    { message: `Input Gain takes a number in this plug-in's saved state (-24..24 dB); "loud" is not a number` });
  assert.throws(() => stateChange('maybe', { name: 'Gate Active', min: false, max: true }),
    { message: 'Gate Active takes on/off (or true/false, 1/0); "maybe" is not one of those' });
  assert.throws(() => stateChange('Clean Channel'), /takes a number/);
  assert.equal(stateChange('2', enumP), 2);
  assert.equal(stateChange(2, enumP), 2);
  assert.equal(stateChange('Clean', enumP, { binary: true }), 'Clean');
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
  await assert.rejects(pluginPresets(call, { action: 'list' }, { classIdFor: () => 'x' }), /give channel and slot, instrument, or plugin/);
});

test('live_plugin_presets load goes through the shared replace-slot flow', async () => {
  const { call } = taskBridge({ Voc: ['Pro EQ'] }, { listPresets: () => PRESETS });
  let seen;
  const replace = async (_c, a) => { seen = a; return { slotName: 'FX02', plugin: 'Pro EQ', bypassed: true }; };
  const r = await pluginPresets(call, { channel: 'Voc', slot: 0, action: 'load', preset: 'Kick' }, { classIdFor: () => '{C}', replace });
  assert.deepEqual(seen, { channel: 'Voc', slot: 0, cid: '{C}', preset: 'Kick' });
  assert.equal(r.slotName, 'FX02');
  assert.equal(r.bypassed, true);
  assert.equal(r.backend, 'preset');
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

test('live_remove_plugin: a remove whose answer timed out but that happened is a success', async () => {
  const racks = { Voc: ['Pro EQ', 'Compressor'] };
  const { call } = taskBridge(racks, { slotCommand: () => { racks.Voc.splice(1, 1); throw new Error('Studio One did not answer "trackTask" within 30000ms.'); } });
  const seen = [];
  const spy = async (op, args, o) => { seen.push([op, o]); return call(op, args); };
  const r = await removePlugin(spy, { channel: 'Voc', slot: 1 }, { closeWindows: async () => [] });
  assert.equal(r.removed, 'Compressor');
  assert.deepEqual(seen.find(([op]) => op === 'trackTask')[1], { timeoutMs: 30000 });
  const notDone = taskBridge({ Voc: ['Pro EQ'] }, { slotCommand: () => { throw new Error('Studio One did not answer "trackTask" within 30000ms.'); } });
  await assert.rejects(removePlugin(notDone.call, { channel: 'Voc', slot: 0 }, { closeWindows: async () => [] }), /did not answer/);
});

test('live_add_plugin with a preset: an insert whose answer timed out but that happened is a success', async () => {
  const racks = { Voc: ['Pro EQ'] };
  const { call } = taskBridge(racks, { listPresets: () => PRESETS, insertPreset: () => { racks.Voc.push('Pro EQ 2'); throw new Error('Studio One did not answer "trackTask" within 30000ms.'); } });
  const seen = [];
  const spy = async (op, args, o) => { if (op === 'trackTask') seen.push([args.ops[0].op, o]); return call(op, args); };
  const r = await addPluginWithPreset(spy, { channel: 'Voc', plugin: 'Pro EQ', preset: 'Kick' }, { classIdFor: () => '{C}' });
  assert.equal(r.slotName, 'FX02');
  assert.deepEqual(r.inserts.map((i) => i.name), ['Pro EQ', 'Pro EQ 2']);
  assert.deepEqual(seen.find(([op]) => op === 'insertPreset')[1], { timeoutMs: 30000 });
  const notDone = taskBridge({ Voc: ['Pro EQ'] }, { listPresets: () => PRESETS, insertPreset: () => { throw new Error('Studio One did not answer "trackTask" within 30000ms.'); } });
  await assert.rejects(addPluginWithPreset(notDone.call, { channel: 'Voc', plugin: 'Pro EQ', preset: 'Kick' }, { classIdFor: () => '{C}' }), /did not answer/);
});

test('session-changing plug-in operations run one at a time', async () => {
  const { call } = fakeBridge({ Gtr: ['Archetype Petrucci X'], Voc: ['Pro EQ', 'Compressor'] });
  const events = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const writeParams = async () => { events.push('write:start'); await gate; events.push('write:end'); return { applied: {} }; };
  const removeCall = async (op, args, o) => {
    if (op === 'insertSlotName') return { name: 'FX02' };
    if (op === 'trackTask') { events.push('remove'); return { results: [{ done: true }] }; }
    if (op === 'inserts') return call(op, args, o);
    return call(op, args, o);
  };
  const a = setParams(call, { channel: 'Gtr', slot: 0, changes: { input_gain: 1 } }, { catalog, discover, pluginClass, writeParams });
  const b = removePlugin(removeCall, { channel: 'Voc', slot: 1 }, { closeWindows: async () => { events.push('remove:start'); return []; } }).catch(() => null);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, ['write:start'], 'the remove waits for the write');
  release();
  await Promise.all([a, b]);
  assert.deepEqual(events.slice(0, 3), ['write:start', 'write:end', 'remove:start']);
});

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('Archetype Petrucci X (real saved state + real scan): % values read and written on the plug-in scale', async () => {
  // petrucci-state.xml: trimmed from a song's "Presets/Channels/<ch>/1 - Archetype Petrucci X.vstpreset";
  // petrucci-catalog-entry.json: scan-plugin.py's entry for the keys in it.
  const xml = fs.readFileSync(path.join(FIXTURES, 'petrucci-state.xml'), 'utf8');
  const entry = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'petrucci-catalog-entry.json'), 'utf8'));
  assert.equal(entry.stateScale.overdrive_drive, 0.01);
  assert.equal(entry.stateScale.input_gain, 1);
  const cat = new Map([[entry.name, entry]]);
  const { call } = fakeBridge({ Gtr: ['Archetype Petrucci X'] });
  const readState = async () => ({ xml, source: 'song-save', saved: true });
  const r = await getParams(call, { channel: 'Gtr', slot: 0 }, { catalog: cat, discover, pluginClass, readState });
  const v = Object.fromEntries(r.params.map((p) => [p.key, p.value]));
  assert.equal(v.overdrive_drive, 95.1);
  assert.equal(v.compressor_compression, 68.5);
  assert.equal(v.wah_position, 100);
  assert.equal(v.input_gain, 0);
  assert.equal(v.gate_threshold, -93.1);
  assert.equal(v.doubler_spread, 7);
  assert.equal(v.gate_active, true);
  const freq = r.params.find((p) => p.key === 'clean_eq_lo_freq');
  assert.deepEqual([freq.value, freq.stateValue, freq.unverified], [null, 0.5, true]);
  assert.match(r.note, /unverified state scale/);

  // Writing 50 % stores 0.5 (not 50, which the plug-in clamps to 100 %). The edited preset is
  // caught when Studio One is asked to re-index it, then the write is stopped there.
  const presetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's1fix-'));
  const preset = buildVstPreset({ classId: 'ABCDEF019182FAEB4E4453504E4A5058', chunks: [{ id: 'Comp', data: writeJuceXml(xml) }] });
  let presetBytes;
  const spyCall = async (op, args) => {
    if (op === 'command') {
      const dir = path.join(presetsRoot, 'Neural DSP', 'Archetype Petrucci X', 'studio-one-mcp');
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) presetBytes = fs.readFileSync(path.join(dir, f));
      throw new Error('stop here');
    }
    return call(op, args);
  };
  const writeParams = (c, a) => writePluginParams(c, a, {
    platform: 'linux', // the song-save + replace fallback
    readState: async () => ({ channel: 'Gtr', slot: 0, plugin: 'Archetype Petrucci X', classId: 'ABCDEF019182FAEB4E4453504E4A5058', xml, raw: preset, source: 'song-save' }),
    closeWindows: async () => [],
    presetsRoot,
    timeoutMs: 0,
    sleep: async () => {},
  });
  await assert.rejects(setParams(spyCall, { channel: 'Gtr', slot: 0, changes: { 'Overdrive Drive': '50 %', input_gain: -6 } }, { catalog: cat, discover, pluginClass, writeParams }), /did not list the new preset/);
  fs.rmSync(presetsRoot, { recursive: true, force: true });
  const out = readJuceXml(parseVstPreset(presetBytes).chunks[0].data);
  assert.match(out, / overdriveDrive="0\.5" /);
  assert.match(out, / inputGain="-6" /);
  assert.equal(out.replace('overdriveDrive="0.5"', 'overdriveDrive="0.951"').replace('inputGain="-6"', 'inputGain="0"'), xml, 'nothing else changed');
  await assert.rejects(setParams(spyCall, { channel: 'Gtr', slot: 0, changes: { clean_eq_lo_freq: 200 } }, { catalog: cat, discover, pluginClass, writeParams }), /cannot be set: the scan could not verify/);
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

  // Closing the windows fails: the original error comes back, with a hint, not the PowerShell one.
  let j = 0;
  await assert.rejects(
    trackTask(async () => { j++; throw new Error('Studio One: Track/MCP Track Edit is not available right now'); }, { op: 'x' }, { closeWindows: async () => { throw new Error('closing plug-in windows failed: powershell broke'); } }),
    (e) => /^Studio One: Track\/MCP Track Edit is not available right now \(a plug-in window may be open/.test(e.message) && !/powershell/.test(e.message),
  );
  assert.equal(j, 1);
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

test('setParams / getParams state on Windows: the real presetio flow runs inside the session queue without deadlock, no save', async () => {
  let current = buildVstPreset({ classId: 'ABCDEF019182FAEB4E4453504E4A5058', chunks: [{ id: 'Comp', data: writeJuceXml('<appModel inputGain="0" gateActive="true"/>') }] });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1ctl-'));
  const presetOps = [];
  const { call, log } = fakeBridge({ Gtr: ['Archetype Petrucci X'] }, {
    presetCommand: (a) => { presetOps.push(a.command); return { ok: true, ran: 1 }; },
  });
  // Stand-ins for the dialog scripts: "export" writes the plug-in's state to the typed path, "load" reads it in.
  const dialog = {
    tmpDir,
    snapshot: async () => ({ pid: 1, exclude: [] }),
    cancelWatch: async () => ({ cancelled: [] }),
    fill: async ({ path: p, expect }) => {
      if (expect === 'export') fs.writeFileSync(p + '.vstpreset', current);
      else current = fs.readFileSync(p);
      return { ok: true };
    },
  };
  const io = { exportState: (c, t) => exportState(c, t, dialog), loadState: (c, t, b, e) => loadState(c, t, b, e, dialog) };
  const writeParams = (c, a) => writePluginParams(c, a, { platform: 'win32', io });
  const readState = (c, t) => readPluginState(c, t, { platform: 'win32', io });
  const deps = { catalog, discover, pluginClass, writeParams, readState };
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock')), 5000));
  const [w1, r1, w2] = await Promise.race([Promise.all([
    setParams(call, { channel: 'Gtr', slot: 0, changes: { 'Input Gain': '5 dB' } }, deps),
    getParams(call, { channel: 'Gtr', slot: 0, filter: 'input' }, deps),
    setParams(call, { channel: 'Gtr', slot: 0, changes: { input_gain: 0 } }, deps),
  ]), timeout]);
  assert.equal(w1.inPlace, true);
  assert.deepEqual(w1.applied, { 'Input Gain': 5 });
  assert.equal(w1.unconfirmed, undefined);
  assert.equal(r1.source, 'export');
  // getParams queues after its rack lookup, so it runs after the second write.
  assert.deepEqual(r1.params.map((p) => [p.key, p.value]), [['input_gain', 0]]);
  assert.equal(w2.inPlace, true);
  assert.match(readJuceXml(parseVstPreset(current).chunks[0].data), /inputGain="0"/);
  assert.deepEqual(presetOps, ['Export Preset', 'Load Preset File', 'Export Preset', 'Export Preset', 'Load Preset File', 'Export Preset', 'Export Preset']);
  assert.ok(!log.some(([op]) => ['save', 'trackTask', 'command'].includes(op)), 'no song save, no insert/remove, no re-index');
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'temp presets deleted');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
