import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPackage, buildPackage } from '../src/commands/packages.js';

test('readPackage returns every file by name', () => {
  const buf = buildPackage([
    { name: 'classfactory.xml', data: Buffer.from('<ClassFactory/>') },
    { name: 'Transpose.js', data: Buffer.from('parameters.addInteger (-64, 64, "AddValue");') },
  ]);
  const files = readPackage(buf);
  assert.deepEqual([...files.keys()], ['classfactory.xml', 'Transpose.js']);
  assert.equal(files.get('Transpose.js').toString(), 'parameters.addInteger (-64, 64, "AddValue");');
});

test('readPackage rejects a non-package buffer', () => {
  assert.throws(() => readPackage(Buffer.from('hello world')), /not a Studio One package/);
});

test('readPackage skips an entry whose stream is corrupt', () => {
  const buf = buildPackage([{ name: 'a.js', data: Buffer.from('ok') }, { name: 'b.js', data: Buffer.from('fine') }]);
  buf[8 + 2] ^= 0xff; // damage the first stream's deflate data
  const files = readPackage(buf);
  assert.equal(files.has('a.js'), false);
  assert.equal(files.get('b.js').toString(), 'fine');
});
