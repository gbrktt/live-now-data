/**
 * Adaptador de fuente: agenda cultural de Madrid (datos abiertos, CKAN).
 *
 * Espejo del adaptador de Barcelona (bcn-open) con las diferencias del dato:
 *   · recurso CSV de 1,6 MB, en ISO-8859-1 con separador `;`
 *     (BCN: UTF-16LE con `,`);
 *   · actualización diaria → mismos tiers que BCN (T2/T3), sin T1;
 *   · trae lo que a BCN le falta: LATITUD/LONGITUD directas, HORA de inicio,
 *     GRATUITO explícito (144 de 147 filas musicales) e instalación con nombre.
 *
 * Datos medidos sobre el CSV real (2026-10-05, 1417 filas):
 *   · 147 filas con TIPO bajo `/Musica`, 144 gratuitas, 3 sin coordenadas
 *     (se descartan), 0 sin hora, 4 recurrentes (talleres);
 *   · 6 conciertos mal categorizados fuera de `Musica` → regla de recall.
 *
 * Idempotencia: id estable = `ID-EVENTO`; el writer deriva el UUID con
 * `uuid5(source, 'event', ID-EVENTO)`.
 */

import type {
  EventSourceAdapter,
  IngestScope,
  RawEventBatch,
  SourceCode,
} from '../types.ts';
import { decodeCsvBytes, toRecords } from './csv.ts';

export const MADRID_OPEN_DEFAULT_URL =
  'https://datos.madrid.es/dataset/206974-0-agenda-eventos-culturales-100/' +
  'resource/206974-4-agenda-eventos-culturales-100-csv/download/' +
  '206974-4-agenda-eventos-culturales-100-csv.csv';

/** Separador del CSV de Madrid (`;`, a diferencia del `,` de BCN). */
const SEPARATOR = ';';

/** Subárbol de taxonomía que contiene los conciertos. */
const MUSIC_PATH = /^\/contenido\/actividades\/musica(\/|$)/i;

/**
 * Lista negra de categorías para la regla de recall: si el título dice
 * «concierto» pero la actividad es teatro/cine/exposición, NO es música
 * ("Concierto en el Amazonas" es una obra; "Las castañuelas como instrumento
 * de concierto" es una exposición — ambos medidos en el CSV real).
 */
const NOT_MUSIC_CATEGORY =
  /teatro|performance|cine|exposici|conferenc|visita|excursi|itinerari|feria|concurso|certamen|deport|lectura|cuentacuentos|titere|marioneta|formacion|curso|taller/i;

/** Regla de recall: el título afirma que es un concierto. */
const CONCERT_TITLE = /\bconcierto[s]?\b/i;

/** Familias que la taxonomía mete en «música» pero no son concierto. */
const NOT_CONCERT =
  /(taller|curs|formaci|iniciaci|workshop|estable|ensayo|coral infantil|familiar|cuenta.?cuentos|titere)/i;

/**
 * ¿La fila es un concierto?
 *
 * 1) `TIPO` dentro del subárbol `/Musica` → sí, salvo que el título diga lo
 *    contrario (la taxonomía municipal incluye talleres de iniciación).
 * 2) Fuera del subárbol → solo si el título menciona «concierto» y la
 *    categoría no está en la lista negra (recall medido: 6 casos, 4 correctos).
 */
export function isConcertRow(row: Record<string, string>): boolean {
  const tipo = (row['TIPO'] ?? '').trim();
  const title = (row['TITULO'] ?? '').trim();
  if (MUSIC_PATH.test(tipo)) {
    return !NOT_CONCERT.test(title);
  }
  if (!CONCERT_TITLE.test(title)) return false;
  return !NOT_MUSIC_CATEGORY.test(tipo) && !NOT_CONCERT.test(title);
}

export interface MadridOpenAdapterOptions {
  url?: string;
  fetchFn?: typeof fetch;
  /** Segundos de vida en caché de la respuesta (evita 1,6 MB por invocación). */
  cacheTtlSeconds?: number;
}

interface CacheEntry {
  at: number;
  text: string;
}

export class MadridOpenAdapter implements EventSourceAdapter {
  readonly source: SourceCode = 'madrid_open';

  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly cacheTtlMs: number;
  private cache: CacheEntry | null = null;

  constructor(opts: MadridOpenAdapterOptions = {}) {
    this.url = opts.url ?? MADRID_OPEN_DEFAULT_URL;
    // Invocar el fetch como método (`this.fetchFn(...)`) vincula la instancia
    // y workerd lo rechaza con "Illegal invocation" (ver bcn-open.ts).
    this.fetchFn = opts.fetchFn ?? fetch;
    this.cacheTtlMs = (opts.cacheTtlSeconds ?? 900) * 1000;
  }

  async fetchScopeBatch(scope: IngestScope, page: number): Promise<RawEventBatch> {
    // Sin paginación: una sola página por scope (como BCN).
    if (page > 0) {
      return { events: [], pageNumber: page, totalPages: 0, totalElements: 0 };
    }

    const text = await this.load();
    const from = this.parseBoundary(scope.params['from']);
    const to = this.parseBoundary(scope.params['to']);

    const events = toRecords(text, Number.POSITIVE_INFINITY, SEPARATOR)
      .filter((row) => isConcertRow(row))
      .filter((row) => {
        // FECHA es fecha local con HORA de inicio ("2026-10-25 00:00:00.0" +
        // "19:00"). El corte de ventana se hace en epoch local-Madrid; la
        // conversión exacta a UTC con `Europe/Madrid` la hace el normalizador.
        const start = this.startEpochMs(row);
        if (start === null) return false;
        if (from !== null && start < from) return false;
        if (to !== null && start >= to) return false;
        return true;
      });

    return {
      events,
      pageNumber: 0,
      totalPages: 1,
      totalElements: events.length,
    };
  }

  /** Epoch (ms) de `FECHA` + `HORA`, interpretando la hora como local Madrid. */
  private startEpochMs(row: Record<string, string>): number | null {
    const fecha = (row['FECHA'] ?? '').trim();
    const hora = (row['HORA'] ?? '').trim() || '12:00';
    const datePart = fecha.slice(0, 10); // "2026-10-25 00:00:00.0" → "2026-10-25"
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
    if (!/^\d{2}:\d{2}$/.test(hora)) return null;
    const naive = Date.parse(`${datePart}T${hora}:00`);
    return Number.isNaN(naive) ? null : naive;
  }

  private parseBoundary(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private async load(): Promise<string> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.cacheTtlMs) return this.cache.text;

    const doFetch = this.fetchFn;
    const res = await doFetch(this.url, { headers: { Accept: 'text/csv' } });
    if (!res.ok) throw new Error(`Madrid open data HTTP ${res.status}`);
    const text = decodeCsvBytes(await res.arrayBuffer());
    this.cache = { at: now, text };
    return text;
  }
}
