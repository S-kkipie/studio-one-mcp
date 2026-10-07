// The file behind a preset name, so a preset can be loaded in place (Load Preset File) instead of
// replacing the plug-in. Studio One's preset list (Host:PresetParam) gives names only; the files are
// in folders named after the plug-in:
//  - Studio One's own: <install>/Presets/<Vendor>/<Plug-in>/** and Documents/Studio One/Presets/**
//    (.preset; .instrument for instrument + FX presets; .vstpreset);
//  - VST3 preset folders (Documents/VST3 Presets, Common Files/VST3 Presets): <Vendor>/<Plug-in>/**,
//    .vstpreset only.
// Read only: nothing is ever written into these folders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { presetRoots } from '../paths.js';
import { parseVstPreset } from './vstpreset.js';

const S1_EXTS = ['.preset', '.vstpreset', '.fxpreset', '.instrument'];
const VST3_EXTS = ['.vstpreset'];

// -> [{ dir, exts }] in precedence order: the user's folders (Documents/Studio One/Presets, Documents/VST3
// Presets) before the factory ones (the install's Presets, Common Files/VST3 Presets).
export function presetFileRoots() {
  const out = presetRoots().map((dir) => ({ dir, exts: S1_EXTS }));
  if (!process.env.STUDIO_ONE_PRESETS) {
    const vst3 = [path.join(os.homedir(), 'Documents', 'VST3 Presets')];
    if (process.platform === 'win32') vst3.push(path.join(process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files', 'VST3 Presets'));
    else vst3.push(path.join(os.homedir(), 'Library/Audio/Presets'), '/Library/Audio/Presets');
    out.push(...vst3.filter((d) => fs.existsSync(d)).map((dir) => ({ dir, exts: VST3_EXTS })));
  }
  const home = path.resolve(os.homedir()).toLowerCase();
  const isUser = (r) => path.resolve(r.dir).toLowerCase().startsWith(home + path.sep) ? 0 : 1;
  return out.map((r, i) => [r, i]).sort((x, y) => (isUser(x[0]) - isUser(y[0])) || (x[1] - y[1])).map(([r]) => r);
}

const lc = (s) => String(s).toLowerCase();
const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

// Folders named `folder` (case-insensitive) within `depth` levels below `root`.
function* pluginDirs(root, folder, depth = 3) {
  for (const e of list(root)) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name);
    if (lc(e.name) === lc(folder)) yield p;
    else if (depth > 1) yield* pluginDirs(p, folder, depth - 1);
  }
}

function* filesIn(dir, depth = 5) {
  for (const e of list(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 1) yield* filesIn(p, depth - 1); } else yield p;
  }
}

// The class ID a preset file names, or null when it cannot be told.
export function presetFileClassId(file) {
  const ext = lc(path.extname(file));
  try {
    const buf = fs.readFileSync(file);
    if (ext === '.vstpreset') {
      const h = String(parseVstPreset(buf).classId || '').replace(/[{}-]/g, '').toUpperCase();
      return /^[0-9A-F]{32}$/.test(h) ? `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}` : null;
    }
    if (ext === '.fxpreset') return (/<AudioEffectPreset[^>]*\scid="([^"]+)"/.exec(buf.toString('utf8')) || [])[1] || null;
    const meta = unzipSync(new Uint8Array(buf))['metainfo.xml'];
    return meta ? (/<Attribute id="Class:ID" value="([^"]*)"/.exec(strFromU8(meta)) || [])[1] || null : null;
  } catch {
    return null;
  }
}

const PRESET_EXT_RE = /\.(preset|vstpreset|fxpreset|instrument)$/i;

// Every preset file in the plug-in's folders, per root in precedence order:
// [{ root, byStem: Map(lower-case stem -> [{ file, ext, folderRel, dir }]) }]. folderRel is the file's
// folder relative to its plug-in folder `dir` ('' directly in it). Only folder listings are read.
export function scanPresetFolder({ folder, exts = null, roots = presetFileRoots() }) {
  const out = [];
  if (!folder) return out;
  for (const root of roots) {
    const allowed = (root.exts || S1_EXTS).filter((e) => !exts || exts.includes(e));
    const byStem = new Map();
    for (const dir of pluginDirs(root.dir, folder)) {
      for (const file of filesIn(dir)) {
        const ext = lc(path.extname(file));
        if (!allowed.includes(ext)) continue;
        const stem = lc(path.basename(file, path.extname(file)));
        const folderRel = path.relative(dir, path.dirname(file)).split(path.sep).filter(Boolean).join('/');
        if (!byStem.has(stem)) byStem.set(stem, []);
        byStem.get(stem).push({ file, ext, folderRel, dir });
      }
    }
    out.push({ root, byStem });
  }
  return out;
}

// The files a name stands for: those of the first root holding one of the right class. -> { root, files } or null.
function candidatesOf(scan, stem, cid) {
  for (const { root, byStem } of scan) {
    let files = byStem.get(stem) || [];
    if (cid) files = files.filter((f) => { const got = presetFileClassId(f.file); return !got || lc(got) === lc(cid); });
    if (files.length) return { root, files };
  }
  return null;
}

// How to name each of several files with one name so that it loads: "Folder/Name" ("./Name" directly in
// the plug-in folder), with the extension added when two of them share a folder.
function spellings(files, name) {
  const perFolder = new Map();
  for (const f of files) perFolder.set(lc(f.folderRel), (perFolder.get(lc(f.folderRel)) || 0) + 1);
  return files.map((f) => `${f.folderRel || '.'}/${name}${perFolder.get(lc(f.folderRel)) > 1 ? f.ext : ''}`);
}

// "Folder/Name", "./Name" or "Name", optionally ending in a preset extension after a folder -> its parts.
export function parsePresetRef(preset) {
  const raw = String(preset ?? '').replace(/\\/g, '/');
  const top = /^\.?\//.test(raw);
  const parts = raw.split('/').filter((x) => x && x !== '.');
  let name = parts.pop() || '';
  let ext = null;
  const m = PRESET_EXT_RE.exec(name);
  if (m && (parts.length || top)) { ext = lc(m[0]); name = name.slice(0, -m[0].length); }
  return { top, sub: parts.map(lc), name, ext };
}

/**
 * The file of preset `preset` (a name from the preset list) of the plug-in whose folder is `folder` (its
 * class name, e.g. "Mai Tai"). Roots are searched in order and the first root with a match decides,
 * whatever the extension, so the user's own presets win over factory ones of the same name.
 * Within that root:
 *  - "Folder/Name" picks the file in that folder (when there is one; else the name alone decides);
 *  - "./Name" picks the file directly in the plug-in's folder, and nothing else;
 *  - a plain name with several files: the one directly in the plug-in's folder wins when it is the only
 *    one there; otherwise it is refused, and err.candidates lists the spellings that load each one.
 * An extension after the folder ("./Pad.fxpreset") picks between files sharing a folder.
 * `cid`: files that name another class are skipped. `exts`: only these extensions. -> { file, ext } or null.
 */
export function findPresetFile({ folder, preset, cid = null, exts = null, roots = presetFileRoots(), scan = null }) {
  if (!folder || !preset) return null;
  const ref = parsePresetRef(preset);
  const found = candidatesOf(scan ?? scanPresetFolder({ folder, exts, roots }), lc(ref.name), cid);
  if (!found) return null;
  const { root, files } = found;
  const byExt = (list) => (ref.ext ? list.filter((f) => f.ext === ref.ext) : list);
  let pool;
  if (ref.top) {
    pool = byExt(files.filter((f) => f.folderRel === ''));
    if (!pool.length) {
      const dirs = [...new Set(files.map((f) => f.dir))];
      throw Object.assign(new Error(`no file named ${ref.name}${ref.ext ?? ''} directly in ${dirs.join(', ')} (it is in: ${spellings(files, ref.name).join(', ')})`),
        { candidates: spellings(files, ref.name) });
    }
  } else {
    const inSub = ref.sub.length ? byExt(files.filter((f) => lc(f.folderRel).split('/').slice(-ref.sub.length).join('/') === ref.sub.join('/'))) : [];
    pool = inSub.length ? inSub : byExt(files);
    if (pool.length > 1) {
      const top = pool.filter((f) => f.folderRel === '');
      if (top.length === 1) pool = top;
    }
  }
  if (pool.length > 1) {
    const all = spellings(files, ref.name);
    const candidates = files.map((f, i) => (pool.includes(f) ? all[i] : null)).filter(Boolean);
    const rel = pool.map((f) => path.relative(root.dir, f.file).split(path.sep).join('/'));
    throw Object.assign(new Error(`preset "${preset}" matches ${pool.length} files in ${root.dir}: ${rel.join(', ')}; pass preset as Folder/Name to pick one (${candidates.map((c) => `"${c}"`).join(' or ')})`), { candidates });
  }
  if (!pool.length) return null;
  return { file: pool[0].file, ext: pool[0].ext };
}

/**
 * Preset list names that stand for several files (in the winning root) -> Map(name -> the spellings that
 * each load one of them). Class IDs are read only for names with more than one file.
 */
export function ambiguousPresetNames(names, { folder, cid = null, exts = null, roots = presetFileRoots(), scan = null }) {
  const out = new Map();
  const sc = scan ?? scanPresetFolder({ folder, exts, roots });
  for (const name of new Set(names)) {
    const stem = lc(name);
    if (!sc.some(({ byStem }) => (byStem.get(stem) || []).length > 1)) continue;
    const found = candidatesOf(sc, stem, cid);
    if (found && found.files.length > 1) out.set(name, spellings(found.files, name));
  }
  return out;
}
