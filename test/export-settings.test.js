// exportSettings bridge op against the fake Host.Settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeHost, fakeAttrs, fakeCodec, loadCore, MAILBOX } from './helpers/s1host.js';

const ALL = ['mp3', 'wav', 'aif', 'flac', 'caf', 'm4a', 'ogg', 'opus'];

function setup(withSettings = true) {
  const settings = withSettings ? {
    SongRenderer: fakeAttrs({ renderRange: 0, closeAfterExport: 1, importToTrack: 0, preMasterFX: 0, writeAudioTempo: 1, realtimeOption: 0 }),
    'SongRenderer.AudioCodec': fakeCodec('mp3'),
    StemRenderer: fakeAttrs({ renderRange: 0, closeAfterExport: 0, realtime: 0, splitMono: 0 }),
    'StemRenderer.AudioCodec': fakeCodec('mp3'),
  } : undefined;
  const host = fakeHost(withSettings ? { settings } : {});
  const { get } = loadCore({ host, config: { mailbox: MAILBOX, allowEval: false } });
  const Bridge = get('Bridge');
  const bridge = new Bridge({ mailbox: MAILBOX, allowEval: false }, null);
  let n = 0;
  const ask = (op, args) => {
    const id = `req-${++n}`;
    host.client.write('request.json', { id, op, args });
    bridge.tick('test');
    return host.client.read('response.json');
  };
  const exp = (args) => ask('exportSettings', args);
  return { host, settings, exp };
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const result = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return plain(r.result); };

test('get (mixdown) reports range, current, selected, available', () => {
  const { exp } = setup();
  const r = result(exp({ kind: 'mixdown', action: 'get' }));
  assert.equal(r.range, 0);
  assert.equal(r.current, 'mp3');
  assert.deepEqual(r.selected, ['mp3']);
  assert.deepEqual(r.available, ALL);
});

test('apply swaps format, selects, sets options; restore puts it all back', () => {
  const { exp, settings } = setup();
  const first = result(exp({ kind: 'mixdown', action: 'get' }));
  const a = result(exp({ kind: 'mixdown', action: 'apply', range: 1, formats: ['wav', 'flac'], options: { importToTrack: true } }));
  assert.equal(a.current, 'wav');
  assert.ok(a.selected.includes('wav') && a.selected.includes('flac'));
  assert.ok(!a.selected.includes('mp3'));
  const r = settings.SongRenderer;
  assert.equal(r.getAttribute('renderRange'), 1);
  assert.equal(r.getAttribute('importToTrack'), 1);
  assert.equal(r.getAttribute('closeAfterExport'), 1);
  assert.equal(settings['SongRenderer.AudioCodec'].getAttribute('mp3').getAttribute('fileType').extension, 'mp3');
  const back = result(exp({ kind: 'mixdown', action: 'restore' }));
  assert.equal(back.restored, true);
  assert.deepEqual(back.settings, first);
  assert.deepEqual(result(exp({ kind: 'mixdown', action: 'get' })), first);
  assert.equal(r.getAttribute('importToTrack'), 0);
  // all original entries are back; nothing extra
  assert.equal(settings['SongRenderer.AudioCodec'].getAttribute('wav').getAttribute('fileType').extension, 'wav');
});

test('restore removes entries added by apply', () => {
  const { exp, settings } = setup();
  const codec = settings['SongRenderer.AudioCodec'];
  codec.removeAttribute('aif');
  // aif is gone from the snapshot's perspective only if removed before apply; apply adds mp3 entry
  result(exp({ kind: 'mixdown', action: 'apply', formats: ['wav'] }));
  assert.ok(codec.getAttribute('mp3'));
  result(exp({ kind: 'mixdown', action: 'restore' }));
  assert.equal(codec.getAttribute('mp3'), undefined);
});

test('invalid applies fail and mutate nothing', () => {
  const { exp } = setup();
  const first = result(exp({ kind: 'stems', action: 'get' }));
  const two = exp({ kind: 'stems', action: 'apply', formats: ['wav', 'flac'] });
  assert.equal(two.ok, false);
  assert.match(two.error, /exactly one/);
  const bad = exp({ kind: 'stems', action: 'apply', formats: ['xyz'], range: 2 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not available/);
  assert.deepEqual(result(exp({ kind: 'stems', action: 'get' })), first);
  assert.equal(exp({ kind: 'stems', action: 'restore' }).result.restored, false);
});

test('apply with only the current format deselects every entry', () => {
  const { exp, settings } = setup();
  const codec = settings['SongRenderer.AudioCodec'];
  codec.getAttribute('wav').setAttribute('selected', 1);
  const a = result(exp({ kind: 'mixdown', action: 'apply', formats: ['mp3'] }));
  assert.equal(a.current, 'mp3');
  assert.deepEqual(a.selected, ['mp3']);
  for (const e of ALL.slice(1)) assert.equal(codec.getAttribute(e).getAttribute('selected'), 0);
});

test('a second apply keeps the first snapshot', () => {
  const { exp } = setup();
  const first = result(exp({ kind: 'mixdown', action: 'get' }));
  result(exp({ kind: 'mixdown', action: 'apply', formats: ['wav'], range: 1 }));
  result(exp({ kind: 'mixdown', action: 'apply', formats: ['flac'], range: 2 }));
  const back = result(exp({ kind: 'mixdown', action: 'restore' }));
  assert.equal(back.restored, true);
  assert.deepEqual(back.settings, first);
});

test('restore without a snapshot reports restored false', () => {
  const { exp } = setup();
  assert.equal(result(exp({ kind: 'mixdown', action: 'restore' })).restored, false);
});

test('unknown kind fails', () => {
  const { exp } = setup();
  assert.equal(exp({ kind: 'video', action: 'get' }).ok, false);
});

test('empty settings fail cleanly instead of throwing', () => {
  const { exp } = setup(false);
  const r = exp({ kind: 'mixdown', action: 'get' });
  assert.equal(r.ok, false);
});
