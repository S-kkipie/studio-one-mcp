// Plug-in class IDs by name, from Studio One's own plug-in cache (<profile>/x64/Plugins-<lang>.settings:
// <Section path="<hash>/<file>"> … <ClassDescription classID name category>). The preset list
// (Host:PresetParam) and insertPreset need a class ID; the cache has one for every plug-in Studio One
// knows, PreSonus ones included, without saving the song.
import fs from 'node:fs';
import path from 'node:path';
import { parseXml, kids } from '../xml.js';
import { studioOneProfiles } from '../paths.js';

export function pluginCacheFiles() {
  if (process.env.STUDIO_ONE_PLUGIN_CACHE) return process.env.STUDIO_ONE_PLUGIN_CACHE.split(path.delimiter).filter(Boolean);
  const out = [];
  for (const p of studioOneProfiles()) {
    for (const dir of [path.join(p, 'x64'), p]) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const f of names) if (/^Plugins-.*\.settings$/i.test(f)) out.push(path.join(dir, f));
    }
    if (out.length) break; // newest profile only
  }
  return out;
}

// -> [{ name, cid, category, file }] in cache order.
export function parsePluginCache(text) {
  const root = parseXml(text);
  const out = [];
  for (const sec of kids(root, 'Section')) {
    const file = sec.attrs.path || '';
    const stack = [...sec.children];
    while (stack.length) {
      const n = stack.shift();
      if (n.tag === 'ClassDescription' && n.attrs.classID && n.attrs.name) {
        out.push({ name: n.attrs.name, cid: n.attrs.classID, category: n.attrs.category || null, file });
      }
      stack.push(...n.children);
    }
  }
  return out;
}

const cache = new Map();
export function loadPluginClasses(files = pluginCacheFiles()) {
  const out = [];
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const hit = cache.get(f);
    if (hit && hit.mtimeMs === st.mtimeMs) { out.push(...hit.classes); continue; }
    let classes = [];
    try { classes = parsePluginCache(fs.readFileSync(f, 'utf8')); } catch { classes = []; }
    cache.set(f, { mtimeMs: st.mtimeMs, classes });
    out.push(...classes);
  }
  return out;
}

// VST2 (.dll) copies share the name; Studio One shows the VST3 one when both are installed.
const rank = (c) => (/\.dll$/i.test(c.file) ? 1 : 0);

// The class ID ("{8-4-4-4-12}") of a plug-in by the name live_inserts shows ("Pro EQ",
// "Archetype Petrucci X 2" for a second instance), or null.
export function classIdFor(name, classes = loadPluginClasses()) {
  const want = String(name ?? '').trim();
  if (!want) return null;
  const pick = (q) => {
    const hits = classes.filter((c) => c.name === q);
    const ci = hits.length ? hits : classes.filter((c) => c.name.toLowerCase() === q.toLowerCase());
    return ci.length ? [...ci].sort((a, b) => rank(a) - rank(b))[0].cid : null;
  };
  return pick(want) || (/\s+\d+$/.test(want) ? pick(want.replace(/\s+\d+$/, '')) : null);
}
