// Creates <repo>/.venv-scan and installs pedalboard into it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { VENV_DIR, defaultPython } from '../src/plugins/scan.js';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`failed: ${cmd} ${args.join(' ')}`); process.exit(r.status || 1); }
}

if (!fs.existsSync(defaultPython())) {
  run(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-m', 'venv', VENV_DIR]);
}
run(defaultPython(), ['-I', '-m', 'pip', 'install', '--upgrade', 'pedalboard']);
console.log(`Scanner environment ready: ${VENV_DIR}`);
