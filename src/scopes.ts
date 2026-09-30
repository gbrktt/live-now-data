/**
 * Particionado del catálogo en scopes de barrido: ciudad × ventana temporal.
 *
 * Un scope es una consulta acotada y re-ejecutable (clave determinista).
 * Esta partición mantiene cada consulta por debajo del deep-paging limit
 * de Ticketmaster (size × page < 1000) y permite barridos incrementales
 * por frequencia (T1/T2/T3 con ventanas distintas).
 */

import type { IngestScope, SourceCode } from './types.ts';

export interface CityScopeConfig {
  city: string;
  /** `lat,lng` usado por Ticketmaster para el filtro geo. */
  latlong: string;
  radiusKm: number;
}

/** Ciudades iniciales de España (configurables vía env CITIES). */
export const DEFAULT_CITIES: readonly CityScopeConfig[] = [
  { city: 'Madrid', latlong: '40.4168,-3.7038', radiusKm: 50 },
  { city: 'Barcelona', latlong: '41.3874,2.1686', radiusKm: 50 },
  { city: 'Valencia', latlong: '39.4699,-0.3763', radiusKm: 40 },
  { city: 'Sevilla', latlong: '37.3891,-5.9845', radiusKm: 40 },
  { city: 'Bilbao', latlong: '43.2630,-2.9350', radiusKm: 35 },
];

/**
 * Parsea la env CITIES: ciudades separadas por `;`, cada una con formato
 * `nombre|lat,lng|radioKm` (las coordenadas ya contienen comas).
 * Ejemplo: `madrid|40.4168,-3.7038|50;barcelona|41.3874,2.1686|50`
 */
export function parseCities(raw: string | undefined): CityScopeConfig[] {
  if (!raw || raw.trim() === '') {
    return [...DEFAULT_CITIES];
  }
  return raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [city, latlong, radius] = entry.split('|');
      const [lat, lng] = (latlong ?? '').split(',');
      const latNum = Number(lat);
      const lngNum = Number(lng);
      const radiusKm = Number(radius);
      if (!city || !Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
        throw new Error(
          `CITIES inválido: "${entry}". Formato esperado: nombre|lat,lon|radio`
        );
      }
      return {
        city,
        latlong: `${latNum},${lngNum}`,
        radiusKm: Number.isFinite(radiusKm) && radiusKm > 0 ? radiusKm : 50,
      };
    });
}

/**
 * Parsea la env `SCOPE_MODE`. Vacío o inválido → `undefined`, que deja que cada
 * tier aplique su modo por defecto (T1 ciudad, T2/T3 país).
 */
export function parseScopeMode(raw: string | undefined): ScopeMode | undefined {
  const value = raw?.trim().toLowerCase();
  return value === 'city' || value === 'country' || value === 'hybrid'
    ? value
    : undefined;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Modo de particionado del barrido.
 *
 * · `city`    — un scope por ciudad × ventana (fresco, radio acotado).
 * · `country` — un scope por ventana de todo el país, sin geo (cobertura).
 * · `hybrid`  — ambos a la vez (diagnóstico / backfill puntual).
 */
export type ScopeMode = 'city' | 'country' | 'hybrid';

export interface BuildScopesOptions {
  cities: CityScopeConfig[];
  from: Date;
  to: Date;
  windowDays: number;
  source: SourceCode;
  countryCode: string;
  /** Default `city`: preserva el comportamiento previo sin tocar llamadores. */
  scopeMode?: ScopeMode;
}

/** Ventanas `[inicio, fin)` consecutivas de `windowDays` días hasta `to`. */
function buildWindows(
  from: Date,
  to: Date,
  windowDays: number
): Array<{ start: Date; end: Date }> {
  const windows: Array<{ start: Date; end: Date }> = [];
  let cursor = new Date(from);
  while (cursor.getTime() < to.getTime()) {
    const end = new Date(
      Math.min(cursor.getTime() + windowDays * 86_400_000, to.getTime())
    );
    windows.push({ start: cursor, end });
    cursor = end;
  }
  return windows;
}

export function buildScopes(opts: BuildScopesOptions): IngestScope[] {
  const { from, to, windowDays, source, countryCode } = opts;
  const mode: ScopeMode = opts.scopeMode ?? 'city';
  const scopes: IngestScope[] = [];

  // Barrido por país: sin `latlong`/`radius` y con `countryCode` como único
  // filtro geográfico. Medido 2026-09-30: 353 eventos ES en 63 días (frente a
  // 86 capturados con el barrido por ciudad) y los eventos traen coordenadas
  // en `_embedded.venues`, así que el feed no los descarta.
  if (mode === 'country' || mode === 'hybrid') {
    for (const { start, end } of buildWindows(from, to, windowDays)) {
      scopes.push({
        key: `${countryCode}-${isoDay(start)}--${isoDay(end)}`,
        source,
        params: {
          countryCode,
          startDateTime: start.toISOString(),
          endDateTime: end.toISOString(),
        },
      });
    }
  }

  if (mode === 'city' || mode === 'hybrid') {
    for (const city of opts.cities) {
      for (const { start, end } of buildWindows(from, to, windowDays)) {
        scopes.push({
          key: `${city.city}-${isoDay(start)}--${isoDay(end)}`,
          source,
          params: {
            city: city.city,
            latlong: city.latlong,
            radius: String(city.radiusKm),
            unit: 'km',
            countryCode,
            startDateTime: start.toISOString(),
            endDateTime: end.toISOString(),
          },
        });
      }
    }
  }

  return scopes;
}