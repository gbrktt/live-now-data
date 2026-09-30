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
import { buildScopes, type CityScopeConfig, type ScopeMode } from './scopes.ts';
import { buildDedupeKey, normalizeText } from './ingest/dedupe.ts';
import type { DedupeCandidateRow } from './types.ts';

export interface OrchestratorOptions {
  source: SourceCode;
  adapter: EventSourceAdapter;
  normalizer: Normalizer<unknown>;
  writer: IngestWriter;
  from: Date;
  to: Date;
  cities: CityScopeConfig[];
  countryCode?: string;
  /**
   * Particionado del barrido. Por defecto `city` (comportamiento previo);
   * T2/T3 usan `country` para cobertura (ver src/config.ts).
   */
  scopeMode?: ScopeMode;
  /**
   * Scopes ya calculados. Las fuentes que no se particionan por ciudad (la
   * agenda municipal de BCN devuelve el fichero entero) pasan aquí sus
   * propias ventanas en vez de usar `buildScopes`.
   */
  scopes?: IngestScope[];
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
    scopeMode = 'city',
    windowDays = 10,
    pageSize = 200,
    maxPagesPerScope = 5,
    dailyQuota = 4000,
    maxScopes = 0,
    onPage,
  } = opts;

  const scopes =
    opts.scopes ??
    buildScopes({
      cities,
      from,
      to,
      windowDays,
      source,
      countryCode,
      scopeMode,
    });
  const effectiveScopes =
    maxScopes > 0 ? scopes.slice(0, maxScopes) : scopes;
  const stats: IngestStats = { ...EMPTY_STATS };
  let scopesProcessed = 0;
  let lastScope: string | null = null;

  // Fase 2 (C2): huellas tocadas en esta corrida, para resolver duplicados al
  // final. El writer también busca las que ya estaban en la BD.
  const dedupeCandidates: DedupeCandidateRow[] = [];

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
        // El normalizador puede ser asíncrono (agenda municipal: deriva el
        // venue_id de la dirección), así que se espera siempre.
        const canonical = await normalizer.toCanonical(raw);
        if (!canonical) {
          stats.skippedInvalid += 1;
          continue;
        }

        const venueId = await writer.upsertVenue(canonical.venue);
        if (!venueId) {
          stats.skippedInvalid += 1;
          continue;
        }

        const { eventId, eventsUpserted, instancesUpserted } =
          await writer.upsertEventWithInstances(canonical, venueId);
        stats.venuesUpserted += 1;
        stats.eventsUpserted += eventsUpserted;
        stats.instancesUpserted += instancesUpserted;

        const firstStart = canonical.occurrences[0]?.startsAt;
        if (firstStart) {
          dedupeCandidates.push({
            source: canonical.source,
            sourceEventId: canonical.sourceEventId,
            eventId,
            title: canonical.title,
            dedupeKey: buildDedupeKey({
              title: canonical.title,
              startsAt: firstStart,
              lat: canonical.venue.lat,
              lng: canonical.venue.lng,
            }),
            venueNameKey: normalizeText(canonical.venue.name),
            isActive: canonical.isActive,
          });
        }
      }

      page += 1;
      onPage?.(scope, stats);
    }

    scopesProcessed += 1;
    lastScope = scope.key;
  }

  // El writer agrupa las escrituras en lotes (límite de 50 subpeticiones de
  // Cloudflare): hay que volcarlos ANTES de que la fase 2 lea de la BD, o sus
  // duplicados aún no existirían y pasarían inadvertidos.
  await writer.flush?.();

  // B6 · higiene: retira lo ya terminado y lo que la fuente ya no devuelve.
  // Va DESPUÉS de escribir los eventos de la corrida (para no retirarlos) y
  // con la lista de ids vistos, que es lo que distingue "desaparecido" de
  // "acaba de llegar".
  if (writer.retireStale) {
    try {
      const seen = dedupeCandidates.map((c) => c.sourceEventId);
      const retired = await writer.retireStale(source, seen, new Date());
      stats.retiredFinished = retired.retiredFinished;
      stats.retiredMissing = retired.retiredMissing;
      if (retired.retiredFinished > 0 || retired.retiredMissing > 0) {
        console.log(
          `[ingest] source=${source} higiene: ` +
            `${retired.retiredFinished} terminados, ` +
            `${retired.retiredMissing} desaparecidos`
        );
      }
    } catch (error) {
      // La ingesta ya está escrita: la higiene no debe abortarla.
      console.error('[ingest] retireStale falló', error);
    }
  }

  // Fase 2 (C2): resolver duplicados con TODO lo que se acaba de escribir más
  // lo que ya había en la BD con la misma huella. Opcional en el contrato: los
  // dobles de test no lo implementan.
  if (writer.reconcileDuplicates) {
    try {
      const result = await writer.reconcileDuplicates(dedupeCandidates);
      stats.aliasesWritten = result.aliases;
      stats.duplicatesHidden = result.hidden;
      stats.duplicatesForReview = result.reviewOnly;
    } catch (error) {
      // La ingesta ya está escrita: un fallo de dedupe no debe abortarla.
      // Queda registrado en ingest_runs.error y se ve en Sentinel.
      console.error('[ingest] reconcileDuplicates falló', error);
    }
  }

  const status: IngestResult['status'] =
    stats.fetched === 0 ? 'empty' : 'success';

  return { status, stats, scopesProcessed, lastScope };
}