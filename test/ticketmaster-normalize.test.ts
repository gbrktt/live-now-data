import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TicketmasterNormalizer,
  ticketmasterNormalizerUtil,
} from '../src/normalize/ticketmaster.ts';
import type { CanonicalEvent } from '../src/types.ts';

/** Fixture realista de la Discovery API v2 (payload acotado). */
function baseEvent(): Record<string, any> {
  return {
    id: 'vvG1ZfM2a4yQ3',
    name: 'Arctic Monkeys: Madrid 2026',
    url: 'https://www.ticketmaster.es/event/arctic-monkeys-madrid',
    dates: {
      start: {
        localDate: '2026-10-15',
        localTime: '21:00:00',
        dateTime: '2026-10-15T21:00:00+02:00',
      },
      end: {
        localDate: '2026-10-15',
        localTime: '23:30:00',
        dateTime: '2026-10-15T23:30:00+02:00',
      },
      timezone: 'Europe/Madrid',
      status: { code: 'onsale' },
    },
    info: 'Concierto de la gira europea con banda invitada.',
    pleaseNote: 'Puertas 45 minutos antes.',
    priceRanges: [
      { type: 'standard', currency: 'EUR', min: 45.0, max: 85.0 },
      { type: 'standard', currency: 'EUR', min: 120.0, max: 250.0 },
    ],
    images: [
      { url: 'https://example.com/a-3x2.jpg', ratio: '3_2', width: 1024, height: 683 },
      { url: 'https://example.com/a-16x9.jpg', ratio: '16_9', width: 1920, height: 1080 },
      { url: 'http://example.com/insegura.jpg', ratio: '16_9' },
    ],
    classifications: [
      {
        primary: false,
        segment: { name: 'Music' },
        genre: { name: 'Rock' },
        subGenre: { name: 'Arena Rock' },
      },
      {
        primary: true,
        segment: { name: 'Music' },
        genre: { name: 'Rock' },
        subGenre: { name: 'Alternative Rock' },
      },
    ],
    _embedded: {
      venues: [
        {
          id: 'KovZPA7AAEA',
          name: 'WiZink Center',
          url: 'https://www.ticketmaster.es/venue/wizink',
          timezone: 'Europe/Madrid',
          city: { name: 'Madrid' },
          address: { line1: 'Av. de los Capuchinos', line2: 's/n' },
          location: { latitude: '40.4241', longitude: '-3.6724' },
        },
      ],
    },
  };
}

function normalize(raw: Record<string, any>): CanonicalEvent | null {
  return new TicketmasterNormalizer().toCanonical(raw);
}

describe('TicketmasterNormalizer', () => {
  it('normaliza un evento completo', () => {
    const canonical = normalize(baseEvent());
    assert.ok(canonical);
    assert.equal(canonical!.title, 'Arctic Monkeys: Madrid 2026');
    // subGenre Alternative Rock → indie
    assert.equal(canonical!.genre, 'indie');
    assert.equal(canonical!.priceFrom, 45);
    assert.equal(canonical!.priceTo, 250);
    assert.equal(canonical!.venue.sourceVenueId, 'KovZPA7AAEA');
    assert.equal(canonical!.venue.name, 'WiZink Center');
    assert.equal(canonical!.venue.city, 'Madrid');
    assert.equal(canonical!.venue.address, 'Av. de los Capuchinos, s/n');
    assert.equal(canonical!.venue.lat, 40.4241);
    assert.equal(canonical!.venue.lng, -3.6724);
    // 2 urls https válidas (la http queda descartada)
    assert.equal(canonical!.images.length, 2);
    assert.ok(canonical!.images[0].includes('3x2'));
    assert.equal(canonical!.isActive, true);
    assert.equal(
      canonical!.externalUrl,
      'https://www.ticketmaster.es/event/arctic-monkeys-madrid'
    );
    assert.match(canonical!.description ?? '', /Concierto/);
    assert.equal(canonical!.occurrences.length, 1);
    assert.equal(
      canonical!.occurrences[0].sourceInstanceId,
      'vvG1ZfM2a4yQ3_2026-10-15'
    );
    assert.equal(
      canonical!.occurrences[0].startsAt,
      '2026-10-15T19:00:00.000Z'
    );
    assert.equal(
      canonical!.occurrences[0].endsAt,
      '2026-10-15T21:30:00.000Z'
    );
  });

  it('devuelve null sin coordenadas de venue', () => {
    const raw = baseEvent();
    raw._embedded.venues[0].location = { latitude: null, longitude: null };
    assert.equal(normalize(raw), null);
  });

  it('devuelve null sin venue', () => {
    const raw = baseEvent();
    delete raw._embedded.venues;
    assert.equal(normalize(raw), null);
  });

  it('devuelve null sin fecha de inicio utilizable', () => {
    const raw = baseEvent();
    delete raw.dates.start.dateTime;
    delete raw.dates.start.localDate;
    delete raw.dates.start.localTime;
    assert.equal(normalize(raw), null);
it('sintetiza fecha a partir de localDate/localTime + timezone', () => {
    const raw = baseEvent();
    delete raw.dates.start.dateTime;
    delete raw.dates.end;
    const canonical = normalize(raw);
    assert.ok(canonical);
    // 15 oct 2026 en Madrid (CEST +2) → 19:00Z
    assert.equal(
      canonical!.occurrences[0].startsAt,
      '2026-10-15T19:00:00.000Z'
    );
  });

  it('marca cancelados/postponed como inactivos', () => {
    const canceled = baseEvent();
    canceled.dates.status.code = 'canceled';
    assert.equal(normalize(canceled)!.isActive, false);

    const postponed = baseEvent();
    postponed.dates.status.code = 'postponed';
    assert.equal(normalize(postponed)!.isActive, false);

    const rescheduled = baseEvent();
    rescheduled.dates.status.code = 'rescheduled';
    assert.equal(normalize(rescheduled)!.isActive, true);
  });

  it('estima endsAt cuando la fuente no lo da', () => {
    const raw = baseEvent();
    delete raw.dates.end;
    const canonical = normalize(raw)!;
    const start = new Date(canonical.occurrences[0].startsAt).getTime();
    const end = new Date(canonical.occurrences[0].endsAt!).getTime();
    assert.equal(end - start, 3 * 3_600_000);
  });

  it('usa genre=null para desconocidos', () => {
    const raw = baseEvent();
    raw.classifications[1] = {
      primary: true,
      segment: { name: 'Music' },
      genre: { name: 'Comedy' },
      subGenre: { name: 'Stand Up' },
    };
    assert.equal(normalize(raw)!.genre, null);
  });
});

describe('ticketmasterNormalizerUtil', () => {
  it('zonedLocalToUtc: Madrid verano (CEST +2)', () => {
    const utc = ticketmasterNormalizerUtil.zonedLocalToUtc(
      '2026-07-15',
      '21:00:00',
      'Europe/Madrid'
    );
    assert.equal(utc, '2026-07-15T19:00:00.000Z');
  });

  it('zonedLocalToUtc: Madrid invierno (CET +1)', () => {
    const utc = ticketmasterNormalizerUtil.zonedLocalToUtc(
      '2026-01-15',
      '21:00:00',
      'Europe/Madrid'
    );
    assert.equal(utc, '2026-01-15T20:00:00.000Z');
  });

  it('parseOffsetMinutes', () => {
    assert.equal(
      ticketmasterNormalizerUtil.parseOffsetMinutes('GMT+02:00'),
      120
    );
    assert.equal(
      ticketmasterNormalizerUtil.parseOffsetMinutes('GMT-05:00'),
      -300
    );
    assert.equal(ticketmasterNormalizerUtil.parseOffsetMinutes('GMT'), 0);
  });
});
  });