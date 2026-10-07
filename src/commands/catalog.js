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
const OUTDATED_WARNING = 'bridge device is outdated: run `studio-one-mcp setup` (or scripts/install-device.js) and restart Studio One for argument schemas';
const REFRESH_FAILED_WARNING = 'refresh failed: Studio One did not answer; showing the cached catalog';
const OFFLINE_WARNING = 'Studio One not running: catalog has only macro commands; it is rebuilt once Studio One answers';

export function catalogFile() { return join(dataDir, 'commands', 'catalog.json'); }

const has = (o, k) => Object.hasOwn(o ?? {}, k);

function baseEntry(category, name, displayCategory, displayName) {
  return { command: `${category}/${name}`, category, name, displayCategory, displayName, variableArgs: false, args: [], examples: [] };
}

function liveEntry(l, schemas) {
  const e = baseEntry(l.category, l.name, l.displayCategory ?? '', l.displayName ?? '');
  if (!has(l, 'arguments')) { e.argsKnown = false; return e; }
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
  const outdated = !!live && live.length > 0 && live.every((l) => !has(l, 'arguments'));
  const allWarnings = [...(warnings ?? [])];
  if (outdated) allWarnings.push(OUTDATED_WARNING);
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
  return { schema: CATALOG_SCHEMA, builtAt: new Date(now).toISOString(), install: install ?? null, live: !!live, ...(live ? { detail: !outdated } : {}), warnings: allWarnings, commands };
}

export function findEntry(catalog, command) {
  const list = catalog?.commands ?? [];
  const exact = list.find((e) => e.command === command);
  if (exact) return exact;
  const lower = String(command).toLowerCase();
  return list.find((e) => e.command.toLowerCase() === lower) ?? null;
}

const memo = new Map(); // file -> { key: "mtimeMs:size", cache }
const inflight = new Map(); // file|refresh -> Promise

function readCache(file) {
  try {
    const st = fs.statSync(file);
    const key = `${st.mtimeMs}:${st.size}`;
    const m = memo.get(file);
    if (m && m.key === key) return m.cache;
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cache = c && c.schema === CATALOG_SCHEMA && Array.isArray(c.commands) ? c : null;
    memo.set(file, { key, cache });
    return cache;
  } catch { memo.delete(file); return null; }
}

// The newest Studio One install: "Studio One 7" beats "Studio One 6"; "Studio Pro 8" counts as 8.
export function pickInstall(apps) {
  const ver = (p) => { const m = [...String(p).matchAll(/Studio (?:One|Pro)\D*?(\d+)/g)]; return m.length ? Number(m[m.length - 1][1]) : 0; };
  let best = null;
  for (const a of apps ?? []) if (best === null || ver(a) > ver(best)) best = a;
  return best;
}

function saveCatalog(file, catalog) {
  fs.mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 1));
  fs.renameSync(tmp, file);
}

async function fetchLive(call) {
  try {
    await call('ping', {}, { timeoutMs: 2500 });
    const live = await call('listCommands', { detail: true }, { timeoutMs: 15000 });
    return Array.isArray(live) ? live : null;
  } catch { return null; }
}

export function getCatalog(call, opts = {}) {
  const file = opts.file ?? catalogFile();
  const k = `${file}|${opts.refresh ? 'r' : ''}`;
  let p = inflight.get(k);
  if (!p) {
    p = buildCatalog(call, { ...opts, file }).finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

async function buildCatalog(call, { refresh = false, now = Date.now(), file, install = pickInstall(studioOneApps()), macroDirs: dirs = defaultMacroDirs() } = {}) {
  const cache = readCache(file);
  const builtMs = cache ? Date.parse(cache.builtAt) : NaN;
  const needsRebuild = !cache || refresh || cache.live === false || cache.detail === false || !(now - builtMs <= MAX_AGE_MS);
  if (!needsRebuild) return cache;

  const live = await fetchLive(call);
  if (!live && cache) return refresh ? { ...cache, warnings: [...(cache.warnings ?? []), REFRESH_FAILED_WARNING], refreshFailed: true } : cache;

  const warnings = [];
  let schemas = {};
  if (live && install) {
    const r = extractEditTaskSchemas(install);
    schemas = r.schemas ?? {};
    warnings.push(...(r.warnings ?? []));
  }
  if (!live) warnings.push(OFFLINE_WARNING);
  if (!live && refresh) warnings.push(REFRESH_FAILED_WARNING);
  const catalog = mergeCatalog({ live, schemas, examples: readMacroExamples(dirs), install, warnings, now });
  if (!live && refresh) catalog.refreshFailed = true;
  try { saveCatalog(file, catalog); } catch (e) { catalog.warnings.push(`catalog cache not saved: ${e.message}`); }
  return catalog;
}
