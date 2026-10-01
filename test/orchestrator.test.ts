import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runIngest } from '../src/orchestrator.ts';
import type {
  EventSourceAdapter,
  IngestWriter,
  Normalizer,
} from '../src/types.ts';

const stubAdapter: EventSourceAdapter = {
  source: 'ticketmaster',
  fetchScopeBatch: async (scope) => ({
    events: [],
    pageNumber: 0,
    totalPages: 1,
    totalElements: 0,
  }),
};

const stubNormalizer: Normalizer<unknown> = {
  toCanonical: () => null,
};

const stubWriter: IngestWriter = {
  dryRun: true,
  upsertVenue: async () => null,
  upsertEventWithInstances: async () => ({
    eventId: 'aaaaaaaa-0000-5000-8000-000000000000',
    eventsUpserted: 0,
    instancesUpserted: 0,
  }),
};

describe('orquestador: fases y orden', () => {
  /** Stub que registra el orden de las llamadas, para fijar el contrato. */
  function recordingWriter(log: string[]): IngestWriter {
    return {
      dryRun: true,
      upsertVenue: async () => 'aaaaaaaa-0000-5000-8000-000000000000',
      upsertEventWithInstances: async () => ({
        eventId: 'aaaaaaaa-0000-5000-8000-000000000000',
        eventsUpserted: 1,
        instancesUpserted: 1,
      }),
      flush: async () => {
        log.push('flush');
      },
      retireStale: async (source, seen) => {
        log.push(`retireStale:${source}:${seen.length}`);
        return { retiredMissing: 0, retiredFinished: 0 };
      },
      reconcileDuplicates: async () => {
        log.push('reconcile');
        return { aliases: 0, hidden: 0, reviewOnly: 0 };
      },
    };
  }

  const adapter: EventSourceAdapter = {
    source: 'ticketmaster',
    fetchScopeBatch: async () => ({
      events: [
        {
          id: 'E1',
          name: 'Concierto',
          _embedded: { venues: [{ id: 'V1', name: 'Sala', location: { latitude: 40.4, longitude: -3.7 } }] },
          dates: { start: { localDate: '2026-10-05', localTime: '20:00:00', timezone: 'Europe/Madrid' } },
          classifications: [],
        },
      ],
      pageNumber: 0,
      totalPages: 1,
      totalElements: 1,
    }),
  };

  const normalizer: Normalizer<unknown> = {
    toCanonical: () => ({
      source: 'ticketmaster' as const,
      sourceEventId: 'E1',
      title: 'Concierto',
      genre: 'pop' as const,
      priceFrom: null,
      priceTo: null,
      description: null,
      externalUrl: null,
      images: [],
      isActive: true,
      metadata: null,
      venue: {
        source: 'ticketmaster' as const,
        sourceVenueId: 'V1',
        name: 'Sala',
        lat: 40.4,
        lng: -3.7,
        address: null,
        city: null,
        noiseLevel: null,
        timezone: null,
        externalUrl: null,
      },
      occurrences: [
        { sourceInstanceId: 'E1', startsAt: '2026-10-05T18:00:00.000Z', endsAt: '2026-10-05T21:00:00.000Z' },
      ],
    }),
  };

  it('vuelca lotes -> higiene -> dedupe, en ese orden', async () => {
    const log: string[] = [];
    const result = await runIngest({
      source: 'ticketmaster',
      adapter,
      normalizer,
      writer: recordingWriter(log),
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-10T00:00:00Z'),
      cities: [{ city: 'Madrid', latlong: '40.41,-3.70', radiusKm: 50 }],
      windowDays: 10,
    });

    assert.equal(result.status, 'success');
    // El orden importa: si `retireStale` corriera antes de `flush`, retiraría
    // los eventos que la propia corrida acaba de escribir.
    assert.deepEqual(log, ['flush', 'retireStale:ticketmaster:1', 'reconcile']);
  });

  it('el dedupe no aborta la ingesta si la higiene falla', async () => {
    const log: string[] = [];
    const writer: IngestWriter = {
      ...recordingWriter(log),
      retireStale: async () => {
        throw new Error('boom');
      },
    };
    const result = await runIngest({
      source: 'ticketmaster',
      adapter,
      normalizer,
      writer,
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-10T00:00:00Z'),
      cities: [{ city: 'Madrid', latlong: '40.41,-3.70', radiusKm: 50 }],
      windowDays: 10,
    });
    assert.equal(result.status, 'success', 'un fallo de higiene no debe fallar la corrida');
    assert.ok(log.includes('reconcile'), 'el dedupe sigue ejecutándose');
  });
});

describe('runIngest maxScopes', () => {
  it('limita los scopes procesados cuando maxScopes > 0', async () => {
    const seen: string[] = [];
    const result = await runIngest({
      source: 'ticketmaster',
      adapter: stubAdapter,
      normalizer: stubNormalizer,
      writer: stubWriter,
      from: new Date('2026-09-14T00:00:00Z'),
      to: new Date('2026-10-24T00:00:00Z'),
      cities: [{ city: 'Madrid', latlong: '40.41,-3.70', radiusKm: 50 }],
      windowDays: 10,
      maxScopes: 1,
      onPage: (scope) => {
        seen.push(scope.key);
      },
    });
    assert.equal(result.scopesProcessed, 1);
    assert.equal(seen.length, 1);
    assert.equal(result.lastScope, seen[0]);
  });

  it('sin maxScopes procesa todo el rango (comportamiento intacto)', async () => {
    const result = await runIngest({
      source: 'ticketmaster',
      adapter: stubAdapter,
      normalizer: stubNormalizer,
      writer: stubWriter,
      from: new Date('2026-09-14T00:00:00Z'),
      to: new Date('2026-10-24T00:00:00Z'),
      cities: [{ city: 'Madrid', latlong: '40.41,-3.70', radiusKm: 50 }],
      windowDays: 10,
    });
    assert.equal(result.scopesProcessed, 4);
  });
});