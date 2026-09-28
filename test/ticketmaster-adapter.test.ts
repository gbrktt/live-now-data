import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TicketmasterAdapter,
  toTicketmasterDateTime,
} from '../src/adapters/ticketmaster.ts';

describe('toTicketmasterDateTime', () => {
  it('elimina los milisegundos de toISOString (formato DIS1015)', () => {
    assert.equal(
      toTicketmasterDateTime('2026-09-14T18:46:39.992Z'),
      '2026-09-14T18:46:39Z'
    );
    assert.equal(
      toTicketmasterDateTime('2026-09-14T18:46:39Z'),
      '2026-09-14T18:46:39Z'
    );
  });

  it('lanza error con fechas inválidas', () => {
    assert.throws(() => toTicketmasterDateTime('no-es-fecha'));
  });
});

describe('TicketmasterAdapter.fetchScopeBatch', () => {
  it('envía fechas sin milisegundos y omite city', async () => {
    let capturedUrl = '';
    const adapter = new TicketmasterAdapter({
      apiKey: 'test-key',
      fetchFn: (async (url: string) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            _embedded: { events: [] },
            page: { size: 200, number: 0, totalElements: 0, totalPages: 0 },
          }),
        } as unknown as Response;
      }) as typeof fetch,
    });

    await adapter.fetchScopeBatch(
      {
        key: 'madrid-test',
        source: 'ticketmaster',
        params: {
          city: 'madrid',
          countryCode: 'ES',
          latlong: '40.4168,-3.7038',
          radius: '50',
          unit: 'km',
          startDateTime: '2026-09-14T18:46:39.992Z',
          endDateTime: '2026-09-24T18:46:39.992Z',
        },
      },
      0
    );

    assert.ok(capturedUrl.includes('classificationName=Music'));
    assert.ok(capturedUrl.includes('startDateTime=2026-09-14T18%3A46%3A39Z'));
    assert.ok(capturedUrl.includes('endDateTime=2026-09-24T18%3A46%3A39Z'));
    assert.ok(!capturedUrl.includes('.992'));
    assert.ok(!capturedUrl.includes('city='));
    // countryCode y source del scope no se envían (rompen el filtro geo).
    assert.ok(!capturedUrl.includes('countryCode='));
    assert.ok(!capturedUrl.includes('source=ticketmaster'));
  });

  // Regresión (2026-09-22): en workerd, `this.fetchFn(...)` vinculaba la
  // instancia como `this` del fetch global → "Illegal invocation" en /run y
  // en los crons. La llamada debe ser desnuda (this = undefined).
  it('invoca fetchFn sin vincular la instancia como `this`', async () => {
    let thisAtCall: unknown = 'not-called';
    const adapter = new TicketmasterAdapter({
      apiKey: 'test-key',
      fetchFn: function (this: unknown) {
        thisAtCall = this;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            _embedded: { events: [] },
            page: { size: 200, number: 0, totalElements: 0, totalPages: 0 },
          }),
        } as unknown as Response);
      } as unknown as typeof fetch,
    });

    await adapter.fetchScopeBatch(
      {
        key: 'madrid-test',
        source: 'ticketmaster',
        params: { latlong: '40.4168,-3.7038', radius: '50', unit: 'km' },
      },
      0
    );

    assert.notStrictEqual(thisAtCall, adapter);
    assert.strictEqual(thisAtCall, undefined);
  });
});