// Client side of the file mailbox (see device/StudioOneMCP/BridgeComponent.js).
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mailboxDir } from './paths.js';
import { nudge as midiNudge } from './midi.js';

const RENUDGE_MS = 150;

const readJson = (p) => {
  try {
    // Studio One's createTextFile writes a UTF-8 BOM.
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};

// The bridge only runs when nudged, so status.json says whether it has loaded,
// not whether it is alive; call('ping') is the liveness check.
export function bridgeStatus(dir = mailboxDir) {
  const s = readJson(join(dir, 'status.json'));
  if (!s) return { loaded: false, reason: 'No status.json yet — is the MCP Bridge device added in Studio One (Studio One → Preferences / Options → External Devices)?' };
  if (s.closed) return { loaded: false, reason: 'Studio One closed the bridge (song or app closed).', ...s };
  return { loaded: true, ...s };
}

// On Windows the rename fails (EPERM/EACCES/EBUSY) while Studio One still has request.json open,
// which happens for a moment after it loaded or unloaded a plug-in instance: retry for a while.
export async function placeRequest(tmp, dest, { rename = renameSync, waitMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      rename(tmp, dest);
      return;
    } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || Date.now() >= deadline) {
        try { unlinkSync(tmp); } catch { /* best effort */ }
        throw e;
      }
      await sleep(50);
    }
  }
}

let queue = Promise.resolve();

// One request in flight at a time: the mailbox has a single slot.
// onSent: called once this call's request has been placed in the mailbox (after the calls queued
// before it). signal: an abort stops waiting for the answer (or drops the call while it is still
// queued) and rejects; the queue moves on, and a later request replaces this one in the mailbox.
export function call(op, args = {}, { timeoutMs = 5000, dir = mailboxDir, nudge = midiNudge, onSent, signal } = {}) {
  const aborted = () => new Error(`"${op}" was abandoned before Studio One answered`);
  const run = async () => {
    if (signal?.aborted) throw aborted();
    const status = bridgeStatus(dir);
    if (!status.loaded) throw new Error(`Studio One bridge not loaded: ${status.reason}`);
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const tmp = join(dir, `request.${id}.tmp`);
    writeFileSync(tmp, JSON.stringify({ id, op, args }) + '\n');
    await placeRequest(tmp, join(dir, 'request.json'), { waitMs: Math.min(timeoutMs, 30000) }); // a long export still gives up placing its request after 30 s
    if (onSent) {
      try { onSent(); } catch { /* the caller's hook must not break the call */ }
    }
    const deadline = Date.now() + timeoutMs;
    let lastNudge = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw aborted();
      if (Date.now() - lastNudge >= RENUDGE_MS) {
        nudge();
        lastNudge = Date.now();
      }
      await new Promise((r) => setTimeout(r, 20));
      const res = readJson(join(dir, 'response.json'));
      if (res && res.id === id) {
        if (!res.ok) throw new Error(`Studio One: ${res.error}`);
        return res.result;
      }
    }
    throw new Error(`Studio One did not answer "${op}" within ${timeoutMs}ms. Is it running, with the MCP Bridge device receiving from the MIDI bus?`);
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}
