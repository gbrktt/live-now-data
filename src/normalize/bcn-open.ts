/**
 * Normalizador: agenda cultural de Barcelona (CSV de datos abiertos) → canónico.
 *
 * Lo que el CSV NO trae y aquí se resuelve:
 *   · nombre de sala → se compone con la dirección (`institution_name` viene
 *     vacío). Menos bonito que "Sala Razzmatazz 3", pero geolocalizado y honesto.
 *   · precio → null. La app lo muestra como «consultar», nunca como «gratis»
 *     (el CSV solo dice si hay inscripción, sin importe).
 *   · imágenes → ninguna. La tarjeta cae al placeholder que ya tiene.
 *   · estado suspendido/aplazado → no viene en el CSV; se marca activo.
 *
 * Id estable: `register_id` (con el BOM ya-retirado por el parser del CSV).
 */

import { mapGenre } from '../genre.ts';
import { genreFromTitle } from './bcn-genre.ts';
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

/** Quita el HTML del `timetable` y lo aplana a texto legible. */
function timetableToText(html: string | undefined): string {
  if (!html) return '';
  const text = html
    .replace(/<br\s*\/?>/gi, ' · ')
    .replace(/<\/(td|th|tr|div|p)>/gi, ' · ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[·\s]+/g, ' ')
    .trim();
  return text;
}

function cleanDescription(value: string): string | null {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_DESCRIPTION_LENGTH
    ? `${cleaned.slice(0, MAX_DESCRIPTION_LENGTH)}…`
    : cleaned;
}

function asNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Nombre de sala a partir de la dirección. El CSV no da el nombre del
 * espacio, pero sí calle, número, barrio y distrito.
 */
export function venueLabelFromAddress(row: Record<string, string>): string {
  const road = (row['addresses_road_name'] ?? '').trim();
  const number = (row['addresses_start_street_number'] ?? '').trim();
  const district = (row['addresses_district_name'] ?? '').trim();
  if (road) {
    return number ? `${road}, ${number}` : road;
  }
  if (district) return district;
  return (row['addresses_town'] ?? '').trim() || 'Espai municipal';
}

/** Clave estable de sala: misma dirección ⇒ mismo venue_id. */
export async function venueSourceId(row: Record<string, string>): Promise<string> {
  const key = [
    (row['addresses_road_id'] ?? '').trim(),
    (row['addresses_start_street_number'] ?? '').trim(),
    (row['addresses_zip_code'] ?? '').trim(),
    venueLabelFromAddress(row),
  ].join('|');
  return deterministicUuid(['bcn_open', 'address', key]);
}

export class BcnOpenNormalizer implements Normalizer<Record<string, string>> {
  async toCanonical(
    value: Record<string, string>
  ): Promise<CanonicalEvent | null> {
    if (!value || typeof value !== 'object') return null;

    const registerId = (value['register_id'] ?? '').trim();
    const title = (value['name'] ?? '').trim();
    if (!registerId || !title) return null;

    const lat = asNumber(value['geo_epgs_4326_lat']);
    const lng = asNumber(value['geo_epgs_4326_lon']);
    // Sin coordenadas el feed (Haversine) no lo puede mostrar nunca.
    if (lat === null || lng === null) return null;

    const startsAt = new Date(value['start_date'] ?? '');
    if (Number.isNaN(startsAt.getTime())) return null;
    const parsedEnd = new Date(value['end_date'] ?? '');
    const endsAt = Number.isNaN(parsedEnd.getTime()) || parsedEnd <= startsAt
      ? new Date(startsAt.getTime() + DEFAULT_DURATION_HOURS * 3_600_000)
      : parsedEnd;

    const district = (value['addresses_district_name'] ?? '').trim();
    const town = (value['addresses_town'] ?? '').trim() || 'Barcelona';
    const addressLine = venueLabelFromAddress(value);

    const venue: CanonicalVenue = {
      source: 'bcn_open',
      sourceVenueId: await venueSourceId(value),
      name: addressLine,
      lat,
      lng,
      address: addressLine,
      city: town,
      noiseLevel: null,
      timezone: TIMEZONE,
      // El CSV no trae la URL del evento; sí la de inscripción/entradas, que
      // es el equivalente útil ("Entradas" en el detalle).
      externalUrl: urlIfPresent(value['values_value']),
    };

    // Género: primero el título (que a veces sí lo delata), después la tabla
    // de taxonomía municipal embebida (src/normalize/bcn-genre.ts). El CSV no
    // trae las categorías, así que sin esto el 95 % quedaba en null.
    const genre = mapGenre(title, null) ?? genreFromTitle(title);

    const description = cleanDescription(
      timetableToText(value['timetable'])
    );

    const occurrence: CanonicalOccurrence = {
      sourceInstanceId: registerId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    };

    return {
      source: 'bcn_open',
      sourceEventId: registerId,
      title,
      genre,
      priceFrom: null,
      priceTo: null,
      description,
      externalUrl: venue.externalUrl,
      images: [],
      isActive: true,
      metadata: {
        providerName: 'Agenda Cultural de Barcelona (datos abiertos)',
        district: district || null,
        valueLabel: value['values_attribute_name'] ?? null,
        sourceModified: value['modified'] ?? null,
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
