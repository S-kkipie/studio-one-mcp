// Macro files (Documents/Studio One/Macros/**.studioonemacro) double as worked
// examples of command arguments: each step names a command and the values it was
// recorded with. Read only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_EXAMPLES = 5;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e]);
const typed = (v) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

// -> { title, steps: [{ command: 'Category/Name', args: { name: value } }] }
export function parseMacro(xml) {
  const head = /<Macro\b([^>]*)>/.exec(xml);
  if (!head) throw new Error('not a macro');
  const steps = [];
  for (const m of xml.matchAll(/<CommandElement\b([^>]*?)(?:\/>|>([\s\S]*?)<\/CommandElement>)/g)) {
    const a = attrs(m[1]);
    if (!a.name) continue;
    const args = {};
    for (const arg of (m[2] || '').matchAll(/<CommandArgument\b([^>]*?)\/?>/g)) {
      const x = attrs(arg[1]);
      if (x.name !== undefined && x.value !== undefined) args[x.name] = typed(x.value);
    }
    steps.push({ command: a.category ? `${a.category}/${a.name}` : a.name, args });
  }
  return { title: attrs(head[1]).title || '', steps };
}

function* macroFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* macroFiles(p);
    else if (e.name.toLowerCase().endsWith('.studioonemacro')) yield p;
  }
}

// -> { 'Category/Name': [{ macro, args }] }, at most 5 per command; steps without
// arguments teach nothing and are skipped.
export function readMacroExamples(dirs) {
  const out = {};
  for (const dir of dirs) {
    for (const file of macroFiles(dir)) {
      let macro;
      try { macro = parseMacro(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { continue; }
      for (const s of macro.steps) {
        if (!Object.keys(s.args).length) continue;
        const list = (out[s.command] ||= []);
        if (list.length < MAX_EXAMPLES) list.push({ macro: macro.title, args: s.args });
      }
    }
  }
  return out;
}

export function macroDirs() {
  if (process.env.STUDIO_ONE_MACROS) return process.env.STUDIO_ONE_MACROS.split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  return [path.join(home, 'Documents/Studio One/Macros'), path.join(home, 'Documents/Studio Pro/Macros')].filter((d) => fs.existsSync(d));
}
