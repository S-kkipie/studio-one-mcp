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

/**
 * The file of preset `preset` (a name from the preset list) of the plug-in whose folder is `folder` (its
 * class name, e.g. "Mai Tai"). Roots are searched in order and the first root with a match decides,
 * whatever the extension, so the user's own presets win over factory ones of the same name. Within that
 * root the name must be one file: several (in different subfolders, or with different extensions) is an
 * error listing them, to be told apart with "Folder/Name" ("./Name" for the one directly in the
 * plug-in's folder). `cid`: files that name another class are skipped. `exts`: only these extensions.
 * -> { file, ext } or null.
 */
export function findPresetFile({ folder, preset, cid = null, exts = null, roots = presetFileRoots() }) {
  if (!folder || !preset) return null;
  const raw = String(preset).replace(/\\/g, '/');
  const top = /^\.?\//.test(raw);
  const parts = raw.split('/').filter((x) => x && x !== '.');
  const stem = lc(parts.pop() || '');
  const sub = parts.map(lc);
  for (const root of roots) {
    const allowed = (root.exts || S1_EXTS).filter((e) => !exts || exts.includes(e));
    const hits = [];
    for (const dir of pluginDirs(root.dir, folder)) {
      for (const file of filesIn(dir)) {
        const ext = lc(path.extname(file));
        if (!allowed.includes(ext) || lc(path.basename(file, path.extname(file))) !== stem) continue;
        if (cid) {
          const got = presetFileClassId(file);
          if (got && lc(got) !== lc(cid)) continue;
        }
        const rel = path.relative(dir, path.dirname(file)).split(path.sep).filter(Boolean).map(lc);
        const inSub = top ? rel.length === 0 : sub.length > 0 && rel.slice(-sub.length).join('/') === sub.join('/');
        hits.push({ file, ext, inSub, folderRel: path.relative(dir, path.dirname(file)).split(path.sep).join('/') });
      }
    }
    if (!hits.length) continue;
    // A folder prefix narrows the choice when it matches the files' folders; otherwise the name decides.
    const pool = hits.some((h) => h.inSub) ? hits.filter((h) => h.inSub) : hits;
    if (pool.length > 1) {
      const list = pool.map((h) => path.relative(root.dir, h.file).split(path.sep).join('/'));
      const name = parts.length || top ? raw.split('/').pop() : String(preset);
      const how = pool.map((h) => `"${h.folderRel ? h.folderRel : '.'}/${name}"`);
      throw new Error(`preset "${preset}" matches ${pool.length} files in ${root.dir}: ${list.join(', ')}; pass preset as Folder/Name to pick one (${[...new Set(how)].join(' or ')})`);
    }
    return { file: pool[0].file, ext: pool[0].ext };
  }
  return null;
}
