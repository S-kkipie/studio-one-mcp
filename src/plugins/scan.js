// Plug-in scanner runner: walks VST3 folders, runs scripts/scan-plugin.py per plug-in in a
// child process (with timeout + kill), and keeps an incremental JSON catalog.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const SCAN_SCRIPT = path.join(REPO_ROOT, 'scripts', 'scan-plugin.py');
export const VENV_DIR = path.join(REPO_ROOT, '.venv-scan');

export function defaultPython() {
  return process.platform === 'win32'
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python');
}

export function defaultRoots() {
  const roots = [];
  if (process.platform === 'win32') roots.push('C:/Program Files/Common Files/VST3');
  const extra = process.env.STUDIO_ONE_MCP_VST3_PATHS;
  if (extra) roots.push(...extra.split(path.delimiter).filter(Boolean));
  return roots;
}

export function defaultCatalogDir() {
  return path.join(os.homedir(), '.studio-one-mcp', 'plugins');
}

export function sanitizeName(name) {
  return String(name).replace(/[^A-Za-z0-9 ._()+-]/g, '_').trim() || '_';
}

/** Recursively find *.vst3 files and bundle dirs (bundles are not descended into). */
export function findPlugins(root) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.name.toLowerCase().endsWith('.vst3')) {
        if (e.isFile() || e.isDirectory()) out.push(full);
      } else if (e.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* already gone */ }
}

function scanFailure(message, kind) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

function errorKind(e) {
  if (e?.kind) return e.kind;
  return /timeout|timed out/i.test(String(e?.message)) ? 'timeout' : 'error';
}

function pathKey(p) { return path.resolve(p).toLowerCase(); }

export function catalogFileName(pluginPath) {
  const base = path.basename(pluginPath).replace(/\.vst3$/i, '');
  const hash = crypto.createHash('sha1').update(pathKey(pluginPath)).digest('hex').slice(0, 6);
  return `${sanitizeName(base)}-${hash}.json`;
}

function isUnder(file, root) {
  const rel = path.relative(pathKey(root), pathKey(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Default runner: python -I scan-plugin.py <path>, JSON on stdout, killed on timeout. */
export function pythonRunner({ path: pluginPath, python, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', SCAN_SCRIPT, pluginPath], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      killTree(child);
      finish(reject, scanFailure(`timeout after ${timeoutMs}ms`, 'timeout'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      const err = scanFailure(`cannot run ${python}: ${e.message}`, 'error');
      err.fatal = true;
      finish(reject, err);
    });
    child.on('close', (code) => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      let parsed;
      try { parsed = JSON.parse(line); } catch { /* handled below */ }
      if (parsed && !parsed.error) return finish(resolve, parsed);
      if (parsed?.error) return finish(reject, scanFailure(parsed.error, 'error'));
      const msg = err.trim().split(/\r?\n/).pop() || `exit code ${code}, no result`;
      finish(reject, scanFailure(msg, 'crash'));
    });
  });
}

export async function scanAll({
  roots = defaultRoots(), catalogDir = defaultCatalogDir(), python = defaultPython(),
  timeoutMs = 60000, runner = pythonRunner, onProgress, retryErrors = false,
} = {}) {
  fs.mkdirSync(catalogDir, { recursive: true });
  const stats = { scanned: 0, skipped: 0, errors: 0, total: 0, pruned: 0 };
  const seen = new Set();
  for (const root of roots) {
    for (const file of findPlugins(root)) {
      const key = pathKey(file);
      if (seen.has(key)) continue;
      seen.add(key);
      stats.total++;
      const base = path.basename(file).replace(/\.vst3$/i, '');
      const entryPath = path.join(catalogDir, catalogFileName(file));
      let st = null;
      let statError = null;
      try { st = fs.statSync(file); } catch (e) { statError = e; }
      const size = st ? (st.isFile() ? st.size : 0) : undefined;
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(entryPath, 'utf8')); } catch { /* none */ }
      if (st && prev && prev.path === file && prev.mtimeMs === st.mtimeMs && prev.size === size) {
        const retry = prev.scanError && (prev.scanErrorKind === 'timeout' || retryErrors);
        if (!retry) { stats.skipped++; continue; }
      }
      let entry;
      const scannedAt = new Date().toISOString();
      try {
        if (statError) throw statError;
        const result = await runner({ path: file, python, timeoutMs });
        entry = { ...result, path: file, mtimeMs: st.mtimeMs, size, scannedAt };
      } catch (e) {
        if (e?.fatal) {
          throw new Error(`Cannot run the Python scanner (${e.message}). Run "npm run scan:setup" first.`);
        }
        stats.errors++;
        entry = {
          name: base, path: file, mtimeMs: st?.mtimeMs, size,
          scanError: String(e?.message || e), scanErrorKind: errorKind(e), scannedAt,
        };
      }
      stats.scanned++;
      fs.writeFileSync(entryPath, JSON.stringify(entry, null, 2));
      onProgress?.(entry);
    }
  }
  // Prune entries of plug-ins that vanished from a scanned root, and legacy-named files.
  for (const f of fs.readdirSync(catalogDir)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(catalogDir, f);
    let e;
    try { e = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
    if (!e?.path || !roots.some((r) => isUnder(e.path, r))) continue;
    if (!seen.has(pathKey(e.path)) || f !== catalogFileName(e.path)) {
      try { fs.unlinkSync(full); stats.pruned++; } catch { /* ignore */ }
    }
  }
  return stats;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const timeoutMs = Number(process.env.STUDIO_ONE_MCP_SCAN_TIMEOUT_MS) || 60000;
  const retryErrors = process.argv.includes('--retry-errors');
  try {
    const r = await scanAll({
      timeoutMs, retryErrors,
      onProgress: (e) => {
        const tag = e.scanError ? `ERROR (${e.scanErrorKind}) ${e.scanError.split('|')[0].slice(0, 120)}` : `${e.params?.length ?? 0} params`;
        console.log(`  ${e.name}: ${tag}`);
      },
    });
    console.log(`Scan done: ${r.total} plug-ins, ${r.scanned} scanned, ${r.skipped} skipped, ${r.errors} errors, ${r.pruned} pruned`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
