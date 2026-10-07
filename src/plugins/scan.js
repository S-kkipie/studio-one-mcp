// Plug-in scanner runner: walks VST3 folders, runs scripts/scan-plugin.py per plug-in in a
// child process (with timeout + kill), and keeps an incremental JSON catalog.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
      finish(reject, new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      let parsed;
      try { parsed = JSON.parse(line); } catch { /* handled below */ }
      if (parsed && !parsed.error) return finish(resolve, parsed);
      const msg = parsed?.error || err.trim().split(/\r?\n/).pop() || `exit code ${code}`;
      finish(reject, new Error(msg));
    });
  });
}

export async function scanAll({
  roots = defaultRoots(), catalogDir = defaultCatalogDir(), python = defaultPython(),
  timeoutMs = 60000, runner = pythonRunner, onProgress,
} = {}) {
  fs.mkdirSync(catalogDir, { recursive: true });
  const stats = { scanned: 0, skipped: 0, errors: 0, total: 0 };
  const seen = new Set();
  for (const root of roots) {
    for (const file of findPlugins(root)) {
      const key = path.resolve(file).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      stats.total++;
      const st = fs.statSync(file);
      const size = st.isFile() ? st.size : 0;
      const base = path.basename(file).replace(/\.vst3$/i, '');
      const entryPath = path.join(catalogDir, `${sanitizeName(base)}.json`);
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(entryPath, 'utf8')); } catch { /* none */ }
      if (prev && prev.path === file && prev.mtimeMs === st.mtimeMs && prev.size === size) {
        stats.skipped++;
        continue;
      }
      let entry;
      try {
        const result = await runner({ path: file, python, timeoutMs });
        entry = { ...result, path: file, mtimeMs: st.mtimeMs, size, scannedAt: new Date().toISOString() };
      } catch (e) {
        stats.errors++;
        entry = { name: base, path: file, mtimeMs: st.mtimeMs, size, scanError: String(e?.message || e), scannedAt: new Date().toISOString() };
      }
      stats.scanned++;
      fs.writeFileSync(entryPath, JSON.stringify(entry, null, 2));
      onProgress?.(entry);
    }
  }
  return stats;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const timeoutMs = Number(process.env.STUDIO_ONE_MCP_SCAN_TIMEOUT_MS) || 60000;
  const r = await scanAll({
    timeoutMs,
    onProgress: (e) => {
      const tag = e.scanError ? `ERROR ${e.scanError}` : `${e.params?.length ?? 0} params`;
      console.log(`  ${e.name}: ${tag}`);
    },
  });
  console.log(`Scan done: ${r.total} plug-ins, ${r.scanned} scanned, ${r.skipped} skipped, ${r.errors} errors`);
}
