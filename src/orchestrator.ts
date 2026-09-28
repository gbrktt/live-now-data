/**
 * Orquestador del barrido: scopes → adaptador → normalizador → writer.
 *
 * Responsabilidades:
 * - respetar la cuota diaria de la fuente (dailyQuota),
 * - no sobrepasar el deep-paging de la fuente (maxPagesPerScope),
 * - recopilar estadísticas por corrida (IngestStats).
 * No conoce la fuente concreta: solo usa `EventSourceAdapter` y `Normalizer`.
 */

import type {
  EventSourceAdapter,
  IngestResult,
  IngestScope,
  IngestStats,
  IngestWriter,
  Normalizer,
  SourceCode,
} from './types.ts';
import { buildScopes, type CityScopeConfig } from './scopes.ts';

export interface OrchestratorOptions {
  source: SourceCode;
  adapter: EventSourceAdapter;
  normalizer: Normalizer<unknown>;
  writer: IngestWriter;
  from: Date;
  to: Date;
  cities: CityScopeConfig[];
  countryCode?: string;
  /** Tamaño de ventana por scope (días). Menor = consultas más ligeras. */
  windowDays?: number;
  pageSize?: number;
  /** Deep paging de la fuente (Ticketmaster: 5 páginas × 200 = 1000). */
  maxPagesPerScope?: number;
  dailyQuota?: number;
  /**
   * Límite de scopes a procesar (0 = sin límite). Solo para pruebas locales
   * (`--scope-limit`): permite validar 1 scope sin barrer la ventana completa.
   */
  maxScopes?: number;
  /** Logger opcional por página procesada. */
  onPage?: (scope: IngestScope, stats: IngestStats) => void;
}

const EMPTY_STATS: IngestStats = {
  apiCalls: 0,
  fetched: 0,
  venuesUpserted: 0,
  eventsUpserted: 0,
  instancesUpserted: 0,
  skippedInvalid: 0,
};

export async function runIngest(
  opts: OrchestratorOptions
): Promise<IngestResult> {
  const {
    source,
    adapter,
    normalizer,
    writer,
    from,
    to,
    cities,
    countryCode = 'ES',
    windowDays = 10,
    pageSize = 200,
    maxPagesPerScope = 5,
    dailyQuota = 4000,
    maxScopes = 0,
    onPage,
  } = opts;

  const scopes = buildScopes({ cities, from, to, windowDays, source, countryCode });
  const effectiveScopes =
    maxScopes > 0 ? scopes.slice(0, maxScopes) : scopes;
  const stats: IngestStats = { ...EMPTY_STATS };
  let scopesProcessed = 0;
  let lastScope: string | null = null;

  if (scopes.length === 0) {
    return { status: 'no-scopes', stats, scopesProcessed: 0, lastScope: null };
  }

  for (const scope of effectiveScopes) {
    let page = 0;
    let totalPages = 1;

    while (page < totalPages) {
      if (stats.apiCalls >= dailyQuota) {
        return {
          status: 'budget-exhausted',
          stats,
          scopesProcessed,
          lastScope,
        };
      }

      const batch = await adapter.fetchScopeBatch(scope, page, pageSize);
      stats.apiCalls += 1;
      stats.fetched += batch.events.length;
      totalPages = Math.min(
        Math.max(batch.totalPages, page + 1),
        maxPagesPerScope
      );

      for (const raw of batch.events) {
        const canonical = normalizer.toCanonical(raw);
        if (!canonical) {
          stats.skippedInvalid += 1;
          continue;
        }

        const venueId = await writer.upsertVenue(canonical.venue);
        if (!venueId) {
          stats.skippedInvalid += 1;
          continue;
        }

        const { eventsUpserted, instancesUpserted } =
          await writer.upsertEventWithInstances(canonical, venueId);
        stats.venuesUpserted += 1;
        stats.eventsUpserted += eventsUpserted;
        stats.instancesUpserted += instancesUpserted;
      }

      page += 1;
      onPage?.(scope, stats);
    }

    scopesProcessed += 1;
    lastScope = scope.key;
  }

  const status: IngestResult['status'] =
    stats.fetched === 0 ? 'empty' : 'success';

  return { status, stats, scopesProcessed, lastScope };
}