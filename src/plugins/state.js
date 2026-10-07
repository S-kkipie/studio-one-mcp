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
import { listPresets, insertPreset, slotCommand } from '../tracks.js';
import { parseVstPreset, buildVstPreset, readJuceXml, writeJuceXml, setXmlAttrs } from './vstpreset.js';
import { findParam } from './catalog.js';
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

async function slotInfo(call, channel, slot) {
  const rack = await call('inserts', { channel });
  const ins = (Array.isArray(rack) && rack[0] ? rack[0].inserts : []) || [];
  const hit = ins.find((x) => x.slot === slot);
  if (!hit) throw new Error(`no plug-in in slot ${slot} on ${channel}`);
  return hit;
}

// -> { channel, slot, plugin, classId, cid, xml | null, raw, presetPath, source: 'song-save' }
export async function readPluginState(call, { channel, slot }, { openArchive = openSongArchive } = {}) {
  const ins = await slotInfo(call, channel, slot);
  // File/Save is greyed out while the song has no unsaved changes; the file on disk is then current.
  let saved = true;
  try {
    const r = await call('save', {});
    if (r && r.executed === false) throw new Error('File/Save did not run');
  } catch (e) {
    if (!/not available/i.test(e.message)) throw new Error(`could not save the song to read the plug-in state: ${e.message}`);
    saved = false;
  }
  const { fileUrl } = await call('song');
  if (!fileUrl) throw new Error('the song has no file yet: save it once in Studio One');
  const zip = openArchive(fileURLToPath(fileUrl));
  const presetPath = findSlotPreset(zip, channel, slot);
  const raw = Buffer.from(zip.raw(presetPath));
  const p = parseVstPreset(raw);
  const comp = p.chunks.find((c) => c.id === 'Comp');
  return {
    channel, slot, plugin: ins.name, classId: p.classId, cid: braceClassId(p.classId),
    xml: comp ? readJuceXml(comp.data) : null, raw, presetPath, source: 'song-save', saved,
  };
}

// A change's value as the state stores it. { normalized } maps through the catalog range.
function stateValue(v, param) {
  if (v && typeof v === 'object' && 'normalized' in v) {
    const n = Number(v.normalized);
    if (!param || typeof param.min !== 'number' || typeof param.max !== 'number' || !(n >= 0 && n <= 1)) return undefined;
    return Math.round((param.min + n * (param.max - param.min)) * 1e6) / 1e6;
  }
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
  return undefined;
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
      const val = stateValue(v, r.param);
      if (!r.stateKey || val === undefined) { missing.push(k); continue; }
      attrs[r.stateKey] = val;
      byAttr[r.stateKey] = [k, val];
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

  const state = await readState(call, { channel, slot });
  const edit = await editState(state, entry, changes, runPython);
  const base = { channel, slot, plugin: state.plugin, applied: edit.applied, missing: edit.missing, backend: 'state', realtime: false, source: state.source };
  if (!Object.keys(edit.applied).length) return base;

  const cid = state.cid || braceClassId(state.classId);
  const name = uuid();
  const scratchDir = path.join(presetsRoot, safeDir(entry.vendor || 'Unknown'), safeDir(entry.name), SCRATCH_FOLDER);
  const file = path.join(scratchDir, `${name}.vstpreset`);
  const created = fs.mkdirSync(scratchDir, { recursive: true });
  let indexed = false;
  try {
    fs.writeFileSync(file, buildVstPreset({ classId: state.classId, chunks: edit.chunks }));

    // Re-indexing takes ~15 s and the bridge may not answer meanwhile; the preset list tells when it is done.
    let indexError = null;
    try { await call('command', { category: 'Presets', name: 'Re-Index Presets' }); } catch (e) { indexError = e; }
    const deadline = now() + timeoutMs;
    for (;;) {
      let found = false;
      try { found = ((await listPresets(call, cid)).presets || []).some((p) => p.name === name); } catch { /* busy indexing */ }
      if (found) { indexed = true; break; }
      if (now() >= deadline) {
        throw new Error(`Re-Index Presets did not list the new preset ${name} within ${Math.round(timeoutMs / 1000)} s` + (indexError ? ` (re-index: ${indexError.message})` : ''));
      }
      await sleep(pollMs);
    }

    // Track Edit tasks do not run while a plug-in window is open.
    await closeWindows();
    const old = await slotInfo(call, channel, slot);
    const oldName = (await call('insertSlotName', { channel, slot })).name;
    const ins = await insertPreset(call, { channel, cid, preset: name, position: slot });
    try {
      await slotCommand(call, { channel, slot: slot + 1, command: 'Remove', name: oldName });
    } catch (e) {
      throw new Error(`the new instance is in slot ${slot} (${ins.slot}) but removing the old one (${oldName}, now slot ${slot + 1}) failed: ${e.message}`);
    }
    if (old.bypassed) await call('setInsertBypass', { channel, slot, bypassed: true });
    const res = { ...base, slotName: ins.slot };
    const now2 = await call('insertSlotName', { channel, slot }).catch(() => null);
    if (now2 && ins.slot && now2.name !== ins.slot) res.warning = `slot ${slot} now holds ${now2.name}, not the new instance ${ins.slot}`;
    return res;
  } finally {
    cleanup(file, scratchDir, created);
    // Re-index again so the deleted preset does not linger in Studio One's preset lists (best effort).
    if (indexed) await call('command', { category: 'Presets', name: 'Re-Index Presets' }).catch(() => {});
  }
}
