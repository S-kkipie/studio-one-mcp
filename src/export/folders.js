// Where Studio One writes exports: the folders come from the song's settings.xml (SongRenderer /
// StemRenderer sections) plus the default <song folder>/Mixdown|Stems. Snapshot a folder before the
// export, diff after it, then move the new files to the requested output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSongArchive } from '../song.js';

export const AUDIO_EXTS = ['wav', 'aif', 'aiff', 'flac', 'caf', 'm4a', 'ogg', 'opus', 'mp3'];

const extOf = (p) => path.extname(String(p)).slice(1).toLowerCase();
const isAudioPath = (p) => AUDIO_EXTS.includes(extOf(p));

function defaultReader(songFile) {
  try {
    return openSongArchive(songFile).text('settings.xml');
  } catch {
    return null;
  }
}

const unescapeXml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const stripSep = (p) => {
  const root = path.parse(p).root;
  if (p === root) return p;
  const t = p.replace(/[\\/]+$/, '');
  return t.length < root.length ? root : t;
};

function settingsFolder(xml, section) {
  if (!xml) return null;
  const m = new RegExp(`<Section\\s+path="${section}"[^>]*>`).exec(xml);
  if (!m || m[0].endsWith('/>')) return null;
  const rest = xml.slice(m.index + m[0].length);
  const next = rest.indexOf('<Section');
  const u = /\burl="(file:\/\/\/[^"]*)"/.exec(next < 0 ? rest : rest.slice(0, next));
  if (!u) return null;
  try {
    return stripSep(fileURLToPath(unescapeXml(u[1])));
  } catch {
    return null;
  }
}

// -> candidate export folders for `kind` ('mixdown' | 'stems'), settings first, default second.
export function exportFolders(songFile, kind, { readSettingsXml = defaultReader } = {}) {
  const section = kind === 'stems' ? 'StemRenderer' : 'SongRenderer';
  const out = [];
  const fromSettings = settingsFolder(readSettingsXml(songFile), section);
  if (fromSettings) out.push(fromSettings);
  out.push(path.join(path.dirname(songFile), kind === 'stems' ? 'Stems' : 'Mixdown'));
  const win = process.platform === 'win32';
  const seen = new Set();
  return out.filter((f) => {
    const k = win ? f.toLowerCase() : f;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// -> Map path -> "mtimeMs:size" for the audio files directly inside the existing folders.
export function snapshotFolders(folders) {
  const map = new Map();
  for (const dir of folders) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!isAudioPath(n)) continue;
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) map.set(p, `${st.mtimeMs}:${st.size}`);
      } catch { /* vanished */ }
    }
  }
  return map;
}

// -> paths in `after` that are new or changed since `before`, sorted.
export function newFiles(before, after) {
  return [...after].filter(([p, v]) => before.get(p) !== v).map(([p]) => p).sort();
}

function freeName(fsx, dest) {
  if (!fsx.existsSync(dest)) return dest;
  const { dir, name, ext } = path.parse(dest);
  for (let i = 2; ; i++) {
    const c = path.join(dir, `${name} (${i})${ext}`);
    if (!fsx.existsSync(c)) return c;
  }
}

const samePath = (a, b) => {
  const x = path.resolve(a), y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

function move(fsx, from, to) {
  try {
    fsx.renameSync(from, to);
  } catch (e) {
    if (e?.code !== 'EXDEV') throw e;
    fsx.copyFileSync(from, to);
    fsx.unlinkSync(from);
  }
}

// Moves the exported files to `output` (a folder, or for a mixdown a file path with an audio
// extension). Never overwrites: a taken name gets " (2)", " (3)"... -> the final paths.
export function moveFiles(files, output, { kind, fs: fsx = fs } = {}) {
  const asFile = kind !== 'stems' && isAudioPath(output);
  if (asFile) {
    if (files.length !== 1 || extOf(files[0]) !== extOf(output)) {
      throw new Error(`output is a file path but the export wrote ${files.length} files; give a folder`);
    }
    fsx.mkdirSync(path.dirname(output), { recursive: true });
    if (samePath(files[0], output)) return [files[0]];
    const dest = freeName(fsx, output);
    move(fsx, files[0], dest);
    return [dest];
  }
  fsx.mkdirSync(output, { recursive: true });
  return files.map((f) => {
    const want = path.join(output, path.basename(f));
    if (samePath(f, want)) return f;
    const dest = freeName(fsx, want);
    move(fsx, f, dest);
    return dest;
  });
}

// Fails early (before any export) on an output that cannot work.
export function checkOutput(output, kind, formats) {
  if (!output || !isAudioPath(output)) return;
  if (kind === 'stems') throw new Error('stems need a folder for output');
  if (Array.isArray(formats)) {
    if (formats.length > 1) throw new Error('output is a file path but several formats were requested; give a folder');
    if (formats.length === 1 && String(formats[0]).toLowerCase() !== extOf(output)) {
      throw new Error(`output extension .${extOf(output)} does not match the format ${formats[0]}`);
    }
  }
}
