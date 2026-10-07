// Plug-in parameter names from presets and the remote-control map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { flattenNames, readPreset, pluginParamNames } from '../src/plugins.js';

const meta = (cls, dataFile) => `﻿<?xml version="1.0" encoding="UTF-8"?>
<MetaInformation>
	<Attribute id="Class:ID" value="{1}"/>
	<Attribute id="Class:Name" value="${cls}"/>
	<Attribute id="Preset:DataFile" value="${dataFile}"/>
</MetaInformation>`;

function writePreset(path, cls, dataFile, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, zipSync({ 'metainfo.xml': strToU8(meta(cls, dataFile)), [dataFile]: strToU8(data) }));
}

function library() {
  const root = mkdtempSync(join(tmpdir(), 's1presets-'));
  writePreset(join(root, 'PreSonus', 'Fat Channel', 'default.preset'), 'Fat Channel', 'data.dsppreset',
    JSON.stringify({ classname: 'Fat Channel', parameters: { filter: { hpf: 24 }, comp: { on: 0, ratio: 2 } } }));
  writePreset(join(root, 'PreSonus', 'Pro EQ', 'Drums', 'Kick.preset'), 'Pro EQ', 'data.fxpreset',
    '<AudioEffectPreset><Attributes x:id="ParameterData" lffreq="40" lfgain="3"/></AudioEffectPreset>');
  // A preset for another plug-in filed under the wrong folder is ignored.
  writePreset(join(root, 'PreSonus', 'Pro EQ', 'stray.preset'), 'Compressor', 'data.fxpreset',
    '<AudioEffectPreset><Attributes x:id="ParameterData" ratio="2"/></AudioEffectPreset>');
  writeFileSync(join(root, 'PreSonus', 'filefilter.xml'), '<x/>');
  const map = join(root, 'remote.surfacedata');
  writeFileSync(map, `<SurfaceDataList>
	<SurfaceDeviceAssignment deviceID="{5E91}" friendlyName="Fat Channel">
		<List x:id="pages"><SurfaceAssignmentPage>
			<Association key="c0.value" value="{5E91}/comp.threshold"/>
			<Association key="c1.value" value="{5E91}/filter.hpf"/>
		</SurfaceAssignmentPage></List>
	</SurfaceDeviceAssignment>
	<SurfaceDeviceAssignment deviceID="{2222}" friendlyName="Channel Controls">
		<Association key="c0.value" value="AudioChannelMacroControlSet/float-1"/>
	</SurfaceDeviceAssignment>
</SurfaceDataList>`);
  return { root, map };
}

test('flattenNames: nested sections become dotted names', () => {
  assert.deepEqual(flattenNames({ a: { b: 1, c: { d: 2 } }, e: 3 }), ['a.b', 'a.c.d', 'e']);
});

test('readPreset: JSON dsppreset and XML ParameterData', () => {
  const { root, map } = library();
  assert.deepEqual(readPreset(join(root, 'PreSonus', 'Fat Channel', 'default.preset')).names, ['filter.hpf', 'comp.on', 'comp.ratio']);
  const eq = readPreset(join(root, 'PreSonus', 'Pro EQ', 'Drums', 'Kick.preset'));
  assert.deepEqual([eq.className, eq.names], ['Pro EQ', ['lffreq', 'lfgain']]);
  assert.equal(readPreset(map), null); // not a zip
});

test('pluginParamNames: remote map first, then presets, deduplicated; strays and unknowns skipped', () => {
  const { root, map } = library();
  const fat = pluginParamNames('Fat Channel', { roots: [root], maps: [map] });
  assert.deepEqual(fat.names, ['comp.threshold', 'filter.hpf', 'comp.on', 'comp.ratio']);
  assert.equal(fat.sources.length, 2);
  assert.deepEqual(pluginParamNames('Pro EQ', { roots: [root], maps: [map] }).names, ['lffreq', 'lfgain']);
  assert.deepEqual(pluginParamNames('Some VST', { roots: [root, join(root, 'missing')], maps: [map] }).names, []);
});

test('pluginParamNames: a second instance ("Pro EQ 2", e.g. after a preset load) resolves to its plug-in', () => {
  const { root, map } = library();
  const r = pluginParamNames('Pro EQ 2', { roots: [root], maps: [map] });
  assert.deepEqual(r.names, ['lffreq', 'lfgain']);
  assert.equal(r.plugin, 'Pro EQ');
  assert.equal(pluginParamNames('Pro EQ', { roots: [root], maps: [map] }).plugin, 'Pro EQ');
  assert.deepEqual(pluginParamNames('Some VST 2', { roots: [root], maps: [map] }).names, []);
});

// A real Mai Tai factory preset (default.preset, trimmed): instrument presets keep their parameters
// as nested <Attributes x:id="..."> under ComponentData, not in one ParameterData element.
const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('readPreset: an instrument preset (nested x:id sections) gives dotted names from the x:id chain', () => {
  const root = mkdtempSync(join(tmpdir(), 's1presets-'));
  const p = join(root, 'PreSonus', 'Mai Tai', 'default.preset');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, zipSync({ 'metainfo.xml': strToU8(fixture('maitai-metainfo.xml')), 'data.fxpreset': strToU8(fixture('maitai-data.fxpreset')) }));
  const r = readPreset(p);
  assert.equal(r.className, 'Mai Tai');
  assert.equal(r.classId, '{B625F134-4485-4A50-A3C8-C9CF0C5495E1}');
  for (const n of ['filter.cutoff', 'filter.resonance', 'masterGain.gain', 'osc1.amp.gain', 'osc1.type', 'glide.glideTime', 'voiceLimit']) {
    assert.ok(r.names.includes(n), `${n} in ${r.names.join(', ')}`);
  }
  assert.ok(!r.names.some((n) => /ComponentData|x:id|^gui\./.test(n)), 'no container ids, no UI state');
  const viaFolder = pluginParamNames('Mai Tai 2', { roots: [root], maps: [] });
  assert.equal(viaFolder.plugin, 'Mai Tai');
  assert.ok(viaFolder.names.includes('masterGain.gain'));
});
