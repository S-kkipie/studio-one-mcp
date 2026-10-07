import { synonyms } from './synonyms.js';

export function fold(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function words(s) { return fold(s).split(' ').filter(Boolean); }

function wordMatches(fieldWords, alt) {
  return fieldWords.some((w) => w === alt || (alt.length >= 3 && w.startsWith(alt)));
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
  for (const t of tokens) {
    const alts = [t, ...synonyms(t)];
    if (alts.some((a) => wordMatches(nameW, a))) score += 3;
    if (alts.some((a) => wordMatches(dispW, a))) score += 3;
    if (alts.some((a) => wordMatches(catW, a))) score += 1;
    if (alts.some((a) => wordMatches(argW, a))) score += 1;
  }
  if (foldedQuery.length >= 4 && (fold(entry.name).includes(foldedQuery) || fold(entry.displayName).includes(foldedQuery))) score += 5;
  return score;
}

export function searchCommands(catalog, query, { limit = 10 } = {}) {
  const rawQuery = String(query ?? '').trim();
  const foldedQuery = fold(rawQuery);
  const tokens = foldedQuery.split(' ').filter(Boolean);
  if (!tokens.length) return [];
  return (catalog.commands ?? [])
    .map((e) => ({ e, score: scoreEntry(e, rawQuery, foldedQuery, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.command.length - b.e.command.length || (a.e.command < b.e.command ? -1 : a.e.command > b.e.command ? 1 : 0))
    .slice(0, limit)
    .map(({ e, score }) => ({ command: e.command, displayName: e.displayName, args: argSummary(e), score }));
}
