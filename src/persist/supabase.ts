/**
 * Writer de persistencia idempotente contra Supabase (service role).
 *
 * Claves estables: UUID determinista derivado de `source + id externo`.
 * Un mismo evento/venue/instancia se re-upsertea siempre en la misma fila:
 * re-ejecutar el barrido N veces no crea duplicados (favoritos estables).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  CanonicalEvent,
  CanonicalVenue,
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

  constructor(opts: SupabaseWriterOptions) {
    this.dryRun = opts.dryRun ?? false;
    this.now = opts.now ?? new Date();
    this.client = createClient(opts.url, opts.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
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
      const { error } = await this.client
        .from('venues')
        .upsert(
          {
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
          },
          { onConflict: 'id' },
        );
      if (error) throw error;
    }

    this.venueIdCache.set(cacheKey, id);
    return id;
  }

  async upsertEventWithInstances(
    event: CanonicalEvent,
    venueId: string
  ): Promise<{ eventsUpserted: number; instancesUpserted: number }> {
    const eventId = await deterministicUuid([
      event.source,
      'event',
      event.sourceEventId,
    ]);
    const first = event.occurrences[0];
    let eventsUpserted = 0;
    let instancesUpserted = 0;

    if (!this.dryRun) {
      const { error: evErr } = await this.client
        .from('events')
        .upsert(
          {
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
            is_active: event.isActive,
            last_verified_at: this.now.toISOString(),
          },
          { onConflict: 'id' },
        );
      if (evErr) throw evErr;
    }
    eventsUpserted += 1;

    if (!this.dryRun && event.occurrences.length > 0) {
      const rows = [];
      for (const occ of event.occurrences) {
        rows.push({
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

      const { error: insErr } = await this.client
        .from('event_instances')
        .upsert(rows, { onConflict: 'id' });
      if (insErr) throw insErr;
    }
    instancesUpserted += event.occurrences.length;

    return { eventsUpserted, instancesUpserted };
  }
}