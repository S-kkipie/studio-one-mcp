// live_export: export the running song's mixdown or stems through Studio One's own export
// (Song/Export Mixdown | Export Stems), with the dialog driven by export/dialog.js and the user's
// export settings put back afterwards.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { windowsSnapshot, driveExportDialog } from './dialog.js';
import { exportFolders, snapshotFolders, newFiles, moveFiles, checkOutput } from './folders.js';

const RANGES = { loop: 0, song: 1, markers: 2 };
const RANGE_NAMES = ['loop', 'song', 'markers'];
const FORMATS = ['wav', 'aif', 'flac', 'caf', 'm4a', 'ogg', 'opus', 'mp3'];
const ALIASES = { aiff: 'aif', vorbis: 'ogg' };

async function findPid() {
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

function validate(o) {
  const { kind, range, output } = o;
  if (kind !== 'mixdown' && kind !== 'stems') throw new Error('kind must be mixdown or stems');
  if (range !== undefined && !(range in RANGES)) throw new Error('range must be loop, song or markers');
  let formats;
  if (o.formats !== undefined) {
    formats = [...new Set(o.formats.map((f) => {
      const k = String(f).toLowerCase().replace(/^\./, '');
      return ALIASES[k] ?? k;
    }))];
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
  checkOutput(output, kind, formats);
  return { formats, timeoutS };
}

export async function exportAudio(call, opts = {}, deps = {}) {
  const d = {
    windowsSnapshot, driveExportDialog, exportFolders, snapshotFolders, moveFiles,
    studioOnePid: findPid, now: () => Date.now(), platform: process.platform, ...deps,
  };
  if (!deps.studioOnePid && d.platform !== 'win32') throw new Error("Exporting through Studio One's dialog is supported on Windows only");
  const { formats, timeoutS } = validate(opts);
  const { kind, output } = opts;
  const t0 = d.now();

  const song = await call('song');
  if (song?.transport?.playing || song?.transport?.recording) throw new Error('stop playback first');
  if (!song?.fileUrl) throw new Error('save the song once first (File/Save): the export folder is next to the song file');
  let rangeIsLoop = opts.range === 'loop';
  if (opts.range === undefined) {
    const cur = await call('exportSettings', { kind, action: 'get' });
    rangeIsLoop = cur?.range === 0;
  }
  if (rangeIsLoop) {
    const lr = song.transport?.loopRange;
    if (!lr || !((lr.end?.seconds ?? 0) > (lr.start?.seconds ?? 0))) throw new Error('set the loop range first (live_set_loop)');
  }

  const folders = d.exportFolders(fileURLToPath(song.fileUrl), kind);
  const before = d.snapshotFolders(folders);
  const pid = await d.studioOnePid();
  const winBefore = await d.windowsSnapshot(pid);

  const options = {};
  for (const [k, v] of Object.entries({
    importToTrack: opts.import_to_track, preMasterFX: opts.skip_master_fx, writeAudioTempo: opts.write_tempo,
    realtime: opts.realtime, splitMono: opts.split_mono,
  })) if (v !== undefined) options[k] = v;
  const req = { kind, action: 'apply', options };
  if (opts.range !== undefined) req.range = RANGES[opts.range];
  if (formats) req.formats = formats;
  let applied;
  let warning = null;
  try {
    applied = await call('exportSettings', req);
    const cmd = call('command', { category: 'Song', name: kind === 'mixdown' ? 'Export Mixdown' : 'Export Stems' }, { timeoutMs: timeoutS * 1000 });
    cmd.catch(() => {}); // surfaced where it is awaited; avoids an unhandled rejection meanwhile
    const drive = d.driveExportDialog({ pid, before: winBefore });
    drive.catch(() => {});
    const r = await drive;
    if (!r.ok) {
      if (r.reason === 'no dialog') throw new Error('Studio One did not open the export dialog; if an export dialog appears, cancel it');
      if (r.reason === 'alert') {
        await cmd.catch(() => {});
        throw new Error(`Studio One refused the export ("${r.title}"): check the range (loop/markers) and formats`);
      }
      if (r.reason === 'dialog did not accept OK') await cmd.catch(() => {});
      throw new Error(`export dialog: ${r.reason}`);
    }
    await cmd;
  } finally {
    try {
      await call('exportSettings', { kind, action: 'restore' });
    } catch (e) {
      warning = `could not restore your export settings: ${e.message || e}`;
    }
  }

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
    settingsRestored: !warning,
    ...(warning ? { note: warning } : {}),
  };
}
