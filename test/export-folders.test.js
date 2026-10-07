import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportFolders, snapshotFolders, newFiles, moveFiles, checkOutput } from '../src/export/folders.js';

const song = path.join(os.tmpdir(), 'songs', 'x', 'x.song');
const dflt = (k) => path.join(path.dirname(song), k);
const url = (p) => `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}/`;
const xml = (mix, stem) => `<Settings>${mix ? `<Section path="SongRenderer"><Attributes fileName="Mixdown"><Url x:id="mixdown" type="2" url="${url(mix)}"/></Attributes></Section>` : ''}${stem ? `<Section path="StemRenderer"><Attributes><Url url="${url(stem)}"/></Attributes></Section>` : ''}</Settings>`;

test('exportFolders reads settings, then the default', () => {
  const mix = path.join(os.tmpdir(), 'My Mixes', 'a');
  const stem = path.join(os.tmpdir(), 'My Stems');
  const r = exportFolders(song, 'mixdown', { readSettingsXml: () => xml(mix, stem) });
  assert.deepEqual(r, [mix, dflt('Mixdown')]);
  assert.deepEqual(exportFolders(song, 'stems', { readSettingsXml: () => xml(mix, stem) }), [stem, dflt('Stems')]);
});

test('exportFolders without settings or with a url equal to the default', () => {
  assert.deepEqual(exportFolders(song, 'mixdown', { readSettingsXml: () => null }), [dflt('Mixdown')]);
  assert.deepEqual(exportFolders(song, 'mixdown', { readSettingsXml: () => '<Settings/>' }), [dflt('Mixdown')]);
  assert.deepEqual(exportFolders(song, 'mixdown', { readSettingsXml: () => xml(dflt('Mixdown')) }), [dflt('Mixdown')]);
});

test('snapshot and newFiles', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-'));
  fs.writeFileSync(path.join(d, 'a.wav'), 'one');
  const before = snapshotFolders([d, path.join(d, 'missing')]);
  fs.writeFileSync(path.join(d, 'b.mp3'), 'x');
  fs.writeFileSync(path.join(d, 'a.wav'), 'longer content');
  fs.writeFileSync(path.join(d, 'n.txt'), 'x');
  const after = snapshotFolders([d]);
  assert.deepEqual(newFiles(before, after), [path.join(d, 'a.wav'), path.join(d, 'b.mp3')]);
  fs.rmSync(d, { recursive: true });
});

test('moveFiles to a folder with collision, to a file, errors, EXDEV', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-'));
  const src = path.join(d, 'src');
  const out = path.join(d, 'out');
  fs.mkdirSync(src); fs.mkdirSync(out);
  fs.writeFileSync(path.join(src, 'a.wav'), 'new');
  fs.writeFileSync(path.join(out, 'a.wav'), 'old');
  assert.deepEqual(moveFiles([path.join(src, 'a.wav')], out, { kind: 'mixdown' }), [path.join(out, 'a (2).wav')]);
  assert.equal(fs.readFileSync(path.join(out, 'a.wav'), 'utf8'), 'old');
  assert.ok(!fs.existsSync(path.join(src, 'a.wav')));

  fs.writeFileSync(path.join(src, 'b.wav'), 'b');
  const target = path.join(d, 'deep', 'final.wav');
  assert.deepEqual(moveFiles([path.join(src, 'b.wav')], target, { kind: 'mixdown' }), [target]);
  assert.equal(fs.readFileSync(target, 'utf8'), 'b');

  fs.writeFileSync(path.join(src, 'c.wav'), 'c'); fs.writeFileSync(path.join(src, 'd.wav'), 'd');
  assert.throws(() => moveFiles([path.join(src, 'c.wav'), path.join(src, 'd.wav')], path.join(d, 'x.wav'), { kind: 'mixdown' }), /output is a file path but the export wrote 2 files; give a folder/);

  const calls = [];
  const fake = {
    ...fs,
    existsSync: () => false,
    mkdirSync: () => {},
    renameSync: () => { throw Object.assign(new Error('x'), { code: 'EXDEV' }); },
    copyFileSync: (a, b) => calls.push(['copy', a, b]),
    unlinkSync: (a) => calls.push(['unlink', a]),
  };
  moveFiles(['/s/a.wav'], '/o', { kind: 'mixdown', fs: fake });
  assert.deepEqual(calls.map((c) => c[0]), ['copy', 'unlink']);
  fs.rmSync(d, { recursive: true });
});

test('checkOutput', () => {
  assert.throws(() => checkOutput('/o/x.wav', 'stems', ['wav']), /stems need a folder for output/);
  assert.throws(() => checkOutput('/o/x.wav', 'mixdown', ['wav', 'mp3']), /several formats/);
  assert.throws(() => checkOutput('/o/x.wav', 'mixdown', ['mp3']), /does not match/);
  checkOutput('/o/x.wav', 'mixdown', ['wav']);
  checkOutput('/o/x.wav', 'mixdown');
  checkOutput('/o/folder', 'stems', ['wav']);
  checkOutput('/o/folder', 'mixdown', ['wav', 'mp3']);
});

test('moveFiles keeps a file already at its destination in place', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xi-'));
  const f = path.join(d, 'a.wav');
  fs.writeFileSync(f, 'a');
  assert.deepEqual(moveFiles([f], d, { kind: 'mixdown' }), [f]);
  assert.deepEqual(moveFiles([f], f, { kind: 'mixdown' }), [f]);
  assert.deepEqual(fs.readdirSync(d), ['a.wav']);
  fs.rmSync(d, { recursive: true });
});

test('settings parsing: self-closing sections, section boundary, drive roots', () => {
  const dir = path.join(os.tmpdir(), 'zz');
  const sc = `<Section path="SongRenderer"/><Section path="Other"><Url url="${url(dir)}"/></Section>`;
  assert.deepEqual(exportFolders(song, 'mixdown', { readSettingsXml: () => sc }), [dflt('Mixdown')]);
  const empty = `<Section path="SongRenderer"><Attributes/></Section><Section path="Other"><Url url="${url(dir)}"/></Section>`;
  assert.deepEqual(exportFolders(song, 'mixdown', { readSettingsXml: () => empty }), [dflt('Mixdown')]);
  if (process.platform === 'win32') {
    const root = `<Section path="SongRenderer"><Url url="file:///C:/"/></Section>`;
    assert.equal(exportFolders(song, 'mixdown', { readSettingsXml: () => root })[0], 'C:\');
  }
});
