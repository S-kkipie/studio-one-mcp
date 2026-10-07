// Searchable catalog of Studio One commands: live list (bridge) + edit-task argument
// schemas (script packages) + argument examples (user macros), cached on disk.
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir, studioOneApps } from '../paths.js';
import { extractEditTaskSchemas } from './schemas.js';
import { readMacroExamples, macroDirs as defaultMacroDirs } from './macros.js';

export const CATALOG_SCHEMA = 1;
const MAX_AGE_MS = 24 * 3600e3;
const MAX_VALUE_EXAMPLES = 5;
const OFFLINE_WARNING = 'Studio One not running: catalog has only macro commands; it is rebuilt once Studio One answers';

export function catalogFile() { return join(dataDir, 'commands', 'catalog.json'); }

const has = (o, k) => Object.hasOwn(o ?? {}, k);

function baseEntry(category, name, displayCategory, displayName) {
  return { command: `${category}/${name}`, category, name, displayCategory, displayName, variableArgs: false, args: [], examples: [] };
}

function liveEntry(l, schemas) {
  const e = baseEntry(l.category, l.name, l.displayCategory ?? '', l.displayName ?? '');
  const decl = String(l.arguments ?? '').trim();
  if (decl === '...') {
    e.variableArgs = true;
    const id = String(l.classID ?? '').toUpperCase();
    const s = id && has(schemas, id) ? schemas[id] : null;
    if (s) e.args = s.args.map((a) => ({ ...a }));
  } else if (decl) {
    e.args = decl.split(',').map((n) => n.trim()).filter(Boolean).map((name) => ({ name, type: 'unknown' }));
  }
  return e;
}

export function mergeCatalog({ live, schemas, examples, install, warnings, now = Date.now() }) {
  const byCommand = new Map();
  if (live) for (const l of live) { if (!l || !l.category || !l.name) continue; const e = liveEntry(l, schemas ?? {}); byCommand.set(e.command, e); }
  const ex = examples ?? {};
  for (const [command, list] of Object.entries(ex)) {
    let e = byCommand.get(command);
    if (!e) {
      if (live) continue; // examples never add commands to a live list
      const i = command.indexOf('/');
      if (i < 0) continue;
      e = baseEntry(command.slice(0, i), command.slice(i + 1), '', '');
      byCommand.set(command, e);
    }
    e.examples = list.map((x) => ({ macro: x.macro, args: x.args }));
    for (const x of list) {
      for (const [k, v] of Object.entries(x.args ?? {})) {
        let a = e.args.find((y) => y.name === k);
        if (!a) { a = { name: k, type: 'unknown' }; e.args.push(a); }
        const seen = a.examples ?? (a.examples = []);
        if (seen.length < MAX_VALUE_EXAMPLES && !seen.some((s) => JSON.stringify(s) === JSON.stringify(v))) seen.push(v);
      }
    }
  }
  const commands = [...byCommand.values()].sort((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
  return { schema: CATALOG_SCHEMA, builtAt: new Date(now).toISOString(), install: install ?? null, live: !!live, warnings: [...(warnings ?? [])], commands };
}

export function findEntry(catalog, command) {
  const list = catalog?.commands ?? [];
  const exact = list.find((e) => e.command === command);
  if (exact) return exact;
  const lower = String(command).toLowerCase();
  return list.find((e) => e.command.toLowerCase() === lower) ?? null;
}

function readCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return c && c.schema === CATALOG_SCHEMA && Array.isArray(c.commands) ? c : null;
  } catch { return null; }
}

function saveCatalog(file, catalog) {
  fs.mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 1));
  fs.renameSync(tmp, file);
}

async function fetchLive(call) {
  try {
    await call('status', {}, { timeoutMs: 1500 });
    const live = await call('listCommands', { detail: true }, { timeoutMs: 15000 });
    return Array.isArray(live) ? live : null;
  } catch { return null; }
}

export async function getCatalog(call, { refresh = false, now = Date.now(), file = catalogFile(), install = studioOneApps()[0] ?? null, macroDirs: dirs = defaultMacroDirs() } = {}) {
  const cache = readCache(file);
  const builtMs = cache ? Date.parse(cache.builtAt) : NaN;
  const needsRebuild = !cache || refresh || cache.live === false || !(now - builtMs <= MAX_AGE_MS);
  if (!needsRebuild) return cache;

  const live = await fetchLive(call);
  if (!live && cache) return cache;

  const warnings = [];
  let schemas = {};
  if (live && install) {
    const r = extractEditTaskSchemas(install);
    schemas = r.schemas ?? {};
    warnings.push(...(r.warnings ?? []));
  }
  if (!live) warnings.push(OFFLINE_WARNING);
  const catalog = mergeCatalog({ live, schemas, examples: readMacroExamples(dirs), install, warnings, now });
  try { saveCatalog(file, catalog); } catch (e) { catalog.warnings.push(`catalog cache not saved: ${e.message}`); }
  return catalog;
}
