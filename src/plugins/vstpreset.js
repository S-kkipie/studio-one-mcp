// .vstpreset (VST3 preset container) and JUCE "VC2!" state helpers. All little-endian.

export function parseVstPreset(buf) {
  if (buf.length < 48 || buf.toString('latin1', 0, 4) !== 'VST3') throw new Error('not a VST3 preset');
  const classId = buf.toString('ascii', 8, 40);
  const listOff = Number(buf.readBigInt64LE(40));
  if (listOff + 8 > buf.length || buf.toString('latin1', listOff, listOff + 4) !== 'List') {
    throw new Error('not a VST3 preset: bad chunk list');
  }
  const count = buf.readInt32LE(listOff + 4);
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const p = listOff + 8 + i * 20;
    const id = buf.toString('latin1', p, p + 4);
    const off = Number(buf.readBigInt64LE(p + 4));
    const size = Number(buf.readBigInt64LE(p + 12));
    chunks.push({ id, data: Buffer.from(buf.subarray(off, off + size)) });
  }
  return { classId, chunks };
}

export function buildVstPreset({ classId, chunks }) {
  const dataLen = chunks.reduce((n, c) => n + c.data.length, 0);
  const listOff = 48 + dataLen;
  const out = Buffer.alloc(listOff + 8 + chunks.length * 20);
  out.write('VST3', 0, 'latin1');
  out.writeInt32LE(1, 4);
  out.write(classId, 8, 32, 'ascii');
  out.writeBigInt64LE(BigInt(listOff), 40);
  let off = 48;
  const entries = [];
  for (const c of chunks) {
    c.data.copy(out, off);
    entries.push({ id: c.id, off, size: c.data.length });
    off += c.data.length;
  }
  out.write('List', listOff, 'latin1');
  out.writeInt32LE(chunks.length, listOff + 4);
  entries.forEach((e, i) => {
    const p = listOff + 8 + i * 20;
    out.write(e.id, p, 4, 'latin1');
    out.writeBigInt64LE(BigInt(e.off), p + 4);
    out.writeBigInt64LE(BigInt(e.size), p + 12);
  });
  return out;
}

export function readJuceXml(compData) {
  if (compData.length < 8 || compData.toString('latin1', 0, 4) !== 'VC2!') return null;
  const size = compData.readUInt32LE(4);
  let end = Math.min(8 + size, compData.length);
  const nul = compData.indexOf(0, 8);
  if (nul !== -1 && nul < end) end = nul;
  return compData.toString('utf8', 8, end);
}

export function writeJuceXml(xml) {
  const body = Buffer.from(xml, 'utf8');
  const out = Buffer.alloc(8 + body.length + 1);
  out.write('VC2!', 0, 'latin1');
  out.writeUInt32LE(body.length + 1, 4);
  body.copy(out, 8);
  return out;
}

const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const unescAttr = (v) => v.replace(/&(quot|lt|gt|apos|amp);/g, (_m, n) => ({ quot: '"', lt: '<', gt: '>', apos: "'", amp: '&' })[n]);

// Keys are a plain attribute name (its first occurrence in the document) or, for elements that
// carry an id (JUCE APVTS: <PARAM id="gain" value="0.5"/>), "TAG[id=x]@attr" as the scanner writes them.
const ID_KEY = /^([^\s[\]@]+)\[id=(.*)\]@([^\s[\]@=]+)$/;

// [start, end) of the attribute value for `key`, or null.
function locate(xml, key) {
  const m = ID_KEY.exec(key);
  if (!m) {
    const r = new RegExp(`\\s${esc(key)}="([^"]*)"`).exec(xml);
    return r ? { start: r.index + r[0].length - 1 - r[1].length, end: r.index + r[0].length - 1 } : null;
  }
  const [, tag, id, attr] = m;
  const tagRe = new RegExp(`<${esc(tag)}(?=[\\s/>])[^>]*>`, 'g');
  for (let t; (t = tagRe.exec(xml));) {
    const idm = /\sid="([^"]*)"/.exec(t[0]);
    if (!idm || unescAttr(idm[1]) !== id) continue;
    const a = new RegExp(`\\s${esc(attr)}="([^"]*)"`).exec(t[0]);
    if (!a) return null;
    const end = t.index + a.index + a[0].length - 1;
    return { start: end - a[1].length, end };
  }
  return null;
}

export function setXmlAttrs(xml, attrs) {
  const missing = [];
  let out = xml;
  for (const [k, v] of Object.entries(attrs)) {
    const at = locate(out, k);
    if (at) out = out.slice(0, at.start) + escAttr(v) + out.slice(at.end);
    else missing.push(k);
  }
  return { xml: out, missing };
}

export function getXmlAttrs(xml, keys) {
  const res = {};
  for (const k of keys) {
    const at = locate(xml, k);
    res[k] = at ? unescAttr(xml.slice(at.start, at.end)) : null;
  }
  return res;
}
