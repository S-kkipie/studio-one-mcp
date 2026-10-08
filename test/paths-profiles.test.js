// Profile discovery skips the crash dumps Studio One leaves beside its profile folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('studioOneProfiles: only "Studio One N" folders, not crash dump files', async () => {
  const appdata = mkdtempSync(join(tmpdir(), 's1prof-'));
  const pre = join(appdata, 'PreSonus');
  mkdirSync(join(pre, 'Studio One 7'), { recursive: true });
  mkdirSync(join(pre, 'Plug-in Scanner'));
  writeFileSync(join(pre, 'Studio One_7_2_3_108761_Win x64_20261007_194445684.dmp'), 'x');
  const saved = { APPDATA: process.env.APPDATA, P: process.env.STUDIO_ONE_PROFILE };
  process.env.APPDATA = appdata;
  delete process.env.STUDIO_ONE_PROFILE;
  try {
    const { studioOneProfiles } = await import(`../src/paths.js?t=${Date.now()}`);
    const got = studioOneProfiles();
    if (process.platform === 'win32') assert.deepEqual(got, [join(pre, 'Studio One 7')]);
    else assert.ok(!got.some((p) => p.endsWith('.dmp')));
  } finally {
    if (saved.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved.APPDATA;
    if (saved.P !== undefined) process.env.STUDIO_ONE_PROFILE = saved.P;
  }
});
