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

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface BuildScopesOptions {
  cities: CityScopeConfig[];
  from: Date;
  to: Date;
  windowDays: number;
  source: SourceCode;
  countryCode: string;
}

export function buildScopes(opts: BuildScopesOptions): IngestScope[] {
  const { from, to, windowDays, source, countryCode } = opts;
  const scopes: IngestScope[] = [];

  for (const city of opts.cities) {
    let cursor = new Date(from);
    while (cursor.getTime() < to.getTime()) {
      const endMs = Math.min(
        cursor.getTime() + windowDays * 86_400_000,
        to.getTime()
      );
      const end = new Date(endMs);
      scopes.push({
        key: `${city.city}-${isoDay(cursor)}--${isoDay(end)}`,
        source,
        params: {
          city: city.city,
          latlong: city.latlong,
          radius: String(city.radiusKm),
          unit: 'km',
          countryCode,
          startDateTime: cursor.toISOString(),
          endDateTime: end.toISOString(),
        },
      });
      cursor = end;
    }
  }

  return scopes;
}