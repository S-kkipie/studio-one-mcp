// State backend: a third-party plug-in's parameters are edited in its saved state and the edited
// state is loaded back by replacing the slot with a new instance made from a temporary preset.
//
// Reading: Studio One keeps each insert's state in the song file
// (Presets/Channels/<channel>/<n> - <name>.vstpreset), so a read saves the song (File/Save) and
// unzips it. Presets/Update Preset was tried as a no-save read path on 7.2.3 and rejected: it opens
// a modal "Save preset" dialog, which blocks the bridge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openSongArchive } from '../song.js';
import { kids, byXid, walk } from '../xml.js';
import { listPresets, insertPreset, slotCommand, INSTANCE_TIMEOUT_MS } from '../tracks.js';
import { parseVstPreset, buildVstPreset, readJuceXml, writeJuceXml, setXmlAttrs, getXmlAttrs } from './vstpreset.js';
import { findParam, matchPlugin, stateScaleOf, displayToState, unverifiedMessage, normalizedRefused } from './catalog.js';
import { closePluginWindows } from './windows.js';
import { REPO_ROOT, defaultPython } from './scan.js';

export const APPLY_STATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'apply-state.py');
export const SCRATCH_FOLDER = 'studio-one-mcp';

export function defaultPresetsRoot() {
  return process.env.STUDIO_ONE_MCP_USER_PRESETS || path.join(os.homedir(), 'Documents', 'Studio One', 'Presets');
}

// "ABCDEF019182FAEB4E4453504E4A5058" -> "{ABCDEF01-9182-FAEB-4E44-53504E4A5058}" (Studio One's Class:ID).
export function braceClassId(id) {
  const h = String(id).replace(/[{}-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(h)) throw new Error(`not a VST3 class id: ${id}`);
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
}

// The song-archive path of the preset holding slot `slot` of `channel`: the one the mixer names
// for that slot (audiomixer.xml, <String x:id="presetPath">), else Studio One's "<slot+1> - " file.
export function findSlotPreset(zip, channel, slot) {
  const mixer = zip.xml('Devices/audiomixer.xml');
  if (mixer) {
    const chans = [...walk(mixer)].filter((n) => /Channel$/.test(n.tag) && (n.attrs.label || n.attrs.name) === channel);
    if (chans.length === 1) {
      const slots = kids(byXid(chans[0], 'Inserts'), 'Attributes').filter((s) => !s.attrs['x:id']);
      const p = slots[slot] ? byXid(slots[slot], 'presetPath')?.attrs.text : null;
      if (p && zip.raw(p)) return p;
    }
  }
  const prefix = `Presets/Channels/${channel}/${slot + 1} - `;
  const hits = zip.names.filter((n) => n.startsWith(prefix) && n.toLowerCase().endsWith('.vstpreset'));
  if (hits.length === 1) return hits[0];
  throw new Error(`no saved state for slot ${slot} of ${channel} in the song (looked for ${prefix}*.vstpreset)`);
}

// After a create or remove that may still be running, the next answer can take as long.
const SLOW = { timeoutMs: INSTANCE_TIMEOUT_MS };

async function rackOf(call, channel, opts) {
  const rack = await (opts ? call('inserts', { channel }, opts) : call('inserts', { channel }));
  return (Array.isArray(rack) && rack[0] ? rack[0].inserts : []) || [];
}

async function slotInfo(call, channel, slot) {
  const hit = (await rackOf(call, channel)).find((x) => x.slot === slot);
  if (!hit) throw new Error(`no plug-in in slot ${slot} on ${channel}`);
  return hit;
}

// -> { channel, slot, plugin, classId, cid, xml | null, raw, presetPath, source: 'song-save' }
export async function readPluginState(call, { channel, slot }, { openArchive = openSongArchive } = {}) {
  const ins = await slotInfo(call, channel, slot);
  // Only ever File/Save an existing .song: on an untitled song it would open Save As.
  const { fileUrl } = await call('song');
  const songPath = fileUrl ? fileURLToPath(fileUrl) : null;
  if (!songPath || !/\.song$/i.test(songPath)) throw new Error('the song has no .song file yet: save it once in Studio One before editing plug-in state');
  // File/Save is greyed out while the song has no unsaved changes; the file on disk is then current.
  let saved = true;
  try {
    const r = await call('save', {});
    if (r && r.executed === false) throw new Error('File/Save did not run');
  } catch (e) {
    if (!/not available/i.test(e.message)) throw new Error(`could not save the song to read the plug-in state: ${e.message}`);
    saved = false;
  }
  const zip = openArchive(songPath);
  const presetPath = findSlotPreset(zip, channel, slot);
  const raw = Buffer.from(zip.raw(presetPath));
  const p = parseVstPreset(raw);
  const comp = p.chunks.find((c) => c.id === 'Comp');
  return {
    channel, slot, plugin: ins.name, classId: p.classId, cid: braceClassId(p.classId),
    xml: comp ? readJuceXml(comp.data) : null, raw, presetPath, source: 'song-save', saved,
  };
}

// A change's value (in the parameter's display units, as the catalog shows it) as the state stores
// it: state = a * display + b, from the scan (stateScale). A key the scan could not verify is
// refused, and so is { normalized }: the state is not a linear 0..1 of the range (log tapers).
function stateValue(v, r, entry) {
  const name = r.param?.name ?? r.key;
  if (v && typeof v === 'object') throw new Error(normalizedRefused(name));
  const scale = stateScaleOf(entry, r.key);
  if (!scale) throw new Error(unverifiedMessage(entry, name));
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return displayToState(scale, v);
  throw new Error(`${name}: give a number or on/off for ${entry.name}'s saved state, not "${v}"`);
}

// On/off as the state already spells it: "true"/"false" where the attribute holds one of those
// (Neural; also two-choice parameters such as a mode), else 1/0 (JUCE APVTS <PARAM id=".." value=".."/>
// parses "true" as 0).
function boolText(xml, stateKey, v) {
  const cur = getXmlAttrs(xml, [stateKey])[stateKey];
  if (cur === 'true' || cur === 'false') return typeof v === 'boolean' || v === 0 || v === 1 ? String(v === true || v === 1) : v;
  return typeof v === 'boolean' ? (v ? 1 : 0) : v;
}

// change key (catalog key or parameter name) -> { param, key, stateKey }
function resolve(entry, k) {
  const keys = entry.stateKeys || {};
  const param = (entry.params || []).find((p) => p.key === k) || findParam(entry, k);
  const key = param ? param.key : k;
  return { param, key, stateKey: keys[k] || keys[key] || null };
}

const runFile = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || stdout || err.message).trim().split(/\r?\n/).pop()));
    else resolve(stdout);
  });
});

function pythonRunner(python = defaultPython()) {
  return (args) => runFile(python, ['-I', ...args]);
}

// Edits the state: XML attributes, or (binary JUCE state) pedalboard via scripts/apply-state.py.
async function editState(state, entry, changes, runPython) {
  const caps = entry.capabilities || {};
  const applied = {};
  const missing = [];
  const comp = parseVstPreset(state.raw).chunks;
  if (state.xml && caps.xmlState) {
    const attrs = {};
    const byAttr = {};
    for (const [k, v] of Object.entries(changes)) {
      const r = resolve(entry, k);
      if (!r.stateKey) { missing.push(k); continue; }
      attrs[r.stateKey] = boolText(state.xml, r.stateKey, stateValue(v, r, entry));
      byAttr[r.stateKey] = [k, v];
    }
    const out = setXmlAttrs(state.xml, attrs);
    for (const a of Object.keys(attrs)) {
      if (out.missing.includes(a)) missing.push(byAttr[a][0]);
      else applied[byAttr[a][0]] = byAttr[a][1];
    }
    const chunks = comp.map((c) => (c.id === 'Comp' ? { id: 'Comp', data: writeJuceXml(out.xml) } : c));
    return { applied, missing, chunks };
  }
  if (caps.stateRoundTrip) {
    const keyed = {};
    const back = {};
    for (const [k, v] of Object.entries(changes)) {
      const r = resolve(entry, k);
      if (v && typeof v === 'object') throw new Error(normalizedRefused(r.param?.name ?? r.key));
      keyed[r.key] = v;
      back[r.key] = k;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's1mcp-state-'));
    const files = ['in.vstpreset', 'changes.json', 'out.json'].map((f) => path.join(tmp, f));
    try {
      fs.writeFileSync(files[0], state.raw);
      fs.writeFileSync(files[1], JSON.stringify(keyed));
      await runPython([APPLY_STATE_SCRIPT, entry.path, ...files]);
      const res = JSON.parse(fs.readFileSync(files[2], 'utf8'));
      for (const key of res.applied || []) applied[back[key] ?? key] = changes[back[key] ?? key];
      for (const key of res.missing || []) missing.push(back[key] ?? key);
      const swap = { Comp: res.comp, Cont: res.cont };
      const chunks = comp.map((c) => (swap[c.id] != null ? { id: c.id, data: Buffer.from(swap[c.id], 'base64') } : c));
      return { applied, missing, chunks };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  throw new Error(`${entry.name} has no editable state (catalog backend: opaque); use its presets instead`);
}

// The old instance could not be removed: take the new one out again so two copies never stay in
// series; if that fails too, bypass the new one. Always throws.
async function rollBack(call, { channel, slot, count, newName, oldName, why }) {
  let undoError = null;
  try {
    const r = await slotCommand(call, { channel, slot, command: 'Remove', name: newName });
    if (r.done !== true) undoError = 'Studio One did not remove it';
  } catch (e) { undoError = e.message; }
  // An answer that timed out may still have removed it: the rack decides.
  const n = (await rackOf(call, channel, SLOW).catch(() => null))?.length;
  const head = `the change was not applied: removing the old instance (${oldName}) failed (${why})`;
  if (n === count) throw new Error(`${head}; the new instance was removed again and the original is unchanged in slot ${slot}`);
  if (!undoError) undoError = n === undefined ? 'the rack could not be read afterwards' : 'the rack did not shrink';
  // Bypass only what is known to be the new instance.
  let bypassed = false;
  const held = await slotFx(call, channel, slot);
  if (held === newName) {
    try { bypassed = !!(await call('setInsertBypass', { channel, slot, bypassed: true })).after; } catch { /* reported below */ }
  }
  const tail = bypassed
    ? `the new instance in slot ${slot} was bypassed, so only the original (now slot ${slot + 1}) is heard`
    : held && held !== newName
      ? `slot ${slot} holds ${held}, not the new instance ${newName}, so nothing was bypassed: check live_inserts, two instances may be in series`
      : `the new instance in slot ${slot} could NOT be bypassed either: two instances are in series, remove one by hand`;
  throw new Error(`${head}, and removing the new instance (${newName}) failed too (${undoError}); ${tail}`);
}

// The FX name of the slot, or null.
async function slotFx(call, channel, slot) {
  return (await call('insertSlotName', { channel, slot }, SLOW).catch(() => null))?.name ?? null;
}

/**
 * Replaces the plug-in in `slot` of `channel` with a new instance of class `cid` made from the indexed
 * preset `preset` (exact name from listPresets): close plug-in windows (Track Edit tasks do not run
 * while one is open), insert the new instance at the same position, remove the old one by its exact
 * FX name (rolled back if that fails, so the original is never lost), check the position, restore
 * the bypass. -> { slotName, plugin, bypassed, warning? }
 */
export async function replaceSlot(call, { channel, slot, cid, preset }, { closeWindows = closePluginWindows } = {}) {
  await closeWindows();
  const old = await slotInfo(call, channel, slot);
  const count = (await rackOf(call, channel)).length;
  const oldName = (await call('insertSlotName', { channel, slot })).name;
  let newName;
  try {
    newName = (await insertPreset(call, { channel, cid, preset, position: slot })).slot;
  } catch (e) {
    // No answer in time does not mean nothing happened: a new instance in the slot, with the old
    // one right below it, is a success.
    const n = (await rackOf(call, channel, SLOW).catch(() => null))?.length;
    if (n !== count + 1) throw e;
    const at = await slotFx(call, channel, slot);
    if (!at || at === oldName || (await slotFx(call, channel, slot + 1)) !== oldName) {
      e.message += `; ${channel} now has ${n} plug-ins (it had ${count}): check live_inserts, a new instance may be in the rack`;
      throw e;
    }
    newName = at;
  }

  // Remove the old instance (now one further down). The rack decides whether it happened: a remove
  // that reported done but left the rack long is a failure, one that timed out but shrank it is not.
  let removeError = null;
  try {
    const r = await slotCommand(call, { channel, slot: slot + 1, command: 'Remove', name: oldName });
    if (r.done !== true) removeError = 'Studio One did not remove it';
  } catch (e) { removeError = e.message; }
  const n = (await rackOf(call, channel, removeError ? SLOW : undefined).catch(() => null))?.length;
  if (n === count) removeError = null;
  else if (!removeError) removeError = n === undefined ? 'the rack could not be read afterwards' : `the rack has ${n} plug-ins afterwards, expected ${count}`;
  if (removeError) await rollBack(call, { channel, slot, count, newName, oldName, why: removeError });

  const res = { slotName: newName, plugin: old.name, bypassed: !!old.bypassed };
  const now2 = await slotFx(call, channel, slot);
  if (newName && now2 !== newName) {
    // Do not bypass what may not be the new instance.
    res.warning = now2 ? `slot ${slot} now holds ${now2}, not the new instance ${newName}` : `slot ${slot} could not be checked afterwards`;
    if (old.bypassed) res.warning += '; the bypass was not restored (check live_inserts, then use live_bypass_insert)';
  } else if (old.bypassed) {
    await call('setInsertBypass', { channel, slot, bypassed: true });
  }
  return res;
}

const safeDir = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || '_';

// Removes the file, then each now-empty folder up to (and including) the first one we created,
// and always the scratch folder itself when it is empty.
function cleanup(file, scratchDir, created) {
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  // mkdirSync returns a \\?\ long path on Windows.
  const stop = path.resolve(created ? created.replace(/^\\\\\?\\/, '') : scratchDir);
  for (let d = path.resolve(scratchDir); ; d = path.dirname(d)) {
    try {
      if (fs.readdirSync(d).length) break;
      fs.rmdirSync(d);
    } catch { break; }
    if (d === stop || path.relative(stop, d).startsWith('..')) break;
  }
}

/**
 * Sets parameters of the plug-in in `slot` of `channel` through its state, in one round-trip:
 * read the state, edit it, write a temporary preset, re-index, insert a new instance with it at the
 * same position, remove the old instance, restore the bypass, delete the preset.
 * -> { channel, slot, plugin, applied: {key: value}, missing: [], backend: 'state', realtime: false, source, slotName }
 */
export async function writePluginParams(call, { channel, slot, changes, entry }, opts = {}) {
  const {
    presetsRoot = defaultPresetsRoot(),
    readState = readPluginState,
    closeWindows = closePluginWindows,
    runPython = pythonRunner(opts.python),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    pollMs = 1000,
    timeoutMs = 30000,
    uuid = () => crypto.randomUUID(),
  } = opts;
  if (!entry) throw new Error('no catalog entry for this plug-in (run live_plugin_scan)');
  const caps = entry.capabilities || {};
  if (!caps.xmlState && !caps.stateRoundTrip) throw new Error(`${entry.name} has no editable state (catalog backend: opaque); use its presets instead`);
  if (!changes || !Object.keys(changes).length) throw new Error('no changes given');

  // A focused plug-in window can hold edits the song has not seen yet.
  await closeWindows({ channel });
  const state = await readState(call, { channel, slot });
  if (entry.classId ? braceClassId(entry.classId) !== braceClassId(state.classId) : matchPlugin(new Map([[entry.name, entry]]), state.plugin) !== entry) {
    throw new Error(`slot ${slot} of ${channel} holds ${state.plugin}, not ${entry.name}; nothing changed`);
  }
  const edit = await editState(state, entry, changes, runPython);
  const base = {
    channel, slot, plugin: state.plugin, applied: edit.applied, missing: edit.missing, backend: 'state', realtime: false, source: state.source,
    note: 'The plug-in is replaced by a new instance with the edited state; changes made in its window during the few seconds of the write are lost.',
  };
  if (!Object.keys(edit.applied).length) {
    return { ...base, note: `Nothing was applied: none of the changes is in ${entry.name}'s saved state (see missing); the plug-in was not touched.` };
  }

  const cid = state.cid || braceClassId(state.classId);
  const name = uuid();
  const scratchDir = path.join(presetsRoot, safeDir(entry.vendor || 'Unknown'), safeDir(entry.name), SCRATCH_FOLDER);
  const file = path.join(scratchDir, `${name}.vstpreset`);
  const created = fs.mkdirSync(scratchDir, { recursive: true });
  let reindexed = false;
  try {
    fs.writeFileSync(file, buildVstPreset({ classId: state.classId, chunks: edit.chunks }));

    // Re-indexing takes ~15 s and the bridge may not answer meanwhile; the preset list tells when it is done.
    let indexError = null;
    reindexed = true;
    try { await call('command', { category: 'Presets', name: 'Re-Index Presets' }); } catch (e) { indexError = e; }
    const deadline = now() + timeoutMs;
    for (;;) {
      let found = false;
      try { found = ((await listPresets(call, cid)).presets || []).some((p) => p.name === name); } catch { /* busy indexing */ }
      if (found) break;
      if (now() >= deadline) {
        throw new Error(`Re-Index Presets did not list the new preset ${name} within ${Math.round(timeoutMs / 1000)} s` + (indexError ? ` (re-index: ${indexError.message})` : ''));
      }
      await sleep(pollMs);
    }

    const rep = await replaceSlot(call, { channel, slot, cid, preset: name }, { closeWindows });
    return { ...base, slotName: rep.slotName, ...(rep.warning ? { warning: rep.warning } : {}) };
  } finally {
    cleanup(file, scratchDir, created);
    // Re-index again so the deleted preset does not linger in Studio One's preset lists (best effort).
    if (reindexed) await call('command', { category: 'Presets', name: 'Re-Index Presets' }).catch(() => {});
  }
}
