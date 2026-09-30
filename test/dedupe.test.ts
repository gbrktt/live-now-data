import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_MERGE_CONFIDENCE,
  REVIEW_CONFIDENCE,
  baseTitle,
  buildDedupeKey,
  geoCell,
  hasCommercialSuffix,
  normalizeText,
  pickCanonical,
  planDedupe,
  type DedupeCandidate,
} from '../src/ingest/dedupe.ts';

// Coordenadas reales medidas en la BD el 2026-09-30.
const PALAU = { lat: 41.36337, lng: 2.15259 };
const RAZZ = { lat: 41.39701, lng: 2.19147 };
const SHAKIRA = { lat: 40.45449, lng: -3.69404 };

function candidate(
  partial: Partial<DedupeCandidate> & {
    sourceEventId: string;
    title: string;
    startsAt: string;
    venueName: string;
    geo: { lat: number; lng: number };
    eventId?: string;
  }
): DedupeCandidate {
  return {
    source: 'ticketmaster',
    eventId: partial.eventId ?? `id-${partial.sourceEventId}`,
    dedupeKey: buildDedupeKey({
      title: partial.title,
      startsAt: partial.startsAt,
      lat: partial.geo.lat,
      lng: partial.geo.lng,
    }),
    venueNameKey: normalizeText(partial.venueName),
    isActive: true,
    ...partial,
  } as DedupeCandidate;
}

describe('baseTitle', () => {
  it('elimina el sufijo comercial de los listados VIP (caso real)', () => {
    const base = 'Hombres G - Los Mejores Años de nuestra vida';
    assert.equal(baseTitle(`${base} | VIP Packages`), baseTitle(base));
    assert.equal(
      baseTitle(`${base} | VIP Packages`),
      'hombres g los mejores anos de nuestra vida'
    );
  });

  it('corta también por corchetes', () => {
    assert.equal(baseTitle('Concierto [Cancelado]'), 'concierto');
  });

  it('normaliza acentos, signos y mayúsculas', () => {
    assert.equal(normalizeText('Los  Mejores AÑOS, ¿no?'), 'los mejores anos no');
  });

  it('detecta si el título lleva sufijo comercial', () => {
    assert.equal(hasCommercialSuffix('Placebo - 30th Anniversary Tour'), false);
    assert.equal(
      hasCommercialSuffix('Placebo - 30th Anniversary Tour | VIP Packages'),
      true
    );
  });
});

describe('buildDedupeKey', () => {
  it('agrupa el mismo concierto con y sin sufijo VIP', () => {
    const base = 'Placebo - 30th Anniversary Tour';
    const a = buildDedupeKey({
      title: base,
      startsAt: '2026-10-01T18:45:00.000Z',
      ...PALAU,
    });
    const b = buildDedupeKey({
      title: `${base} | VIP Packages`,
      startsAt: '2026-10-01T18:45:00.000Z',
      ...PALAU,
    });
    assert.equal(a, b);
  });

  // LA GUARDA CRÍTICA: sin la hora exacta, la gira se comería (272 eventos).
  it('NO agrupa fechas distintas del mismo cartel (gira de 12 fechas)', () => {
    const title = 'SHAKIRA - LAS MUJERES YA NO LLORAN - RESIDENCIA EUROPEA';
    const keys = new Set(
      Array.from({ length: 12 }, (_, i) =>
        buildDedupeKey({
          title,
          startsAt: new Date(Date.UTC(2026, 9, 2 + i, 19)).toISOString(),
          ...SHAKIRA,
        })
      )
    );
    assert.equal(keys.size, 12, 'las 12 fechas deben ser huellas distintas');
  });

  it('NO agrupa horas distintas del mismo concierto en la misma sala', () => {
    const title = 'Blood Red Shoes';
    const a = buildDedupeKey({
      title,
      startsAt: '2026-10-03T17:00:00.000Z',
      ...RAZZ,
    });
    const b = buildDedupeKey({
      title,
      startsAt: '2026-10-03T19:00:00.000Z',
      ...RAZZ,
    });
    assert.notEqual(a, b);

describe('planDedupe', () => {
  // Caso real #1: el mismo concierto listado dos veces por Ticketmaster.
  it('fusiona el duplicado VIP y elige el título limpio', () => {
    const title = 'Hombres G - Los Mejores Años de nuestra vida';
    const plan = planDedupe([
      candidate({
        sourceEventId: 'Z1k17k6PS',
        title: `${title} | VIP Packages`,
        startsAt: '2026-10-01T19:00:00.000Z',
        venueName: 'Palau Sant Jordi',
        geo: PALAU,
      }),
      candidate({
        sourceEventId: 'Z1kjMvkop',
        title,
        startsAt: '2026-10-01T19:00:00.000Z',
        venueName: 'Palau Sant Jordi',
        geo: PALAU,
      }),
    ]);

    assert.equal(plan.groups, 1);
    assert.equal(plan.autoMerges, 1);
    assert.equal(plan.reviewOnly, 0);
    const [decision] = plan.decisions;
    // Gana el que NO lleva sufijo, aunque llegue segundo.
    assert.equal(decision.canonical.title, title);
    assert.equal(decision.loser.title, `${title} | VIP Packages`);
    assert.equal(decision.confidence, AUTO_MERGE_CONFIDENCE);
    assert.equal(decision.reason, 'same-venue');
    assert.equal(decision.auto, true);
  });

  // Caso real #2: Blood Red Shoes, 2 salas con coordenada IDÉNTICA (0 m).
  it('NO auto-oculta el mismo cartel en salas distintas de un mismo complejo', () => {
    const plan = planDedupe([
      candidate({
        sourceEventId: 'A',
        title: 'Blood Red Shoes',
        startsAt: '2026-10-03T19:00:00.000Z',
        venueName: 'Sala Razzmatazz 2',
        geo: RAZZ,
      }),
      candidate({
        sourceEventId: 'B',
        title: 'Blood Red Shoes',
        startsAt: '2026-10-03T19:00:00.000Z',
        venueName: 'Sala Razzmatazz 3',
        geo: RAZZ,
      }),
    ]);

    assert.equal(plan.groups, 1, 'comparten huella: el geo no las separa');
    assert.equal(plan.autoMerges, 0, 'pero NO se deben ocultar');
    assert.equal(plan.reviewOnly, 1, 'van a la cola de revisión');
    assert.equal(plan.decisions[0].confidence, REVIEW_CONFIDENCE);
    assert.equal(plan.decisions[0].reason, 'venue-name-differs');
    assert.equal(plan.decisions[0].auto, false);
  });

  it('deja intactas las 12 fechas de una gira', () => {
    const title = 'SHAKIRA - LAS MUJERES YA NO LLORAN - RESIDENCIA EUROPEA';
    const plan = planDedupe(
      Array.from({ length: 12 }, (_, i) =>
        candidate({
          sourceEventId: `sha-${i}`,
          title,
          startsAt: new Date(Date.UTC(2026, 9, 2 + i, 19)).toISOString(),
          venueName: 'Estadio Shakira (Iberdrola Music)',
          geo: SHAKIRA,
        })
      )
    );
    assert.equal(plan.groups, 0);
    assert.equal(plan.decisions.length, 0);
  });

  it('es idempotente: el resultado no depende del orden de llegada', () => {
    const title = 'Placebo - 30th Anniversary Tour';
    const rows = [
      candidate({
        sourceEventId: 'A',
        title: `${title} | VIP Packages`,
        startsAt: '2026-10-01T18:45:00.000Z',
        venueName: 'Movistar Arena',
        geo: PALAU,
      }),
      candidate({
        sourceEventId: 'B',
        title,
        startsAt: '2026-10-01T18:45:00.000Z',
        venueName: 'Movistar Arena',
        geo: PALAU,
      }),
    ];
    const first = planDedupe(rows);
    const second = planDedupe([...rows].reverse());
    assert.equal(first.autoMerges, 1);
    assert.equal(second.autoMerges, 1);
    assert.equal(
      second.decisions[0].canonical.sourceEventId,
      first.decisions[0].canonical.sourceEventId
    );
  });

  it('ignora candidatos sin huella utilizable', () => {
    const plan = planDedupe([
      {
        source: 'ticketmaster',
        sourceEventId: 'X',
        eventId: 'e1',
        title: 'Algo',
        dedupeKey: '',
        venueNameKey: 'sala',
        isActive: true,
      },
      {
        source: 'ticketmaster',
        sourceEventId: 'Y',
        eventId: 'e2',
        title: 'Algo',
        dedupeKey: '',
        venueNameKey: 'sala',
        isActive: true,
      },
    ]);
    assert.equal(plan.groups, 0);
    assert.equal(plan.decisions.length, 0);
  });
});

describe('pickCanonical', () => {
  it('el título sin sufijo gana; a igualdad, el source_event_id menor', () => {
    const a = candidate({
      sourceEventId: 'zzz',
      title: 'Concierto | VIP Packages',
      startsAt: '2026-10-01T19:00:00.000Z',
      venueName: 'Sala X',
      geo: PALAU,
    });
    const b = candidate({
      sourceEventId: 'aaa',
      title: 'Concierto',
      startsAt: '2026-10-01T19:00:00.000Z',
      venueName: 'Sala X',
      geo: PALAU,
    });
    assert.equal(pickCanonical([a, b]).sourceEventId, 'aaa');

    const c = candidate({
      sourceEventId: 'mmm',
      title: 'Concierto',
      startsAt: '2026-10-01T19:00:00.000Z',
      venueName: 'Sala X',
      geo: PALAU,
    });
    // Empate de formato -> desempate estable por id.
    assert.equal(pickCanonical([c, b]).sourceEventId, 'aaa');
  });

  it('un evento visible gana a uno ya fusionado', () => {
    // Regresión: si el canónico fuera una fila ya oculta, la invisibilidad se
    // propagaría al grupo entero en corridas sucesivas.
    const hidden = candidate({
      sourceEventId: 'aaa',
      title: 'Concierto',
      startsAt: '2026-10-01T19:00:00.000Z',
      venueName: 'Sala X',
      geo: PALAU,
    });
    hidden.isActive = false;
    const visible = candidate({
      sourceEventId: 'zzz',
      title: 'Concierto | VIP Packages',
      startsAt: '2026-10-01T19:00:00.000Z',
      venueName: 'Sala X',
      geo: PALAU,
    });
    assert.equal(pickCanonical([hidden, visible]).sourceEventId, 'zzz');
  });
});

  });

  it('la celda geo agrupa salas a menos de ~1 km', () => {
    assert.equal(geoCell(41.39701, 2.19147), geoCell(41.39772, 2.19111));
    assert.notEqual(geoCell(41.397, 2.191), geoCell(41.363, 2.152));
  });
});
