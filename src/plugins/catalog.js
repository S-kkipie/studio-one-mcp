// Plug-in catalog lookup: reads the per-plug-in JSON files written by scan.js.
import fs from 'node:fs';
import path from 'node:path';

// Version of the entry format scan-plugin.py writes; scanAll rescans entries of another version.
// 2: stateScale / unverifiedKeys (how each state attribute stores the displayed value), isInstrument,
//    params[].type and params[].choices.
export const CATALOG_SCHEMA = 2;

// 'state' when the parameters can be edited through the saved state: pedalboard loads the state
// back (stateRoundTrip), or the XML state has attributes mapped to parameters. Otherwise 'opaque'
// ('unavailable' for scan errors).
export function entryBackend(e) {
  if (!e) return null;
  if (e.scanError) return 'unavailable';
  const c = e.capabilities ?? {};
  if (c.stateRoundTrip) return 'state';
  if (c.xmlState && Object.keys(e.stateKeys ?? {}).length) return 'state';
  return 'opaque';
}

// How the XML state stores parameter `key`: state = a * display + b, or null when the scanner could
// not verify it (or the entry predates schema 2).
export function stateScaleOf(entry, key) {
  const s = entry?.stateScale?.[key];
  if (typeof s === 'number' && Number.isFinite(s) && s !== 0) return { a: s, b: 0 };
  if (s && typeof s === 'object' && Number.isFinite(s.a) && s.a !== 0 && Number.isFinite(s.b ?? 0)) return { a: s.a, b: s.b ?? 0 };
  return null;
}

// Why a mapped parameter without a verified scale cannot be written.
export function unverifiedMessage(entry, name) {
  if (entry?.schema !== CATALOG_SCHEMA) {
    return `${name} on ${entry?.name}: the catalog entry is from an older scan that did not check how the saved state stores values; run live_plugin_scan, then try again (or use live_plugin_presets)`;
  }
  return `${name} on ${entry.name} cannot be set: the scan could not verify how its saved state stores the value (for example a log-scaled frequency), so a write could land on the wrong value; use live_plugin_presets or the plug-in window instead`;
}

export const normalizedRefused = (name) => `${name}: { normalized } is not accepted for third-party plug-ins (their saved state is not a linear 0..1 of the range); give the value in the parameter's units, as live_plugin_params shows it`;

const tidy = (x) => Number.parseFloat(x.toPrecision(12));
export const displayToState = (scale, d) => tidy(scale.a * d + scale.b);
export const stateToDisplay = (scale, s) => tidy((s - scale.b) / scale.a);

export function loadCatalog(dir) {
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')); } catch { return map; }
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (e && typeof e.name === 'string') map.set(e.name, e);
    } catch { /* skip unreadable file */ }
  }
  return map;
}

export function matchPlugin(catalog, studioOneName) {
  const raw = String(studioOneName ?? '').trim().toLowerCase();
  if (!raw) return null;
  const exact = (q) => { for (const [name, entry] of catalog) if (name.toLowerCase() === q) return entry; return null; };
  const hit = exact(raw);
  if (hit) return hit;
  const base = raw.replace(/\s+\d+$/, '');
  const hit2 = exact(base);
  if (hit2) return hit2;
  let best = null;
  for (const [name, entry] of catalog) {
    const n = name.toLowerCase();
    if (base.startsWith(n) && /^\s*(\(.*\)|\d+)?$/.test(base.slice(n.length)) && (!best || n.length > best.n.length)) best = { n, entry };
  }
  return best ? best.entry : null;
}

export function findParam(entry, query) {
  const params = entry.params ?? [];
  const q = String(query ?? '');
  const lq = q.toLowerCase();
  const pick = (fn) => params.filter(fn);
  const byKey = pick((p) => p.key === q);
  if (byKey.length) return byKey[0];
  const exact = pick((p) => p.name === q);
  if (exact.length === 1) return exact[0];
  const ci = pick((p) => String(p.name).toLowerCase() === lq);
  if (ci.length === 1) return ci[0];
  const sub = lq ? pick((p) => String(p.name).toLowerCase().includes(lq)) : [];
  if (sub.length === 1) return sub[0];
  const cands = exact.length > 1 ? exact : ci.length > 1 ? ci : sub;
  if (cands.length > 1) {
    throw new Error(`Ambiguous parameter "${query}" in ${entry.name}: ${cands.map((p) => `${p.name} (${p.key})`).join(', ')}`);
  }
  return null;
}

export function searchCatalog(catalog, text) {
  const q = String(text ?? '').toLowerCase();
  const out = [];
  for (const e of catalog.values()) {
    if (q && !`${e.name} ${e.vendor ?? ''}`.toLowerCase().includes(q)) continue;
    if (e.scanError) {
      out.push({ name: e.name, vendor: e.vendor ?? null, paramCount: 0, backend: 'unavailable', scanError: e.scanError });
      continue;
    }
    out.push({ name: e.name, vendor: e.vendor ?? null, isInstrument: typeof e.isInstrument === 'boolean' ? e.isInstrument : null, paramCount: (e.params ?? []).length, backend: entryBackend(e) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
