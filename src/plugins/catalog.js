// Plug-in catalog lookup: reads the per-plug-in JSON files written by scan.js.
import fs from 'node:fs';
import path from 'node:path';

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
  const base = String(studioOneName ?? '').trim().replace(/\s+\d+$/, '').toLowerCase();
  if (!base) return null;
  let best = null;
  for (const [name, entry] of catalog) {
    const n = name.toLowerCase();
    if (n === base) return entry;
    if (base.startsWith(n) && (!best || n.length > best.name.length)) best = { name: n, entry };
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
    const c = e.capabilities ?? {};
    out.push({ name: e.name, vendor: e.vendor ?? null, paramCount: (e.params ?? []).length, backend: c.stateRoundTrip || c.xmlState ? 'state' : 'opaque' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
