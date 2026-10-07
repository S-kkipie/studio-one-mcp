import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanAll, pythonRunner, defaultPython, defaultRoots } from '../src/plugins/scan.js';

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
  const root = path.join(base, 'VST3');
  const catalogDir = path.join(base, 'catalog');
  fs.mkdirSync(path.join(root, 'Vendor'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Bundle.vst3', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Alpha.vst3'), 'aaaa');
  fs.writeFileSync(path.join(root, 'Vendor', 'Beta.vst3'), 'bb');
  fs.writeFileSync(path.join(root, 'Contents.vst3.zip'), 'zip');
  fs.writeFileSync(path.join(root, 'Bundle.vst3', 'Contents', 'Inner.vst3'), 'x');
  return { base, root, catalogDir };
}
const okRunner = async ({ path: p }) => ({
  name: path.basename(p, '.vst3'), vendor: 'V', params: [],
  capabilities: { hostParams: false, stateRoundTrip: false, xmlState: false }, stateKeys: {},
});
const entries = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const file = (dir, name) => {
  const f = entries(dir).find((x) => x.startsWith(`${name}-`) && /^[0-9a-f]{6}\.json$/.test(x.slice(name.length + 1)));
  assert.ok(f, `no catalog file for ${name}: ${entries(dir)}`);
  return path.join(dir, f);
};
const read = (dir, name) => JSON.parse(fs.readFileSync(file(dir, name), 'utf8'));

test('writes one JSON per plug-in (files and bundles, no zips, no nesting in bundles)', async () => {
  const { root, catalogDir } = setup();
  const r = await scanAll({ roots: [root], catalogDir, runner: okRunner });
  assert.equal(entries(catalogDir).length, 3);
  for (const n of ['Alpha', 'Beta', 'Bundle']) file(catalogDir, n);
  assert.equal(r.total, 3);
  assert.equal(r.scanned, 3);
  const a = read(catalogDir, 'Alpha');
  assert.equal(a.name, 'Alpha');
  assert.equal(a.path, path.join(root, 'Alpha.vst3'));
  assert.equal(a.size, 4);
  assert.ok(a.mtimeMs > 0 && a.scannedAt);
});

test('runner crash/timeout is recorded as scanError and scan continues', async () => {
  const { root, catalogDir } = setup();
  const runner = async (args) => {
    if (args.path.endsWith('Alpha.vst3')) throw new Error('timeout after 10ms');
    return okRunner(args);
  };
  const r = await scanAll({ roots: [root], catalogDir, runner });
  assert.equal(r.errors, 1);
  assert.equal(r.scanned, 3);
  const a = read(catalogDir, 'Alpha');
  assert.match(a.scanError, /timeout/);
  assert.equal(a.name, 'Alpha');
  file(catalogDir, 'Beta');
});

test('unchanged file is skipped on second run', async () => {
  const { root, catalogDir } = setup();
  await scanAll({ roots: [root], catalogDir, runner: okRunner });
  let calls = 0;
  const r = await scanAll({ roots: [root], catalogDir, runner: async (a) => { calls++; return okRunner(a); } });
  assert.equal(calls, 0);
  assert.equal(r.skipped, 3);
  assert.equal(r.scanned, 0);
});

test('entries of another catalog schema are rescanned even when the file is unchanged', async () => {
  const { root, catalogDir } = setup();
  await scanAll({ roots: [root], catalogDir, runner: okRunner });
  assert.equal(read(catalogDir, 'Alpha').schema, 2);
  const f = file(catalogDir, 'Alpha');
  const old = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete old.schema;
  fs.writeFileSync(f, JSON.stringify(old));
  const seen = [];
  const r = await scanAll({ roots: [root], catalogDir, runner: async (a) => { seen.push(path.basename(a.path)); return okRunner(a); } });
  assert.deepEqual(seen, ['Alpha.vst3']);
  assert.equal(r.skipped, 2);
  assert.equal(read(catalogDir, 'Alpha').schema, 2);
});

test('default VST3 folders per platform', () => {
  assert.deepEqual(defaultRoots('win32', 'C:/Users/u').slice(0, 1), ['C:/Program Files/Common Files/VST3']);
  assert.deepEqual(defaultRoots('darwin', '/Users/u').slice(0, 2), ['/Library/Audio/Plug-Ins/VST3', path.join('/Users/u', 'Library', 'Audio', 'Plug-Ins', 'VST3')]);
  assert.equal(defaultRoots('linux', '/home/u').filter((r) => /VST3$/.test(r) && !process.env.STUDIO_ONE_MCP_VST3_PATHS).length, 0);
});

test('changed mtime is rescanned', async () => {
  const { root, catalogDir } = setup();
  await scanAll({ roots: [root], catalogDir, runner: okRunner });
  const f = path.join(root, 'Alpha.vst3');
  const t = new Date(Date.now() + 60000);
  fs.utimesSync(f, t, t);
  const seen = [];
  const r = await scanAll({ roots: [root], catalogDir, runner: async (a) => { seen.push(path.basename(a.path)); return okRunner(a); } });
  assert.deepEqual(seen, ['Alpha.vst3']);
  assert.equal(r.scanned, 1);
  assert.equal(r.skipped, 2);
});

const failing = (kind, message = 'boom') => async (a) => {
  if (!a.path.endsWith('Alpha.vst3')) return okRunner(a);
  const e = new Error(message);
  if (kind) e.kind = kind;
  throw e;
};
const countingRunner = (calls) => async (a) => { calls.push(path.basename(a.path)); return okRunner(a); };

test('scanErrorKind is stored; timeouts are always retried', async () => {
  const { root, catalogDir } = setup();
  await scanAll({ roots: [root], catalogDir, runner: failing('timeout', 'timeout after 5ms') });
  assert.equal(read(catalogDir, 'Alpha').scanErrorKind, 'timeout');
  const calls = [];
  const r = await scanAll({ roots: [root], catalogDir, runner: countingRunner(calls) });
  assert.deepEqual(calls, ['Alpha.vst3']);
  assert.equal(r.errors, 0);
  assert.equal(read(catalogDir, 'Alpha').scanError, undefined);
});

test('crash and generic errors are retried only with retryErrors', async () => {
  for (const kind of ['crash', 'error']) {
    const { root, catalogDir } = setup();
    await scanAll({ roots: [root], catalogDir, runner: failing(kind) });
    assert.equal(read(catalogDir, 'Alpha').scanErrorKind, kind);
    let calls = [];
    await scanAll({ roots: [root], catalogDir, runner: countingRunner(calls) });
    assert.deepEqual(calls, [], kind);
    calls = [];
    await scanAll({ roots: [root], catalogDir, runner: countingRunner(calls), retryErrors: true });
    assert.deepEqual(calls, ['Alpha.vst3'], kind);
    assert.equal(read(catalogDir, 'Alpha').scanError, undefined);
  }
});

test('an error without kind and "timeout" in its message is classified as timeout', async () => {
  const { root, catalogDir } = setup();
  await scanAll({ roots: [root], catalogDir, runner: failing(null, 'timeout after 10ms') });
  assert.equal(read(catalogDir, 'Alpha').scanErrorKind, 'timeout');
});

test('missing python aborts scanAll with a setup hint and writes no entries', async () => {
  const { root, catalogDir } = setup();
  await assert.rejects(
    scanAll({ roots: [root], catalogDir, python: path.join(root, 'no-such-python.exe'), runner: pythonRunner, timeoutMs: 5000 }),
    /npm run scan:setup/,
  );
  assert.equal(entries(catalogDir).length, 0);
});

test('same basename in different folders does not collide', async () => {
  const { root, catalogDir } = setup();
  fs.mkdirSync(path.join(root, 'Other'));
  fs.writeFileSync(path.join(root, 'Other', 'Alpha.vst3'), 'zz');
  const r = await scanAll({ roots: [root], catalogDir, runner: okRunner });
  assert.equal(r.total, 4);
  assert.equal(entries(catalogDir).filter((f) => f.startsWith('Alpha-')).length, 2);
});

test('prunes entries of removed plug-ins under scanned roots only, and legacy-named files', async () => {
  const { base, root, catalogDir } = setup();
  await scanAll({ roots: [root], catalogDir, runner: okRunner });
  const outside = path.join(catalogDir, 'Elsewhere-abcdef.json');
  fs.writeFileSync(outside, JSON.stringify({ name: 'Elsewhere', path: path.join(base, 'not-scanned', 'E.vst3') }));
  const legacy = path.join(catalogDir, 'Alpha.json');
  fs.writeFileSync(legacy, JSON.stringify({ name: 'Alpha', path: path.join(root, 'Alpha.vst3') }));
  fs.rmSync(path.join(root, 'Vendor', 'Beta.vst3'));
  const r = await scanAll({ roots: [root], catalogDir, runner: okRunner });
  assert.equal(r.pruned, 2);
  assert.ok(!fs.existsSync(legacy));
  assert.ok(fs.existsSync(outside));
  assert.ok(!entries(catalogDir).some((f) => f.startsWith('Beta-')));
  file(catalogDir, 'Alpha');
});

// --- scan-plugin.py helpers (need only a python; pedalboard is imported lazily) ---
const pyExe = fs.existsSync(defaultPython()) ? defaultPython() : 'python';
const pyOk = spawnSync(pyExe, ['-I', '-c', 'pass']).status === 0;
const helperScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'scan-plugin.py');
function pyJson(expr) {
  const code = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('sp',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
print(json.dumps(${expr}))`;
  const r = spawnSync(pyExe, ['-I', '-c', code, helperScript], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('unique_claims rejects attributes claimed by several keys', { skip: !pyOk }, () => {
  assert.deepEqual(pyJson("m.unique_claims({'a':'value','b':'value','c':'gain'})"), { c: 'gain' });
});

test('xml_attr_map keys APVTS-style PARAM elements by id', { skip: !pyOk }, () => {
  const out = pyJson(`m.xml_attr_map('<?xml version="1.0"?><S inputGain="1"><PARAM id="drive" value="0.5"/><PARAM id="mix" value="0.2"/></S>')`);
  assert.equal(out['PARAM[id=drive]@value'], '0.5');
  assert.equal(out['PARAM[id=mix]@value'], '0.2');
  assert.equal(out.inputGain, '1');
  assert.equal(out.value, undefined);
});

const pedalboardOk = pyOk && spawnSync(pyExe, ['-I', '-c', 'import pedalboard'], { encoding: 'utf8' }).status === 0;

test('verify_scales: how each state attribute stores the displayed value, checked by loading edited states', { skip: !pedalboardOk && 'needs the scanner venv' }, () => {
  // A fake plug-in whose XML state drives its parameters, like Archetype: percentages kept 0..1, dB
  // as dB, a log-scaled frequency kept normalised (not linear: unverified), a pan choice kept -50..50.
  const code = String.raw`import importlib.util,json,sys,struct,math
spec=importlib.util.spec_from_file_location('sp',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class P:
    def __init__(s, typ, lo=None, hi=None, step=None, vals=None, fmt=str):
        s.type, s.min_value, s.max_value, s.step_size, s.approximate_step_size = typ, lo, hi, step, None
        s.valid_values, s.fmt, s.v = vals or [], fmt, None
    @property
    def string_value(s): return s.fmt(s.v)
    @property
    def raw_value(s): return 1.0 if s.v else 0.0
pans = ['%d L' % (50 - i) for i in range(50)] + ['C'] + ['%d R' % i for i in range(1, 51)]
prm = {
  'drive': P(float, 0.0, 100.0, 1.0, fmt=lambda v: '%d %%' % round(v)),
  'gain': P(float, -24.0, 24.0, 0.1, fmt=lambda v: '%.1f dB' % v),
  'freq': P(float, 20.0, 20000.0, None, fmt=lambda v: '%.0f Hz' % v),
  'pan': P(str, vals=pans, fmt=lambda v: v),
  'on': P(bool, False, True, 1),
}
binds = {
  'drive': ('overdriveDrive', lambda t: float(t) * 100),
  'gain': ('inputGain', float),
  'freq': ('lowFreq', lambda t: 20 * 1000 ** float(t)),
  'pan': ('cabPan', lambda t: pans[int(float(t)) + 50]),
  'on': ('active', lambda t: t == 'true'),
}
class Plug:
    def __init__(s, xml): s.raw_state = m.vc2(xml)
    @property
    def raw_state(s): return m.vc2(s.xml)
    @raw_state.setter
    def raw_state(s, raw):
        size = struct.unpack_from('<I', raw, 4)[0]
        s.xml = raw[8:8 + size].rstrip(b'\x00').decode()
        a = m.xml_attr_map(s.xml)
        for k, (attr, f) in binds.items():
            v = a[attr]
            prm[k].v = f(v) if v is not None else None
xml = '<appModel overdriveDrive="0.951" inputGain="0" lowFreq="0.5" cabPan="0" active="true"/>'
p = Plug(xml)
raw = bytes(p.raw_state)
keys = {k: a for k, (a, f) in binds.items()}
scales, unverified = m.verify_scales(p, raw, m.extract_xml(raw), m.xml_attr_map(xml), prm, keys)
print(json.dumps({'scales': scales, 'unverified': unverified, 'xml': p.xml}))`;
  const r = spawnSync(pyExe, ['-I', '-c', code, helperScript], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.scales, { drive: 0.01, gain: 1, pan: { a: 1, b: -50 }, on: 1 });
  assert.deepEqual(out.unverified, ['freq']);
  assert.equal(out.xml, '<appModel overdriveDrive="0.951" inputGain="0" lowFreq="0.5" cabPan="0" active="true"/>', 'the default state is loaded back');
});

test('raw_with_xml swaps the XML inside JUCE\'s VST3 wrapper (base64 IComponent) and set_xml_attr edits one attribute', { skip: !pyOk }, () => {
  const out = pyJson(`(lambda raw: m.extract_xml(m.raw_with_xml(raw, m.set_xml_attr('<a x="1" y="2"><PARAM id="d" value="0.5"/></a>', 'PARAM[id=d]@value', '0.25'))))(m.vc2('<VST3PluginState><IComponent>' + m.juce_b64_encode(m.vc2('<a x="1"/>')) + '</IComponent></VST3PluginState>'))`);
  assert.equal(out.replace(/\0+$/, ''), '<a x="1" y="2"><PARAM id="d" value="0.25"/></a>');
});

test('signature expands synonyms and camelCase', { skip: !pyOk }, () => {
  assert.deepEqual(pyJson("[m.signature('lo_mid_freq'), m.signature('lowMidFrequency'), m.signature('Cab L Level')]"),
    ['lowmiddlefrequency', 'lowmiddlefrequency', 'cableftlevel']);
});
