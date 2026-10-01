/**
 * Resolución de entidades entre fuentes (C2 · deduplicación).
 *
 * Lógica pura, sin red ni base de datos, para poder testearla con los casos
 * REALES medidos contra Ticketmaster el 2026-09-30:
 *
 *   · A fusionar (8):  "Placebo … Tour" y "Placebo … Tour | VIP Packages" con
 *     la misma hora y el mismo venue. Ticketmaster se duplica a sí mismo.
 *   · A NO fusionar (272): las 12 fechas de la gira de Shakira en el Estadio
 *     Shakira, y "Blood Red Shoes" en Razzmatazz 2 vs 3 (salas distintas con
 *     coordenada IDÉNTICA: 0 m de distancia).
 *
 * Por eso la huella lleva la HORA EXACTA de inicio y la confianza depende
 * del nombre del venue: el geo por sí solo no identifica una sala.
 *
 * Diseño de niveles (umbrales del §9 de docs/PROPUESTA.md):
 *   · confianza 1.00 → fusión automática (el perdedor se oculta).
 *   · confianza 0.80 → cola de revisión: se registra el alias pero NO se
 *     oculta nada, porque puede que sean dos funciones reales en salas
 *     distintas (el caso medido de Razzmatazz 2 vs 3, a 0 m de distancia).
 */

import type { SourceCode } from '../types.ts';

/** Confianza mínima para ocultar el perdedor automáticamente. */
export const AUTO_MERGE_CONFIDENCE = 1;
/** Confianza de la cola de revisión: mismo geo, nombre de venue distinto. */
export const REVIEW_CONFIDENCE = 0.8;

/** Sufijos comerciales que la fuente añade a unlisting (≠ un concierto nuevo). */
const COMMERCIAL_TOKENS =
  /\b(vip\s+packages?|packages?|paquete|paquetes|entradas|pass(es)?|promo)\b/g;

/** Quita acentos y signos, deja solo [a-z0-9 ], para comparar nombres. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Título base de un concierto: se queda con la parte anterior al primer
 * separador comercial (`|`, `[…]`) y elimina tokens como "VIP Packages".
 *
 *   "Hombres G - … | VIP Packages"  ->  "hombres g los mejores anos de nuestra vida"
 *   "Hombres G - …"                 ->  "hombres g los mejores anos de nuestra vida"
 */
export function baseTitle(title: string): string {
  const head = title.split(/[|\[]/)[0] ?? '';
  return normalizeText(head.replace(COMMERCIAL_TOKENS, ' '));
}

/** ¿El título lleva sufijo comercial? (gana el que NO lo lleva) */
export function hasCommercialSuffix(title: string): boolean {
  return baseTitle(title) !== normalizeText(title);
}

/**
 * Celda geográfica (~1,1 km) para agrupar sin depender del UUID del venue:
 * entre fuentes distintas la sala es una fila diferente con el mismo punto.
 */
export function geoCell(lat: number, lng: number): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

/** Huella de agrupación: título base + HORA EXACTA + celda geo. */
export function buildDedupeKey(input: {
  title: string;
  startsAt: string;
  lat: number;
  lng: number;
}): string {
  const start = new Date(input.startsAt);
  const iso = Number.isNaN(start.getTime()) ? input.startsAt : start.toISOString();
  return [baseTitle(input.title), iso, geoCell(input.lat, input.lng)].join('|');
}

export interface DedupeCandidate {
  source: SourceCode;
  sourceEventId: string;
  /** UUID determinista del evento (events.id). */
  eventId: string;
  title: string;
  /** Clave ya calculada con `buildDedupeKey`. */
  dedupeKey: string;
  /** Nombre de venue normalizado: decide el nivel de confianza. */
  venueNameKey: string;
  isActive: boolean;
}

export interface DedupeDecision {
  loser: DedupeCandidate;
  canonical: DedupeCandidate;
  confidence: number;
  reason: 'same-venue' | 'venue-name-differs';
  /** true solo si se puede ocultar el perdedor sin revisión humana. */
  auto: boolean;
}

export interface DedupePlan {
  decisions: DedupeDecision[];
  autoMerges: number;
  reviewOnly: number;
  /** Grupos con >1 fila, sean o no fusionables. */
  groups: number;
}

/**
 * Elige el ganador con un ORDEN TOTAL determinista, para que el resultado no
 * dependa del orden de llegada de los lotes:
 *   1) un evento visible gana a uno ya fusionado (no se propaga la invisibilidad);
 *   2) el título sin sufijo comercial gana al que lo lleva;
 *   3) a igualdad, el `source_event_id` menor (criterio arbitrario pero estable).
 */
export function pickCanonical(members: DedupeCandidate[]): DedupeCandidate {
  return [...members].sort((a, b) => {
    const aActive = a.isActive ? 0 : 1;
    const bActive = b.isActive ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    const aClean = hasCommercialSuffix(a.title) ? 1 : 0;
    const bClean = hasCommercialSuffix(b.title) ? 1 : 0;
    if (aClean !== bClean) return aClean - bClean;
    if (a.sourceEventId !== b.sourceEventId) {
      return a.sourceEventId < b.sourceEventId ? -1 : 1;
    }
    return a.eventId < b.eventId ? -1 : 1;
  })[0];
}

/**
 * Agrupa por huella y decide qué se fusiona. No toca la base de datos: solo
 * devuelve el plan, que el writer aplica.
 */
export function planDedupe(candidates: DedupeCandidate[]): DedupePlan {
  const groups = new Map<string, DedupeCandidate[]>();
  for (const candidate of candidates) {
    // Guarda crítica: sin huella NO se agrupa. Si la clave vacía llegara al
    // `Map`, TODOS los eventos sin huella caerían en un único grupo y se
    // fusionarían entre sí, destruyendo el catálogo.
    if (typeof candidate.dedupeKey !== 'string' || candidate.dedupeKey.length === 0) {
      continue;
    }
    const list = groups.get(candidate.dedupeKey);
    if (list) list.push(candidate);
    else groups.set(candidate.dedupeKey, [candidate]);
  }

  const decisions: DedupeDecision[] = [];
  let groupCount = 0;

  for (const members of groups.values()) {
    if (members.length < 2) continue;
    groupCount += 1;
    const canonical = pickCanonical(members);
    for (const loser of members) {
      if (loser.eventId === canonical.eventId) continue;
      const sameVenueName = loser.venueNameKey === canonical.venueNameKey;
      decisions.push({
        loser,
        canonical,
        confidence: sameVenueName ? AUTO_MERGE_CONFIDENCE : REVIEW_CONFIDENCE,
        reason: sameVenueName ? 'same-venue' : 'venue-name-differs',
        auto: sameVenueName,
      });
    }
  }

  return {
    decisions,
    autoMerges: decisions.filter((d) => d.auto).length,
    reviewOnly: decisions.filter((d) => !d.auto).length,
    groups: groupCount,
  };
}
