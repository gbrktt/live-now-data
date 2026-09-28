/**
 * Adaptador de fuente: Ticketmaster Discovery API v2.
 *
 * - Endpoint: GET https://app.ticketmaster.com/discovery/v2/events.json
 * - Autenticación: `?apikey={key}`
 * - Límites oficiales: 5000 llamadas/día · 5 req/s · deep paging size×page < 1000
 * - Filtro musical: `classificationName=Music` (nombre legible; el parámetro
 *   `source=` de la API es el canal de venta —`ticketmaster`, `universe`,
 *   `frontgate`…— y NO debe usarse para filtrar música, pues p. ej.
 *   `source=ticketmaster` devuelve 0 resultados en ES).
 * - Geo: el filtro por radio (`latlong`+`radius`) debe ir SIN `countryCode`:
 *   la combinación geo+country devuelve 0 resultados (verificado 2026-09-14).
 */

import type {
  EventSourceAdapter,
  IngestScope,
  RawEventBatch,
  SourceCode,
} from '../types.ts';

const BASE_URL = 'https://app.ticketmaster.com/discovery/v2/events.json';

export interface TicketmasterAdapterOptions {
  apiKey: string;
  /** Mínimo ms entre llamadas (200ms → 5 req/s). */
  minIntervalMs?: number;
  size?: number;
  fetchFn?: typeof fetch;
}

export const TICKETMASTER_DEEP_PAGING_LIMIT = 1000;

/**
 * Ticketmaster exige fechas `YYYY-MM-DDTHH:mm:ssZ` (error DIS1015 si llevan
 * milisegundos). `Date.toISOString()` siempre emite `.mmmZ`, así que se
 * normaliza aquí, en el borde con la fuente: el resto del sistema sigue
 * trabajando con `Date` nativos.
 */
export function toTicketmasterDateTime(value: string): string {
  const normalized = value.replace(/\.\d+Z$/, 'Z');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(normalized)) {
    return normalized;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Fecha inválida para Ticketmaster: "${value}"`);
  }
  return parsed.toISOString().replace(/\.\d+Z$/, 'Z');
}

export class TicketmasterAdapter implements EventSourceAdapter {
  readonly source: SourceCode = 'ticketmaster';

  private readonly minIntervalMs: number;
  private readonly size: number;
  private readonly fetchFn: typeof fetch;
  private readonly opts: TicketmasterAdapterOptions;
  private lastCallMs = 0;

  constructor(opts: TicketmasterAdapterOptions) {
    this.opts = opts;
    this.minIntervalMs = opts.minIntervalMs ?? 200;
    this.size = opts.size ?? 200;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async fetchScopeBatch(
    scope: IngestScope,
    page: number,
    size: number = this.size
  ): Promise<RawEventBatch> {
    const params = new URLSearchParams({
      apikey: this.opts.apiKey,
      classificationName: 'Music',
      size: String(size),
      page: String(page),
    });
    // `city` y `countryCode` son etiquetas del scope, no filtros de la API:
    // `city` no es un parámetro de la Discovery API y `countryCode` combinado
    // con geo (`latlong`+`radius`) devuelve 0 resultados. `source` interno del
    // scope ('ticketmaster') tampoco se envía: en la API `source=` es el canal
    // de venta y `source=ticketmaster` devuelve 0 en ES.
    for (const [key, value] of Object.entries(scope.params)) {
      if (key === 'city' || key === 'countryCode' || key === 'source') continue;
      params.set(
        key,
        key === 'startDateTime' || key === 'endDateTime'
          ? toTicketmasterDateTime(value)
          : value
      );
    }

    const url = `${BASE_URL}?${params.toString()}`;
    await this.throttle();

    // Invocar como método (`this.fetchFn(...)`) pasa la instancia como `this`
    // y workerd rechaza el fetch global con "Illegal invocation". Se desacopla
    // en una variable local para que la llamada sea desnuda (this = undefined).
    const doFetch = this.fetchFn;
    const res = await doFetch(url, { headers: { Accept: 'application/json' } });

    if (res.status === 401 || res.status === 403) {
      throw new Error(
      'Ticketmaster autenticación fallida: revisa TICKETMASTER_API_KEY'
      );
    }
    if (res.status === 429) {
      throw new Error('Ticketmaster rate limit (429): reduce DAILY_QUOTA o sube minIntervalMs');
    }
    if (!res.ok) {
      throw new Error(`Ticketmaster HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      _embedded?: { events?: unknown[] };
      page?: { size: number; number: number; totalElements: number; totalPages: number };
    };

    const events = Array.isArray(data._embedded?.events) ? data._embedded.events : [];
    const pageInfo = data.page;
    const totalPages = pageInfo?.totalPages ?? 0;

    // Deep paging limit: la API solo permite recuperar el item nº1000.
    const maxUsablePages = Math.ceil(TICKETMASTER_DEEP_PAGING_LIMIT / size);
    const cappedTotalPages = Math.min(totalPages, maxUsablePages);

    return {
      events,
      pageNumber: pageInfo?.number ?? page,
      totalPages: cappedTotalPages,
      totalElements: pageInfo?.totalElements ?? events.length,
    };
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const waitMs = this.minIntervalMs - (now - this.lastCallMs);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.lastCallMs = Date.now();
  }
}