// Folded synonym groups (EN/ES) for command search. Multi-word entries (e.g. 'velocidad del tema')
// are ignored by the lookup: query tokens are single words, and splitting them would make
// stopwords like 'del'/'tema' match the group.
export const SYNONYM_GROUPS = [
  ['transpose', 'transponer', 'transposicion', 'transportar', 'tono', 'semitono', 'octava', 'octave'],
  ['quantize', 'cuantizar', 'cuantizacion', 'cuantiza', 'quantise'],
  ['track', 'pista', 'pistas', 'tracks'],
  ['duplicate', 'duplicar', 'clonar'],
  ['delete', 'borrar', 'eliminar', 'remove', 'quitar'],
  ['velocity', 'velocidad', 'dinamica'],
  ['length', 'duracion', 'largo', 'longitud'],
  ['humanize', 'humanizar'],
  ['mute', 'silenciar', 'mutear', 'enmudecer'],
  ['solo', 'solista'],
  ['split', 'dividir', 'cortar', 'partir'],
  ['merge', 'unir', 'combinar', 'fusionar'],
  ['marker', 'marcador', 'marca'],
  ['loop', 'bucle', 'ciclo'],
  ['zoom', 'acercar', 'alejar', 'ampliar'],
  ['select', 'seleccionar', 'seleccion', 'selection'],
  ['note', 'notes', 'nota', 'notas'],
  ['event', 'events', 'evento', 'eventos', 'clip', 'region', 'parte'],
  ['insert', 'insertar', 'agregar', 'anadir', 'add'],
  ['export', 'exportar', 'render', 'renderizar', 'mixdown', 'bounce'],
  ['record', 'grabar', 'grabacion'],
  ['play', 'start', 'reproducir', 'iniciar', 'tocar'],
  ['stop', 'parar', 'detener'],
  ['undo', 'deshacer'],
  ['redo', 'rehacer'],
  ['save', 'guardar'],
  ['open', 'abrir'],
  ['console', 'mezclador', 'mixer', 'consola'],
  ['tempo', 'bpm', 'velocidad del tema'],
  ['random', 'randomize', 'aleatorio', 'aleatorizar'],
  ['reverse', 'invertir', 'revertir', 'mirror', 'espejo'],
  ['color', 'colour', 'colorear'],
  ['rename', 'renombrar', 'nombre'],
  ['fade', 'fundido'],
  ['normalize', 'normalizar'],
  ['chord', 'acorde', 'acordes', 'chords', 'armonia', 'harmony'],
  ['scale', 'escala'],
];

// word -> array of other single-word members of every group containing it
export const SYNONYMS = {};
for (const group of SYNONYM_GROUPS) {
  const words = group.filter((w) => !w.includes(' '));
  for (const w of words) {
    const set = new Set(SYNONYMS[w] ?? []);
    for (const o of words) if (o !== w) set.add(o);
    SYNONYMS[w] = [...set];
  }
}

export function synonyms(token) {
  return Object.hasOwn(SYNONYMS, token) ? SYNONYMS[token] : [];
}
