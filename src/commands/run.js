import { fold } from './search.js';

export function splitCommand(s) {
  const str = String(s ?? '');
  const i = str.indexOf('/');
  if (i < 0) throw new Error(`command must be "Category/Name", got "${str}"`);
  return { category: str.slice(0, i), name: str.slice(i + 1) };
}

const TRUE_WORDS = new Set(['on', 'true', 'yes', 'si']);
const FALSE_WORDS = new Set(['off', 'false', 'no']);

function normalizeValue(arg, value) {
  if (arg.type === 'bool') {
    if (value === true) return 1;
    if (value === false) return 0;
    if (typeof value === 'string') {
      const f = fold(value);
      if (TRUE_WORDS.has(f)) return 1;
      if (FALSE_WORDS.has(f)) return 0;
    }
    if (value === 0 || value === 1) return value;
    throw new Error(`${arg.name} must be on/off (1 or 0)`);
  }
  if (arg.choices?.length) {
    const oneOf = () => new Error(`${arg.name} must be one of: ${arg.choices.map((c) => `${c.label} (${c.value})`).join(', ')}`);
    if (typeof value === 'string') {
      const f = fold(value);
      const labels = arg.choices.map((c) => ({ c, f: fold(c.label) }));
      let hit = labels.find((l) => l.f === f)?.c;
      if (!hit) {
        const pre = labels.filter((l) => f && l.f.startsWith(f));
        if (pre.length === 1) hit = pre[0].c;
      }
      if (!hit) hit = arg.choices.find((c) => String(c.value) === value.trim());
      if (!hit) throw oneOf();
      return hit.value;
    }
    if (typeof value === 'number' && arg.choices.some((c) => c.value === value)) return value;
    throw oneOf();
  }
  if (arg.type === 'int' || arg.type === 'float') {
    if (typeof value === 'string') {
      if (value.trim() === '' || Number.isNaN(Number(value))) throw new Error(`${arg.name} must be a number`);
      value = Number(value);
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`${arg.name} must be a finite number`);
      if (arg.type === 'int' && !Number.isInteger(value)) throw new Error(`${arg.name} must be a whole number`);
      if ((arg.min !== undefined && value < arg.min) || (arg.max !== undefined && value > arg.max)) {
        throw new Error(`${arg.name} must be between ${arg.min ?? '-inf'} and ${arg.max ?? 'inf'}`);
      }
    }
  }
  return value;
}

export function normalizeArgs(entry, args) {
  if (args === undefined) return { flat: undefined, warnings: [] };
  if (Array.isArray(args)) return { flat: args, warnings: [] };
  if (args === null || typeof args !== 'object') throw new Error('args must be an object or a flat array');
  if (!entry?.args?.length) {
    return { flat: Object.entries(args).flat(), warnings: ['arguments not checked: no schema for this command'] };
  }
  const flat = [];
  const seen = new Set();
  for (const [key, value] of Object.entries(args)) {
    const arg = entry.args.find((a) => a.name === key) ?? entry.args.find((a) => a.name.toLowerCase() === key.toLowerCase());
    if (!arg) throw new Error(`unknown argument ${key} for ${entry.command}; valid: ${entry.args.map((a) => a.name).join(', ')}`);
    if (seen.has(arg.name)) throw new Error(`duplicate argument ${arg.name}`);
    seen.add(arg.name);
    flat.push(arg.name, normalizeValue(arg, value));
  }
  return { flat, warnings: [] };
}
