/**
 * Taxonomía de géneros: nombres de la fuente → género canónico de la app.
 *
 * La app expone 5 géneros (jazz, rock, indie, electronic, pop). Ticketmaster
 * usa una taxonomía amplia por `classifications[].genre.name` / `subGenre.name`.
 * Prioridad: coincidencia exacta (subgénero → género) → reglas por keyword.
 * Si no hay coincidencia → null (la app ya trata genre=null sin romper nada)
 * y se registra en `genre_mappings` para mapeado posterior sin cambiar código.
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
  [/pop|country|folk|latin|reggaeton|urbano|tropical/i, 'pop'],
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
export function mapGenre(
  genreName: string | null | undefined,
  subGenreName: string | null | undefined
): AppGenre | null {
  for (const name of [subGenreName, genreName]) {
    if (!name) continue;
    const exact = EXACT[normalizeName(name)];
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