// One control surface for every plug-in: picks a backend per insert and routes reads, writes and
// presets through it.
//  - native: PreSonus plug-ins. Studio One's findParameter answers their internal names (found in
//    their presets and the remote-control map); realtime.
//  - state: third-party plug-ins whose saved state the scanner could map (catalog xmlState or
//    stateRoundTrip). Reads save the song and read the slot's state from it; writes replace the
//    slot with a new instance made from the edited state (a few seconds, not realtime).
//  - opaque: everything else (no host parameters, no editable state, scan errors, not scanned):
//    presets, bypass and the window only.
import fs from 'node:fs';
import { loadCatalog, matchPlugin, findParam, searchCatalog } from './catalog.js';
import { defaultCatalogDir, defaultPython, scanAll } from './scan.js';
import { readPluginState, writePluginParams, replaceSlot } from './state.js';
import { getXmlAttrs } from './vstpreset.js';
import { closePluginWindows } from './windows.js';
import { classIdFor, findPluginClass } from './classes.js';
import { pluginParamNames } from '../plugins.js';
import { listPresets, insertPreset, addPlugin, slotCommand } from '../tracks.js';

const SCAN_HINT = 'run live_plugin_scan (it needs `npm run scan:setup` once)';

// -> { backend: 'native' | 'state' | 'opaque', entry, names, reason }. PreSonus names are tried
// first, so a catalog entry can never capture a PreSonus plug-in. `pluginClass(name)` is Studio One's
// own class entry for the name; its file tells whether an unscanned plug-in is a VST3.
export function pickBackend(insertName, catalog, { discover = pluginParamNames, pluginClass = findPluginClass } = {}) {
  const { names } = discover(insertName);
  if (names.length) return { backend: 'native', entry: null, names };
  const entry = catalog ? matchPlugin(catalog, insertName) : null;
  if (entry) {
    if (entry.scanError) return { backend: 'opaque', entry, reason: 'scanError' };
    const c = entry.capabilities || {};
    if (c.stateRoundTrip || c.xmlState) return { backend: 'state', entry };
    return { backend: 'opaque', entry, reason: c.hostParams ? 'noState' : 'noHostParams' };
  }
  // Not found in Studio One's list either (or no list): it may still be a VST3, so suggest the scan.
  const cls = pluginClass(insertName);
  if (cls && !/\.vst3$/i.test(cls.file || '')) return { backend: 'opaque', entry: null, reason: 'unsupported' };
  return { backend: 'opaque', entry: null, reason: 'unscanned' };
}

export function backendFor(insertName, catalog, opts) {
  return pickBackend(insertName, catalog, opts).backend;
}

// Why a plug-in's parameters cannot be set, and what to do instead.
export function opaqueMessage(name, { reason, entry } = {}) {
  if (reason === 'scanError') {
    const why = String(entry?.scanError || '').split(/\r?\n|\|/)[0].slice(0, 160);
    return `${name} could not be scanned (${why}); re-run live_plugin_scan to try again, or use live_plugin_presets to load a preset instead`;
  }
  if (reason === 'unscanned') return `${name} is not in the plug-in catalog: ${SCAN_HINT}, or use live_plugin_presets to load a preset instead`;
  if (reason === 'unsupported') return `${name} is not supported for parameter control (only VST3 plug-ins are scanned); use live_plugin_presets to load a preset instead`;
  if (reason === 'noState') return `${name}'s parameters could not be mapped to its saved state; use live_plugin_presets to load a preset instead`;
  return `${name} does not expose its parameters to hosts; use live_plugin_presets to load a preset instead`;
}

async function insertAt(call, channel, slot) {
  const rack = (await call('inserts', { channel }))[0];
  const plug = rack && rack.inserts.find((i) => i.slot === slot);
  if (!plug) throw new Error(`no plug-in in slot ${slot} on ${channel} (live_inserts lists the slots; an instrument itself is not in a slot and its parameters cannot be reached here)`);
  return plug;
}

const defaults = (deps = {}) => ({
  catalog: deps.catalog ?? loadCatalog(defaultCatalogDir()),
  discover: deps.discover ?? pluginParamNames,
  pluginClass: deps.pluginClass ?? findPluginClass,
  readState: deps.readState ?? readPluginState,
  writeParams: deps.writeParams ?? writePluginParams,
  ...deps,
});

// A value from the state XML as a JSON value: "true"/"false" -> boolean, numbers -> number.
function fromState(text) {
  if (text === null || text === undefined) return null;
  if (text === 'true' || text === 'false') return text === 'true';
  const n = Number(text);
  return text.trim() !== '' && Number.isFinite(n) ? n : text;
}

const matches = (filter, ...texts) => !filter || texts.some((t) => String(t ?? '').toLowerCase().includes(filter.toLowerCase()));

/**
 * Parameters of the plug-in in `slot` of `channel`, with values.
 * native -> { channel, slot, plugin, backend, realtime: true, params: [{ name, value, text, min, max, normalized }] }
 * state  -> { channel, slot, plugin, backend, realtime: false, source: 'song-save', saved, params: [{ name, key, value, label, min, max }] }
 * opaque -> { channel, slot, plugin, backend, realtime: false, params: [], note }
 */
export async function getParams(call, { channel, slot, filter, params }, deps) {
  const d = defaults(deps);
  const plug = await insertAt(call, channel, slot);
  // Explicit names go straight to Studio One (the native path), whatever the plug-in.
  if (params?.length) return { ...(await call('pluginParams', { channel, slot, names: params })), backend: 'native', realtime: true };
  const b = pickBackend(plug.name, d.catalog, { discover: d.discover, pluginClass: d.pluginClass });
  const head = { channel, slot, plugin: plug.name, backend: b.backend };
  if (b.backend === 'native') {
    const want = b.names.filter((n) => matches(filter, n));
    if (!want.length) return { ...head, realtime: true, params: [], note: `no parameter name contains "${filter}"` };
    const r = await call('pluginParams', { channel, slot, names: want });
    // Discovered names the plug-in does not answer to are noise (other versions, UI state).
    return { ...head, plugin: r.plugin ?? plug.name, realtime: true, params: r.params };
  }
  if (b.backend === 'opaque') return { ...head, realtime: false, params: [], note: opaqueMessage(plug.name, b) };

  const entry = b.entry;
  const keys = entry.stateKeys || {};
  const wanted = (entry.params || []).filter((p) => matches(filter, p.name, p.key));
  const st = await d.readState(call, { channel, slot });
  const out = { ...head, realtime: false, source: st.source, saved: st.saved, params: [] };
  if (!st.xml) {
    return { ...out, params: wanted.map((p) => ({ name: p.name, key: p.key, value: null, label: p.label || undefined, min: p.min, max: p.max })), note: `${plug.name} keeps a binary state: values cannot be read, but they can be set` };
  }
  const mapped = wanted.filter((p) => keys[p.key]);
  const vals = getXmlAttrs(st.xml, mapped.map((p) => keys[p.key]));
  out.params = mapped.map((p) => ({ name: p.name, key: p.key, value: fromState(vals[keys[p.key]]), label: p.label || undefined, min: p.min, max: p.max }));
  const unmapped = wanted.filter((p) => !keys[p.key]).map((p) => p.name);
  if (unmapped.length) out.unmapped = unmapped;
  return out;
}

// A number given with a unit, in the parameter's unit: the unit must be the catalog label
// (case-insensitive), or the label with a k prefix (x1000), or ms for a parameter in s.
function inUnit(n, unit, param, key, text) {
  const label = String(param?.label ?? '').trim();
  const u = unit.toLowerCase();
  const l = label.toLowerCase();
  if (l && u === l) return n;
  if (l && u === `k${l}`) return n * 1000;
  if (l === 's' && u === 'ms') return n / 1000;
  throw new Error(`${param?.name ?? key} is ${label ? `in ${label}` : 'unitless'}; "${text}" not understood`);
}

// Why non-numeric text cannot go into XML state: the plug-in would read it as some number
// (live, Archetype took Amp Type "Clean" as 0), so it is refused with what is accepted.
function notNumber(text, param, key, bool) {
  const name = param?.name ?? key ?? 'This parameter';
  if (bool) return `${name} takes on/off (or true/false, 1/0); "${text}" is not one of those`;
  const range = param && typeof param.min === 'number' && typeof param.max === 'number'
    ? `${param.min}..${param.max}${param.label ? ` ${param.label}` : ''}`
    : 'range not known: read the current value with live_plugin_params';
  return `${name} takes a number in this plug-in's saved state (${range}); "${text}" is not a number`;
}

/**
 * A change value for the state backend.
 *  - binary state (pedalboard): strings pass unchanged, so the plug-in's own text conversion is used;
 *  - XML state: text is on/off/true/false, or a number, optionally with the parameter's unit
 *    ("6 dB"; "2 kHz" -> 2000 for a Hz parameter); numbers must lie within the catalog min..max.
 *    Other text is refused: the plug-in would read it as an arbitrary number.
 * Numbers 0/1 on a boolean parameter become booleans; { normalized } passes through.
 */
export function stateChange(v, param, { binary = false, key } = {}) {
  const bool = param && (param.isBoolean || (param.min === false && param.max === true));
  if (typeof v === 'string') {
    if (binary) return v;
    const t = v.trim();
    if (/^(true|on|yes)$/i.test(t)) return true;
    if (/^(false|off|no)$/i.test(t)) return false;
    const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z%°]*)$/i.exec(t);
    if (!m) throw new Error(notNumber(t, param, key, bool));
    v = m[2] ? inUnit(Number(m[1]), m[2], param, key, t) : Number(m[1]);
  }
  if (bool && typeof v === 'number' && (v === 0 || v === 1)) return v === 1;
  if (!binary && typeof v === 'number' && param && typeof param.min === 'number' && typeof param.max === 'number' && (v < param.min || v > param.max)) {
    throw new Error(`${param.name ?? key} must be within ${param.min}..${param.max}${param.label ? ` ${param.label}` : ''}; got ${v}`);
  }
  return v;
}

// A change value for the native backend: text, raw value or normalized.
function nativeArg(param, v) {
  if (typeof v === 'string') return { param, text: v };
  if (typeof v === 'number') return { param, value: v };
  if (typeof v === 'boolean') return { param, value: v ? 1 : 0 };
  if (v && typeof v === 'object' && typeof v.normalized === 'number') return { param, normalized: v.normalized };
  throw new Error(`${param}: give text, a number or { normalized }`);
}

/**
 * Sets parameters: `changes` is { name or key: value } with value text ("-12 dB"), a number
 * (the raw value), a boolean or { normalized: 0..1 }.
 * native, one change -> the bridge's { param, before, after } plus backend/realtime;
 * native, several -> { ..., results: [{ param, before, after }] }; state -> writePluginParams' result.
 */
export async function setParams(call, { channel, slot, changes }, deps) {
  const d = defaults(deps);
  const list = Object.entries(changes || {});
  if (!list.length) throw new Error('no changes given');
  const plug = await insertAt(call, channel, slot);
  const b = pickBackend(plug.name, d.catalog, { discover: d.discover, pluginClass: d.pluginClass });
  if (b.backend === 'opaque') throw new Error(opaqueMessage(plug.name, b));
  if (b.backend === 'native') {
    const results = [];
    for (const [k, v] of list) results.push(await call('setPluginParam', { channel, slot, ...nativeArg(k, v) }));
    if (results.length === 1) return { ...results[0], backend: 'native', realtime: true };
    return { channel, slot, plugin: plug.name, backend: 'native', realtime: true, results: results.map(({ param, before, after }) => ({ param, before, after })) };
  }
  const conv = {};
  for (const [k, v] of list) {
    const param = (b.entry.params || []).find((p) => p.key === k) || findParam(b.entry, k);
    conv[k] = stateChange(v, param, { binary: !(b.entry.capabilities || {}).xmlState, key: k });
  }
  return d.writeParams(call, { channel, slot, changes: conv, entry: b.entry });
}

// The class ID of the slot's plug-in, or of `plugin` by name.
function classOf(name, d) {
  const cid = (d.classIdFor ?? classIdFor)(name);
  if (!cid) throw new Error(`no class ID for ${name} in Studio One's plug-in list (is it installed, and has Studio One scanned it?)`);
  return cid;
}

/**
 * Presets Studio One has indexed for a plug-in (a slot's, or `plugin` by name), and loading one
 * onto a slot: a new instance with the preset replaces the slot (same position, bypass kept), and
 * the old instance is removed only after the new one is in.
 */
export async function pluginPresets(call, { channel, slot, plugin, action = 'list', preset }, deps = {}) {
  const d = { replace: replaceSlot, ...deps };
  const hasSlot = channel !== undefined && slot !== undefined;
  if (action === 'load') {
    if (!hasSlot) throw new Error('load needs channel and slot');
    if (!preset) throw new Error('load needs preset (a name from action list)');
  }
  if (!hasSlot && !plugin) throw new Error('give channel and slot, or plugin');
  const name = hasSlot ? (await insertAt(call, channel, slot)).name : plugin;
  const cid = classOf(name, d);
  const presets = (await listPresets(call, cid)).presets || [];
  if (action === 'list') return { ...(hasSlot ? { channel, slot } : {}), plugin: name, cid, count: presets.length, presets: presets.map((p) => p.name) };
  if (action !== 'load') throw new Error('action must be list or load');
  if (!presets.some((p) => p.name === preset)) throw new Error(`${name} has no preset named "${preset}" (action list shows them)`);
  const r = await d.replace(call, { channel, slot, cid, preset }, d.closeWindows ? { closeWindows: d.closeWindows } : undefined);
  return {
    channel, slot, plugin: r.plugin ?? name, preset, slotName: r.slotName, bypassed: r.bypassed, backend: 'preset', realtime: false,
    ...(r.warning ? { warning: r.warning } : {}),
    note: 'The plug-in was replaced by a new instance with the preset; settings made in its window since the last change are gone.',
  };
}

// A plug-in on a channel's inserts, optionally from one of its presets.
export async function addPluginWithPreset(call, { channel, plugin, preset }, deps = {}) {
  if (!preset) return addPlugin(call, { channel, plugin });
  const cid = classOf(plugin, deps);
  const presets = (await listPresets(call, cid)).presets || [];
  if (!presets.some((p) => p.name === preset)) throw new Error(`${plugin} has no preset named "${preset}" (live_plugin_presets lists them)`);
  const r = await insertPreset(call, { channel, cid, preset });
  const [rack] = await call('inserts', { channel });
  return { channel, added: plugin, preset, slotName: r.slot, inserts: rack ? rack.inserts : null, note: 'One live_undo removes it.' };
}

// Removes the plug-in in `slot` of `channel` (by its exact FX name, so the right one goes).
export async function removePlugin(call, { channel, slot }, { closeWindows = closePluginWindows } = {}) {
  const plug = await insertAt(call, channel, slot);
  await closeWindows({ channel });
  const before = (await call('inserts', { channel }))[0].inserts.length;
  const { name } = await call('insertSlotName', { channel, slot });
  const r = await slotCommand(call, { channel, slot, command: 'Remove', name });
  const [rack] = await call('inserts', { channel });
  const after = rack ? rack.inserts : [];
  if (r.done !== true || after.length !== before - 1) throw new Error(`Studio One did not remove ${plug.name} from slot ${slot} of ${channel}`);
  return { channel, removed: plug.name, slot, inserts: after, note: 'One live_undo brings it back with its settings.' };
}

// (Re)scans the installed VST3 plug-ins into the catalog (only new or changed files are scanned).
export async function runScan({ scan = scanAll, catalogDir = defaultCatalogDir(), python = defaultPython(), exists = fs.existsSync } = {}) {
  if (!exists(python)) throw new Error('The plug-in scanner needs its Python environment: run `npm run scan:setup` once in the studio-one-mcp folder, then live_plugin_scan again.');
  const scanned = [];
  const stats = await scan({ catalogDir, python, onProgress: (e) => scanned.push(e.name) });
  const all = searchCatalog(loadCatalog(catalogDir));
  const byBackend = {};
  for (const e of all) byBackend[e.backend] = (byBackend[e.backend] || 0) + 1;
  const backendOf = new Map(all.map((e) => [e.name, e.backend]));
  return { ...stats, byBackend, scannedNow: scanned.map((name) => ({ name, backend: backendOf.get(name) ?? 'unavailable' })) };
}
