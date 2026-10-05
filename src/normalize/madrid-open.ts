/**
 * Normalizador: agenda cultural de Madrid (CSV datos abiertos) → canónico.
 *
 * Fortalezas respecto a BCN (lo que aporta Madrid al catálogo):
 *   · LATITUD/LONGITUD directas del Ayuntamiento (no hay que estimar);
 *   · HORA de inicio real → `live_now` preciso (BCN no trae hora);
 *   · GRATUITO explícito → `priceFrom = 0`, el feed de «gratis» por fin
 *     tiene dato municipal verificado (144 de 147 filas musicales);
 *   · NOMBRE-INSTALACION con nombre de sala (BCN solo da dirección).
 *
 * Lo que NO trae: imágenes, precio cuando GRATUITO=0 (queda null →
 * «consultar»), ni estado de cancelación (se asume activo).
 *
 * Id estable: `ID-EVENTO` (con el espacio inicial del header ya retirado por
 * `toRecords`, que hace `trim()` a la cabecera).
 */

import { mapGenre } from '../genre.ts';
import { genreFromTitle } from './bcn-genre.ts';
import { zonedLocalToUtc } from './tz.ts';
import { deterministicUuid } from '../utils/uuid.ts';
import type {
  CanonicalEvent,
  CanonicalOccurrence,
  CanonicalVenue,
  Normalizer,
} from '../types.ts';

const DEFAULT_DURATION_HOURS = 3;
const MAX_DESCRIPTION_LENGTH = 400;
const TIMEZONE = 'Europe/Madrid';
const CITY = 'Madrid';

function cleanDescription(value: string): string | null {
  const cleaned = value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_DESCRIPTION_LENGTH
    ? `${cleaned.slice(0, MAX_DESCRIPTION_LENGTH)}…`
    : cleaned;
}

function asNumber(value: string | undefined): number | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  // El CSV usa coma decimal ("2,6").
  const parsed = Number(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Dirección completa: `CLASE-VIAL + NOMBRE-VIA + NUM` (p. ej.
 * "CALLE CONDE DUQUE 9"). Si no, el nombre de la instalación.
 */
export function venueAddressFromRow(row: Record<string, string>): string {
  const road = (row['CLASE-VIAL-INSTALACION'] ?? '').trim();
  const name = (row['NOMBRE-VIA-INSTALACION'] ?? '').trim();
  const num = (row['NUM-INSTALACION'] ?? '').trim();
  const line = [road, name].filter(Boolean).join(' ').trim();
  if (!line) return (row['NOMBRE-INSTALACION'] ?? '').trim();
  return num ? `${line} ${num}` : line;
}

/** Nombre de sala: instalación si la trae; si no, la dirección (patrón BCN). */
export function venueLabelFromRow(row: Record<string, string>): string {
  const installation = (row['NOMBRE-INSTALACION'] ?? '').trim();
  return installation || venueAddressFromRow(row) || 'Espacio municipal';
}

/** Clave estable de sala: misma instalación+dirección ⇒ mismo venue_id. */
export async function venueSourceId(row: Record<string, string>): Promise<string> {
  const key = [
    (row['NOMBRE-INSTALACION'] ?? '').trim(),
    venueAddressFromRow(row),
    (row['CODIGO-POSTAL-INSTALACION'] ?? '').trim(),
  ].join('|');
  return deterministicUuid(['madrid_open', 'venue', key]);
}

/**
 * Género: la taxonomía municipal SÍ viaja en `TIPO`
 * ("/contenido/actividades/Musica/JazzSoulFunkySwingReagge"), a diferencia
 * del CSV de BCN. Fallback: reglas por título (bcn-genre, reutilizadas).
 */
export function genreFromRow(title: string, tipo: string): CanonicalEvent['genre'] {
  const parts = tipo.split('/').filter(Boolean);
  const musicIndex = parts.findIndex((p) => /musica/i.test(p));
  if (musicIndex !== -1) {
    const providerGenre = parts[musicIndex];
    const providerSubgenre = parts[musicIndex + 1] ?? null;
    const mapped = mapGenre(providerGenre, providerSubgenre);
    if (mapped) return mapped;
  }
  // Mismo orden que el normalizador de BCN: palabras clave del título y
  // después la tabla de títulos municipales.
  return mapGenre(title, null) ?? genreFromTitle(title);
}

export class MadridOpenNormalizer implements Normalizer<Record<string, string>> {
  async toCanonical(
    value: Record<string, string>
  ): Promise<CanonicalEvent | null> {
    if (!value || typeof value !== 'object') return null;

    const id = (value['ID-EVENTO'] ?? '').trim();
    const title = (value['TITULO'] ?? '').trim();
    if (!id || !title) return null;

    const lat = asNumber(value['LATITUD']);
    const lng = asNumber(value['LONGITUD']);
    // Sin coordenadas el feed (Haversine) no lo puede mostrar nunca.
    if (lat === null || lng === null) return null;

    // FECHA aporta el día ("2026-10-25 00:00:00.0") y HORA la hora local
    // ("19:00"). Sin HORA cae a mediodía: preferible a 00:00 (marcaría
    // "en directo" a medianoche en la ventana de arranque de -2h).
    const fecha = (value['FECHA'] ?? '').trim();
    const localDate = fecha.slice(0, 10);
    const hora = (value['HORA'] ?? '').trim() || '12:00';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return null;

    const startsAt = zonedLocalToUtc(localDate, hora, TIMEZONE);
    if (!startsAt) return null;
    const endsAt = new Date(
      new Date(startsAt).getTime() + DEFAULT_DURATION_HOURS * 3_600_000
    ).toISOString();

    const address = venueAddressFromRow(value);
    const venueName = venueLabelFromRow(value);
    if (!venueName) return null;
    const externalUrl =
      urlIfPresent(value['URL-ACTIVIDAD']) ??
      urlIfPresent(value['CONTENT-URL']) ??
      urlIfPresent(value['URL-INSTALACION']);

    const venue: CanonicalVenue = {
      source: 'madrid_open',
      sourceVenueId: await venueSourceId(value),
      name: venueName,
      lat,
      lng,
      address: address || null,
      city: CITY,
      noiseLevel: null,
      timezone: TIMEZONE,
      externalUrl,
    };

    // Precio: GRATUITO=1 → 0 (dato explícito, el filtro «gratis» lo usa);
    // con importe → número; sin nada → null («consultar», nunca «gratis»).
    const isFree = (value['GRATUITO'] ?? '').trim() === '1';
    const priceRaw = asNumber(value['PRECIO']);
    const priceFrom = isFree ? 0 : priceRaw;

    const tipo = (value['TIPO'] ?? '').trim();
    const recurrence =
      (value['LARGA-DURACION'] ?? '').trim() === '1'
        ? {
            daysOfWeek: (value['DIAS-SEMANA'] ?? '').trim() || null,
            until: (value['FECHA-FIN'] ?? '').trim().slice(0, 10) || null,
          }
        : null;

    const occurrence: CanonicalOccurrence = {
      sourceInstanceId: id,
      startsAt,
      endsAt,
    };

    return {
      source: 'madrid_open',
      sourceEventId: id,
      title,
      genre: genreFromRow(title, tipo),
      priceFrom,
      priceTo: priceFrom,
      description: cleanDescription(value['DESCRIPCION'] ?? ''),
      externalUrl,
      images: [],
      isActive: true,
      metadata: {
        providerName: 'Agenda cultural de Madrid (datos abiertos)',
        providerTipo: tipo || null,
        free: isFree,
        district: (value['DISTRITO-INSTALACION'] ?? '').trim() || null,
        neighborhood: (value['BARRIO-INSTALACION'] ?? '').trim() || null,
        audience: (value['AUDIENCIA'] ?? '').trim() || null,
        recurrence,
        activityUrl: urlIfPresent(value['URL-ACTIVIDAD']),
      },
      venue,
      occurrences: [occurrence],
    };
  }
}

function urlIfPresent(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}
