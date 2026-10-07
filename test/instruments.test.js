// Instrument addressing (Environment/Synths), target resolution and preset commands on the bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeHost, fakeMixer, fakeDocument, loadComponent, MAILBOX } from './helpers/s1host.js';
import { listInstruments, presetCommand } from '../src/plugins/controller.js';

const plain = (v) => JSON.parse(JSON.stringify(v));

function setup({ instruments, presetLog = [] } = {}) {
  const document = fakeDocument({
    instruments: instruments || [
      { name: 'Mai Tai', params: { cutoff: { value: 0.5 } } },
      { name: 'Mai Tai 2', params: { cutoff: { value: 0.25 } } },
      { name: 'Impact' },
    ],
  });
  const host = fakeHost({ document });
  const mixer = fakeMixer([{ label: 'Vox', inserts: [{ name: 'Fat Channel', fx: 'FX01', params: { 'comp.ratio': { value: 2, min: 1, max: 20 } } }] }], { presetLog });
  const { component, params } = loadComponent({ host, config: { mailbox: MAILBOX }, mixer });
  let n = 0;
  const ring = (op, args) => {
    host.client.write('request.json', { id: `i${++n}`, op, args });
    component.paramChanged(params[0]);
    return host.client.read('response.json');
  };
  return { ring, document, presetLog };
}

test('instruments: Inst01.. with device titles; null-safe without a Synths folder', () => {
  const { ring } = setup();
  assert.deepEqual(plain(ring('instruments', {}).result), [
    { index: 1, component: 'Inst01', name: 'Mai Tai' },
    { index: 2, component: 'Inst02', name: 'Mai Tai 2' },
    { index: 3, component: 'Inst03', name: 'Impact' },
  ]);
  const none = setup({ instruments: [] });
  assert.deepEqual(plain(none.ring('instruments', {}).result), []);
});

test('instrument target: exact title wins over a longer one; InstNN; case-insensitive fallback', () => {
  const { ring } = setup();
  assert.equal(ring('pluginParams', { instrument: 'Mai Tai', names: ['cutoff'] }).result.params[0].value, 0.5);
  assert.equal(ring('pluginParams', { instrument: 'Mai Tai 2', names: ['cutoff'] }).result.params[0].value, 0.25);
  assert.equal(ring('pluginParams', { instrument: 'Inst02', names: ['cutoff'] }).result.params[0].value, 0.25);
  const ci = plain(ring('pluginParams', { instrument: 'impact', names: ['x'] }).result);
  assert.equal(ci.plugin, 'Impact');
  assert.deepEqual(ci.missing, ['x']);
  assert.match(ring('pluginParams', { instrument: 'Nope', names: [] }).error, /no instrument named Nope \(have: Inst01 \(Mai Tai\)/);
});

test('instrument target: ambiguous case-insensitive match lists the candidates', () => {
  const { ring } = setup({ instruments: [{ name: 'Mai Tai' }, { name: 'MAI TAI' }] });
  assert.match(ring('pluginParams', { instrument: 'mai tai', names: [] }).error, /ambiguous: Inst01 \(Mai Tai\), Inst02 \(MAI TAI\)/);
  assert.equal(ring('pluginParams', { instrument: 'Mai Tai', names: [] }).result.plugin, 'Mai Tai');
});

test('pluginParams / setPluginParam on an instrument; insert shape unchanged', () => {
  const { ring, document } = setup();
  const r = plain(ring('setPluginParam', { instrument: 'Mai Tai 2', param: 'cutoff', normalized: 1 }).result);
  assert.equal(r.instrument, 'Mai Tai 2');
  assert.equal(r.after.value, 1);
  assert.equal(document.instComps.Inst02.find('Device').params.cutoff.value, 1);
  assert.equal(document.instComps.Inst01.find('Device').params.cutoff.value, 0.5);
  const ins = plain(ring('pluginParams', { channel: 'Vox', slot: 0, names: ['comp.ratio'] }).result);
  assert.equal(ins.channel, 'Vox');
  assert.equal(ins.slot, 0);
  assert.equal('instrument' in ins, false);
});

test('openPluginEditor on an instrument runs Device/Edit on its component', () => {
  const { ring, document } = setup();
  assert.deepEqual(plain(ring('openPluginEditor', { instrument: 'Impact' }).result), { instrument: 'Impact', plugin: 'Impact', opened: true });
  assert.deepEqual(document.instLog, [['Device', 'Edit', false]]);
});

test('presetCommand: check first, then run; instrument and insert targets', () => {
  const { ring, document, presetLog } = setup();
  assert.deepEqual(plain(ring('presetCommand', { target: { instrument: 'Mai Tai' }, command: 'Export Preset' }).result), { ok: true });
  assert.deepEqual(document.instLog, [['Presets', 'Export Preset', true], ['Presets', 'Export Preset', false]]);
  assert.deepEqual(plain(ring('presetCommand', { target: { channel: 'Vox', slot: 0 }, command: 'Load Preset File' }).result), { ok: true });
  assert.deepEqual(presetLog, [['Fat Channel', 'Presets', 'Load Preset File', true], ['Fat Channel', 'Presets', 'Load Preset File', false]]);
});

test('presetCommand: bad command, unavailable command, unknown target', () => {
  const { ring, document } = setup({ instruments: [{ name: 'Mute', presets: false }] });
  assert.match(ring('presetCommand', { target: { instrument: 'Mute' }, command: 'Format C' }).error, /command must be/);
  assert.match(ring('presetCommand', { target: { instrument: 'Mute' }, command: 'Export Preset' }).error, /not available for Mute/);
  assert.deepEqual(document.instLog, [['Presets', 'Export Preset', true]]); // never ran
  assert.match(ring('presetCommand', { target: { instrument: 'Zed' }, command: 'Export Preset' }).error, /no instrument named Zed/);
});

test('server wrappers pass the op, target and timeout through', async () => {
  const seen = [];
  const call = async (op, args, opts) => (seen.push([op, args, opts]), op === 'instruments' ? [{ index: 1, component: 'Inst01', name: 'Mai Tai' }] : { ok: true });
  assert.equal((await listInstruments(call))[0].name, 'Mai Tai');
  await presetCommand(call, { instrument: 'Mai Tai' }, 'Export Preset', { timeoutMs: 9000 });
  assert.deepEqual(seen[1], ['presetCommand', { target: { instrument: 'Mai Tai' }, command: 'Export Preset' }, { timeoutMs: 9000 }]);
});
