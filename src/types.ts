/**
 * Modelo canónico (agnóstico de fuente) del Canonical Data Ingestion Layer.
 *
 * Toda fuente (Ticketmaster, Bandsintown, Songkick, promotoras locales, …)
 * se normaliza hacia estos tipos. El orquestador y el writer de persistencia
 * solo conocen este modelo: añadir una fuente nueva = nuevo adapter + normalizer.
 */

export type SourceCode = 'ticketmaster' | 'demo';

/** Géneros canónicos actuales de la app (ver src/constants/filters.ts). */
export type AppGenre = 'jazz' | 'rock' | 'indie' | 'electronic' | 'pop';

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
  /** Devuelve null si el evento no es normalizable (venue sin coords, etc.). */
  toCanonical(raw: R): CanonicalEvent | null;
}

export interface IngestStats {
  apiCalls: number;
  fetched: number;
  venuesUpserted: number;
  eventsUpserted: number;
  instancesUpserted: number;
  skippedInvalid: number;
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

/** Contrato de persistencia (idempotente). dryRun = no escribe. */
export interface IngestWriter {
  readonly dryRun: boolean;
  upsertVenue(venue: CanonicalVenue): Promise<string | null>;
  upsertEventWithInstances(
    event: CanonicalEvent,
    venueId: string
  ): Promise<{ eventsUpserted: number; instancesUpserted: number }>;
}