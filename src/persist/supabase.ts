/**
 * Writer de persistencia idempotente contra Supabase (service role).
 *
 * Claves estables: UUID determinista derivado de `source + id externo`.
 * Un mismo evento/venue/instancia se re-upsertea siempre en la misma fila:
 * re-ejecutar el barrido N veces no crea duplicados (favoritos estables).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  buildDedupeKey,
  normalizeText,
  planDedupe,
  type DedupeCandidate,
} from '../ingest/dedupe.ts';
import type {
  CanonicalEvent,
  CanonicalVenue,
  DedupeCandidateRow,
  DedupeReconcileResult,
  IngestWriter,
} from '../types.ts';
import { deterministicUuid } from '../utils/uuid.ts';

export interface SupabaseWriterOptions {
  url: string;
  serviceRoleKey: string;
  dryRun?: boolean;
  now?: Date;
}

export class SupabaseWriter implements IngestWriter {
  readonly dryRun: boolean;
  private readonly client: SupabaseClient;
  private readonly now: Date;
  private readonly venueIdCache = new Map<string, string>();
  /** Pares (genre, subGenre) ya registrados como no mapeados en esta corrida. */
  private readonly registeredGenreKeys = new Set<string>();
  /**
   * `source:sourceEventId` que ya están fusionados (`event_aliases`). Se carga
   * una vez por corrida y evita que el upsert RESUCITE un evento fusionado.
   */
  private aliasLosers: Set<string> | null = null;

  constructor(opts: SupabaseWriterOptions) {
    this.dryRun = opts.dryRun ?? false;
    this.now = opts.now ?? new Date();
    this.client = createClient(opts.url, opts.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /**
   * Escribe en lote y devuelve el mapa `sourceVenueId -> id`.
   *
   * Por qué: Cloudflare limita a 50 subpeticiones por invocación de Worker. Con
   * un upsert por fila, la agenda municipal (157 salas distintas en un T3)
   * reventaba con "Too many subrequests by single Worker invocation". Agrupar
   * en un solo POST por lote deja el margen de sobra y además va más rápido.
   *
   * Por qué no en el orquestador: el writer es quien conoce la clave de
   * conflicto y el `venueIdCache`; meter el buffer aquí mantiene el contrato
   * `IngestWriter` intacto para el resto de ingestas.
   */
  private venueBatch: Array<Record<string, unknown>> = [];
  private eventBatch: Array<Record<string, unknown>> = [];
  private instanceBatch: Array<Record<string, unknown>> = [];
  /** Subpeticiones consumidas en la invocación actual. */
  private requestCount = 0;
  private static readonly MAX_REQUESTS = 40;
  private static readonly VENUE_BATCH_SIZE = 200;
  private static readonly ROW_BATCH_SIZE = 100;

  private async flushVenues(): Promise<void> {
    if (this.venueBatch.length === 0) return;
    const rows = this.venueBatch;
    this.venueBatch = [];
    this.requestCount += 1;
    const { error } = await this.client
      .from('venues')
      .upsert(rows, { onConflict: 'id' });
    if (error) throw error;
  }

  /** Vuelca eventos e instancias en un POST cada uno. */
  private async flushRows(): Promise<void> {
    const events = this.eventBatch;
    const instances = this.instanceBatch;
    this.eventBatch = [];
    this.instanceBatch = [];
    if (events.length > 0) {
      this.requestCount += 1;
      const { error } = await this.client
        .from('events')
        .upsert(events, { onConflict: 'id' });
      if (error) throw error;
    }
    if (instances.length > 0) {
      this.requestCount += 1;
      const { error } = await this.client
        .from('event_instances')
        .upsert(instances, { onConflict: 'id' });
      if (error) throw error;
    }
  }

  /**
   * Vuelca TODO lo pendiente. Lo llama el orquestador al cerrar la corrida:
   * sin esto, los últimos eventos de un lote grande se quedarían sin escribir.
   */
  async flush(): Promise<void> {
    if (this.dryRun) return;
    await this.flushVenues();
    await this.flushRows();
  }

  async upsertVenue(venue: CanonicalVenue): Promise<string | null> {
    const cacheKey = `${venue.source}:${venue.sourceVenueId}`;
    const cached = this.venueIdCache.get(cacheKey);
    if (cached) return cached;

    const id = await deterministicUuid([
      venue.source,
      'venue',
      venue.sourceVenueId,
    ]);

    if (!this.dryRun) {
      this.venueBatch.push({
        id,
        name: venue.name,
        lat: venue.lat,
        lng: venue.lng,
        address: venue.address,
        city: venue.city,
        noise_level: venue.noiseLevel,
        source: venue.source,
        source_venue_id: venue.sourceVenueId,
        timezone: venue.timezone,
        external_url: venue.externalUrl,
      });
      if (
        this.venueBatch.length >= SupabaseWriter.VENUE_BATCH_SIZE ||
        this.requestCount >= SupabaseWriter.MAX_REQUESTS
      ) {
        await this.flushVenues();
      }
    }

    this.venueIdCache.set(cacheKey, id);
    return id;
  }

  /**
   * Registra en `genre_mappings` los `(genre, subGenre)` que el mapa de
   * `src/genre.ts` no reconoce, con `app_genre = null`. Así el diagnóstico
   * `select provider_genre, provider_subgenre from genre_mappings
   * where app_genre is null` dice exactamente qué falta por mapear, sin
   * necesidad de un despliegue.
   *
   * · `ignoreDuplicates`: solo inserta pares que faltan. Un mapeo ya decidido
   *   a mano NUNCA se sobrescribe con `null` (el `mapGenre` es por código, no
   *   lee la tabla, así que podría volver a proponer un par ya resuelto).
   * · Un registro por par y por corrida: 27 eventos `World / Flamenco` son
   *   una sola escritura, no 27.
   */
  private async registerUnmappedGenre(event: CanonicalEvent): Promise<void> {
    if (this.dryRun) return;

    const meta = event.metadata;
    const providerGenre =
      typeof meta?.['providerGenre'] === 'string' ? meta['providerGenre'] : '';
    const providerSubGenre =
      typeof meta?.['providerSubGenre'] === 'string' ? meta['providerSubGenre'] : '';
    // Sin nombre de proveedor no hay nada que mapear después.
    if (!providerGenre && !providerSubGenre) return;

    const key = `${event.source}|${providerGenre}|${providerSubGenre}`;
    if (this.registeredGenreKeys.has(key)) return;
    this.registeredGenreKeys.add(key);

    const { error } = await this.client
      .from('genre_mappings')
      .upsert(
        {
          source: event.source,
          provider_genre: providerGenre,
          provider_subgenre: providerSubGenre,
          app_genre: null,
        },
        {
          onConflict: 'source,provider_genre,provider_subgenre',
          ignoreDuplicates: true,
        }
      );
    if (error) throw error;
  }

  /**
   * Carga (una sola vez por writer) los alias ya conocidos. Sin esto, el upsert
   * de la fase 1 pondría `is_active = true` sobre un evento que la fase 2 ya
   * había fusionado: si la fase 2 fallara, el duplicado volvería a verse en el
   * feed. Con esto la fusión es duradera y la fase 2 solo descubre duplicados
   * NUEVOS.
   */
  private async ensureAliasLosersLoaded(source: string): Promise<void> {
    if (this.aliasLosers !== null || this.dryRun) return;
    const { data, error } = await this.client
      .from('event_aliases')
      .select('source, source_event_id')
      .eq('source', source);
    if (error) throw error;
    this.aliasLosers = new Set(
      (data ?? []).map(
        (row) => `${row['source']}:${row['source_event_id']}`
      )
    );
  }

  /** ¿Este (source, id) ya perdió una fusión anterior? */
  private isKnownLoser(source: string, sourceEventId: string): boolean {
    return this.aliasLosers?.has(`${source}:${sourceEventId}`) ?? false;
  }

  async upsertEventWithInstances(
    event: CanonicalEvent,
    venueId: string
  ): Promise<{ eventId: string; eventsUpserted: number; instancesUpserted: number }> {
    const eventId = await deterministicUuid([
      event.source,
      'event',
      event.sourceEventId,
    ]);
    const first = event.occurrences[0];
    let eventsUpserted = 0;
    let instancesUpserted = 0;

    // Claves de deduplicación (C2). Se calculan SIEMPRE, también en dryRun,
    // para que el plan de fusión se pueda inspeccionar sin escribir.
    const startsAt = first?.startsAt ?? null;
    const dedupeKey =
      startsAt !== null
        ? buildDedupeKey({
            title: event.title,
            startsAt,
            lat: event.venue.lat,
            lng: event.venue.lng,
          })
        : null;
    const venueNameKey = normalizeText(event.venue.name);

    // Un evento ya fusionado no vuelve a activarse aunque la fuente lo devuelva.
    await this.ensureAliasLosersLoaded(event.source);
    const isActive = this.isKnownLoser(event.source, event.sourceEventId)
      ? false
      : event.isActive;

    if (!this.dryRun) {
      this.eventBatch.push({
        id: eventId,
        venue_id: venueId,
        title: event.title,
        description: event.description,
        genre: event.genre,
        price_from: event.priceFrom,
        price_to: event.priceTo,
        starts_at: first?.startsAt ?? null,
        ends_at: first?.endsAt ?? null,
        is_recurring: event.occurrences.length > 1,
        source: event.source,
        source_event_id: event.sourceEventId,
        external_url: event.externalUrl,
        images: event.images.length > 0 ? event.images : null,
        metadata: event.metadata,
        is_active: isActive,
        last_verified_at: this.now.toISOString(),
        dedupe_key: dedupeKey,
        venue_name_key: venueNameKey,
      });

      for (const occ of event.occurrences) {
        this.instanceBatch.push({
          id: await deterministicUuid([
            event.source,
            'instance',
            occ.sourceInstanceId,
          ]),
          event_id: eventId,
          starts_at: occ.startsAt,
          ends_at: occ.endsAt,
          live_now: false,
          source: event.source,
          source_instance_id: occ.sourceInstanceId,
        });
      }

      // Se vuelcan juntos: los lotes se agrupan para no gastar una
      // subpetición por fila (límite de 50 por invocación en Cloudflare).
      if (
        this.eventBatch.length >= SupabaseWriter.ROW_BATCH_SIZE ||
        this.requestCount >= SupabaseWriter.MAX_REQUESTS
      ) {
        await this.flushRows();
      }
    }
    eventsUpserted += 1;

    // Género que `mapGenre` no reconoce: se registra para poder mapearlo luego
    // sin desplegar código (bucle de mejora).
    if (event.genre === null) {
      await this.registerUnmappedGenre(event);
    }

    if (!this.dryRun && event.occurrences.length > 0) {
      // Ya encoladas arriba, junto a su evento.
    }
    instancesUpserted += event.occurrences.length;

    return { eventId, eventsUpserted, instancesUpserted };
  }

  /**
   * Fase 2 de la ingesta: resolver entidades duplicadas.
   *
   * Busca también en la BD las filas con la MISMA huella que llegaron en
   * corridas anteriores (un par duplicado puede entrar en lotes distintos:
   * T1 captura uno y T3 el otro). Sin esa búsqueda el dedupe solo valdría
   * dentro de la corrida.
   *
   * Nunca borra: escribe el alias y marca el perdedor `is_active = false`
   * (el feed ya lo excluye). Los favoritos cuelgan de `event_instance_id`,
   * y las instancias del perdedor se conservan → ningún favorito se rompe.
   */
  async reconcileDuplicates(
    candidates: DedupeCandidateRow[]
  ): Promise<DedupeReconcileResult> {
    const empty: DedupeReconcileResult = { aliases: 0, hidden: 0, reviewOnly: 0 };
    if (candidates.length === 0) return empty;

    const keys = [...new Set(candidates.map((c) => c.dedupeKey))].filter(
      (k): k is string => typeof k === 'string' && k.length > 0
    );
    if (keys.length === 0) return empty;

    // 1) Filas ya en la BD con esas huellas (pueden ser de corridas previas).
    const byEventId = new Map<string, DedupeCandidate>();
    const addCandidate = (row: DedupeCandidate): void => {
      if (typeof row.dedupeKey !== 'string' || row.dedupeKey.length === 0) return;
      const existing = byEventId.get(row.eventId);
      // Gana la fila más reciente/activa: una ya fusionada manda sobre la vista.
      if (!existing || (row.isActive && !existing.isActive)) {
        byEventId.set(row.eventId, row);
      }
    };

    if (!this.dryRun) {
      for (let i = 0; i < keys.length; i += 100) {
        const slice = keys.slice(i, i + 100);
        const { data, error } = await this.client
          .from('events')
          .select('id, source, source_event_id, title, dedupe_key, venue_name_key, is_active')
          .in('dedupe_key', slice);
        if (error) throw error;
        for (const row of data ?? []) {
          addCandidate({
            eventId: row['id'] as string,
            source: row['source'] as DedupeCandidate['source'],
            sourceEventId: (row['source_event_id'] as string) ?? '',
            title: (row['title'] as string) ?? '',
            dedupeKey: (row['dedupe_key'] as string) ?? '',
            venueNameKey: (row['venue_name_key'] as string) ?? '',
            isActive: row['is_active'] !== false,
          });
        }
      }
    }

    // 2) Las que acaba de escribir esta corrida.
    for (const candidate of candidates) {
      addCandidate({
        eventId: candidate.eventId,
        source: candidate.source,
        sourceEventId: candidate.sourceEventId,
        title: candidate.title,
        dedupeKey: candidate.dedupeKey,
        venueNameKey: candidate.venueNameKey,
        isActive: candidate.isActive,
      });
    }

    const plan = planDedupe([...byEventId.values()]);

    let aliases = 0;
    let hidden = 0;
    let reviewOnly = 0;

    if (!this.dryRun) {
      for (const decision of plan.decisions) {
        const { error: aliasErr } = await this.client
          .from('event_aliases')
          .upsert(
            {
              source: decision.loser.source,
              source_event_id: decision.loser.sourceEventId,
              canonical_event_id: decision.canonical.eventId,
              confidence: decision.confidence,
              reason: decision.reason,
            },
            { onConflict: 'source,source_event_id' },
          );
        if (aliasErr) throw aliasErr;
        aliases += 1;
        // La caché de perdedores se mantiene al día para el resto de la corrida.
        this.aliasLosers?.add(
          `${decision.loser.source}:${decision.loser.sourceEventId}`
        );

        // Solo la fusión automática oculta. La cola de revisión deja el evento
        // visible: dos funciones en salas distintas son un dato legítimo.
        if (!decision.auto) {
          reviewOnly += 1;
          continue;
        }

        // `.select('id')` + el filtro `is_active = true` hace que `hidden`
        // cuente filas REALMENTE cambiadas. Sin esto, cada corrida volvería a
        // contar como "duplicados ocultados" los que ya estaban fusionados y la
        // métrica crecería sin parar (engañando a Sentinel).
        const { data: hiddenRows, error: hideErr } = await this.client
          .from('events')
          .update({ is_active: false, merged_into: decision.canonical.eventId })
          .eq('id', decision.loser.eventId)
          .eq('is_active', true)
          .select('id');
        if (hideErr) throw hideErr;
        hidden += hiddenRows?.length ?? 0;
      }
    } else {
      aliases = plan.decisions.length;
      hidden = plan.autoMerges;
      reviewOnly = plan.reviewOnly;
    }

    return { aliases, hidden, reviewOnly };
  }
}