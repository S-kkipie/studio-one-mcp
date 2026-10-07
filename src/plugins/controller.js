// One control surface for every plug-in: picks a backend per insert and routes reads, writes and
// presets through it.
//  - native: PreSonus plug-ins. Studio One's findParameter answers their internal names (found in
//    their presets and the remote-control map); realtime.
//  - state: third-party plug-ins whose saved state the scanner could map (catalog stateRoundTrip, or
//    xmlState with mapped attributes). On Windows reads export the state in place (Export Preset)
//    and writes load the edited state in place (Load Preset File): no song save, same instance
//    (state.js). Elsewhere reads save the song and read the slot's state from it, and writes
//    replace the slot with a new instance made from the edited state. Not realtime either way.
//    Values are in the parameter's display units; the scan's stateScale converts them to and from
//    the state (Archetype keeps 0..1 for a 0..100 %), and keys it could not verify are read-only.
//  - opaque: everything else (no host parameters, no editable state, scan errors, not scanned):
//    presets, bypass and the window only.
import fs from 'node:fs';
import {
  loadCatalog, matchPlugin, findParam, searchCatalog, entryBackend, stateScaleOf, stateToDisplay, unverifiedMessage, normalizedRefused, CATALOG_SCHEMA,
} from './catalog.js';
import { defaultCatalogDir, defaultPython, scanAll } from './scan.js';
import { readPluginState, writePluginParams, replaceSlot, loadablePreset } from './state.js';
import { findPresetFile } from './presetfiles.js';
import { openSongArchive } from '../song.js';
import { walk } from '../xml.js';
import { fileURLToPath } from 'node:url';
import * as presetio from './presetio.js';
import { getXmlAttrs, parseVstPreset } from './vstpreset.js';
import { closePluginWindows } from './windows.js';
import { classIdFor, findPluginClass, loadPluginClasses } from './classes.js';
import { pluginParamNames, presetClass, presetClassById } from '../plugins.js';
import { listPresets, insertPreset, addPlugin, slotCommand, INSTANCE_TIMEOUT_MS } from '../tracks.js';

const SCAN_HINT = 'run live_plugin_scan (it needs `npm run scan:setup` once)';

// One session-changing plug-in operation at a time (state reads and writes, preset loads, removes,
// adds, scans): two of them interleaved could save, insert, remove or load over each other's
// instances. Not reentrant: nothing that runs inside it may call another serialized() entry point.
// The preset file dialog has its own lock (presetio.js withDialogLock), taken inside this one.
let sessionQueue = Promise.resolve();
export function serialized(fn) {
  const run = sessionQueue.then(fn, fn);
  sessionQueue = run.catch(() => {});
  return run;
}

// -> { backend: 'native' | 'state' | 'opaque', entry, names, reason }. PreSonus names are tried
// first, so a catalog entry can never capture a PreSonus plug-in. `pluginClass(name)` is Studio One's
// own class entry for the name; its file tells whether an unscanned plug-in is a VST3.
export function pickBackend(insertName, catalog, { discover = pluginParamNames, pluginClass = findPluginClass } = {}) {
  // Studio One reported no name (an instrument whose device has no title): nothing to look it up by.
  if (insertName == null || insertName === '') return { backend: 'opaque', entry: null, reason: 'unnamed' };
  const { names } = discover(insertName);
  if (names.length) return { backend: 'native', entry: null, names };
  const entry = catalog ? matchPlugin(catalog, insertName) : null;
  if (entry) {
    if (entry.scanError) return { backend: 'opaque', entry, reason: 'scanError' };
    if (entryBackend(entry) === 'state') return { backend: 'state', entry };
    // An XML state with no attribute mapped to a parameter is as opaque as no state at all.
    return { backend: 'opaque', entry, reason: (entry.capabilities || {}).hostParams ? 'noState' : 'noHostParams' };
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
  if (reason === 'unnamed') return 'Studio One reports no name for this plug-in, so its parameters cannot be looked up; use live_plugin_presets to load a preset instead';
  if (reason === 'unscanned') return `${name} is not in the plug-in catalog: ${SCAN_HINT}, or use live_plugin_presets to load a preset instead`;
  if (reason === 'unsupported') return `${name} is not supported for parameter control (only VST3 plug-ins are scanned); use live_plugin_presets to load a preset instead`;
  if (reason === 'noState') return `${name}'s parameters could not be mapped to its saved state; use live_plugin_presets to load a preset instead`;
  return `${name} does not expose its parameters to hosts; use live_plugin_presets to load a preset instead`;
}

async function insertAt(call, channel, slot) {
  const rack = (await call('inserts', { channel }))[0];
  const plug = rack && rack.inserts.find((i) => i.slot === slot);
  if (!plug) throw new Error(`no plug-in in slot ${slot} on ${channel} (live_inserts lists the slots; for an instrument itself give instrument instead, live_instruments lists them)`);
  return plug;
}

/**
 * The plug-in a tool addresses: { channel, slot } (an insert) or { instrument } (a name or InstNN from
 * live_instruments). Exactly one form; with `optional`, neither form gives null.
 */
export function pluginTarget({ channel, slot, instrument } = {}, { optional = false } = {}) {
  const hasInst = instrument !== undefined && instrument !== null && instrument !== '';
  const hasChannel = channel !== undefined && channel !== null;
  const hasSlot = slot !== undefined && slot !== null;
  if (hasInst && (hasChannel || hasSlot)) throw new Error('give either instrument, or channel and slot, not both');
  if (hasInst) return { instrument: String(instrument) };
  if (hasChannel && hasSlot) return { channel, slot };
  if (hasChannel || hasSlot) throw new Error('an insert needs both channel and slot (live_inserts lists them)');
  if (optional) return null;
  throw new Error('give channel and slot (an insert, from live_inserts) or instrument (from live_instruments)');
}

const isInst = (t) => t != null && t.instrument !== undefined;

// An instrument by component (Inst01), exact name, or a unique case-insensitive name. Exact, so
// "Mai Tai" never lands on "Mai Tai 2". -> { component, name, index }
export async function instrumentAt(call, ref) {
  const list = await listInstruments(call);
  const want = String(ref ?? '').trim();
  const have = () => (list.length ? ` (have: ${list.map((x) => `${x.name ?? '(no name)'} [${x.component}]`).join(', ')})` : ' (the song has no instruments)');
  const lower = (t) => String(t ?? '').toLowerCase();
  if (/^inst\d+$/i.test(want)) {
    const hit = list.find((x) => lower(x.component) === want.toLowerCase());
    if (hit) return hit;
  }
  if (!want) throw new Error(`give an instrument name or component${have()}`);
  let hits = list.filter((x) => x.name != null && x.name === want);
  if (!hits.length) hits = list.filter((x) => x.name != null && lower(x.name) === want.toLowerCase());
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`instrument ${want} is ambiguous: ${hits.map((x) => x.component).join(', ')}; give the component (e.g. ${hits[0].component})`);
  throw new Error(`no instrument named ${want}${have()}`);
}

// The addressed plug-in -> { target (for the bridge and state ops), head (for results), name }.
// An instrument is addressed by its component, so a rename or a twin cannot redirect the call.
async function resolvePlugin(call, target, deps = {}) {
  if (isInst(target)) {
    const inst = await instrumentAt(call, target.instrument);
    const cls = await instrumentClass(call, inst, deps);
    return {
      target: { instrument: inst.component }, head: { instrument: inst.name ?? inst.component, component: inst.component },
      name: inst.name, instrument: true, cls,
      // A renamed instrument is looked up by its class name (its presets and catalog entry are filed under it).
      lookupName: cls?.className ?? inst.name,
    };
  }
  const plug = await insertAt(call, target.channel, target.slot);
  return { target: { channel: target.channel, slot: target.slot }, head: { channel: target.channel, slot: target.slot }, name: plug.name, lookupName: plug.name, instrument: false };
}

// The class of the song's instrument N, from the song file's last save: Presets/Synths/<N> - <title>.fxpreset
// (cid attribute) or .vstpreset (header). -> class ID or null.
export function savedSynthClassId(zip, index) {
  const name = (zip?.names || []).find((n) => {
    const m = /^Presets\/Synths\/(\d+) - .+\.(fxpreset|vstpreset)$/i.exec(n);
    return m && Number(m[1]) === Number(index);
  });
  if (!name) return null;
  const raw = zip.raw(name);
  if (!raw) return null;
  try {
    if (/\.vstpreset$/i.test(name)) {
      const h = String(parseVstPreset(Buffer.from(raw)).classId).toUpperCase();
      return /^[0-9A-F]{32}$/.test(h) ? `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}` : null;
    }
    return (/<AudioEffectPreset[^>]*\scid="([^"]+)"/.exec(Buffer.from(raw).toString('utf8')) || [])[1] || null;
  } catch {
    return null;
  }
}

async function songArchive(call, openArchive = openSongArchive) {
  const { fileUrl } = await call('song');
  const songPath = fileUrl ? fileURLToPath(fileUrl) : null;
  if (!songPath || !/\.song$/i.test(songPath)) return null;
  return openArchive(songPath);
}

/**
 * An instrument's class -> { cid, className } or null: by its title (Studio One's plug-in cache, else the
 * plug-in's own presets: the cache leaves out the built-in instruments), else, for a renamed instrument,
 * from the song's last save (the saved synth state names the class; its presets or the cache name it).
 * `deps.zip`: a song archive already open (or a function giving one).
 */
export async function instrumentClass(call, inst, deps = {}) {
  const byCache = (deps.pluginClass ?? findPluginClass)(inst.name);
  if (byCache?.cid) return { cid: byCache.cid, className: byCache.name ?? inst.name };
  const byPresets = (deps.presetClass ?? presetClass)(inst.name);
  if (byPresets?.classId) return { cid: byPresets.classId, className: byPresets.className ?? inst.name };
  let zip = null;
  try {
    zip = typeof deps.zip === 'function' ? await deps.zip() : deps.zip !== undefined ? deps.zip : await songArchive(call, deps.openArchive);
  } catch { zip = null; }
  const cid = savedSynthClassId(zip, inst.index);
  if (!cid) return null;
  const named = (deps.classes ?? loadPluginClasses)().find((c) => String(c.cid).toLowerCase() === cid.toLowerCase())?.name
    ?? (deps.presetClassById ?? presetClassById)(cid)?.className ?? null;
  return { cid, className: named };
}

// Bridge results name an instrument by the component we sent; show its name instead.
function relabel(r, p) {
  if (!p.instrument || !r || typeof r !== 'object') return r;
  return { ...r, ...p.head };
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
 * Parameters of a plug-in, with values: the one in `slot` of `channel`, or the instrument `instrument`
 * (name or InstNN from live_instruments). Results carry { channel, slot } or { instrument, component }.
 * native -> { ..., plugin, backend, realtime: true, params: [{ name, value, text, min, max, normalized }] }
 * state  -> { ..., plugin, backend, realtime: false, source: 'export' (Windows) | 'song-save' (+ saved), params: [{ name, key, value, label, min, max }] }
 * opaque -> { ..., plugin, backend, realtime: false, params: [], note }
 */
export async function getParams(call, args, deps) {
  const d = defaults(deps);
  const { filter, params } = args;
  const p = await resolvePlugin(call, pluginTarget(args), d);
  // Explicit names go straight to Studio One (the native path), whatever the plug-in.
  if (params?.length) return { ...relabel(await call('pluginParams', { ...p.target, names: params }), p), backend: 'native', realtime: true };
  const b = pickBackend(p.lookupName, d.catalog, { discover: d.discover, pluginClass: d.pluginClass });
  const head = { ...p.head, plugin: p.name ?? p.lookupName, backend: b.backend };
  if (b.backend === 'native') {
    const want = b.names.filter((n) => matches(filter, n));
    if (!want.length) return { ...head, realtime: true, params: [], note: `no parameter name contains "${filter}"` };
    const r = await call('pluginParams', { ...p.target, names: want });
    // Discovered names the plug-in does not answer to are noise (other versions, UI state).
    return { ...head, plugin: r.plugin ?? p.name, realtime: true, params: r.params };
  }
  if (b.backend === 'opaque') return { ...head, realtime: false, params: [], note: opaqueMessage(p.name ?? p.head.instrument, b) };

  const entry = b.entry;
  const keys = entry.stateKeys || {};
  const wanted = (entry.params || []).filter((p) => matches(filter, p.name, p.key));
  // The read opens a preset dialog (or, off Windows, saves the song): it waits for any other
  // session-changing plug-in operation.
  const st = await serialized(() => d.readState(call, p.target));
  const out = { ...head, realtime: false, source: st.source, saved: st.saved, params: [] };
  const desc = (p) => ({ name: p.name, key: p.key, label: p.label || undefined, min: p.min, max: p.max, ...(p.choices && p.type === 'choice' ? { choices: p.choices } : {}) });
  if (!st.xml) {
    return { ...out, params: wanted.map((q) => ({ ...desc(q), value: null })), note: `${p.name} keeps a binary state: values cannot be read, but they can be set` };
  }
  const mapped = wanted.filter((p) => keys[p.key]);
  const vals = getXmlAttrs(st.xml, mapped.map((p) => keys[p.key]));
  const unverified = [];
  out.params = mapped.map((p) => {
    let raw = fromState(vals[keys[p.key]]);
    if (p.type === 'choice' && typeof raw === 'boolean') raw = raw ? 1 : 0;
    const scale = stateScaleOf(entry, p.key);
    if (!scale) {
      unverified.push(p.name);
      return { ...desc(p), value: null, stateValue: raw, unverified: true };
    }
    return { ...desc(p), value: typeof raw === 'number' ? stateToDisplay(scale, raw) : raw };
  });
  const unmapped = wanted.filter((p) => !keys[p.key]).map((p) => p.name);
  if (unmapped.length) out.unmapped = unmapped;
  if (unverified.length) {
    out.note = `${unverified.length} parameter(s) have an unverified state scale (value null; stateValue is the raw saved-state value, not in the parameter's units) and cannot be set` +
      (entry.schema !== CATALOG_SCHEMA ? ': the catalog entry is from an older scan, run live_plugin_scan' : '');
  }
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
 *  - XML state: text is on/off/true/false (on/off parameters only: boolean, or a choice of two), or a number, optionally with the parameter's unit
 *    ("6 dB"; "2 kHz" -> 2000 for a Hz parameter); numbers must lie within the catalog min..max.
 *    Other text is refused: the plug-in would read it as an arbitrary number.
 * Numbers 0/1 on a boolean parameter become booleans. A choice (catalog choices) is its index,
 * 0..choices-1. { normalized } is refused: the state is not a linear 0..1 of the range.
 */
export function stateChange(v, param, { binary = false, key } = {}) {
  const bool = param && (param.isBoolean || (param.min === false && param.max === true));
  if (v && typeof v === 'object') throw new Error(normalizedRefused(param?.name ?? key));
  if (typeof v === 'string') {
    if (binary) return v;
    const t = v.trim();
    const word = /^(true|on)$/i.test(t) ? true : /^(false|off)$/i.test(t) ? false : null;
    if (word !== null) {
      // Only an on/off parameter (boolean, or a choice of two) takes a word: elsewhere it would be
      // written as 1/0, a value the parameter may not mean.
      if (bool || param?.choices === 2) return word;
      throw new Error(`${param?.name ?? key ?? 'This parameter'} is not an on/off parameter; "${t}" only works for on/off parameters: give a number${param && typeof param.min === 'number' && typeof param.max === 'number' ? ` within ${param.min}..${param.max}${param.label ? ` ${param.label}` : ''}` : ''}`);
    }
    const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z%°]*)$/i.exec(t);
    if (!m) throw new Error(notNumber(t, param, key, bool));
    v = m[2] ? inUnit(Number(m[1]), m[2], param, key, t) : Number(m[1]);
  }
  if (bool && typeof v === 'number' && (v === 0 || v === 1)) return v === 1;
  if (!binary && typeof v === 'number' && param?.type === 'choice' && param.choices > 0 && !(Number.isInteger(v) && v >= 0 && v < param.choices)) {
    throw new Error(`${param.name ?? key} is a choice of ${param.choices} (0..${param.choices - 1}, as live_plugin_params shows it); got ${v}`);
  }
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
export async function setParams(call, args, deps) {
  return serialized(() => setParamsNow(call, args, deps));
}

async function setParamsNow(call, args, deps) {
  const d = defaults(deps);
  const { changes } = args;
  const list = Object.entries(changes || {});
  if (!list.length) throw new Error('no changes given');
  const p = await resolvePlugin(call, pluginTarget(args), d);
  const plug = { name: p.name ?? p.head.instrument };
  const b = pickBackend(p.lookupName, d.catalog, { discover: d.discover, pluginClass: d.pluginClass });
  if (b.backend === 'opaque') throw new Error(opaqueMessage(plug.name, b));
  if (b.backend === 'native') {
    const results = [];
    for (const [k, v] of list) results.push(relabel(await call('setPluginParam', { ...p.target, ...nativeArg(k, v) }), p));
    if (results.length === 1) return { ...results[0], backend: 'native', realtime: true };
    return { ...p.head, plugin: plug.name, backend: 'native', realtime: true, results: results.map(({ param, before, after }) => ({ param, before, after })) };
  }
  const conv = {};
  const binary = !(b.entry.capabilities || {}).xmlState;
  for (const [k, v] of list) {
    const param = (b.entry.params || []).find((p) => p.key === k) || findParam(b.entry, k);
    if (!param) throw new Error(`no parameter ${k} on ${plug.name} (live_plugin_params lists them)`);
    conv[k] = stateChange(v, param, { binary, key: k });
    // A mapped attribute whose scale the scan could not verify would be written on the wrong scale.
    if (!binary && (b.entry.stateKeys || {})[param.key] && !stateScaleOf(b.entry, param.key)) throw new Error(unverifiedMessage(b.entry, param.name));
  }
  const r = await d.writeParams(call, { ...(p.instrument ? { target: p.target } : p.target), changes: conv, entry: b.entry });
  return relabel(r, p);
}

// The class ID of the slot's plug-in, or of `plugin` by name.
function classOf(name, d) {
  // Studio One's plug-in cache leaves out its built-in instruments: their presets name the class.
  const cid = (d.classIdFor ?? classIdFor)(name) ?? (d.presetClass ?? presetClass)(name)?.classId ?? null;
  if (!cid) throw new Error(`no class ID for ${name} in Studio One's plug-in list (is it installed, and has Studio One scanned it?)`);
  return cid;
}

/**
 * Presets Studio One has indexed for a plug-in (an insert's, an instrument's, or `plugin` by name), and
 * loading one onto an insert or an instrument.
 * A load first looks for the preset's file (presetfiles.js) and loads it in place through the plug-in's
 * own Load Preset File (Windows): same instance, slot, channel and bypass, no song save. An instrument
 * only ever gets a synth-only .preset (an .instrument bundle is cut down to its synth part), so its
 * channel's inserts stay as they are. Without a file, an insert falls back to replacing the slot with
 * a new instance made from the preset (same position, bypass kept, old instance removed only after
 * the new one is in); an instrument fails.
 */
export async function pluginPresets(call, args, deps = {}) {
  return args?.action === 'load' ? serialized(() => pluginPresetsNow(call, args, deps)) : pluginPresetsNow(call, args, deps);
}

export const PRESET_IN_PLACE_NOTE = "Loaded in place through the plug-in's own Load Preset File: same instance, slot and bypass, and the song was not saved (Studio One's preset dialog flashes briefly). live_undo does not revert it: load the previous preset instead.";

async function pluginPresetsNow(call, args, deps = {}) {
  const { plugin, action = 'list', preset } = args || {};
  const d = {
    replace: replaceSlot, findFile: findPresetFile, pluginClass: findPluginClass, platform: process.platform,
    io: { loadState: (...a) => presetio.loadState(...a) }, ...deps,
  };
  const target = pluginTarget(args, { optional: true });
  if (action === 'load') {
    if (!target) throw new Error('load needs channel and slot, or instrument');
    if (!preset) throw new Error('load needs preset (a name from action list)');
  }
  if (!target && !plugin) throw new Error('give channel and slot, instrument, or plugin');
  const p = target ? await resolvePlugin(call, target, d) : null;
  const name = p ? p.name ?? p.head.instrument : plugin;
  // An instrument's class comes with it (also for a renamed one); otherwise by name.
  const cid = p?.instrument ? p.cls?.cid ?? classOf(p.lookupName ?? name, d) : classOf(name, d);
  const presets = (await listPresets(call, cid)).presets || [];
  if (action === 'list') return { ...(p ? p.head : {}), plugin: name, cid, count: presets.length, presets: presets.map((x) => x.name) };
  if (action !== 'load') throw new Error('action must be list or load');
  // "Folder/Name" (or "./Name") picks one of several files with the same name; the list has the name.
  const listed = presetListName(preset);
  if (!presets.some((x) => x.name === listed)) throw new Error(`${name} has no preset named "${listed}" (action list shows them)`);

  // The plug-in's folder is its class name ("Mai Tai" for "Mai Tai 2").
  const folder = (p?.instrument ? p.cls?.className : null) ?? d.pluginClass(name)?.name ?? (d.presetClass ?? presetClass)(name)?.className ?? String(name).replace(/\s+\d+$/, '');
  const found = d.platform === 'win32' ? d.findFile({ folder, preset, cid, exts: p.instrument ? null : ['.preset', '.vstpreset', '.fxpreset'] }) : null;
  if (found) {
    const { ext, buf } = loadablePreset(found.ext, fs.readFileSync(found.file), { instrument: p.instrument, cls: { cid, name: folder } });
    await d.io.loadState(call, p.target, buf, ext);
    const out = { ...p.head, plugin: name, preset, file: found.file, backend: 'preset', realtime: false, inPlace: true, note: PRESET_IN_PLACE_NOTE };
    if (!p.instrument) {
      // Same instance: the slot still holds the plug-in, at the same place.
      const [rack] = await call('inserts', { channel: p.target.channel });
      out.inserts = rack ? rack.inserts : null;
    }
    return out;
  }
  if (p.instrument) {
    throw new Error(d.platform === 'win32'
      ? `preset file not found for in-place load: no file for "${preset}" in ${folder}'s preset folders (an instrument is never replaced to load a preset)`
      : "an instrument's preset can only be loaded on Windows (through its Load Preset File dialog)");
  }
  const { channel, slot } = p.target;
  const r = await d.replace(call, { channel, slot, cid, preset: listed }, d.closeWindows ? { closeWindows: d.closeWindows } : undefined);
  return {
    channel, slot, plugin: r.plugin ?? name, preset, slotName: r.slotName, bypassed: r.bypassed, backend: 'preset', realtime: false, inPlace: false,
    ...(r.warning ? { warning: r.warning } : {}),
    note: 'No preset file was found to load in place, so the plug-in was replaced by a new instance with the preset; settings made in its window since the last change are gone. Do NOT use live_undo to revert it: load the previous preset instead.',
  };
}

const SLOW = { timeoutMs: INSTANCE_TIMEOUT_MS };

// A plug-in on a channel's inserts, optionally from one of its presets.
export async function addPluginWithPreset(call, args, deps = {}) {
  return serialized(() => addPluginWithPresetNow(call, args, deps));
}

async function addPluginWithPresetNow(call, { channel, plugin, preset }, deps = {}) {
  if (!preset) return addPlugin(call, { channel, plugin });
  const cid = classOf(plugin, deps);
  const presets = (await listPresets(call, cid)).presets || [];
  if (!presets.some((p) => p.name === preset)) throw new Error(`${plugin} has no preset named "${preset}" (live_plugin_presets lists them)`);
  const before = ((await call('inserts', { channel }))[0]?.inserts || []).length;
  let slotName;
  try {
    slotName = (await insertPreset(call, { channel, cid, preset })).slot;
  } catch (e) {
    // No answer in time: if the rack grew by one, the insert happened (at the end).
    const [rack] = await call('inserts', { channel }, SLOW).catch(() => [null]);
    if (!rack || rack.inserts.length !== before + 1) throw e;
    slotName = (await call('insertSlotName', { channel, slot: before }, SLOW).catch(() => null))?.name ?? null;
  }
  const [rack] = await call('inserts', { channel });
  return { channel, added: plugin, preset, slotName, inserts: rack ? rack.inserts : null, note: 'One live_undo removes it.' };
}

// Removes the plug-in in `slot` of `channel` (by its exact FX name, so the right one goes).
export async function removePlugin(call, args, deps) {
  return serialized(() => removePluginNow(call, args, deps));
}

async function removePluginNow(call, { channel, slot }, { closeWindows = closePluginWindows } = {}) {
  const plug = await insertAt(call, channel, slot);
  await closeWindows({ channel });
  const before = (await call('inserts', { channel }))[0].inserts.length;
  const { name } = await call('insertSlotName', { channel, slot });
  let r = null;
  let error = null;
  try { r = await slotCommand(call, { channel, slot, command: 'Remove', name }); } catch (e) { error = e; }
  // The rack decides: a remove whose answer timed out may still have happened.
  const [rack] = await (error ? call('inserts', { channel }, SLOW).catch(() => [null]) : call('inserts', { channel }));
  const after = rack ? rack.inserts : null;
  if (after && after.length === before - 1) return { channel, removed: plug.name, slot, inserts: after, note: 'One live_undo brings it back with its settings.' };
  if (error) throw error;
  throw new Error(`Studio One did not remove ${plug.name} from slot ${slot} of ${channel}` + (r && r.done === true ? ' (the rack did not shrink)' : ''));
}

// The song's instruments: [{ index, component: 'Inst01', name: 'Mai Tai' }].
export async function listInstruments(call) {
  return (await call('instruments', {})) ?? [];
}

// Instrument track -> instrument, from the song file's last save (Devices/musictrackdevice.xml):
// each MusicTrackChannel (label = the track's channel in live_tracks) has a destination such as
// "1 - Mai Tai/Synth Input" (the instrument's number and name). -> Map(track channel label -> { index, name })
export function songInstrumentRouting(zip) {
  const out = new Map();
  const root = zip?.xml?.('Devices/musictrackdevice.xml');
  if (!root) return out;
  for (const ch of walk(root)) {
    if (ch.tag !== 'MusicTrackChannel' || !ch.attrs.label) continue;
    const dest = ch.children.find((c) => c.attrs['x:id'] === 'destination');
    const m = /^(\d+) - (.+?)(?:\/[^/]*)?$/.exec(dest?.attrs.friendlyName ?? '');
    if (m) out.set(ch.attrs.label, { index: Number(m[1]), name: m[2] });
  }
  return out;
}

/**
 * The song's instruments with their backend, class and the instrument tracks that play them:
 * [{ instrument, component, backend, classId, tracks: [names] }] plus unmapped music tracks.
 * Tracks come from the song file's last save (best effort): a track added or rerouted since then is
 * listed under unmappedTracks.
 */
export async function instrumentsOverview(call, deps = {}) {
  const d = defaults(deps);
  const openArchive = deps.openArchive ?? openSongArchive;
  const list = await listInstruments(call);
  const tracks = ((await call('tracks', { events: false }).catch(() => [])) || []).filter((t) => t.mediaType === 'Music');
  let routing = new Map();
  let routingNote = null;
  let zipOnce;
  try {
    const { fileUrl } = await call('song');
    const songPath = fileUrl ? fileURLToPath(fileUrl) : null;
    if (songPath && /\.song$/i.test(songPath)) {
      const z = openArchive(songPath);
      zipOnce = Promise.resolve(z);
      routing = songInstrumentRouting(z);
    } else routingNote = 'the song has not been saved yet, so tracks are not mapped';
  } catch (e) {
    routingNote = `tracks could not be mapped (${e.message})`;
  }
  const byInst = new Map(list.map((x) => [x.component, []]));
  const unmapped = [];
  for (const t of tracks) {
    const r = routing.get(t.channel ?? t.name);
    // The saved number and name must both match; a name alone counts only when it is unique.
    let hit = r ? list.find((x) => x.index === r.index && x.name != null && x.name === r.name) : null;
    if (!hit && r) {
      const same = list.filter((x) => x.name != null && x.name === r.name);
      if (same.length === 1) hit = same[0];
    }
    if (hit) byInst.get(hit.component).push(t.name);
    else unmapped.push(t.name);
  }
  // The song is opened at most once (already above, for the tracks); an instrument needs it only when its
  // title does not name its class.
  const zip = () => (zipOnce ??= songArchive(call, openArchive).catch(() => null));
  const instruments = [];
  for (const x of list) {
    const cls = await instrumentClass(call, x, { ...d, zip });
    const b = pickBackend(cls?.className ?? x.name, d.catalog, { discover: d.discover, pluginClass: d.pluginClass });
    instruments.push({ instrument: x.name ?? null, component: x.component, backend: b.backend, classId: cls?.cid ?? null, tracks: byInst.get(x.component) });
  }
  return {
    instruments,
    ...(unmapped.length ? { unmappedTracks: unmapped } : {}),
    note: routingNote ?? "tracks are read from the song's last save: a track added or rerouted since then is listed in unmappedTracks (save the song to map it).",
  };
}

// The name in Studio One's preset list for a preset given as "Folder/Name", "./Name" or "Name".
export const presetListName = (preset) => String(preset ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';

// Runs a Presets command ("Export Preset" | "Load Preset File") on an insert ({ channel, slot }) or an
// instrument ({ instrument }). The bridge checks availability first. It blocks while the file dialog is
// open, so the caller needs a dialog filler running and a timeout that covers it.
export async function presetCommand(call, target, command, { timeoutMs = 30000 } = {}) {
  return call('presetCommand', { target, command }, { timeoutMs });
}

// (Re)scans the installed VST3 plug-ins into the catalog (only new or changed files are scanned).
export async function runScan(opts) {
  return serialized(() => runScanNow(opts));
}

async function runScanNow({ scan = scanAll, catalogDir = defaultCatalogDir(), python = defaultPython(), exists = fs.existsSync } = {}) {
  if (!exists(python)) throw new Error('The plug-in scanner needs its Python environment: run `npm run scan:setup` once in the studio-one-mcp folder, then live_plugin_scan again.');
  const scanned = [];
  const stats = await scan({ catalogDir, python, onProgress: (e) => scanned.push(e.name) });
  const all = searchCatalog(loadCatalog(catalogDir));
  const byBackend = {};
  for (const e of all) byBackend[e.backend] = (byBackend[e.backend] || 0) + 1;
  const backendOf = new Map(all.map((e) => [e.name, e.backend]));
  return { ...stats, byBackend, scannedNow: scanned.map((name) => ({ name, backend: backendOf.get(name) ?? 'unavailable' })) };
}
