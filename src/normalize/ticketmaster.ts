/**
 * Normalizador Ticketmaster: payload Discovery API v2 → modelo canónico.
 *
 * Sin dependencias de red: recibe un objeto de evento crudo y devuelve un
 * `CanonicalEvent` (o null si no es normalizable: sin fecha, sin venue o
 * venue sin coordenadas). Todos los accesos son defensivos.
 */

import { mapGenre } from '../genre.ts';
import type {
  CanonicalEvent,
  CanonicalOccurrence,
  CanonicalVenue,
  Normalizer,
} from '../types.ts';

const DEFAULT_DURATION_HOURS = 3;
const MAX_IMAGES = 5;
const MAX_DESCRIPTION_LENGTH = 600;
const PREFERRED_IMAGE_RATIOS = ['3_2', '16_9', '4_3'];

type JsonRecord = Record<string, unknown>;

function asRecord(v: unknown): JsonRecord | null {
  return typeof v === 'object' && v !== null ? (v as JsonRecord) : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Label "GMT+02:00|GMT-05:00" de Intl → minutos de offset. */
function parseOffsetMinutes(label: string): number {
  const m = /([+-])(\d{2}):?(\d{2})/.exec(label);
  if (!m) return 0;
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function offsetLabelForZone(timezone: string, at: Date): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    const part = fmt.formatToParts(at).find((p) => p.type === 'timeZoneName');
    return part?.value ?? 'GMT+00:00';
  } catch {
    return 'GMT+00:00';
  }
}

function hourValid(h: number): boolean {
  return Number.isFinite(h) && h >= 0 && h <= 23;
}
function minuteValid(m: number): boolean {
  return Number.isFinite(m) && m >= 0 && m <= 59;
}

/** Convierte fecha/hora local + timezone del evento a ISO UTC. */
function zonedLocalToUtc(
  localDate: string,
  localTime: string,
  timezone: string | null
): string | null {
  const [y, mo, d] = localDate.split('-').map(Number);
  const [hh, mm] = (localTime || '00:00:00').split(':').map(Number);
  if (![y, mo, d].every(Number.isFinite) || !hourValid(hh) || !minuteValid(mm)) {
    return null;
  }
  // Primera aproximación: interpretar la hora local como UTC para obtener offset.
  const guess = new Date(Date.UTC(y, mo - 1, d, hh, mm));
  const offset = timezone
    ? parseOffsetMinutes(offsetLabelForZone(timezone, guess))
    : 0;
  const utc = new Date(guess.getTime() - offset * 60_000);
  return Number.isNaN(utc.getTime()) ? null : utc.toISOString();
}

function toUtcIso(v: unknown): string | null {
  const s = asString(v);
  if (!s) return null;
  const date = new Date(s);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pickPrimaryClassification(classifications: unknown): JsonRecord | null {
  if (!Array.isArray(classifications)) return null;
  for (const item of classifications) {
    const rec = asRecord(item);
    if (rec && rec.primary === true) return rec;
  }
  return asRecord(classifications[0]);
}

function extractImageUrls(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  const seen = new Set<string>();
  const preferred: string[] = [];
  const rest: string[] = [];

  for (const img of images) {
    const rec = asRecord(img);
    const url = asString(rec?.url);
    const ratio = asString(rec?.ratio);
    if (!url || !/^https:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    if (ratio && PREFERRED_IMAGE_RATIOS.includes(ratio)) {
      preferred.push(url);
    } else {
      rest.push(url);
    }
  }

  return [...preferred, ...rest].slice(0, MAX_IMAGES);
}

function extractAddress(venue: JsonRecord): string | null {
  const addr = asRecord(venue['address']);
  const line1 = asString(addr?.['line1']);
  if (!line1) return null;
  const line2 = asString(addr?.['line2']);
  return line2 ? `${line1}, ${line2}` : line1;
}

function cleanDescription(raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_DESCRIPTION_LENGTH
    ? `${cleaned.slice(0, MAX_DESCRIPTION_LENGTH)}…`
    : cleaned;
}

/** Cancelados/aparcados no son visibles para los usuarios. */
function isEventActive(raw: JsonRecord): boolean {
  const dates = asRecord(raw['dates']);
  const status = asRecord(dates?.['status']);
  const code = asString(status?.['code']) ?? '';
  return !['canceled', 'cancelled', 'postponed'].includes(code);
}

// Re-export para tests.
export const ticketmasterNormalizerUtil = { zonedLocalToUtc, parseOffsetMinutes };
export class TicketmasterNormalizer implements Normalizer<unknown> {
  toCanonical(value: unknown): CanonicalEvent | null {
    const raw = asRecord(value);
    if (!raw) return null;

    const id = asString(raw['id']);
    const name = asString(raw['name']);
    if (!id || !name) return null;

    const embedded = asRecord(raw['_embedded']);
    const venueArray = Array.isArray(embedded?.['venues'])
      ? (embedded['venues'] as unknown[])
      : [];
    const venue = asRecord(venueArray[0]);
    if (!venue) return null;

    const loc = asRecord(venue['location']);
    const lat = asNumber(loc?.['latitude']);
    const lng = asNumber(loc?.['longitude']);
    if (lat === null || lng === null) return null;

    const dates = asRecord(raw['dates']);
    if (!dates) return null;
    const start = asRecord(dates?.['start']);
    if (!start) return null;

    const timezone = asString(dates?.['timezone']);
    const dateTime = asString(start['dateTime']);
    const localDate = asString(start['localDate']);
    const localTime = asString(start['localTime']);
    const startsAt =
      toUtcIso(dateTime) ??
      (localDate
        ? zonedLocalToUtc(localDate, localTime ?? '00:00:00', timezone)
        : null);
    if (!startsAt) return null;

    const ends = asRecord(dates['end']);
    const endsAt =
      toUtcIso(ends?.['dateTime']) ??
      new Date(
        new Date(startsAt).getTime() + DEFAULT_DURATION_HOURS * 3_600_000
      ).toISOString();

    // Género
    const classification = pickPrimaryClassification(raw['classifications']);
    const genreName = asString(asRecord(classification?.['genre'])?.['name']);
    const subGenreName = asString(asRecord(classification?.['subGenre'])?.['name']);
    const genre = mapGenre(genreName, subGenreName);

    // Precios (primero rangos "standard"; fallback a cualquiera)
    const priceRanges = Array.isArray(raw['priceRanges'])
      ? (raw['priceRanges'] as unknown[])
      : [];
    const typedRanges = priceRanges
      .map((r) => asRecord(r))
      .filter((r): r is JsonRecord => r !== null)
      .map((r) => ({
        type: asString(r['type']),
        min: asNumber(r['min']),
        max: asNumber(r['max']),
        currency: asString(r['currency']),
      }))
      .filter((r) => r.min !== null || r.max !== null);

    const standard = typedRanges.filter((r) => r.type === 'standard');
    const effective = standard.length > 0 ? standard : typedRanges;

    const mins = effective
      .map((r) => r.min)
      .filter((v): v is number => v !== null);
    const maxes = effective
      .map((r) => r.max)
      .filter((v): v is number => v !== null);

    const priceFrom = mins.length > 0
      ? Math.round(Math.min(...mins) * 100) / 100
      : null;
    const priceTo = maxes.length > 0
      ? Math.round(Math.max(...maxes) * 100) / 100
      : null;

    const cityRec = asRecord(venue['city']);

    const venueCanonical: CanonicalVenue = {
      source: 'ticketmaster',
      // El venue de TM tiene id propio; fallback al id del evento.
      sourceVenueId: asString(venue['id']) ?? id,
      name: asString(venue['name']) ?? '',
      lat,
      lng,
      address: extractAddress(venue),
      city: asString(cityRec?.['name']),
      noiseLevel: null,
      timezone,
      externalUrl: asString(venue['url']),
    };

    if (!venueCanonical.name) return null;

    const sourceInstanceId = localDate ? `${id}_${localDate}` : id;
    const occurrence: CanonicalOccurrence = {
      sourceInstanceId,
      startsAt,
      endsAt,
    };

    const info = asString(raw['info']);
    const pleaseNote = asString(raw['pleaseNote']);
    const description = cleanDescription(
      [info, pleaseNote].filter(Boolean).join('\n')
    );

    const metadata: Record<string, unknown> = {
      providerGenre: genreName,
      providerSubGenre: subGenreName,
      providerStatus: asString(asRecord(dates['status'])?.['code']),
      currency: typedRanges[0]?.currency ?? null,
    };

    return {
      source: 'ticketmaster',
      sourceEventId: id,
      title: name,
      genre,
      priceFrom,
      priceTo,
      description,
      externalUrl: asString(raw['url']),
      images: extractImageUrls(raw['images']),
      isActive: isEventActive(raw),
      metadata,
      venue: venueCanonical,
      occurrences: [occurrence],
    };
  }
}