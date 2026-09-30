/**
 * Taxonomía de géneros: nombres de la fuente → género canónico de la app.
 *
 * La app expone 5 géneros (jazz, rock, indie, electronic, pop). Ticketmaster
 * usa una taxonomía amplia por `classifications[].genre.name` / `subGenre.name`.
 * Prioridad: coincidencia exacta (subgénero específico → género declarado) →
 * reglas por keyword. Un subgénero demasiado amplio (`pop`) cede ante el
 * género. Si no hay coincidencia → null (la app ya trata genre=null sin
 * romper nada) y el writer registra el par en `genre_mappings` con
 * `app_genre=null` para poder mapearlo después sin cambiar código.
 */

import type { AppGenre } from './types.ts';

const APP_GENRES: readonly AppGenre[] = [
  'jazz',
  'rock',
  'indie',
  'electronic',
  'pop',
];

/** Mapa exacto por nombre normalizado (ver normalizeName). */
const EXACT: Record<string, AppGenre> = {
  rock: 'rock',
  'rock roll': 'rock',
  'hard rock': 'rock',
  'classic rock': 'rock',
  'psychedelic rock': 'rock',
  'garage rock': 'rock',
  'progressive rock': 'rock',
  'southern rock': 'rock',
  metal: 'rock',
  'heavy metal': 'rock',
  punk: 'rock',
  'punk rock': 'rock',
  grunge: 'rock',
  rockabilly: 'rock',
  alternative: 'indie',
  'indie alternative': 'indie',
  'alternative rock': 'indie',
  indie: 'indie',
  'indie rock': 'indie',
  'dream pop': 'indie',
  shoegaze: 'indie',
  'post-rock': 'indie',
  emo: 'indie',
  'indie folk': 'indie',
  jazz: 'jazz',
  'jazz blues': 'jazz',
  'vocal jazz': 'jazz',
  'smooth jazz': 'jazz',
  'acid jazz': 'jazz',
  bebop: 'jazz',
  blues: 'jazz',
  soul: 'jazz',
  funk: 'jazz',
  'r b': 'jazz',
  'rhythm blues': 'jazz',
  'latin': 'pop',
  'latin pop': 'pop',
  'reggaeton': 'pop',
  'urbano': 'pop',
  'tropical': 'pop',
  'regional mexican': 'pop',
  // Mundo y folclore. El género `World` de Ticketmaster agrupa el flamenco y
  // la música tradicional, que en la taxonomía de la app entran como `pop`
  // (mismo criterio que `latin`/`reggaeton`). Sin estas entradas, el 63 % del
  // catálogo ES de 7 días (27 de 43 eventos, `World / Flamenco`) quedaba con
  // `genre = null` y por tanto invisible al filtrar por género.
  flamenco: 'pop',
  world: 'pop',
  'world music': 'pop',
  folklorico: 'pop',
  folklore: 'pop',
  salsa: 'pop',
  merengue: 'pop',
  bachata: 'pop',
  cumbia: 'pop',
  bossanova: 'jazz',
  'bossa nova': 'jazz',
  swing: 'jazz',
  pop: 'pop',
  'indie pop': 'pop',
  'dance pop': 'pop',
  'power pop': 'pop',
  country: 'pop',
  folk: 'pop',
  'traditional pop': 'pop',
  electronic: 'electronic',
  'edm/electronic': 'electronic',
  'dance/electronic': 'electronic',
  edm: 'electronic',
  techno: 'electronic',
  house: 'electronic',
  trance: 'electronic',
  dubstep: 'electronic',
  'drum bass': 'electronic',
  electro: 'electronic',
  synthwave: 'electronic',
  'electronic rock': 'electronic',
  'big room': 'electronic',
  'deep house': 'electronic',
  'tech house': 'electronic',
};

const KEYWORD_RULES: ReadonlyArray<[RegExp, AppGenre]> = [
  [/jazz|blues|soul|funk|bebop|bossanova|bossa nova|swing/i, 'jazz'],
  [/metal|punk|grunge|rock/i, 'rock'],
  [/indie|alternative|shoegaze|dream.?pop/i, 'indie'],
  [/electronic|edm|techno|house|trance|dubstep|electro|synth/i, 'electronic'],
  [/pop|country|folk|latin|reggaeton|urbano|tropical|flamenco|world|salsa|merengue|bachata|cumbia/i, 'pop'],
];

function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .replace(/\band\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mapea género/subgénero de una fuente al género canónico de la app.
 * Devuelve null si no hay coincidencia (género desconocido).
 */
/**
 * Subgéneros demasiado amplios para decidir el género de la app.
 *
 * `Rock / Pop` (10 de los 43 eventos ES de 7 días) llegaba como `pop` y
 * hundía el catálogo: el histórico tenía el 78 % etiquetado `pop`. Cuando el
 * subgénero es uno de estos, decide el `genre` declarado por la fuente, que es
 * el dato más específico. Los subgéneros reales (`Smooth Jazz`, `Techno`,
 * `Vocal Jazz`…) conservan la prioridad sobre el género.
 */
const BROAD_SUBGENRES: ReadonlySet<string> = new Set([
  'pop',
  'other',
  'misc',
  'miscellaneous',
]);

export function mapGenre(
  genreName: string | null | undefined,
  subGenreName: string | null | undefined
): AppGenre | null {
  const genreKey = genreName ? normalizeName(genreName) : '';
  const subGenreKey = subGenreName ? normalizeName(subGenreName) : '';

  // 1) Subgénero específico  2) género declarado (gana al subgénero amplio).
  for (const key of [subGenreKey, genreKey]) {
    if (!key || BROAD_SUBGENRES.has(key)) continue;
    const exact = EXACT[key];
    if (exact) return exact;
  }

  const haystack = `${genreName ?? ''} ${subGenreName ?? ''}`;
  for (const [re, genre] of KEYWORD_RULES) {
    if (re.test(haystack)) return genre;
  }

  return null;
}

export function isKnownAppGenre(value: string): value is AppGenre {
  return (APP_GENRES as readonly string[]).includes(value);
}