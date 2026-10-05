/**
 * Tests de la fuente `madrid_open` (Fase 1 · cobertura Madrid).
 *
 * Lote: sistema multi-fuente de ingesta — adaptador + normalizador de la
 * agenda cultural de datos.madrid.es. Validación: `.clinerules/30-validation.md`
 * (typecheck + node --test en `live-now-data`).
 *
 * Los títulos/tipos citados son filas REALES medidas en el CSV de
 * datos.madrid.es (2026-10-05, 1417 filas, 147 musicales).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConcertRow,
  MADRID_OPEN_DEFAULT_URL,
  MadridOpenAdapter,
} from '../src/adapters/madrid-open.ts';
import {
  MadridOpenNormalizer,
  genreFromRow,
  venueAddressFromRow,
  venueLabelFromRow,
} from '../src/normalize/madrid-open.ts';

/** Fila real: concierto en el Conde Duque (TIPO Musica). */
const JAZZ_ROW: Record<string, string> = {
  'ID-EVENTO': '50430557',
  TITULO: 'Aires Iberoamérica, con Jasminum Ensemble',
  PRECIO: '',
  GRATUITO: '1',
  'LARGA-DURACION': '0',
  'DIAS-SEMANA': '',
  'DIAS-EXCLUIDOS': '',
  FECHA: '2026-10-10 00:00:00.0',
  'FECHA-FIN': '2026-10-10 23:59:00.0',
  HORA: '19:00',
  DESCRIPCION:
    'Aires de Iberoamérica es un viaje musical entre España y Latinoamérica. Duración: 60 minutos.',
  'CONTENT-URL': 'https://www.madrid.es/vista/actividad/1',
  'URL-ACTIVIDAD': 'https://www.madrid.es/vista/actividad/2',
  'URL-INSTALACION': 'https://www.madrid.es/vista/instalacion/3',
  'NOMBRE-INSTALACION': 'Centro Cultural Conde Duque',
  'CLASE-VIAL-INSTALACION': 'CALLE',
  'NOMBRE-VIA-INSTALACION': 'CONDE DUQUE',
  'NUM-INSTALACION': '9',
  'DISTRITO-INSTALACION': 'CENTRO',
  'BARRIO-INSTALACION': 'UNIVERSIDAD',
  'CODIGO-POSTAL-INSTALACION': '28015',
  LATITUD: '40.42739911262292',
  LONGITUD: '-3.710589286287491',
  TIPO: '/contenido/actividades/Musica',
  AUDIENCIA: '/usuario/Adultos',
};

describe('madrid-open · isConcertRow (filtro)', () => {
  it('acepta el subárbol /Musica con cualquier subgénero', () => {
    for (const tipo of [
      '/contenido/actividades/Musica',
      '/contenido/actividades/Musica/JazzSoulFunkySwingReagge',
      '/contenido/actividades/Musica/CoroGospel',
      '/contenido/actividades/Musica/Flamenco',
      '/contenido/actividades/Musica/Clasica',
      '/contenido/actividades/Musica/RockPop',
    ]) {
      assert.equal(
        isConcertRow({ ...JAZZ_ROW, TIPO: tipo, TITULO: 'Ciclo de conciertos' }),
        true,
        tipo
      );
    }
  });

  it('excluye talleres y cursos etiquetados como música', () => {
    // Filas reales: "Taller de iniciación a castañuelas…",
    // "Jugando con la música: Taller de iniciación…".
    assert.equal(
      isConcertRow({
        ...JAZZ_ROW,
        TITULO: 'Taller de iniciación a castañuelas. Turno de tarde',
      }),
      false
    );
    assert.equal(
      isConcertRow({
        ...JAZZ_ROW,
        TITULO: 'Jugando con la música: Taller de iniciación al lenguaje musical',
      }),
      false
    );
  });

  it('recall: acepta «concierto» fuera del subárbol si la categoría no lo veta', () => {
    // Real: "Gran concierto de Navidad. Escolanía del Escorial" estaba en
    // ProgramacionDestacada (categoría blanda) → sí es música.
    assert.equal(
      isConcertRow({
        ...JAZZ_ROW,
        TIPO: '/contenido/actividades/ProgramacionDestacadaAgendaCultura',
        TITULO: 'Gran concierto de Navidad. Escolanía del Escorial',
      }),
      true
    );
  });

  it('veta categorías que comparten la palabra «concierto» sin ser música', () => {
    // Real: "Concierto en el Amazonas" es TEATRO;
    // "Las castañuelas como instrumento de concierto" es una EXPOSICIÓN.
    assert.equal(
      isConcertRow({
        ...JAZZ_ROW,
        TIPO: '/contenido/actividades/TeatroPerformance',
        TITULO: 'Concierto en el Amazonas',
      }),
      false
    );
    assert.equal(
      isConcertRow({
        ...JAZZ_ROW,
        TIPO: '/contenido/actividades/Exposiciones',
        TITULO: 'Las castañuelas como instrumento de concierto',
      }),
      false
    );
  });

  it('descarta filas sin indicio de música', () => {
    assert.equal(
      isConcertRow({
        ...JAZZ_ROW,
        TIPO: '/contenido/actividades/Exposiciones',
        TITULO: 'Fotografía documental',
      }),
      false
    );
    assert.equal(isConcertRow({ ...JAZZ_ROW, TIPO: '', TITULO: '' }), false);
  });
});

describe('madrid-open · MadridOpenNormalizer', () => {
  const normalizer = new MadridOpenNormalizer();

  it('normaliza una fila real a canónico con coords e id estable', async () => {
    const canonical = await normalizer.toCanonical(JAZZ_ROW);
    assert.ok(canonical);
    assert.equal(canonical.source, 'madrid_open');
    assert.equal(canonical.sourceEventId, '50430557');
    assert.equal(canonical.title, 'Aires Iberoamérica, con Jasminum Ensemble');
    assert.equal(canonical.venue.lat, 40.42739911262292);
    assert.equal(canonical.venue.lng, -3.710589286287491);
    assert.equal(canonical.venue.city, 'Madrid');
    assert.equal(canonical.venue.timezone, 'Europe/Madrid');
    assert.equal(canonical.venue.name, 'Centro Cultural Conde Duque');
    assert.equal(canonical.venue.address, 'CALLE CONDE DUQUE 9');
    assert.equal(canonical.venue.externalUrl, 'https://www.madrid.es/vista/actividad/2');
    assert.equal(canonical.occurrences.length, 1);
    assert.equal(canonical.occurrences[0].sourceInstanceId, '50430557');
    assert.equal(canonical.isActive, true);
    assert.deepEqual(canonical.images, []);
  });

  it('convierte FECHA+HORA local Madrid a ISO UTC (CEST y CET)', async () => {
    // Octubre (CEST, +2): 19:00 → 17:00Z.
    const summer = await normalizer.toCanonical(JAZZ_ROW);
    assert.equal(summer?.occurrences[0].startsAt, '2026-10-10T17:00:00.000Z');
    // Enero (CET, +1): 20:00 → 19:00Z.
    const winter = await normalizer.toCanonical({
      ...JAZZ_ROW,
      FECHA: '2027-01-15 00:00:00.0',
      HORA: '20:00',
    });
    assert.equal(winter?.occurrences[0].startsAt, '2027-01-15T19:00:00.000Z');
  });

  it('GRATUITO=1 → priceFrom=0 (el filtro «gratis» municipal lo usa)', async () => {
    const canonical = await normalizer.toCanonical(JAZZ_ROW);
    assert.equal(canonical?.priceFrom, 0);
    assert.equal(canonical?.priceTo, 0);
  });

  it('precio con importe → número con coma decimal convertida', async () => {
    const canonical = await normalizer.toCanonical({
      ...JAZZ_ROW,
      GRATUITO: '0',
      PRECIO: '2,6',
    });
    assert.equal(canonical?.priceFrom, 2.6);
  });

  it('sin GRATUITO ni PRECIO → null («consultar», nunca «gratis»)', async () => {
    const canonical = await normalizer.toCanonical({
      ...JAZZ_ROW,
      GRATUITO: '0',
      PRECIO: '',
    });
    assert.equal(canonical?.priceFrom, null);
  });

  it('devuelve null sin coordenadas (el feed es geo-first)', async () => {
    const { LATITUD: _lat, ...withoutLat } = JAZZ_ROW;
    assert.equal(await normalizer.toCanonical(withoutLat), null);
  });

  it('devuelve null sin id o sin fecha utilizable', async () => {
    const { 'ID-EVENTO': _id, ...withoutId } = JAZZ_ROW;
    assert.equal(await normalizer.toCanonical(withoutId), null);
    assert.equal(await normalizer.toCanonical({ ...JAZZ_ROW, FECHA: '' }), null);
    assert.equal(await normalizer.toCanonical({ ...JAZZ_ROW, FECHA: 'no-date' }), null);
  });

  it('recoge la recurrencia en metadata sin romper la ocurrencia única', async () => {
    const canonical = await normalizer.toCanonical({
      ...JAZZ_ROW,
      'LARGA-DURACION': '1',
      'DIAS-SEMANA': 'L,M,X,J,V,S,D',
    });
    const recurrence = (canonical?.metadata as Record<string, unknown>)?.['recurrence'];
    assert.deepEqual(recurrence, {
      daysOfWeek: 'L,M,X,J,V,S,D',
      until: '2026-10-10',
    });
    assert.equal(canonical?.occurrences.length, 1);
  });

  it('metadata trae procedencia municipal, barrio y audiencia', async () => {
    const canonical = await normalizer.toCanonical(JAZZ_ROW);
    const meta = canonical?.metadata as Record<string, unknown>;
    assert.equal(meta['providerName'], 'Agenda cultural de Madrid (datos abiertos)');
    assert.equal(meta['district'], 'CENTRO');
    assert.equal(meta['neighborhood'], 'UNIVERSIDAD');
    assert.equal(meta['free'], true);
    assert.equal(meta['providerTipo'], '/contenido/actividades/Musica');
  });
});

describe('madrid-open · genreFromRow', () => {
  it('usa el subgénero de TIPO cuando lo reconoce', () => {
    assert.equal(
      genreFromRow('X', '/contenido/actividades/Musica/JazzSoulFunkySwingReagge'),
      'jazz'
    );
    assert.equal(genreFromRow('X', '/contenido/actividades/Musica/Clasica'), 'classical');
    assert.equal(genreFromRow('X', '/contenido/actividades/Musica/RockPop'), 'rock');
    assert.equal(genreFromRow('X', '/contenido/actividades/Musica/Flamenco'), 'pop');
  });

  it('cae a reglas por título cuando el TIPO es genérico', () => {
    assert.equal(
      genreFromRow('Concierto de swing en el Conde Duque', '/contenido/actividades/Musica'),
      'jazz'
    );
    assert.equal(
      genreFromRow('Fotografía documental', '/contenido/actividades/Exposiciones'),
      null
    );
  });
});

describe('madrid-open · venue helpers', () => {
  it('compone dirección y usa la instalación como nombre de sala', () => {
    assert.equal(venueAddressFromRow(JAZZ_ROW), 'CALLE CONDE DUQUE 9');
    assert.equal(venueLabelFromRow(JAZZ_ROW), 'Centro Cultural Conde Duque');
  });

  it('sin instalación cae a la dirección (patrón BCN)', () => {
    const row = { ...JAZZ_ROW, 'NOMBRE-INSTALACION': '' };
    assert.equal(venueLabelFromRow(row), 'CALLE CONDE DUQUE 9');
  });

  it('sin nada → etiqueta por defecto', () => {
    const row = {
      'NOMBRE-INSTALACION': '',
      'CLASE-VIAL-INSTALACION': '',
      'NOMBRE-VIA-INSTALACION': '',
      'NUM-INSTALACION': '',
    };
    assert.equal(venueLabelFromRow(row), 'Espacio municipal');
  });
});

describe('madrid-open · MadridOpenAdapter', () => {
  const header = [
    ' ID-EVENTO',
    'TITULO',
    'PRECIO',
    'GRATUITO',
    'LARGA-DURACION',
    'DIAS-SEMANA',
    'DIAS-EXCLUIDOS',
    'FECHA',
    'FECHA-FIN',
    'HORA',
    'DESCRIPCION',
    'CONTENT-URL',
    'TITULO-ACTIVIDAD',
    'URL-ACTIVIDAD',
    'URL-INSTALACION',
    'NOMBRE-INSTALACION',
    'ACCESIBILIDAD-INSTALACION',
    'CLASE-VIAL-INSTALACION',
    'NOMBRE-VIA-INSTALACION',
    'NUM-INSTALACION',
    'DISTRITO-INSTALACION',
    'BARRIO-INSTALACION',
    'CODIGO-POSTAL-INSTALACION',
    'COORDENADA-X',
    'COORDENADA-Y',
    'LATITUD',
    'LONGITUD',
    'TIPO',
    'AUDIENCIA',
  ].join(';');

  function dataRow(
    id: string,
    title: string,
    fecha: string,
    hora: string,
    tipo: string
  ): string {
    return [
      id,
      `"${title}"`,
      '""',
      '"1"',
      '"0"',
      '""',
      '""',
      `"${fecha} 00:00:00.0"`,
      `"${fecha} 23:59:00.0"`,
      `"${hora}"`,
      '""',
      '""',
      '""',
      '""',
      '""',
      '""',
      '""',
      '""',
      '""',
      '""',
      '""',
      '""',
      '""',
      '""',
      '""',
      '"40.4"',
      '"-3.7"',
      `"${tipo}"`,
      '""',
    ].join(';');
  }

  const CSV_FIXTURE = [
    header,
    dataRow('1', 'Concierto de jazz', '2026-10-10', '19:00', '/contenido/actividades/Musica'),
    dataRow('2', 'Taller de castañuelas', '2026-10-11', '17:00', '/contenido/actividades/Musica'),
    dataRow('3', 'Concierto fuera de ventana', '2026-12-24', '20:00', '/contenido/actividades/Musica'),
    dataRow('4', 'Obra titulada Concierto', '2026-10-12', '19:00', '/contenido/actividades/TeatroPerformance'),
  ].join('\n');

  function fixtureAdapter(): MadridOpenAdapter {
    return new MadridOpenAdapter({
      fetchFn: (async () =>
        new Response(CSV_FIXTURE, {
          status: 200,
          headers: { 'Content-Type': 'text/csv' },
        })) as unknown as typeof fetch,
    });
  }

  const scope = {
    key: 'madrid_open-test',
    source: 'madrid_open' as const,
    params: {
      from: '2026-10-10T00:00:00.000Z',
      to: '2026-10-13T00:00:00.000Z',
    },
  };

  it('filtra por concierto y ventana temporal (una sola página)', async () => {
    const adapter = fixtureAdapter();
    const batch = await adapter.fetchScopeBatch(scope, 0);
    // Esperados: fila 1 (en ventana, música); excluidas: 2 (taller),
    // 3 (fuera de ventana), 4 (teatro con "Concierto" en el título).
    assert.equal(batch.totalElements, 1);
    assert.equal(batch.totalPages, 1);
    const rows = batch.events as Record<string, string>[];
    const first = rows[0] ?? {};
    assert.equal(first['ID-EVENTO'] ?? first[' ID-EVENTO'], '1');
  });

  it('page > 0 devuelve vacío (sin paginación)', async () => {
    const batch = await fixtureAdapter().fetchScopeBatch(scope, 1);
    assert.deepEqual(batch.events, []);
    assert.equal(batch.totalPages, 0);
  });

  it('expone la URL pública por defecto de datos.madrid.es', () => {
    assert.match(MADRID_OPEN_DEFAULT_URL, /^https:\/\/datos\.madrid\.es\//);
  });
});

