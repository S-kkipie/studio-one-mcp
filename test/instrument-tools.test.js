// Instruments in the plug-in tools, preset loads in place (preset file resolution), live_instruments,
// and the parked fixes (instance timeouts with a re-read, on/off words only for on/off parameters).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import {
  pluginTarget, instrumentAt, getParams, setParams, stateChange, pluginPresets, instrumentsOverview, songInstrumentRouting,
  pickBackend, instrumentClass, savedSynthClassId, presetListName,
} from '../src/plugins/controller.js';
import { findPresetFile, presetFileClassId, ambiguousPresetNames } from '../src/plugins/presetfiles.js';
import { loadablePreset } from '../src/plugins/state.js';
import { addPlugin, addInstrumentTrack, addFxSend, INSTANCE_TIMEOUT_MS } from '../src/tracks.js';
import { presetClass } from '../src/plugins.js';
import { parseXml } from '../src/xml.js';

const MAITAI = '{B625F134-4485-4A50-A3C8-C9CF0C5495E1}';
const INSTRUMENTS = [
  { index: 1, component: 'Inst01', name: 'Mai Tai' },
  { index: 2, component: 'Inst02', name: 'Mai Tai 2' },
  { index: 4, component: 'Inst04', name: 'Impact' },
];

// A fake bridge: instruments, one channel per insert list, plug-in parameter ops; logs calls.
function bridge({ racks = {}, instruments = INSTRUMENTS, extra = {} } = {}) {
  const log = [];
  const call = async (op, args = {}, opts) => {
    log.push([op, args, opts]);
    if (extra[op]) return extra[op](args, opts);
    if (op === 'instruments') return instruments;
    if (op === 'inserts') return [{ channel: args.channel, inserts: (racks[args.channel] || []).map((name, slot) => ({ slot, name, bypassed: false })) }];
    if (op === 'pluginParams') return { ...(args.instrument ? { instrument: args.instrument } : { channel: args.channel, slot: args.slot }), plugin: 'x', params: args.names.map((name) => ({ name, value: 1, text: '1', min: 0, max: 2, normalized: 0.5 })), missing: [] };
    if (op === 'setPluginParam') return { ...(args.instrument ? { instrument: args.instrument } : { channel: args.channel, slot: args.slot }), plugin: 'x', param: args.param, before: { value: 0 }, after: { value: 1 } };
    if (op === 'trackTask' && args.ops[0].op === 'listPresets') return { results: [{ presets: [{ index: 1, name: 'default' }, { index: 2, name: 'Fat Bass' }, { index: 3, name: 'Kick' }, { index: 4, name: 'Gone' }] }] };
    throw new Error(`unexpected op ${op}`);
  };
  return { call, log };
}

const discover = (name) => ({ names: /^Mai Tai/.test(name) ? ['filter.cutoff', 'masterGain.gain'] : name === 'Pro EQ' ? ['lfgain'] : [], sources: [] });
const pluginClass = () => null;
const SYNTH = {
  schema: 2, name: 'VST Synth', capabilities: { hostParams: true, xmlState: true }, params: [{ key: 'cutoff', name: 'Cutoff', label: 'Hz', min: 20, max: 20000 }],
  stateKeys: { cutoff: 'cutoff' }, stateScale: { cutoff: 1 },
};
const catalog = new Map([[SYNTH.name, SYNTH]]);

test('pluginTarget: exactly one of instrument, or channel and slot', () => {
  assert.deepEqual(pluginTarget({ instrument: 'Mai Tai' }), { instrument: 'Mai Tai' });
  assert.deepEqual(pluginTarget({ channel: 'Voc', slot: 0 }), { channel: 'Voc', slot: 0 });
  assert.throws(() => pluginTarget({ instrument: 'Mai Tai', channel: 'Voc', slot: 0 }), /either instrument, or channel and slot, not both/);
  assert.throws(() => pluginTarget({ instrument: 'Mai Tai', slot: 0 }), /not both/);
  assert.throws(() => pluginTarget({ channel: 'Voc' }), /needs both channel and slot/);
  assert.throws(() => pluginTarget({}), /give channel and slot .* or instrument/);
  assert.equal(pluginTarget({}, { optional: true }), null);
});

test('instrumentAt: exact name or InstNN; "Mai Tai" never lands on "Mai Tai 2"', async () => {
  const { call } = bridge();
  assert.equal((await instrumentAt(call, 'Mai Tai')).component, 'Inst01');
  assert.equal((await instrumentAt(call, 'Mai Tai 2')).component, 'Inst02');
  assert.equal((await instrumentAt(call, 'inst04')).name, 'Impact');
  assert.equal((await instrumentAt(call, 'impact')).component, 'Inst04');
  await assert.rejects(instrumentAt(call, 'Mai'), /no instrument named Mai \(have: Mai Tai \[Inst01\], Mai Tai 2 \[Inst02\], Impact \[Inst04\]\)/);
  const twins = bridge({ instruments: [{ index: 1, component: 'Inst01', name: 'Pad' }, { index: 2, component: 'Inst02', name: 'pad' }] });
  assert.equal((await instrumentAt(twins.call, 'pad')).component, 'Inst02', 'exact case first');
  await assert.rejects(instrumentAt(twins.call, 'PAD'), /ambiguous: Inst01, Inst02/);
});

test('getParams / setParams on an instrument: native names, addressed by component, results name the instrument', async () => {
  const { call, log } = bridge();
  const r = await getParams(call, { instrument: 'Mai Tai 2', filter: 'cutoff' }, { catalog, discover, pluginClass });
  assert.equal(r.backend, 'native');
  assert.equal(r.instrument, 'Mai Tai 2');
  assert.equal(r.component, 'Inst02');
  assert.deepEqual(log.find(([op]) => op === 'pluginParams')[1], { instrument: 'Inst02', names: ['filter.cutoff'] });
  const one = await setParams(call, { instrument: 'Mai Tai', changes: { 'masterGain.gain': '-3 dB' } }, { catalog, discover, pluginClass });
  assert.deepEqual([one.instrument, one.component, one.param, one.backend], ['Mai Tai', 'Inst01', 'masterGain.gain', 'native']);
  assert.deepEqual(log.find(([op]) => op === 'setPluginParam')[1], { instrument: 'Inst01', param: 'masterGain.gain', text: '-3 dB' });
  const named = await getParams(call, { instrument: 'Impact', params: ['bypass'] }, { catalog, discover, pluginClass });
  assert.equal(named.instrument, 'Impact');
  await assert.rejects(getParams(call, { instrument: 'Mai Tai', channel: 'X', slot: 0 }, { catalog, discover, pluginClass }), /not both/);
});

test('setParams on a state-backend instrument writes through the state with an instrument target', async () => {
  const { call } = bridge({ instruments: [{ index: 1, component: 'Inst01', name: 'VST Synth' }] });
  let seen;
  const writeParams = async (_c, a) => { seen = a; return { instrument: a.target.instrument, applied: a.changes, missing: [], inPlace: true }; };
  const r = await setParams(call, { instrument: 'VST Synth', changes: { cutoff: '2 kHz' } }, { catalog, discover, pluginClass, writeParams });
  assert.deepEqual(seen.target, { instrument: 'Inst01' });
  assert.deepEqual(seen.changes, { cutoff: 2000 });
  assert.equal(r.instrument, 'VST Synth');
  let read;
  const readState = async (_c, t) => { read = t; return { xml: '<s cutoff="440"/>', source: 'export' }; };
  const g = await getParams(call, { instrument: 'VST Synth' }, { catalog, discover, pluginClass, readState });
  assert.deepEqual(read, { instrument: 'Inst01' });
  assert.deepEqual(g.params.map((p) => [p.key, p.value]), [['cutoff', 440]]);
});

test('stateChange: on/off/true/false only for on/off parameters (boolean or a choice of two)', () => {
  assert.equal(stateChange('on', { name: 'Gate', isBoolean: true }), true);
  assert.equal(stateChange('OFF', { name: 'Mode', type: 'choice', choices: 2 }), false);
  assert.throws(() => stateChange('on', { name: 'Input Gain', label: 'dB', min: -24, max: 24 }),
    { message: 'Input Gain is not an on/off parameter; "on" only works for on/off parameters: give a number within -24..24 dB' });
  assert.throws(() => stateChange('true', { name: 'Amp Type', type: 'choice', choices: 4 }), /Amp Type is not an on\/off parameter/);
  assert.throws(() => stateChange('yes', { name: 'Gate', isBoolean: true }), /takes on\/off/, 'yes/no are not on/off words');
  assert.equal(stateChange('on', undefined, { binary: true }), 'on', 'binary state: text passes unchanged');
});

// ---- preset files -------------------------------------------------------------------------------

const metaXml = (cid, name, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>\n<MetaInformation>\n\t<Attribute id="Class:ID" value="${cid}"/>\n\t<Attribute id="Class:Name" value="${name}"/>\n${extra}</MetaInformation>`;
const presetZip = (cid, name) => zipSync({ 'metainfo.xml': strToU8(metaXml(cid, name, '\t<Attribute id="Preset:DataFile" value="data.fxpreset"/>\n')), 'data.fxpreset': strToU8(`<AudioEffectPreset cid="${cid}"/>`) });
const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
const vstpreset = (hex32) => {
  // "VST3", version 1, 32-char class id, chunk list offset; then an empty "List" chunk list.
  const head = Buffer.alloc(48);
  head.write('VST3', 0, 'ascii'); head.writeInt32LE(1, 4); head.write(hex32, 8, 'ascii'); head.writeBigInt64LE(48n, 40);
  const list = Buffer.alloc(8); list.write('List', 0, 'ascii'); list.writeInt32LE(0, 4);
  return Buffer.concat([head, list]);
};

function presetLibrary() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 's1presetfiles-'));
  const user = path.join(base, 'Documents', 'Studio One', 'Presets');
  const factory = path.join(base, 'Program', 'Presets');
  const vst3 = path.join(base, 'VST3 Presets');
  put(path.join(factory, 'PreSonus', 'Mai Tai', 'default.preset'), presetZip(MAITAI, 'Mai Tai'));
  put(path.join(factory, 'PreSonus', 'Mai Tai', 'Bass', 'Fat Bass.preset'), presetZip(MAITAI, 'Mai Tai'));
  put(path.join(factory, 'PreSonus', 'Mai Tai', 'Lead', 'Fat Bass.preset'), presetZip(MAITAI, 'Mai Tai'));
  // Another plug-in's preset filed under Mai Tai: its class says so, it is skipped.
  put(path.join(factory, 'PreSonus', 'Mai Tai', 'Kick.preset'), presetZip('{073C4094-E062-4FB5-8328-74608DD1A3A4}', 'Pro EQ'));
  put(path.join(user, 'User Presets', 'mai tai', 'My Pad.instrument'), Buffer.from('x'));
  put(path.join(vst3, 'Vendor', 'VST Synth', 'Init.vstpreset'), vstpreset('ABCDEF019182FAEB4E4453504E4A5058'));
  // In a VST3 folder only .vstpreset counts.
  put(path.join(vst3, 'Vendor', 'VST Synth', 'Other.preset'), presetZip('{X}', 'VST Synth'));
  const roots = [{ dir: user, exts: ['.preset', '.vstpreset', '.fxpreset', '.instrument'] }, { dir: factory, exts: ['.preset', '.vstpreset', '.fxpreset', '.instrument'] }, { dir: vst3, exts: ['.vstpreset'] }];
  return { base, user, factory, vst3, roots };
}

test('findPresetFile: plug-in folder under any vendor, case-insensitive name, Folder/Name, class checked, VST3 folders .vstpreset only', () => {
  const { roots, factory, user, vst3 } = presetLibrary();
  const find = (preset, extra = {}) => findPresetFile({ folder: 'Mai Tai', preset, cid: MAITAI, roots, ...extra });
  assert.equal(find('DEFAULT').file, path.join(factory, 'PreSonus', 'Mai Tai', 'default.preset'));
  assert.equal(find('Lead/Fat Bass').file, path.join(factory, 'PreSonus', 'Mai Tai', 'Lead', 'Fat Bass.preset'));
  assert.equal(find('Bass/Fat Bass').file, path.join(factory, 'PreSonus', 'Mai Tai', 'Bass', 'Fat Bass.preset'));
  // One name, several files in one root: refused, listing them relative to the root, until Folder/Name picks one.
  assert.throws(() => find('Fat Bass'), {
    message: `preset "Fat Bass" matches 2 files in ${factory}: PreSonus/Mai Tai/Bass/Fat Bass.preset, PreSonus/Mai Tai/Lead/Fat Bass.preset; pass preset as Folder/Name to pick one ("Bass/Fat Bass" or "Lead/Fat Bass")`,
  });
  assert.throws(() => find('Nowhere/Fat Bass'), /matches 2 files/, 'an unknown folder prefix does not pick one');
  assert.equal(find('Kick'), null, 'another class is skipped');
  assert.equal(find('Kick', { cid: null }).ext, '.preset');
  assert.deepEqual(find('my pad'), { file: path.join(user, 'User Presets', 'mai tai', 'My Pad.instrument'), ext: '.instrument' });
  // The user's folders win over factory ones, whatever the extension.
  put(path.join(user, 'Mine', 'Mai Tai', 'default.instrument'), Buffer.from('x'));
  assert.deepEqual(find('default'), { file: path.join(user, 'Mine', 'Mai Tai', 'default.instrument'), ext: '.instrument' });
  // Same name, same folder, two extensions: refused too; "./Name" picks the one directly in the plug-in folder.
  put(path.join(factory, 'PreSonus', 'Mai Tai', 'Pad.preset'), presetZip(MAITAI, 'Mai Tai'));
  put(path.join(factory, 'PreSonus', 'Mai Tai', 'Pad.fxpreset'), Buffer.from(`<AudioEffectPreset cid="${MAITAI}"/>`));
  put(path.join(factory, 'PreSonus', 'Mai Tai', 'Lead', 'Lead Pad.preset'), presetZip(MAITAI, 'Mai Tai'));
  assert.throws(() => find('Pad'), /matches 2 files .*PreSonus\/Mai Tai\/Pad\.fxpreset, PreSonus\/Mai Tai\/Pad\.preset/);
  assert.equal(find('./default', { roots: roots.slice(1) }).file, path.join(factory, 'PreSonus', 'Mai Tai', 'default.preset'));
  assert.equal(find('My Pad', { exts: ['.preset', '.vstpreset'] }), null);
  assert.equal(find('Gone'), null);
  const vst = findPresetFile({ folder: 'VST Synth', preset: 'Init', cid: '{ABCDEF01-9182-FAEB-4E44-53504E4A5058}', roots });
  assert.deepEqual(vst, { file: path.join(vst3, 'Vendor', 'VST Synth', 'Init.vstpreset'), ext: '.vstpreset' });
  assert.equal(findPresetFile({ folder: 'VST Synth', preset: 'Other', roots }), null, 'a .preset in a VST3 folder is not taken');
  assert.equal(presetFileClassId(vst.file), '{ABCDEF01-9182-FAEB-4E44-53504E4A5058}');
});

// An .instrument as Studio One exports it (7.2.3, Mai Tai): synth + an insert + channel data.
function instrumentBundle() {
  const parts = `<PresetParts>
<PresetPart><Attributes><Attribute id="AudioSynth:IsMainPreset" value="1"/><Attribute id="Class:Name" value="Mai Tai"/><Attribute id="Preset:DataFile" value="Mai Tai.fxpreset"/><Attribute id="Preset:DataMimeType" value="audio/x-fxpreset+xml"/></Attributes></PresetPart>
<PresetPart><Attributes><Attribute id="Inserts:DeviceUID" value="{1}"/><Attribute id="Preset:DataFile" value="Mai Tai/1 - Archetype.vstpreset"/></Attributes></PresetPart>
</PresetParts>`;
  return zipSync({
    'Mai Tai.fxpreset': strToU8(`<AudioEffectPreset cid="${MAITAI}"/>`),
    'Mai Tai/1 - Archetype.vstpreset': strToU8('insert'),
    '.Channels/Channel0.data': strToU8('<Channel/>'),
    'presetparts.xml': strToU8(parts),
    'metainfo.xml': strToU8(metaXml(MAITAI, 'Mai Tai', '\t<Attribute id="Document:MimeType" value="application/x.presonus-instrument"/>\n')),
  });
}

test('loadablePreset: an instrument only ever gets a synth-only .preset; inserts take .preset/.vstpreset as they are', () => {
  const synth = loadablePreset('.instrument', instrumentBundle(), { instrument: true });
  assert.equal(synth.ext, '.preset');
  const z = unzipSync(new Uint8Array(synth.buf));
  assert.deepEqual(Object.keys(z).sort(), ['data.fxpreset', 'metainfo.xml'], 'no insert presets, no channel data');
  assert.match(strFromU8(z['metainfo.xml']), /Preset:DataMimeType" value="audio\/x-fxpreset"/);
  assert.match(strFromU8(z['metainfo.xml']), /Document:MimeType" value="application\/x-presonus-preset"/);
  assert.throws(() => loadablePreset('.instrument', instrumentBundle()), /can only go on an instrument/);
  // A multi-part .preset is a bundle too.
  const multi = loadablePreset('.preset', instrumentBundle(), { instrument: true });
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(multi.buf))).sort(), ['data.fxpreset', 'metainfo.xml']);
  const plain = presetZip(MAITAI, 'Mai Tai');
  assert.deepEqual(loadablePreset('.preset', plain, { instrument: true }).buf, Buffer.from(plain));
  const v = vstpreset('ABCDEF019182FAEB4E4453504E4A5058');
  assert.equal(loadablePreset('.vstpreset', v).ext, '.vstpreset');
  const wrapped = loadablePreset('.vstpreset', v, { instrument: true, cls: { cid: '{C}', name: 'VST Synth' } });
  const w = unzipSync(new Uint8Array(wrapped.buf));
  assert.deepEqual(Object.keys(w).sort(), ['data.vstpreset', 'metainfo.xml']);
  assert.match(strFromU8(w['metainfo.xml']), /Class:ID" value="\{C\}"[\s\S]*application\/x-steinberg-vstpreset/);
  assert.equal(loadablePreset('.fxpreset', strToU8('<AudioEffectPreset/>'), { cls: { cid: '{C}', name: 'Pro EQ' } }).ext, '.preset');
});

// ---- preset load ---------------------------------------------------------------------------------

function loadDeps(found, extra = {}) {
  const loads = [];
  const replaced = [];
  return {
    loads,
    replaced,
    deps: {
      platform: 'win32',
      classIdFor: () => MAITAI,
      pluginClass: () => null,
      presetClass: (n) => ({ classId: MAITAI, className: String(n).replace(/\s+\d+$/, '') }),
      findFile: (q) => { loads.query = q; return typeof found === 'function' ? found(q) : found; },
      io: { loadState: async (_c, target, buf, ext) => { loads.push({ target, buf: Buffer.from(buf), ext }); return { ok: true }; } },
      replace: async (_c, a) => { replaced.push(a); return { slotName: 'FX02', bypassed: false, plugin: 'Pro EQ' }; },
      ...extra,
    },
  };
}

test('preset load on an insert: in place when the file is found (no replace), else the replace-slot fallback', async () => {
  const { roots, factory } = presetLibrary();
  const file = path.join(factory, 'PreSonus', 'Mai Tai', 'default.preset');
  const { call, log } = bridge({ racks: { Voc: ['Pro EQ'] } });
  const a = loadDeps({ file, ext: '.preset' });
  const r = await pluginPresets(call, { channel: 'Voc', slot: 0, action: 'load', preset: 'Kick' }, a.deps);
  assert.equal(r.inPlace, true);
  assert.equal(r.file, file);
  assert.deepEqual(a.loads.map((l) => [l.target, l.ext]), [[{ channel: 'Voc', slot: 0 }, '.preset']]);
  assert.deepEqual(a.loads[0].buf, fs.readFileSync(file));
  assert.equal(a.replaced.length, 0);
  assert.deepEqual(r.inserts.map((i) => i.name), ['Pro EQ']);
  assert.deepEqual(a.loads.query.exts, ['.preset', '.vstpreset', '.fxpreset'], 'an insert never takes an .instrument');
  assert.equal(a.loads.query.folder, 'Pro EQ');
  assert.ok(!log.some(([op, args]) => op === 'save' || (op === 'trackTask' && args.ops[0].op !== 'listPresets')), 'no save, no slot commands');

  const b = loadDeps(null);
  const f = await pluginPresets(call, { channel: 'Voc', slot: 0, action: 'load', preset: 'Kick' }, b.deps);
  assert.equal(f.inPlace, false);
  assert.equal(f.slotName, 'FX02');
  assert.deepEqual(b.replaced, [{ channel: 'Voc', slot: 0, cid: MAITAI, preset: 'Kick' }]);
  assert.equal(b.loads.length, 0);

  // Off Windows there is no Load Preset File automation: the replace path, the file is not even looked up.
  const c = loadDeps({ file, ext: '.preset' }, { platform: 'linux' });
  assert.equal((await pluginPresets(call, { channel: 'Voc', slot: 0, action: 'load', preset: 'Kick' }, c.deps)).inPlace, false);
  assert.equal(c.loads.query, undefined);
  void roots;
});

test('preset load on an instrument: synth-only preset in place; never a replace; a missing file is an error', async () => {
  const { base } = presetLibrary();
  const bundle = put(path.join(base, 'x', 'My Pad.instrument'), instrumentBundle());
  const { call, log } = bridge();
  const a = loadDeps({ file: bundle, ext: '.instrument' });
  const r = await pluginPresets(call, { instrument: 'Mai Tai 2', action: 'load', preset: 'Fat Bass' }, a.deps);
  assert.deepEqual([r.instrument, r.component, r.inPlace], ['Mai Tai 2', 'Inst02', true]);
  assert.equal(a.loads.query.folder, 'Mai Tai', 'the class folder, not the instance name');
  assert.equal(a.loads.query.exts, null);
  assert.deepEqual(a.loads[0].target, { instrument: 'Inst02' });
  assert.equal(a.loads[0].ext, '.preset', 'never an .instrument');
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(a.loads[0].buf))).sort(), ['data.fxpreset', 'metainfo.xml']);
  assert.equal(a.replaced.length, 0);
  assert.ok(!log.some(([op]) => op === 'inserts' || op === 'save'));

  const b = loadDeps(null);
  await assert.rejects(pluginPresets(call, { instrument: 'Mai Tai', action: 'load', preset: 'Fat Bass' }, b.deps), /preset file not found for in-place load/);
  assert.equal(b.replaced.length, 0);
  await assert.rejects(pluginPresets(call, { instrument: 'Mai Tai', action: 'load', preset: 'Nope' }, b.deps), /has no preset named "Nope"/);
  const c = loadDeps({ file: bundle, ext: '.instrument' }, { platform: 'darwin' });
  await assert.rejects(pluginPresets(call, { instrument: 'Mai Tai', action: 'load', preset: 'Fat Bass' }, c.deps), /only be loaded on Windows/);

  const list = await pluginPresets(call, { instrument: 'Mai Tai', action: 'list' }, a.deps);
  assert.deepEqual([list.instrument, list.component, list.cid, list.count], ['Mai Tai', 'Inst01', MAITAI, 4]);
});

// ---- live_instruments ------------------------------------------------------------------------------

const MUSIC_DEVICE = `<?xml version="1.0" encoding="UTF-8"?>
<MusicTrackDevice><Attributes x:id="channels"><ChannelGroup name="MusicTrack">
  <MusicTrackChannel name="Channel01" label="Pista de acordes"/>
  <MusicTrackChannel name="Channel02" label="Claude Synth">
    <Connection x:id="instrumentOut" friendlyName="Mai Tai"/>
    <Connection x:id="destination" friendlyName="1 - Mai Tai/Synth Input"/>
  </MusicTrackChannel>
  <MusicTrackChannel name="Channel03" label="Drums"><Connection x:id="destination" friendlyName="4 - Impact/Input"/></MusicTrackChannel>
  <MusicTrackChannel name="Channel04" label="Old"><Connection x:id="destination" friendlyName="3 - Presence/Input"/></MusicTrackChannel>
</ChannelGroup></Attributes></MusicTrackDevice>`;

test('songInstrumentRouting: track channel -> instrument number and name from the saved song', () => {
  const r = songInstrumentRouting({ xml: () => parseXml(MUSIC_DEVICE) });
  assert.deepEqual([...r.entries()], [['Claude Synth', { index: 1, name: 'Mai Tai' }], ['Drums', { index: 4, name: 'Impact' }], ['Old', { index: 3, name: 'Presence' }]]);
  assert.equal(songInstrumentRouting({ xml: () => null }).size, 0);
});

test('instrumentsOverview: instruments with backend, class and the tracks that play them', async () => {
  const tracks = [
    { name: 'Claude Synth', mediaType: 'Music', channel: 'Claude Synth' },
    { name: 'Drums', mediaType: 'Music', channel: 'Drums' },
    { name: 'Old', mediaType: 'Music', channel: 'Old' },
    { name: 'New', mediaType: 'Music', channel: 'New' },
    { name: 'Vox', mediaType: 'Audio', channel: 'Vox' },
  ];
  const { call } = bridge({ extra: { tracks: () => tracks, song: () => ({ fileUrl: 'file:///C:/Songs/x/x.song' }) } });
  let opened;
  const r = await instrumentsOverview(call, {
    catalog, discover, pluginClass: (n) => (n === 'Impact' ? { cid: '{IMP}', name: 'Impact' } : null),
    presetClass: (n) => (/^Mai Tai/.test(n) ? { classId: MAITAI, className: 'Mai Tai' } : null),
    openArchive: (p) => { opened = p; return { xml: () => parseXml(MUSIC_DEVICE) }; },
  });
  assert.match(opened, /x\.song$/);
  assert.deepEqual(r.instruments, [
    { instrument: 'Mai Tai', component: 'Inst01', backend: 'native', classId: MAITAI, tracks: ['Claude Synth'] },
    { instrument: 'Mai Tai 2', component: 'Inst02', backend: 'native', classId: MAITAI, tracks: [] },
    { instrument: 'Impact', component: 'Inst04', backend: 'opaque', classId: '{IMP}', tracks: ['Drums'] },
  ]);
  assert.deepEqual(r.unmappedTracks, ['Old', 'New']);
  assert.match(r.note, /last save/);
  const unsaved = bridge({ extra: { tracks: () => tracks, song: () => ({ fileUrl: null }) } });
  const u = await instrumentsOverview(unsaved.call, { catalog, discover, pluginClass, presetClass: () => null });
  assert.equal(u.instruments.length, 3);
  assert.match(u.note, /not been saved/);
});

// ---- parked fixes: instance timeouts and a re-read after a thrown call --------------------------------

const timedOut = () => new Error('Studio One did not answer within 30 s');

test('addPlugin: 30 s answer time; a timed-out add that happened is a success, one that did not is the error', async () => {
  let rack = ['Pro EQ'];
  const opts = [];
  const mk = (grows) => async (op, a, o) => {
    if (op === 'inserts') { opts.push(['inserts', o]); return [{ channel: a.channel, inserts: rack.map((name, slot) => ({ slot, name, bypassed: false })) }]; }
    if (op === 'trackTask') { opts.push(['trackTask', o]); if (grows) rack = [...rack, 'Compressor']; throw timedOut(); }
    throw new Error(`unexpected ${op}`);
  };
  const r = await addPlugin(mk(true), { channel: 'Voc', plugin: 'Compressor' });
  assert.equal(r.added, 'Compressor');
  assert.match(r.warning, /did not answer in time/);
  assert.deepEqual(opts.find(([op]) => op === 'trackTask')[1], { timeoutMs: INSTANCE_TIMEOUT_MS });
  assert.equal(INSTANCE_TIMEOUT_MS, 30000);
  assert.ok(opts.some(([op, o]) => op === 'inserts' && o?.timeoutMs === INSTANCE_TIMEOUT_MS), 'the re-read waits as long');
  rack = ['Pro EQ'];
  await assert.rejects(addPlugin(mk(false), { channel: 'Voc', plugin: 'Compressor' }), /did not answer/);
  // A normal answer keeps the old shape.
  const ok = async (op, a) => (op === 'trackTask' ? { results: [{ added: 'Compressor' }] } : [{ channel: a.channel, inserts: [] }]);
  assert.deepEqual(Object.keys(await addPlugin(ok, { channel: 'Voc', plugin: 'Compressor' })).sort(), ['added', 'channel', 'inserts', 'note']);
});

test('addInstrumentTrack: 30 s answer time; a timed-out add with one new instrument channel is a success', async () => {
  let channels = ['Mai Tai', 'Main'];
  let taskOpts;
  const mk = (adds) => async (op, a, o) => {
    if (op === 'inserts') return channels.map((channel) => ({ channel, inserts: [] }));
    if (op === 'trackTask') { taskOpts = o; if (adds) channels = ['Mai Tai', 'Mai Tai 2', 'Main']; throw timedOut(); }
    throw new Error(`unexpected ${op}`);
  };
  const r = await addInstrumentTrack(mk(true), { instrument: 'Mai Tai' });
  assert.deepEqual(taskOpts, { timeoutMs: INSTANCE_TIMEOUT_MS });
  assert.equal(r.mixerChannel, 'Mai Tai 2');
  assert.equal(r.instrument, 'Mai Tai');
  assert.match(r.warning, /live_tracks/);
  channels = ['Mai Tai', 'Main'];
  await assert.rejects(addInstrumentTrack(mk(false), { instrument: 'Mai Tai' }), /did not answer/);
});

test('addFxSend: 30 s answer time; a timed-out add with a new FX channel is a success', async () => {
  let labels = ['Voc', 'Main'];
  let taskOpts;
  const mk = (adds) => async (op, a, o) => {
    if (op === 'channels') return labels.map((label) => ({ label }));
    if (op === 'sends') return [{ channel: a.channel, sends: adds ? [{ index: 0, name: 'FX1' }] : [] }];
    if (op === 'trackTask') { taskOpts = o; if (adds) labels = ['Voc', 'FX1', 'Main']; throw timedOut(); }
    throw new Error(`unexpected ${op}`);
  };
  const r = await addFxSend(mk(true), { channel: 'Voc', plugin: 'Room Reverb' });
  assert.deepEqual(taskOpts, { timeoutMs: INSTANCE_TIMEOUT_MS });
  assert.equal(r.fxChannel, 'FX1');
  assert.equal(r.plugin, 'Room Reverb');
  assert.match(r.warning, /did not answer in time/);
  labels = ['Voc', 'Main'];
  await assert.rejects(addFxSend(mk(false), { channel: 'Voc', plugin: 'Room Reverb' }), /did not answer/);
});

// ---- fix round 1: unnamed and renamed instruments, Folder/Name loads -------------------------------

test('an instrument without a name: addressable as InstNN, opaque, never a crash', async () => {
  const { call } = bridge({ instruments: [{ index: 1, component: 'Inst01', name: null }, { index: 2, component: 'Inst02', name: 'Mai Tai' }] });
  assert.equal((await instrumentAt(call, 'Inst01')).component, 'Inst01');
  assert.equal((await instrumentAt(call, 'mai tai')).component, 'Inst02');
  await assert.rejects(instrumentAt(call, 'null'), /no instrument named null \(have: \(no name\) \[Inst01\], Mai Tai \[Inst02\]\)/);
  await assert.rejects(instrumentAt(call, ''), /give an instrument name or component/);
  assert.deepEqual(pickBackend(null, catalog, { discover, pluginClass }), { backend: 'opaque', entry: null, reason: 'unnamed' });
  assert.equal(presetClass(null), null);
  const g = await getParams(call, { instrument: 'Inst01' }, { catalog, discover, pluginClass, presetClass: () => null, zip: null });
  assert.deepEqual([g.instrument, g.backend], ['Inst01', 'opaque']);
  assert.match(g.note, /no name/);
  const o = await instrumentsOverview(bridge({ instruments: [{ index: 1, component: 'Inst01', name: null }], extra: { tracks: () => [], song: () => ({ fileUrl: null }) } }).call,
    { catalog, discover, pluginClass, presetClass: () => null });
  assert.deepEqual(o.instruments, [{ instrument: null, component: 'Inst01', backend: 'opaque', classId: null, tracks: [] }]);
});

test('a renamed instrument: its class comes from the saved synth state, and lookups use the class name', async () => {
  const zip = {
    names: ['Presets/Synths/1 - Lead.fxpreset', 'Presets/Synths/2 - Other.vstpreset'],
    raw: (n) => (n.endsWith('.fxpreset') ? Buffer.from(`<AudioEffectPreset cid="${MAITAI}" version="2"/>`) : vstpreset('ABCDEF019182FAEB4E4453504E4A5058')),
  };
  assert.equal(savedSynthClassId(zip, 1), MAITAI);
  assert.equal(savedSynthClassId(zip, 2), '{ABCDEF01-9182-FAEB-4E44-53504E4A5058}');
  assert.equal(savedSynthClassId(zip, 3), null);
  const noName = { pluginClass: () => null, presetClass: () => null, classes: () => [], presetClassById: (cid) => (cid === MAITAI ? { classId: MAITAI, className: 'Mai Tai' } : null) };
  assert.deepEqual(await instrumentClass(null, { index: 1, name: 'Lead' }, { ...noName, zip }), { cid: MAITAI, className: 'Mai Tai' });
  assert.deepEqual(await instrumentClass(null, { index: 2, name: 'Other' }, { ...noName, zip, classes: () => [{ cid: '{abcdef01-9182-faeb-4e44-53504e4a5058}', name: 'VST Synth' }] }),
    { cid: '{ABCDEF01-9182-FAEB-4E44-53504E4A5058}', className: 'VST Synth' });
  assert.equal(await instrumentClass(null, { index: 5, name: 'Gone' }, { ...noName, zip }), null);

  const { call, log } = bridge({ instruments: [{ index: 1, component: 'Inst01', name: 'Lead' }] });
  const r = await getParams(call, { instrument: 'Lead', filter: 'cutoff' }, { catalog, discover, ...noName, zip });
  assert.deepEqual([r.instrument, r.backend], ['Lead', 'native'], 'Mai Tai names, found by the class name');
  assert.deepEqual(log.find(([op]) => op === 'pluginParams')[1], { instrument: 'Inst01', names: ['filter.cutoff'] });
  const a = loadDeps({ file: 'x', ext: '.preset' }, { ...noName, zip, classIdFor: () => null });
  a.deps.findFile = (q) => { a.loads.query = q; return null; };
  await assert.rejects(pluginPresets(call, { instrument: 'Lead', action: 'load', preset: 'default' }, a.deps), /preset file not found/);
  assert.deepEqual([a.loads.query.folder, a.loads.query.cid], ['Mai Tai', MAITAI]);
});

test('preset load with Folder/Name: the list is checked by the name, the file by the folder', async () => {
  assert.deepEqual([presetListName('Send FX/Arena'), presetListName('./Arena'), presetListName('Arena')], ['Arena', 'Arena', 'Arena']);
  const { call } = bridge({ racks: { Voc: ['Pro EQ'] } });
  const a = loadDeps(null);
  const r = await pluginPresets(call, { channel: 'Voc', slot: 0, action: 'load', preset: 'Drums/Kick' }, a.deps);
  assert.equal(a.loads.query.preset, 'Drums/Kick');
  assert.deepEqual(a.replaced, [{ channel: 'Voc', slot: 0, cid: MAITAI, preset: 'Kick' }], 'the replace takes the listed name');
  assert.equal(r.inPlace, false);
  const b = loadDeps(() => { throw new Error('preset "Kick" matches 2 files'); });
  await assert.rejects(pluginPresets(call, { channel: 'Voc', slot: 0, action: 'load', preset: 'Kick' }, b.deps), /matches 2 files/);
  assert.equal(b.replaced.length, 0, 'an ambiguous name never falls back to a replace');
});

// ---- fix round 2: list annotation, tie-break, ./Name -------------------------------------------------

const REVERB = '{11111111-2222-3333-4444-555555555555}';
const FAT = '{5E91DC8A-E560-4115-98FA-59FB3F215BA1}';
// Factory-shaped: Room Reverb's "Arena" in the plug-in folder and in "Send FX/"; Fat Channel's "default"
// in the folder and in module subfolders, "Bass" only in module subfolders.
function factoryShaped() {
  const factory = fs.mkdtempSync(path.join(os.tmpdir(), 's1factory-'));
  put(path.join(factory, 'PreSonus', 'Room Reverb', 'Arena.preset'), presetZip(REVERB, 'Room Reverb'));
  put(path.join(factory, 'PreSonus', 'Room Reverb', 'Send FX', 'Arena.preset'), presetZip(REVERB, 'Room Reverb'));
  put(path.join(factory, 'PreSonus', 'Room Reverb', 'Hall.preset'), presetZip(REVERB, 'Room Reverb'));
  for (const sub of ['', 'Compressor FET', 'EQ Passive']) put(path.join(factory, 'PreSonus', 'Fat Channel', sub, 'default.preset'), presetZip(FAT, 'Fat Channel'));
  for (const sub of ['Compressor FET', 'EQ Passive']) put(path.join(factory, 'PreSonus', 'Fat Channel', sub, 'Bass.preset'), presetZip(FAT, 'Fat Channel'));
  return { factory, roots: [{ dir: factory, exts: ['.preset', '.vstpreset', '.fxpreset', '.instrument'] }] };
}

test('findPresetFile tie-break: a plain name with one file directly in the plug-in folder takes that one', () => {
  const { factory, roots } = factoryShaped();
  const rr = (preset) => findPresetFile({ folder: 'Room Reverb', preset, cid: REVERB, roots });
  assert.equal(rr('Arena').file, path.join(factory, 'PreSonus', 'Room Reverb', 'Arena.preset'));
  assert.equal(rr('./Arena').file, path.join(factory, 'PreSonus', 'Room Reverb', 'Arena.preset'));
  assert.equal(rr('Send FX/Arena').file, path.join(factory, 'PreSonus', 'Room Reverb', 'Send FX', 'Arena.preset'));
  const fat = (preset) => findPresetFile({ folder: 'Fat Channel', preset, cid: FAT, roots });
  assert.equal(fat('default').file, path.join(factory, 'PreSonus', 'Fat Channel', 'default.preset'));
  assert.equal(fat('EQ Passive/default').file, path.join(factory, 'PreSonus', 'Fat Channel', 'EQ Passive', 'default.preset'));
  // Still several after the tie-break: refused, with the candidates as data too.
  let err;
  try { fat('Bass'); } catch (e) { err = e; }
  assert.match(err.message, /preset "Bass" matches 2 files .*PreSonus\/Fat Channel\/Compressor FET\/Bass\.preset, PreSonus\/Fat Channel\/EQ Passive\/Bass\.preset/);
  assert.deepEqual(err.candidates, ['Compressor FET/Bass', 'EQ Passive/Bass']);
});

test('findPresetFile ./Name: only a file directly in the plug-in folder, never one in a subfolder', () => {
  const { factory, roots } = factoryShaped();
  let err;
  try { findPresetFile({ folder: 'Fat Channel', preset: './Bass', cid: FAT, roots }); } catch (e) { err = e; }
  assert.equal(err.message.split(' (')[0], `no file named Bass directly in ${path.join(factory, 'PreSonus', 'Fat Channel')}`);
  assert.deepEqual(err.candidates, ['Compressor FET/Bass', 'EQ Passive/Bass']);
  assert.throws(() => findPresetFile({ folder: 'Room Reverb', preset: './Hall.fxpreset', cid: REVERB, roots }), /no file named Hall\.fxpreset directly in/);
  assert.equal(findPresetFile({ folder: 'Room Reverb', preset: './Hall.preset', cid: REVERB, roots }).ext, '.preset');
});

test('list: names that stand for several files are listed as loadable Folder/Name spellings, with an ambiguous map', async () => {
  const { roots } = factoryShaped();
  const ambiguous = (names, o) => ambiguousPresetNames(names, { ...o, roots });
  assert.deepEqual(Object.fromEntries(ambiguous(['Arena', 'Hall', 'Nope'], { folder: 'Room Reverb', cid: REVERB })), { Arena: ['./Arena', 'Send FX/Arena'] });

  // Studio One lists "Arena" twice (one per file).
  const call = async (op, a) => {
    if (op === 'inserts') return [{ channel: a.channel, inserts: [{ slot: 0, name: 'Room Reverb', bypassed: false }] }];
    if (op === 'trackTask') return { results: [{ presets: [{ index: 1, name: 'Arena' }, { index: 2, name: 'Arena' }, { index: 3, name: 'Hall' }] }] };
    throw new Error(`unexpected ${op}`);
  };
  const deps = { platform: 'win32', classIdFor: () => REVERB, pluginClass: () => ({ name: 'Room Reverb', cid: REVERB }), ambiguous };
  const r = await pluginPresets(call, { channel: 'FX', slot: 0, action: 'list' }, deps);
  assert.deepEqual(r.presets, ['./Arena', 'Send FX/Arena', 'Hall']);
  assert.equal(r.count, 3);
  assert.deepEqual(r.ambiguous, { Arena: ['./Arena', 'Send FX/Arena'] });
  // Every name handed out loads as it is.
  const loads = [];
  for (const preset of r.presets) {
    const found = findPresetFile({ folder: 'Room Reverb', preset, cid: REVERB, roots, exts: ['.preset', '.vstpreset', '.fxpreset'] });
    assert.ok(found, preset);
    await pluginPresets(call, { channel: 'FX', slot: 0, action: 'load', preset }, {
      ...deps, findFile: (q) => findPresetFile({ ...q, roots }), io: { loadState: async (_c, _t, buf) => { loads.push(buf.length); } },
    });
  }
  assert.equal(loads.length, 3);
  // Off Windows (no file lookups): the plain list.
  assert.deepEqual((await pluginPresets(call, { channel: 'FX', slot: 0, action: 'list' }, { ...deps, platform: 'linux' })).presets, ['Arena', 'Arena', 'Hall']);
});
