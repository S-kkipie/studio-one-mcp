// Edit-task argument schemas, recovered from Studio One's script packages:
// classfactory.xml (which task is which class), the task's .js source
// (parameters.add* calls) and the skin XML (radio/preset labels per dialog form).
import fs from 'node:fs';
import path from 'node:path';
import { readPackage } from './packages.js';

const unescapeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&');

function attrs(text) {
  const out = Object.create(null);
  for (const m of text.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

export function parseClassFactory(xml) {
  const out = [];
  for (const m of xml.matchAll(/<ScriptClass\b([^>]*?)(?:\/>|>([\s\S]*?)<\/ScriptClass>)/g)) {
    const a = attrs(m[1]);
    if (!a.classID) continue;
    let args = null;
    for (const t of (m[2] ?? '').matchAll(/<Attribute\b([^>]*)>/g)) {
      const at = attrs(t[1]);
      if (at.id === 'arguments' && at.value !== undefined) { args = at.value; break; }
    }
    out.push({
      classID: a.classID.toUpperCase(),
      subCategory: a.subCategory ?? null,
      name: a.name ?? null,
      sourceFile: a.sourceFile ?? null,
      args,
    });
  }
  return out;
}

const KINDS = { Integer: 'int', Float: 'float', Param: 'bool', String: 'string', List: 'list', Menu: 'menu', Color: 'color' };

// Text inside the parentheses opened at src[open], honouring string literals.
function callText(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

// Top-level comma split of an argument list, honouring parens and strings.
function splitArgs(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === '\\') cur += text[++i] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") { quote = c; cur += c; }
    else if (c === '(' || c === '[') { depth++; cur += c; }
    else if (c === ')' || c === ']') { depth--; cur += c; }
    else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim());
}

function evalNumber(expr) {
  if (!/^[-+0-9.\s/*]+$/.test(expr) || !/\d/.test(expr)) return null;
  try {
    const v = new Function(`return (${expr});`)();
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseScriptArgs(js) {
  const args = [];
  const seen = new Set();
  const callRe = /(?:\bcontext\s*\.\s*)?\bparameters\s*\.\s*(add\w*)\s*\(/g;
  for (const m of js.matchAll(callRe)) {
    const kind = m[1].slice(3);
    if (kind !== '' && !Object.hasOwn(KINDS, kind)) continue;
    const open = m.index + m[0].length - 1;
    const text = callText(js, open);

    // assignment target just before the call (after the last ; or newline)
    const before = js.slice(0, m.index);
    const lineStart = Math.max(before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
    const tm = /(?:(?:this|_this)\.(\w+)|var\s+(\w+))\s*=\s*(?:<[^>]*>\s*)?$/.exec(before.slice(lineStart));
    const target = tm ? (tm[1] ?? tm[2]) : null;

    const strings = [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)]
      .map((s) => s[1] ?? s[2]).filter((s) => !/^Media:/.test(s));
    let name = strings.length ? strings[strings.length - 1] : null;
    if (name === null && target) {
      const nm = new RegExp(`(?:\\b(?:this|_this)\\.)?\\b${escRe(target)}\\.name\\s*=\\s*"([^"]+)"`).exec(js);
      name = nm ? nm[1] : target;
    }
    if (!name || seen.has(name)) continue;
    seen.add(name);

    let type;
    if (kind !== '') type = KINDS[kind];
    else if (/Media:VelocityParam/.test(text)) type = 'velocity';
    else if (/Media:BeatListParam/.test(text)) type = 'beats';
    else type = 'param';

    const arg = { name, type };
    if (type === 'int' || type === 'float') {
      const [a, b] = splitArgs(text);
      const min = a === undefined ? null : evalNumber(a);
      const max = b === undefined ? null : evalNumber(b);
      if (min !== null) arg.min = min;
      if (max !== null) arg.max = max;
    }
    if (target) {
      const dm = new RegExp(`\\b${escRe(target)}\\.(?:default|value)\\s*=(?!=)\\s*([-+]?(?:\\d+\\.?\\d*|\\.\\d+)|true|false)\\s*(?:[;\\n]|$)`).exec(js);
      if (dm) arg.default = dm[1] === 'true' ? true : dm[1] === 'false' ? false : Number(dm[1]);
    }
    args.push(arg);
  }
  const d = /runDialog\s*\(\s*"(\w+)"/.exec(js);
  return { args, dialog: d ? d[1] : null };
}

export function parseSkinForms(xml) {
  const forms = Object.create(null);
  for (const fm of xml.matchAll(/<Form\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Form>)/g)) {
    if (fm[2] === undefined) continue;
    const { name: formName } = attrs(fm[1]);
    if (!formName) continue;
    const form = (forms[formName] ??= Object.create(null));
    for (const em of fm[2].matchAll(/<(RadioButton|ToolButton)\b([^>]*)>/g)) {
      const a = attrs(em[2]);
      const value = Number(a.value);
      if (!a.name || a.value === undefined || a.value === '' || Number.isNaN(value)) continue;
      const slot = (form[a.name] ??= { choices: [], presets: [] });
      const list = em[1] === 'RadioButton' ? slot.choices : slot.presets;
      if (!list.some((x) => x.value === value)) list.push({ value, label: a.title ?? '' });
    }
  }
  return forms;
}

export function schemasFromPackageFiles(files) {
  const lower = new Map([...files.keys()].map((k) => [k.toLowerCase(), k]));
  const get = (n) => files.get(n) ?? files.get(lower.get(n.toLowerCase()));
  const fkey = lower.get('classfactory.xml');
  if (!fkey) return {};
  const classes = parseClassFactory(files.get(fkey).toString('utf8'));

  const forms = Object.create(null);
  for (const [n, buf] of files) {
    if (!/\.xml$/i.test(n) || n.toLowerCase() === 'classfactory.xml') continue;
    for (const [f, argsMap] of Object.entries(parseSkinForms(buf.toString('utf8')))) {
      const dst = (forms[f] ??= Object.create(null));
      for (const [a, v] of Object.entries(argsMap)) {
        const slot = (dst[a] ??= { choices: [], presets: [] });
        for (const k of ['choices', 'presets']) {
          for (const x of v[k]) if (!slot[k].some((y) => y.value === x.value)) slot[k].push(x);
        }
      }
    }
  }

  const out = Object.create(null);
  for (const c of classes) {
    if (!c.sourceFile) continue;
    const src = get(c.sourceFile);
    if (!src) continue;
    const { args, dialog } = parseScriptArgs(src.toString('utf8'));
    const form = (dialog && forms[dialog]) || Object.create(null);
    out[c.classID] = {
      task: c.name,
      subCategory: c.subCategory,
      args: args.map((a) => {
        const extra = form[a.name];
        const r = { ...a };
        if (extra?.choices.length) r.choices = extra.choices.map((x) => ({ ...x }));
        if (extra?.presets.length) r.presets = extra.presets.map((x) => ({ ...x }));
        return r;
      }),
    };
  }
  return out;
}

export function extractEditTaskSchemas(installDir) {
  const scripts = path.join(installDir, 'Scripts');
  if (!fs.existsSync(scripts)) return { schemas: {}, warnings: ['no Studio One install found'] };
  const schemas = Object.create(null);
  const warnings = [];
  for (const f of fs.readdirSync(scripts).filter((n) => /\.package$/i.test(n)).sort()) {
    try {
      Object.assign(schemas, schemasFromPackageFiles(readPackage(fs.readFileSync(path.join(scripts, f)))));
    } catch (e) {
      warnings.push(`${f}: ${e.message}`);
    }
  }
  return { schemas, warnings };
}
