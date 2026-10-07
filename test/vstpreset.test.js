import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVstPreset, buildVstPreset, readJuceXml, writeJuceXml, setXmlAttrs, getXmlAttrs,
} from '../src/plugins/vstpreset.js';

const CLASS_ID = 'ABCDEF019182FAEB4E4453504E4A5058';
function sample() {
  return {
    classId: CLASS_ID,
    chunks: [
      { id: 'Comp', data: writeJuceXml('<a x="1" y="true"/>') },
      { id: 'Cont', data: Buffer.alloc(0) },
      { id: 'Info', data: Buffer.from('<Info a="b"/>', 'utf8') },
    ],
  };
}

test('round-trips a preset', () => {
  const p = sample();
  const r = parseVstPreset(buildVstPreset(p));
  assert.equal(r.classId, CLASS_ID);
  assert.deepEqual(r.chunks.map((c) => c.id), ['Comp', 'Cont', 'Info']);
  for (let i = 0; i < 3; i++) assert.ok(r.chunks[i].data.equals(p.chunks[i].data));
});

test('readJuceXml / writeJuceXml', () => {
  const comp = writeJuceXml('<a x="1"/>');
  assert.equal(readJuceXml(comp), '<a x="1"/>');
  assert.equal(comp.readUInt32LE(4), Buffer.byteLength('<a x="1"/>') + 1);
  assert.equal(readJuceXml(Buffer.from('nope')), null);
});

test('setXmlAttrs / getXmlAttrs', () => {
  const { xml, missing } = setXmlAttrs('<a x="1" y="true"/>', { x: '2', zz: '3' });
  assert.equal(xml, '<a x="2" y="true"/>');
  assert.deepEqual(missing, ['zz']);
  assert.deepEqual(getXmlAttrs(xml, ['x', 'q']), { x: '2', q: null });
});

test('bad header throws', () => {
  assert.throws(() => parseVstPreset(Buffer.alloc(64)), /not a VST3 preset/);
});

test('byte-exact layout', () => {
  const b = buildVstPreset(sample());
  assert.equal(b.toString('latin1', 0, 4), 'VST3');
  assert.equal(b.readInt32LE(4), 1);
  assert.equal(b.toString('ascii', 8, 40), CLASS_ID);
  const off = Number(b.readBigInt64LE(40));
  assert.equal(b.toString('latin1', off, off + 4), 'List');
  assert.equal(b.readInt32LE(off + 4), 3);
  assert.equal(Number(b.readBigInt64LE(off + 12)), 48);
});

test('setXmlAttrs escapes and getXmlAttrs unescapes', () => {
  const val = 'a"b&c<d';
  const { xml } = setXmlAttrs('<a x="1"/>', { x: val });
  assert.equal(xml, '<a x="a&quot;b&amp;c&lt;d"/>');
  assert.equal(getXmlAttrs(xml, ['x']).x, val);
  assert.equal(setXmlAttrs(xml, { x: getXmlAttrs(xml, ['x']).x }).xml, xml);
});

test('TAG[id=x]@attr keys address the attribute of the element with that id (APVTS style)', () => {
  const src = '<S><PARAM id="gain" value="0.5"/><PARAM value="1" id="mix"/><PARAM id="a&amp;b" value="2"/><X value="9"/></S>';
  const { xml, missing } = setXmlAttrs(src, { 'PARAM[id=mix]@value': 0.25, 'PARAM[id=a&b]@value': 3, 'PARAM[id=nope]@value': 1, 'PARAM[id=gain]@zz': 1, value: 7 });
  assert.equal(xml, '<S><PARAM id="gain" value="7"/><PARAM value="0.25" id="mix"/><PARAM id="a&amp;b" value="3"/><X value="9"/></S>');
  assert.deepEqual(missing, ['PARAM[id=nope]@value', 'PARAM[id=gain]@zz']);
  assert.deepEqual(getXmlAttrs(xml, ['PARAM[id=gain]@value', 'PARAM[id=mix]@value', 'PARAM[id=a&b]@value', 'X[id=q]@value']), {
    'PARAM[id=gain]@value': '7', 'PARAM[id=mix]@value': '0.25', 'PARAM[id=a&b]@value': '3', 'X[id=q]@value': null,
  });
});

test('TAG[id=x]@attr does not match a longer tag name or a self-closing tag of another element', () => {
  const src = '<PARAMS id="g" value="1"/><PARAM id="g" value="2"/>';
  assert.equal(setXmlAttrs(src, { 'PARAM[id=g]@value': 5 }).xml, '<PARAMS id="g" value="1"/><PARAM id="g" value="5"/>');
});
