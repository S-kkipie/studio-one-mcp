import { synonyms } from './synonyms.js';

export function fold(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function words(s) { return fold(s).split(' ').filter(Boolean); }

const STOPWORDS = new Set('a de del la el los las un una unos unas y o en con para por al the of to and in on an'.split(' '));

// prefix=false: exact word match only (used for synonym alternatives, e.g. clip must not hit Clipboard)
function wordMatches(fieldWords, alt, prefix = true) {
  return fieldWords.some((w) => w === alt || (prefix && alt.length >= 3 && w.startsWith(alt)));
}

export function argSummary(entry) {
  return (entry.args ?? []).map((a) => {
    if (a.choices?.length) return `${a.name}(${a.choices.map((c) => c.label).join('|')})`;
    if (a.type === 'bool') return `${a.name}(on|off)`;
    if (a.min !== undefined && a.max !== undefined) return `${a.name}(${a.min}..${a.max})`;
    return a.name;
  }).join(', ');
}

function scoreEntry(entry, rawQuery, foldedQuery, tokens) {
  if (foldedQuery === fold(entry.command) || rawQuery.toLowerCase() === entry.command.toLowerCase()) return 100;
  const nameW = words(entry.name);
  const dispW = words(entry.displayName);
  const catW = [...words(entry.category), ...words(entry.displayCategory)];
  const argW = (entry.args ?? []).flatMap((a) => [...words(a.name), ...(a.choices ?? []).flatMap((c) => words(c.label))]);
  let score = 0;
  const hitBy = (t, fw) => wordMatches(fw, t) || synonyms(t).some((a) => wordMatches(fw, a, false));
  for (const t of tokens) {
    if (hitBy(t, nameW)) score += 3;
    if (hitBy(t, dispW)) score += 3;
    if (hitBy(t, catW)) score += 1;
    if (hitBy(t, argW)) score += 1;
  }
  // The query names the whole command ("transponer" → Transponer, not
  // "Transponer pistas de instrumentos"): every content word of the field is matched.
  const covered = (fw) => {
    const content = fw.filter((w) => !STOPWORDS.has(w));
    return content.length > 0 && content.every((w) => tokens.some((t) => hitBy(t, [w])));
  };
  if (covered(nameW) || covered(dispW)) score += 4;
  // Every query word found somewhere ("marker named" → Marker/Insert Named).
  const anywhere = [...nameW, ...dispW, ...catW, ...argW];
  if (tokens.length > 1 && tokens.every((t) => hitBy(t, anywhere))) score += 4;
  if (foldedQuery.length >= 4 && (fold(entry.name).includes(foldedQuery) || fold(entry.displayName).includes(foldedQuery))) score += 5;
  return score;
}

const richness = (e) => ((e.args?.length || e.examples?.length) ? 1 : 0);

export function searchCommands(catalog, query, { limit = 10 } = {}) {
  const rawQuery = String(query ?? '').trim();
  const foldedQuery = fold(rawQuery);
  const all = foldedQuery.split(' ').filter(Boolean);
  if (!all.length) return [];
  const content = all.filter((t) => !STOPWORDS.has(t));
  const tokens = content.length ? content : all;
  return (catalog.commands ?? [])
    .map((e) => ({ e, score: scoreEntry(e, rawQuery, foldedQuery, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || richness(b.e) - richness(a.e) || a.e.command.length - b.e.command.length || (a.e.command < b.e.command ? -1 : a.e.command > b.e.command ? 1 : 0))
    .slice(0, limit)
    .map(({ e, score }) => ({ command: e.command, displayName: e.displayName, args: argSummary(e), score }));
}
