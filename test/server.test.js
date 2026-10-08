// End to end over stdio: spawn the real MCP server against a temporary Songs
// folder and a temporary mailbox, and call its tools as a client would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeSong } from './helpers/fixtures.js';

const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));
let client;
let songs;
let mcpHome;

const touch = (path, isoDate) => utimesSync(path, new Date(isoDate), new Date(isoDate));

before(async () => {
  songs = mkdtempSync(join(tmpdir(), 's1songs-'));
  mcpHome = mkdtempSync(join(tmpdir(), 's1home-'));
  // Saved song with two autosaves.
  const a = writeSong(join(songs, 'Demo Tune', 'Demo Tune.song'), { title: 'Demo Tune' });
  touch(a, '2026-01-02T00:00:00Z');
  touch(writeSong(join(songs, 'Demo Tune', 'History', 'Demo Tune 1 (Autosaved).song')), '2026-01-01T00:00:00Z');
  touch(writeSong(join(songs, 'Demo Tune', 'History', 'Demo Tune 2 (Autosaved).song')), '2026-01-01T12:00:00Z');
  // Older song whose title also contains "Tune".
  touch(writeSong(join(songs, 'Old Tune', 'Old Tune.song'), { title: 'Old Tune' }), '2025-06-01T00:00:00Z');
  // Never saved by hand: only autosaves.
  touch(writeSong(join(songs, 'Sketch', 'History', 'Sketch 1 (Autosaved).song')), '2026-02-01T00:00:00Z');
  // A folder Studio One made for a brand-new song: Media only, nothing to read.
  mkdirSync(join(songs, 'Brand New', 'Media'), { recursive: true });

  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: { ...process.env, STUDIO_ONE_SONGS: songs, STUDIO_ONE_MCP_HOME: mcpHome },
    }),
  );
});

after(() => client?.close());

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, text, data: r.isError ? null : JSON.parse(text) };
}

test('exposes the song and live tools', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'live_add_bus', 'live_add_instrument_track', 'live_add_marker', 'live_add_plugin', 'live_add_send', 'live_add_track', 'live_arranger', 'live_audio_process', 'live_bounce', 'live_bypass_insert', 'live_changes', 'live_channels', 'live_chords', 'live_clear_chords', 'live_command', 'live_command_info', 'live_create_part', 'live_delete_marker',
    'live_edit_events', 'live_edit_notes', 'live_eval', 'live_events', 'live_export', 'live_extract_chords', 'live_find_command', 'live_groups', 'live_import_audio', 'live_inserts', 'live_instruments', 'live_list_commands', 'live_macros', 'live_markers', 'live_meters', 'live_mix_snapshot', 'live_notes', 'live_parts_from_chords', 'live_plugin_params', 'live_plugin_presets', 'live_plugin_scan', 'live_plugin_snapshot', 'live_plugin_window', 'live_plugins', 'live_record', 'live_record_setup',
    'live_redo', 'live_remove_plugin', 'live_rename_marker', 'live_run_macro', 'live_save', 'live_select_events', 'live_select_track', 'live_sends', 'live_set_automation',
    'live_set_channel', 'live_set_chords', 'live_set_loop', 'live_set_plugin_param', 'live_set_send', 'live_set_transport', 'live_song', 'live_status', 'live_takes', 'live_tempo', 'live_time_signature', 'live_track_edit', 'live_track_state',
    'live_tracks', 'live_transport', 'live_undo', 'live_write_automation', 'live_write_chords', 'live_write_drums', 'live_write_notes',
    'plugin_catalog', 'song_diff', 'song_history', 'song_list', 'song_read',
  ]);
});

test('song_list: newest first, autosave-only songs flagged, empty folders skipped', async () => {
  const { data } = await call('song_list');
  assert.deepEqual(data.map((s) => [s.title, !!s.unsaved, s.autosaves]), [
    ['Sketch', true, 1],
    ['Demo Tune', false, 2],
    ['Old Tune', false, 0],
  ]);
  assert.deepEqual((await call('song_list', { query: 'tune', limit: 1 })).data.map((s) => s.title), ['Demo Tune']);
});

test('song_read summary by exact title', async () => {
  const { data } = await call('song_read', { song: 'Demo Tune' });
  assert.equal(data.title, 'Demo Tune');
  assert.deepEqual(data.tempo, [120, 60]);
  assert.equal(data.tracks[0].name, 'Vox');
  assert.equal(data.otherMatches, undefined);
});

test('song_read: partial title picks the newest and names the others', async () => {
  const { data } = await call('song_read', { song: 'tune' });
  assert.equal(data.title, 'Demo Tune');
  assert.deepEqual(data.otherMatches, ['Old Tune']);
});

test('song_read full with a track filter; autosave-only songs are readable', async () => {
  const full = (await call('song_read', { song: 'Demo Tune', detail: 'full', track: 'vo' })).data;
  assert.equal(full.tracks.length, 1);
  assert.equal(full.tracks[0].layers.length, 2);
  assert.ok(full.mixer.length > 0);
  assert.equal((await call('song_read', { song: 'Sketch' })).data.tracks[0].name, 'Vox');
});

test('song_read: unknown song is a tool error, not a crash', async () => {
  const r = await call('song_read', { song: 'does not exist' });
  assert.equal(r.isError, true);
  assert.match(r.text, /No song matching/);
});

test('song_history: autosaves newest first, also for autosave-only songs', async () => {
  const { data } = await call('song_history', { song: 'Demo Tune' });
  assert.deepEqual(data.map((h) => basename(h.file)), ['Demo Tune 2 (Autosaved).song', 'Demo Tune 1 (Autosaved).song']);
  assert.equal((await call('song_history', { song: 'Sketch' })).data.length, 1);
});

test('song_diff: against the newest autosave by default, older to newer; errors without autosaves', async () => {
  const { data } = await call('song_diff', { song: 'Demo Tune' });
  // The save (2026-01-02) is newer than both autosaves, so the newest autosave is "from".
  assert.equal(basename(data.from), 'Demo Tune 2 (Autosaved).song');
  assert.equal(basename(data.to), 'Demo Tune.song');
  assert.deepEqual([data.changes, data.diff], [0, []]);
  const none = await call('song_diff', { song: 'Old Tune' });
  assert.equal(none.isError, true);
  assert.match(none.text, /no autosaves/);
});

test('live_status without a bridge explains how to install it', async () => {
  const { data } = await call('live_status');
  assert.equal(data.connected, false);
  assert.match(data.reason, /External Devices/);
});

test('live tools fail cleanly when the bridge is not loaded', async () => {
  const r = await call('live_channels');
  assert.equal(r.isError, true);
  assert.match(r.text, /bridge not loaded/);
});

test('live_status when Studio One closed the bridge', async () => {
  mkdirSync(join(mcpHome, 'mailbox'), { recursive: true });
  writeFileSync(join(mcpHome, 'mailbox', 'status.json'), '﻿' + JSON.stringify({ protocol: 1, closed: true }));
  const { data } = await call('live_status');
  assert.equal(data.connected, false);
  assert.match(data.reason, /closed/);
});

test('live_record refuses without confirm: true (it writes a take into the song)', async () => {
  const r = await client.callTool({ name: 'live_record', arguments: {} });
  assert.equal(r.isError, true);
  const r2 = await client.callTool({ name: 'live_record', arguments: { confirm: false } });
  assert.equal(r2.isError, true);
});

test('live_set_plugin_param: one param with one value, or a changes batch, never both', async () => {
  const none = await call('live_set_plugin_param', { channel: 'X', slot: 0 });
  assert.equal(none.isError, true);
  assert.match(none.text, /give param .* or changes/);
  const both = await call('live_set_plugin_param', { channel: 'X', slot: 0, param: 'a', text: '1', changes: { b: 2 } });
  assert.match(both.text, /give either changes, or param/);
  const two = await call('live_set_plugin_param', { channel: 'X', slot: 0, param: 'a', text: '1', value: 2 });
  assert.match(two.text, /exactly one of text, normalized or value/);
});

test('live_plugin_window open needs channel and slot', async () => {
  const r = await call('live_plugin_window', { action: 'open' });
  assert.equal(r.isError, true);
  assert.match(r.text, /open needs channel and slot, or instrument/);
});

test('plug-in tools take an insert (channel + slot) or an instrument, exactly one', async () => {
  const both = await call('live_plugin_params', { channel: 'X', slot: 0, instrument: 'Mai Tai' });
  assert.equal(both.isError, true);
  assert.match(both.text, /give either instrument, or channel and slot, not both/);
  const half = await call('live_set_plugin_param', { channel: 'X', param: 'a', text: '1' });
  assert.equal(half.isError, true);
  assert.match(half.text, /needs both channel and slot/);
  const none = await call('live_plugin_params', {});
  assert.match(none.text, /give channel and slot .* or instrument/);
  const presets = await call('live_plugin_presets', { action: 'list', instrument: 'Mai Tai', slot: 1 });
  assert.match(presets.text, /not both/);
  const tools = (await client.listTools()).tools;
  for (const name of ['live_plugin_params', 'live_set_plugin_param', 'live_plugin_presets', 'live_plugin_window']) {
    assert.ok(tools.find((t) => t.name === name).inputSchema.properties.instrument, `${name} takes instrument`);
  }
  const win = await call('live_plugin_window', { action: 'open' });
  assert.match(win.text, /open needs channel and slot, or instrument/);
  const close = await call('live_plugin_window', { action: 'closeAll', channel: 'X', instrument: 'Mai Tai' });
  assert.equal(close.isError, true);
  assert.match(close.text, /channel .* or instrument .* not both/);
});
