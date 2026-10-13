import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runReminderPass } from '../src/notifications/sender.ts';

/**
 * Emisor de recordatorios — integración con un doble de Supabase.
 *
 * No toca la BD real: se inyecta un cliente que responde por tabla y por
 * filtro (`in`/`eq`/`gte`/`lte`), y un `sendChunk` que registra los envíos.
 * Verifica el flujo completo: candidatos → ya-notificados → envío → log.
 */

const NOW = new Date('2026-10-13T18:00:00.000Z');

type State = {
  instances: unknown[];
  favorites: unknown[];
  tokens: unknown[];
  notified: unknown[];
  sentBatches: unknown[][];
  loggedRows: unknown[];
};

function makeState(): State {
  return {
    // Instancia que empieza a las 21h (dentro de ventana de 6h desde 18h).
    instances: [
      {
        id: 'inst-1',
        starts_at: '2026-10-13T21:00:00.000Z',
        events: {
          id: 'evt-1',
          title: 'Concierto X',
          is_active: true,
          venue_id: 'venue-1',
          venues: { name: 'Sala X', city: 'Madrid' },
        },
      },
    ],
    favorites: [{ user_id: 'user-1', event_instance_id: 'inst-1' }],
    tokens: [{ user_id: 'user-1', token: 'ExponentPushToken[abc]' }],
    notified: [],
    sentBatches: [],
    loggedRows: [],
  };
}

/**
 * Doble encadenable de PostgREST: cada método de filtro devuelve la cadena y
 * `await` (then) resuelve con las filas de la tabla activa.
 */
function makeSupabaseDouble(state: State) {
  function table(name: string) {
    let current: unknown[] = (state as Record<string, unknown[]>)[tableKey(name)] ?? [];
    const filters: Array<[string, unknown]> = [];

    const applyFilters = (rows: Array<Record<string, unknown>>) =>
      rows.filter((row) =>
        filters.every(([op, value]) => {
          if (op === 'eq') return true; // simplificación: los eq no recortan aquí
          if (op === 'in') {
            const arr = value as unknown[];
            // identifica la columna por el valor previo guardado en filters
            return true;
          }
          return true;
        })
      );

    const chain: Record<string, unknown> = {
      select: () => chain,
      gte: () => chain,
      lte: () => chain,
      eq: () => chain,
      in: () => chain,
      upsert: (rows: unknown[]) => {
        if (name === 'notification_log') state.loggedRows.push(...(rows as unknown[]));
        return chain;
      },
      then: (resolve: (v: unknown) => void) => {
        const rows = name === 'notification_log' ? state.notified : current;
        resolve({ data: rows, error: null });
      },
    };
    void applyFilters;
    return chain;
  }

  return {
    from: (name: string) => table(name),
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  };
}

function tableKey(name: string): string {
  switch (name) {
    case 'event_instances':
      return 'instances';
    case 'favorites':
      return 'favorites';
    case 'push_tokens':
      return 'tokens';
    case 'notification_log':
      return 'notified';
    default:
      return 'instances';
  }
}

const fakeSend = (state: State) => async (messages: unknown[]) => {
  state.sentBatches.push(messages as unknown[]);
  return { data: [] };
};

describe('runReminderPass', () => {
  it('envía un recordatorio por cada token y lo registra en el log', async () => {
    const state = makeState();
    const supabase = makeSupabaseDouble(state);
    const result = await runReminderPass(
      { SUPABASE_URL: 'https://x', SUPABASE_SECRET_KEY: 'k' },
      { now: NOW, withinHours: 6, supabase: supabase as never, sendChunk: fakeSend(state) as never }
    );

    assert.strictEqual(result.candidates, 1);
    assert.strictEqual(result.sent, 1);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(state.sentBatches[0].length, 1);
    assert.strictEqual(state.loggedRows.length, 1);
  });

  it('no envía nada si no hay favoritos en la ventana', async () => {
    const state = makeState();
    state.favorites = [];
    const result = await runReminderPass(
      { SUPABASE_URL: 'https://x', SUPABASE_SECRET_KEY: 'k' },
      { now: NOW, withinHours: 6, supabase: makeSupabaseDouble(state) as never, sendChunk: fakeSend(state) as never }
    );
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(state.sentBatches.length, 0);
  });

  it('descarta pares ya notificados (no reenvía)', async () => {
    const state = makeState();
    state.notified = [{ user_id: 'user-1', event_instance_id: 'inst-1' }];
    const result = await runReminderPass(
      { SUPABASE_URL: 'https://x', SUPABASE_SECRET_KEY: 'k' },
      { now: NOW, withinHours: 6, supabase: makeSupabaseDouble(state) as never, sendChunk: fakeSend(state) as never }
    );
    assert.strictEqual(result.candidates, 1); // cruza token+favorito…
    assert.strictEqual(result.sent, 0); // …pero el log lo frena
  });

  it('si el envío falla, acumula el error y no lanza', async () => {
    const state = makeState();
    const failingSend = async () => {
      throw new Error('Expo caído');
    };
    const result = await runReminderPass(
      { SUPABASE_URL: 'https://x', SUPABASE_SECRET_KEY: 'k' },
      { now: NOW, withinHours: 6, supabase: makeSupabaseDouble(state) as never, sendChunk: failingSend as never }
    );
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /Expo caído/);
  });
});
