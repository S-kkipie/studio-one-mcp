// Studio One's script packages (<install>/Scripts/*.package): "PACKAGEF", the
// files as zlib streams, then a directory: per file "File", u32 type, UTF-16LE
// name ended by 00 00, 9 bytes (date), u64 offset, u64 compressed, u64 size.
import zlib from 'node:zlib';

const MAGIC = Buffer.from('PACKAGEF');
const MARK = Buffer.from([0x46, 0x69, 0x6c, 0x65, 0x02, 0x00, 0x00, 0x00]); // "File" + u32 2

export function readPackage(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(MAGIC)) throw new Error('not a Studio One package');
  const files = new Map();
  let i = 8;
  while ((i = buf.indexOf(MARK, i)) >= 0) {
    let j = i + 8;
    let name = '';
    while (j + 1 < buf.length && buf.readUInt16LE(j) !== 0 && j - (i + 8) < 520) { name += String.fromCharCode(buf.readUInt16LE(j)); j += 2; }
    if (j - (i + 8) >= 520 || j + 2 + 9 + 24 > buf.length) { i += 1; continue; } // not a real entry
    j += 2 + 9;
    const offset = Number(buf.readBigUInt64LE(j));
    const csize = Number(buf.readBigUInt64LE(j + 8));
    i = j + 24;
    if (!name || offset < 8 || offset + csize > buf.length) continue;
    try { files.set(name, zlib.inflateSync(buf.subarray(offset, offset + csize))); } catch { /* corrupt entry: skip */ }
  }
  return files;
}

// Builds a package in the same layout (tests and fixtures).
export function buildPackage(files) {
  const streams = [];
  const dir = [];
  let offset = 8;
  for (const f of files) {
    const z = zlib.deflateSync(f.data);
    streams.push(z);
    const name = Buffer.from(f.name + '\0', 'utf16le');
    const nums = Buffer.alloc(24);
    nums.writeBigUInt64LE(BigInt(offset), 0);
    nums.writeBigUInt64LE(BigInt(z.length), 8);
    nums.writeBigUInt64LE(BigInt(f.data.length), 16);
    dir.push(MARK, name, Buffer.from([0xe9, 0x07, 7, 0x1d, 0x12, 0x16, 3, 0, 0]), nums);
    offset += z.length;
  }
  return Buffer.concat([MAGIC, ...streams, ...dir, Buffer.alloc(28), MAGIC]);
}
