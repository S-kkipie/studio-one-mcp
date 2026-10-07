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
// When one name has several files: the one that needs no repacking first.
const EXT_RANK = { '.preset': 0, '.vstpreset': 1, '.fxpreset': 2, '.instrument': 3 };

// -> [{ dir, exts }]: the user's Studio One presets first, then the install's, then VST3 folders.
export function presetFileRoots() {
  const out = presetRoots().map((dir) => ({ dir, exts: S1_EXTS }));
  if (process.env.STUDIO_ONE_PRESETS) return out;
  const vst3 = [path.join(os.homedir(), 'Documents', 'VST3 Presets')];
  if (process.platform === 'win32') vst3.push(path.join(process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files', 'VST3 Presets'));
  else vst3.push('/Library/Audio/Presets', path.join(os.homedir(), 'Library/Audio/Presets'));
  return [...out, ...vst3.filter((d) => fs.existsSync(d)).map((dir) => ({ dir, exts: VST3_EXTS }))];
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

/**
 * The file of preset `preset` (a name from the preset list; "Folder/Name" prefers the file in that
 * subfolder) of the plug-in whose folder is `folder` (its class name, e.g. "Mai Tai").
 * `cid`: files that name another class are skipped. `exts`: only these extensions.
 * -> { file, ext } or null.
 */
export function findPresetFile({ folder, preset, cid = null, exts = null, roots = presetFileRoots() }) {
  if (!folder || !preset) return null;
  const parts = String(preset).split(/[\\/]/).filter(Boolean);
  const stem = lc(parts.pop() || '');
  const sub = parts.map(lc);
  const hits = [];
  let order = 0;
  for (const root of roots) {
    const allowed = (root.exts || S1_EXTS).filter((e) => !exts || exts.includes(e));
    for (const dir of pluginDirs(root.dir, folder)) {
      for (const file of filesIn(dir)) {
        const ext = lc(path.extname(file));
        if (!allowed.includes(ext) || lc(path.basename(file, path.extname(file))) !== stem) continue;
        const rel = path.relative(dir, path.dirname(file)).split(path.sep).filter(Boolean).map(lc);
        const inSub = sub.length > 0 && rel.slice(-sub.length).join('/') === sub.join('/');
        if (cid) {
          const got = presetFileClassId(file);
          if (got && lc(got) !== lc(cid)) continue;
        }
        hits.push({ file, ext, inSub, order: order++ });
      }
    }
  }
  // A folder prefix narrows the choice when it matches the files' folders; otherwise the name decides.
  const pool = hits.some((h) => h.inSub) ? hits.filter((h) => h.inSub) : hits;
  if (!pool.length) return null;
  pool.sort((a, b) => (EXT_RANK[a.ext] - EXT_RANK[b.ext]) || (a.order - b.order));
  return { file: pool[0].file, ext: pool[0].ext };
}
