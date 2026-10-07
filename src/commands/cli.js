// `studio-one-mcp cmd find|info|run|refresh|help`: the command catalog from a terminal.
import { findCommand, commandInfo, runCommand } from './tools.js';
import { getCatalog as realGetCatalog } from './catalog.js';

export const CMD_USAGE = `studio-one-mcp cmd find <words…> [--limit N] [--state] [--json]
studio-one-mcp cmd info <Category/Name> [--json]
studio-one-mcp cmd run <Category/Name> [--Arg value …] [--check] [--json]
studio-one-mcp cmd refresh [--json]
studio-one-mcp cmd help`;

export function parseCmdArgs(argv) {
  const [sub, ...rest] = argv;
  const words = [];
  const flags = {};
  const cmdArgs = {};
  let i = 0;
  let error;
  while (i < rest.length && !rest[i].startsWith('--')) words.push(rest[i++]);
  while (i < rest.length) {
    const t = rest[i++];
    if (!t.startsWith('--')) { words.push(t); continue; }
    const eq = t.indexOf('=');
    const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
    const inline = eq < 0 ? undefined : t.slice(eq + 1);
    if (name === 'state' || name === 'json' || name === 'check') {
      if (inline === undefined || inline === 'true' || inline === '1') flags[name] = true;
      else if (inline === 'false' || inline === '0') flags[name] = false;
      else error ??= `--${name} takes true/false/1/0, got "${inline}"`;
      continue;
    }
    const hasValue = inline !== undefined || (i < rest.length && !rest[i].startsWith('--'));
    const value = inline !== undefined ? inline : hasValue ? rest[i++] : true;
    if (name === 'limit') flags.limit = value;
    else cmdArgs[name] = value;
  }
  return error ? { sub, words, flags, cmdArgs, error } : { sub, words, flags, cmdArgs };
}

function argLine(a) {
  let s = `  ${a.name}: ${a.type ?? 'unknown'}`;
  if (a.min !== undefined || a.max !== undefined) s += ` ${a.min ?? ''}..${a.max ?? ''}`;
  if (a.default !== undefined) s += ` (default ${a.default})`;
  if (a.choices?.length) s += ` choices: ${a.choices.map((c) => `${c.value}=${c.label}`).join(', ')}`;
  if (a.examples?.length) s += `; examples: ${a.examples.join(', ')}`;
  return s;
}

export async function runCmd(argv, { call, getCatalog = realGetCatalog, out = console } = {}) {
  const { sub, words, flags, cmdArgs, error } = parseCmdArgs(argv);
  if (sub === 'help') { out.log(CMD_USAGE); return 0; }
  const usage = (msg) => { if (msg) out.error(`error: ${msg}`); out.error(CMD_USAGE); return 2; };
  if (!['find', 'info', 'run', 'refresh'].includes(sub)) return usage(sub ? `unknown subcommand ${sub}` : null);
  if (error) return usage(error);
  const opts = { getCatalog };
  const text = words.join(' ');
  const print = (r, lines) => { if (flags.json) out.log(JSON.stringify(r, null, 2)); else for (const l of lines) out.log(l); };
  try {
    if (sub !== 'run' && Object.keys(cmdArgs).length) return usage(`unknown option --${Object.keys(cmdArgs)[0]}`);
    if (sub === 'find') {
      if (!text) return usage('find needs search words');
      let limit;
      if (flags.limit !== undefined) {
        limit = flags.limit === true ? NaN : Number(flags.limit);
        if (!Number.isInteger(limit) || limit < 1) return usage('--limit needs a positive number');
      }
      const r = await findCommand(call, { query: text, limit, with_state: !!flags.state }, opts);
      print(r, r.results.map((x) => [x.command, x.displayName, x.args].filter(Boolean).join(' — ') + `${x.enabled === undefined ? '' : x.enabled ? ' [enabled]' : ' [disabled]'}`));
      if (r.note && !flags.json) out.log(r.note);
      return 0;
    }
    if (sub === 'info') {
      if (!text) return usage('info needs Category/Name');
      let r;
      try { r = await commandInfo(call, { command: text }, opts); }
      catch (e) { out.error(`error: ${e.message}`); return 1; }
      const lines = [r.command, r.displayName ?? '', ...(r.args ?? []).map(argLine)];
      if (r.enabled !== undefined) lines.push(`enabled: ${r.enabled}`);
      print(r, lines);
      return 0;
    }
    if (sub === 'run') {
      if (!text) return usage('run needs Category/Name');
      let r;
      try { r = await runCommand(call, { command: text, args: Object.keys(cmdArgs).length ? cmdArgs : undefined, check_only: !!flags.check }, opts); }
      catch (e) { if (String(e.message).includes('Category/Name')) return usage(e.message); throw e; }
      const lines = [r.executed === false ? 'not executed' : 'executed'];
      if (r.enabled !== undefined) lines.push(`enabled: ${r.enabled}`);
      if (r.note) lines.push(r.note);
      for (const w of r.warnings ?? []) lines.push(`warning: ${w}`);
      print(r, lines);
      return r.executed === false ? 1 : 0;
    }
    const c = await getCatalog(call, { refresh: true });
    const w = c.warnings ?? [];
    print(c, [`catalog: ${c.commands.length} commands (${c.live ? 'live' : 'macro-only'}), ${w.length} warnings`, ...w]);
    return 0;
  } catch (e) {
    out.error(`error: ${e.message}`);
    return 1;
  }
}
