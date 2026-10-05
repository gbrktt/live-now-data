/**
 * Modelo canónico (agnóstico de fuente) del Canonical Data Ingestion Layer.
 *
 * Toda fuente (Ticketmaster, Bandsintown, Songkick, promotoras locales, …)
 * se normaliza hacia estos tipos. El orquestador y el writer de persistencia
 * solo conocen este modelo: añadir una fuente nueva = nuevo adapter + normalizer.
 */

export type SourceCode = 'ticketmaster' | 'bcn_open' | 'madrid_open' | 'demo';

/** Géneros canónicos actuales de la app (ver src/constants/filters.ts). */
/**
 * Géneros canónicos de la app (ver src/constants/filters.ts).
 * `classical` se añadió el 2026-09-30 junto con la agenda municipal de
 * Barcelona, que clasifica el 40 % de sus conciertos como música clásica.
 */
export type AppGenre =
  | 'jazz'
  | 'rock'
  | 'indie'
  | 'electronic'
  | 'pop'
  | 'classical';

export interface CanonicalVenue {
  source: SourceCode;
  sourceVenueId: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  city: string | null;
  noiseLevel: string | null;
  timezone: string | null;
  externalUrl: string | null;
}

export interface CanonicalOccurrence {
  /** Clave estable de la instancia: `{sourceEventId}` o `{sourceEventId}_{localDate}`. */
  sourceInstanceId: string;
  /** ISO UTC */
  startsAt: string;
  /** ISO UTC o null si no se conoce (se estima en normalización). */
  endsAt: string | null;
}

export interface CanonicalEvent {
  source: SourceCode;
  sourceEventId: string;
  title: string;
  genre: AppGenre | null;
  priceFrom: number | null;
  priceTo: number | null;
  description: string | null;
  /** Enlace del evento en la fuente (ej. entradas de Ticketmaster). */
  externalUrl: string | null;
  images: string[];
  /** false si cancelado/aparcado; la API debe ocultarlo. */
  isActive: boolean;
  /** Payload normalizado de la fuente para auditoría/trazabilidad. */
  metadata: Record<string, unknown> | null;
  venue: CanonicalVenue;
  occurrences: CanonicalOccurrence[];
}

/** Partición de barrido: un scope = ciudad x ventana de fechas (+ params fuente). */
export interface IngestScope {
  key: string;
  source: SourceCode;
  params: Record<string, string>;
}

export interface RawEventBatch {
  events: unknown[];
  pageNumber: number;
  totalPages: number;
  totalElements: number;
}

/** Contrato de adaptador de fuente. Una implementación por proveedor. */
export interface EventSourceAdapter {
  readonly source: SourceCode;
  fetchScopeBatch(scope: IngestScope, page: number, size: number): Promise<RawEventBatch>;
}

export interface Normalizer<R = unknown> {
  /**
   * Devuelve null si el evento no es normalizable (venue sin coords, etc.).
   * Puede ser asíncrono: la agenda municipal deriva el `venue_id` de la
   * dirección, que requiere un hash.
   */
  toCanonical(raw: R): CanonicalEvent | null | Promise<CanonicalEvent | null>;
}

export interface IngestStats {
  apiCalls: number;
  fetched: number;
  venuesUpserted: number;
  eventsUpserted: number;
  instancesUpserted: number;
  skippedInvalid: number;
  /** Aliases escritos en `event_aliases` (C2). */
  aliasesWritten?: number;
  /** Perdedores ocultados por fusión automática (C2). */
  duplicatesHidden?: number;
  /** Aliases en cola de revisión: registrados pero NO ocultados (C2). */
  duplicatesForReview?: number;
  /** B6 · eventos ya terminados que se han retirado. */
  retiredFinished?: number;
  /** B6 · eventos que la fuente ya no devuelve y se han retirado. */
  retiredMissing?: number;
}

export type IngestResultStatus =
  | 'success'
  | 'empty'
  | 'budget-exhausted'
  | 'no-scopes';

export interface IngestResult {
  status: IngestResultStatus;
  stats: IngestStats;
  scopesProcessed: number;
  lastScope: string | null;
}

/** Fila mínima que el writer necesita para decidir una fusión (ver ingest/dedupe.ts). */
export interface DedupeCandidateRow {
  source: SourceCode;
  sourceEventId: string;
  eventId: string;
  title: string;
  dedupeKey: string;
  venueNameKey: string;
  isActive: boolean;
}

export interface DedupeReconcileResult {
  /** Aliases escritos en `event_aliases`. */
  aliases: number;
  /** Perdedores ocultados (`is_active = false` + `merged_into`). */
  hidden: number;
  /** Aliases de la cola de revisión (registrados, NO ocultados). */
  reviewOnly: number;
}

/** Contrato de persistencia (idempotente). dryRun = no escribe. */
export interface IngestWriter {
  readonly dryRun: boolean;
  upsertVenue(venue: CanonicalVenue): Promise<string | null>;
  upsertEventWithInstances(
    event: CanonicalEvent,
    venueId: string
  ): Promise<{ eventId: string; eventsUpserted: number; instancesUpserted: number }>;
  /**
   * Vuelca los lotes pendientes. Obligatorio antes de cualquier fase que lea
   * de la BD (el dedupe), o los últimos eventos de la corrida no existirían
   * todavía y sus duplicados pasarían inadvertidos.
   */
  flush?(): Promise<void>;

  /**
   * Fase 2 de la ingesta: resolver entidades duplicadas. Opcional para no
   * obligar a los dobles de test a implementarlo.
   */
  reconcileDuplicates?(
    candidates: DedupeCandidateRow[]
  ): Promise<DedupeReconcileResult>;

  /**
   * B6 · higiene: retira (`is_active = false`) los eventos de esta fuente que
   * la corrida NO ha visto y que ya han terminado. Nunca borra filas.
   */
  retireStale?(
    source: string,
    seenSourceEventIds: string[],
    finishedBefore: Date
  ): Promise<{ retiredMissing: number; retiredFinished: number }>;
}