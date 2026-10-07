// Handlers for live_find_command, live_command_info and live_command.
import { getCatalog as realGetCatalog, findEntry } from './catalog.js';
import { searchCommands, argSummary } from './search.js';
import { splitCommand, normalizeArgs } from './run.js';

async function checkEnabled(call, command) {
  const { category, name } = splitCommand(command);
  const r = await call('command', { category, name, checkOnly: true });
  return r?.enabled;
}

export async function findCommand(call, { query, limit = 10, with_state, refresh } = {}, opts = {}) {
  const get = opts.getCatalog ?? realGetCatalog;
  const catalog = await get(call, { refresh: !!refresh });
  const results = searchCommands(catalog, query, { limit });
  const out = { results, catalog: { commands: catalog.commands.length, builtAt: catalog.builtAt, live: catalog.live, warnings: catalog.warnings } };
  if (with_state) {
    let failed = false;
    for (const r of results) {
      try { r.enabled = await checkEnabled(call, r.command); } catch { failed = true; }
    }
    if (failed) out.note = 'could not check enabled state for some commands';
  }
  return out;
}

export async function commandInfo(call, { command }, opts = {}) {
  const get = opts.getCatalog ?? realGetCatalog;
  const catalog = await get(call, {});
  const entry = findEntry(catalog, command);
  if (!entry) {
    const near = searchCommands(catalog, command, { limit: 5 }).map((r) => r.command);
    throw new Error(`no command ${command}; closest: ${near.join(', ')}`);
  }
  const info = { ...entry, argsSummary: argSummary(entry) };
  try { info.enabled = await checkEnabled(call, entry.command); } catch { /* omitted */ }
  return info;
}

export async function runCommand(call, { command, category, name, args, check_only } = {}, opts = {}) {
  const get = opts.getCatalog ?? realGetCatalog;
  if (command) ({ category, name } = splitCommand(command));
  if (!category || !name) throw new Error('give command "Category/Name" or both category and name');
  const full = `${category}/${name}`;
  let entry = null;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    try { entry = findEntry(await get(call, {}), full); } catch { entry = null; }
  }
  const { flat, warnings } = normalizeArgs(entry, args);
  const payload = { category, name, checkOnly: !!check_only };
  if (flat !== undefined) payload.args = flat;
  const result = await call('command', payload);
  const out = { command: full, ...result };
  if (warnings.length) out.warnings = warnings;
  if (result?.executed === false) out.note = 'not available in the current context (needs a selection or an open editor?)';
  return out;
}
