// live_export: export the running song's mixdown or stems through Studio One's own export
// (Song/Export Mixdown | Export Stems), with the dialog driven by export/dialog.js and the user's
// export settings put back afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withDialogLock } from '../dialoglock.js';
import { snapshotDialogs } from '../plugins/filedialog.js';
import { windowsSnapshot, driveExportDialog, cancelExportDialogs } from './dialog.js';
import { exportFolders, snapshotFolders, newFiles, moveFiles, checkOutput, AUDIO_EXTS } from './folders.js';

const RANGES = { loop: 0, song: 1, markers: 2 };
const RANGE_NAMES = ['loop', 'song', 'markers'];
const FORMATS = ['wav', 'aif', 'flac', 'caf', 'm4a', 'ogg', 'opus', 'mp3'];
const ALIASES = { aiff: 'aif', vorbis: 'ogg' };
const canonFormat = (f) => { const k = String(f).toLowerCase().replace(/^\./, ''); return ALIASES[k] ?? k; };

// After a failed dialog: how long a late export dialog is watched for (and cancelled), then how
// long the pending export command may still take before it is abandoned so restore can run.
export const LATE_CANCEL_MS = 20000;
export const SETTLE_MS = 20000;

async function tasklistPid() {
  const run = promisify(execFile);
  for (const image of ['Studio One.exe', 'Studio Pro.exe']) {
    let stdout = '';
    try {
      ({ stdout } = await run('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${image}`]));
    } catch { continue; }
    const m = /^"[^"]*","(\d+)"/m.exec(stdout);
    if (m) return Number(m[1]);
  }
  throw new Error('Studio One is not running (no Studio One process found)');
}

// The Studio One process, picked like the preset dialog does (one process, or the one with a song
// window); the process list is the fallback (e.g. Studio Pro.exe, or the helper failed).
export async function findPid({ snapshot = snapshotDialogs, fallback = tasklistPid } = {}) {
  try {
    return (await snapshot()).pid;
  } catch (e) {
    const msg = String(e?.message ?? e).replace(/^file dialog: /, '');
    if (/several Studio One instances/.test(msg)) throw new Error(msg);
  }
  return fallback();
}

function validate(o) {
  const { kind, range, output } = o;
  if (kind !== 'mixdown' && kind !== 'stems') throw new Error('kind must be mixdown or stems');
  if (range !== undefined && !(range in RANGES)) throw new Error('range must be loop, song or markers');
  let formats;
  if (o.formats !== undefined) {
    formats = [...new Set(o.formats.map(canonFormat))];
    for (const f of formats) if (!FORMATS.includes(f)) throw new Error(`unknown format "${f}" (use ${FORMATS.join(', ')})`);
    if (!formats.length) throw new Error('formats is empty');
    if (kind === 'stems' && formats.length !== 1) throw new Error('stems take exactly one format');
  }
  if (kind !== 'stems') {
    if (o.split_mono !== undefined) throw new Error('split_mono is only for stems');
    if (o.realtime !== undefined) throw new Error('realtime is only for stems');
  }
  const timeoutS = o.timeout_s ?? 600;
  if (typeof timeoutS !== 'number' || !(timeoutS >= 10 && timeoutS <= 3600)) throw new Error('timeout_s must be between 10 and 3600');
  if (output !== undefined && (typeof output !== 'string' || !path.isAbsolute(output))) throw new Error('output must be an absolute path (a folder, or a file path for a single mixdown)');
  checkOutput(output, kind, formats);
  return { formats, timeoutS };
}

const isOutputFile = (output) => !!output && AUDIO_EXTS.includes(path.extname(output).slice(1).toLowerCase());

export async function exportAudio(call, opts = {}, deps = {}) {
  const d = {
    windowsSnapshot, driveExportDialog, cancelExportDialogs, exportFolders, snapshotFolders, moveFiles,
    studioOnePid: findPid, now: () => Date.now(), platform: process.platform, lock: withDialogLock,
    lateCancelMs: LATE_CANCEL_MS, settleMs: SETTLE_MS, ...deps,
  };
  if (!deps.studioOnePid && d.platform !== 'win32') throw new Error("Exporting through Studio One's dialog is supported on Windows only");
  const v = validate(opts);
  // One dialog flow at a time: a preset dialog (live_plugin_*) never runs during an export.
  return d.lock(() => run(call, opts, v, d));
}

async function run(call, opts, { formats, timeoutS }, d) {
  const { kind, output } = opts;
  const t0 = d.now();
  const notes = [];

  const song = await call('song');
  if (song?.transport?.playing || song?.transport?.recording) throw new Error('stop playback first');
  if (typeof song?.fileUrl !== 'string' || !song.fileUrl.startsWith('file:')) throw new Error('save the song once first (File/Save): the export folder is next to the song file');

  let cur = await call('exportSettings', { kind, action: 'get' });
  if (cur?.pending) {
    // An earlier export was interrupted (e.g. the MCP server stopped) and left its settings applied:
    // put the user's own settings back first, so the snapshot taken by apply is theirs.
    const r = await call('exportSettings', { kind, action: 'restore' });
    if (r?.settings) cur = r.settings;
    notes.push('export settings left applied by an interrupted export were put back first');
  }
  const rangeIsLoop = opts.range === undefined ? cur?.range === 0 : opts.range === 'loop';
  if (rangeIsLoop) {
    const lr = song.transport?.loopRange;
    if (!lr || !((lr.end?.seconds ?? 0) > (lr.start?.seconds ?? 0))) throw new Error('set the loop range first (live_set_loop)');
  }
  if (!formats && isOutputFile(output) && cur?.current) {
    const used = (kind === 'mixdown' && Array.isArray(cur.selected) && cur.selected.length ? cur.selected : [cur.current]).map(canonFormat);
    try {
      checkOutput(output, kind, [...new Set(used)]);
    } catch (e) {
      throw new Error(`${e.message} (the export dialog's current choice; pass formats to pick)`);
    }
  }

  const folders = d.exportFolders(fileURLToPath(song.fileUrl), kind);
  const before = d.snapshotFolders(folders);
  const pid = await d.studioOnePid();
  const winBefore = await d.windowsSnapshot(pid);

  const options = {};
  for (const [k, val] of Object.entries({
    importToTrack: opts.import_to_track, preMasterFX: opts.skip_master_fx, writeAudioTempo: opts.write_tempo,
    realtime: opts.realtime, splitMono: opts.split_mono,
  })) if (val !== undefined) options[k] = val;
  const req = { kind, action: 'apply', options };
  if (opts.range !== undefined) req.range = RANGES[opts.range];
  if (formats) req.formats = formats;

  let applied;
  let failure = null;
  try {
    applied = await call('exportSettings', req);
    await runExport(call, kind, timeoutS, folders, pid, winBefore, d);
  } catch (e) {
    failure = e;
  }

  let restored = false;
  let restoreError = null;
  try {
    const r = await call('exportSettings', { kind, action: 'restore' });
    restored = r?.restored === true;
  } catch (e) {
    restoreError = `your export settings could not be put back yet (${e.message || e}); the next live_export puts them back`;
  }

  if (failure) {
    let msg = failure.message || String(failure);
    if (failure.alert) {
      const written = newFiles(before, d.snapshotFolders(folders));
      if (written.length) msg += `; files written anyway: ${written.join(', ')}`;
    }
    if (restoreError) msg += `; ${restoreError}`;
    throw new Error(msg);
  }
  if (restoreError) notes.push(restoreError);
  else if (!restored) notes.push('Studio One had no saved copy of your export settings to put back');

  const after = d.snapshotFolders(folders);
  let files = newFiles(before, after);
  if (!files.length) throw new Error(`the export ran but no new files were found in: ${folders.join(', ')}; if you changed the location in the dialog without saving the song, look there`);
  if (output) files = d.moveFiles(files, output, { kind });

  return {
    kind,
    range: RANGE_NAMES[applied?.range] ?? opts.range,
    formats: applied?.selected,
    files: files.map((p) => ({ path: p, bytes: fs.statSync(p).size })),
    seconds: (d.now() - t0) / 1000,
    settingsRestored: restored,
    ...(notes.length ? { note: notes.join('; ') } : {}),
  };
}

// Sends the export command and drives its dialog. The dialog wait starts only once the command is
// in the mailbox. Throws on failure (err.alert when Studio One refused with an alert); never leaves
// the command pending for longer than the late-cancel watch plus settleMs.
async function runExport(call, kind, timeoutS, folders, pid, winBefore, d) {
  const abandon = new AbortController();
  let markSent;
  const sent = new Promise((r) => { markSent = r; });
  let done = false;
  const settled = call('command', { category: 'Song', name: kind === 'mixdown' ? 'Export Mixdown' : 'Export Stems' }, {
    timeoutMs: timeoutS * 1000, onSent: () => markSent(), signal: abandon.signal,
  }).then((value) => ({ value }), (error) => ({ error }));
  void settled.then(() => { done = true; });

  // Bounded wait for the command, then abandon it so restore is not stuck behind it.
  const settleWithin = async (ms) => {
    let timer;
    await Promise.race([settled, new Promise((r) => { timer = setTimeout(r, ms); })]);
    clearTimeout(timer);
    if (!done) abandon.abort();
    return settled;
  };

  const first = await Promise.race([sent.then(() => 'sent'), settled.then(() => 'settled')]);
  if (first !== 'sent') {
    const r = await settled;
    throw r.error ?? new Error('the export command returned before it was sent');
  }

  let r;
  try {
    r = await d.driveExportDialog({ pid, before: winBefore });
  } catch (e) {
    r = { ok: false, reason: e.message || String(e) };
  }

  if (r.ok) {
    const c = await settled;
    if (c.error) {
      if (/did not answer/.test(c.error.message)) {
        throw new Error(`the export did not finish within timeout_s (${timeoutS} s): it may still be running; files go to ${folders.join(', ')}`);
      }
      throw c.error;
    }
    return;
  }

  if (r.reason === 'alert') {
    await settleWithin(d.settleMs);
    throw Object.assign(new Error(`Studio One refused the export ("${r.title}"): check the range (loop/markers) and formats`), { alert: true });
  }

  // No dialog, or the dialog could not be driven: a late export dialog must not stay open (or be
  // left for the user), so watch for one and cancel it (Escape, never Enter) until the command settles.
  let cancelled = [];
  if (!done) {
    const stop = new AbortController();
    void settled.then(() => stop.abort());
    try {
      cancelled = (await d.cancelExportDialogs({ pid, before: winBefore, timeoutMs: d.lateCancelMs, signal: stop.signal })).cancelled ?? [];
    } catch { /* best effort */ }
  }
  const c = await settleWithin(d.settleMs);
  // The command failed on its own (not abandoned by us): that error is the real reason.
  if (c.error && !abandon.signal.aborted) throw new Error(`${c.error.message} (no export dialog appeared)`);
  if (r.reason === 'no dialog') throw new Error('Studio One did not open the export dialog in time; any late export dialog was cancelled');
  throw new Error(`export dialog: ${r.reason}${cancelled.length ? '; a late export dialog was cancelled' : ''}`);
}
