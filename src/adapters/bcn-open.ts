/**
 * Adaptador de fuente: Agenda Cultural de Barcelona (C1).
 *
 * Publicada por el Ayuntamiento en datos abiertos (CKAN). Es la primera
 * fuente que devuelve algo PARA ESTA NOCHE: Ticketmaster da 0 eventos en curso
 * en todo el país, y esta agenda da 13 conciertos en las próximas 24 h
 * (medido 2026-09-30), el 100 % con coordenadas.
 *
 * - Recurso: CSV de 7,8 MB en UTF-16LE (el JSON equivalente son 173 MB, no
 *   viable en un Worker). `src/adapters/csv.ts` lo decodifica y parsea.
 * - Sin paginación en el servidor: se descarga el fichero entero y se filtra
 *   por la ventana temporal del scope.
 * - El CSV no trae nombre de sala (la columna `institution_name` viene vacía),
 *   ni imágenes, ni descripción, ni estado de suspensión. Se acepta el coste:
 *   el valor está en la cobertura de "ahora", no en la riqueza de la ficha.
 *
 * Idempotencia: el id estable es `register_id` (nada que inventar), y el
 * writer deriva el UUID con `uuid5(source, 'event', register_id)`.
 */

import type {
  EventSourceAdapter,
  IngestScope,
  RawEventBatch,
  SourceCode,
} from '../types.ts';
import { decodeCsvBytes, toRecords } from './csv.ts';

export const BCN_OPEN_DEFAULT_URL =
  'https://opendata-ajuntament.barcelona.cat/data/dataset/' +
  '2767159c-1c98-46b8-a686-2b25b40cb053/resource/' +
  '3abb2414-1ee0-446e-9c25-380e938adb73/download';

/**
 * Filtro ESTRICTO de conciertos.
 *
 * Se aplicó después de comprobar que un regex laxo arrastraba talleres y
 * cursos ("Taller Guitarra", "Cant bàsic per a principiants"): la taxonomía
 * municipal mete en «música» la familia entera de cursos y Workshops.
 */
const CONCERT_CATEGORY =
  /^(concerts?|m[uú]sica|cl[àa]ssica|pop i rock|pop,? ?jazz,? ?rock,? ?tecno|jazz|rock|pop|flamenc|coral|choral|oratori|electr[oó]nic[ae]?|sonor|world|folk|hip.?hop|rap|salsa|tango|cabaret|bandes)$/i;

/** Familias que la taxonomía etiqueta como «música» pero no son concierto. */
const NOT_CONCERT =
  /(taller|curs|ball|dansa|teatre|circ|familiar|exposici|visita|ruta|tastet|cat[àa]leg|formaci[óo]|t[eè]cnic|laboratori|infantil)/i;

/**
 * El CSV no trae `type_name` (sí está en el JSON de 173 MB), así que no se
 * puede filtrar por «Puntual» / «Permanent» / «Cíclic». Las exposiciones
 * quedan fuera por su categoría (`Exposicions` está en la lista negativa) y las
 * series (`Cíclic`) se aceptan: son conciertos recurrentes legítimos.
 */
export function isConcertRow(row: Record<string, string>): boolean {
  const category = (row['secondary_filters_name'] ?? '').trim();
  const fullPath = row['secondary_filters_fullpath'] ?? '';
  if (category || fullPath) {
    if (NOT_CONCERT.test(category) || NOT_CONCERT.test(fullPath)) return false;
    return CONCERT_CATEGORY.test(category) || CONCERT_CATEGORY.test(fullPath);
  }
  return isConcertTitle(row['name'] ?? '');
}

/**
 * EL CSV PUBLICADO NO TRAE TAXONOMÍA: las columnas `secondary_filters_*` vienen
 * vacías en las 3514 filas (verificado 2026-09-30). Solo el JSON de 173 MB las
 * trae, y no es viable en un Worker.
 *
 * Así que el filtro principal mira el TÍTULO. Medido contra el JSON (que sí
 * tiene la clasificación real) sobre 3511 eventos cruzados:
 *   · precisión 92,2 % · recall 84,9 % (TP 675 · FP 57 · FN 120 · TN 2659)
 * Revisados a mano, casi todos los 57 falsos positivos son música de verdad
 * ("Concert d'Any Nou", "Coral de Cambra"): el "error" es de taxonomía, no de
 * fondo. Los falsos negativos que sí duelen ("Vermuts Musicals", "Festival
 * Feroe") se recuperan con las reglas de `RECALL_RULES`.
 */
export function isConcertTitle(title: string): boolean {
  if (TITLE_EXCLUSION.test(title)) return false;
  if (MUSIC_TITLE.test(title)) return true;
  // Reglas de recall: [condición, veto]. Se aceptan si la condición casa y el
  // veto NO. Los casos salen del cruce medido con el JSON, no de suposición.
  return RECALL_RULES.some(
    ([condition, veto]) => condition.test(title) && !(veto?.test(title) ?? false)
  );
}

const MUSIC_TITLE =
  /\b(concert|concierto|m[uú]sica|musical|jazz|rock|pop|flamen[co]|cl[àa]ssic[ao]?|sonor|[óo]pera|oratori|coral|choral|vermuts? musicals?)\b/i;

/**
 * Títulos que SÍ son música sin llevar ninguna palabra clave. Ejemplo medido:
 * "Festival 'Feroe'26' amb 'St. Paul & The Broken Bones'" → es un cartel, pero
 * el nombre no dice "concierto". Se vetan los festivales de cine y teatro, que
 * comparten la palabra pero no son música.
 */
const RECALL_RULES: Array<[RegExp, RegExp]> = [
  [/\bfestival\b/i, /\b(cine|cinema|film|teatre|teatro|documental)\b/i],
  // "Espectacle 'Vicky Gastelo'", "Espectacle 'Les barques volen pel cel'".
  [/\bespectacle\b/i, /\b(infantil|magic|circ)\b/i],
  // "Cercavila de Festa Major": documento social con música de fondo.
  [/\bcercavila\b|\bfesta\b/i, /\b(paella|gastronom)/i],
];

/** Exclusiones de título: no son concierto aunque lleven la palabra clave. */
const TITLE_EXCLUSION =
  /\b(taller|curs|cursor|exposici[óo]|visita|ruta|tastet|formaci[óo]|presentaci[óo]|inauguraci[óo]|confer[eè]ncia|debate)\b/i;

export interface BcnOpenAdapterOptions {
  url?: string;
  fetchFn?: typeof fetch;
  /** Segundos de vida en caché de la respuesta (evita 7,8 MB por invocación). */
  cacheTtlSeconds?: number;
}

interface CacheEntry {
  at: number;
  text: string;
}

export class BcnOpenAdapter implements EventSourceAdapter {
  readonly source: SourceCode = 'bcn_open';

  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly cacheTtlMs: number;
  private cache: CacheEntry | null = null;

  constructor(opts: BcnOpenAdapterOptions = {}) {
    this.url = opts.url ?? BCN_OPEN_DEFAULT_URL;
    // Invocar el fetch como método (`this.fetchFn(...)`) vincula la instancia y
    // workerd lo rechaza con "Illegal invocation" (ver ticketmaster.ts).
    this.fetchFn = opts.fetchFn ?? fetch;
    this.cacheTtlMs = (opts.cacheTtlSeconds ?? 900) * 1000;
  }

  async fetchScopeBatch(scope: IngestScope, page: number): Promise<RawEventBatch> {
    // Sin paginación: una sola página por scope.
    if (page > 0) {
      return { events: [], pageNumber: page, totalPages: 0, totalElements: 0 };
    }

    const text = await this.load();
    const from = this.parseBoundary(scope.params['from']);
    const to = this.parseBoundary(scope.params['to']);

    const events = toRecords(text)
      .filter((row) => isConcertRow(row))
      .filter((row) => {
        const start = Date.parse(row['start_date'] ?? '');
        if (Number.isNaN(start)) return false;
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
    if (!res.ok) throw new Error(`BCN open data HTTP ${res.status}`);
    const text = decodeCsvBytes(await res.arrayBuffer());
    this.cache = { at: now, text };
    return text;
  }
}
