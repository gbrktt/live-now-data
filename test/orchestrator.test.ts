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