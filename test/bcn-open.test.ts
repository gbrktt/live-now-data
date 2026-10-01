import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConcertRow,
  isConcertTitle,
} from '../src/adapters/bcn-open.ts';
import {
  BcnOpenNormalizer,
  venueLabelFromAddress,
} from '../src/normalize/bcn-open.ts';

// Títulos reales medidos en la agenda de Barcelona (2026-09-30).
const CONCIERTOS = [
  '"Concert de Nadal", Orquestra de cambra catalana',
  "Concert \"Hillbilly Moon Explosion\"",
  "Concert 'Gipsy Nur Project'",
  "Concert \"Kolochi baw\"",
  'Festival internacional de música experimental',
  "Concert d'Any Nou amb l'Orquestra Simfònica del Vallès",
  "Festival 'Feroe'26' amb 'St. Paul & The Broken Bones'",
  'Vermuts Musicals a la Masia',
];

const NO_MUSICA = [
  'Taller "Flamenc"',
  "Taller 'Guitarra'",
  "Cant bàsic per a principiants",
  'Iniciació a la interpretació teatral',
  'Exposició de fotografia contemporània',
  'Xerrada "Presentació de la restauració"',
  'Visita guiada al castell',
  'Acte d’inauguració del curs 26-27 al Conservatori',
];

describe('isConcertTitle', () => {
  for (const title of CONCIERTOS) {
    it(`acepta: ${title.slice(0, 40)}`, () => {
      assert.equal(isConcertTitle(title), true);
    });
  }
  for (const title of NO_MUSICA) {
    it(`rechaza: ${title.slice(0, 40)}`, () => {
      assert.equal(isConcertTitle(title), false);
    });
  }
});

describe('isConcertRow', () => {
  it('usa la categoría cuando el CSV la trae', () => {
    assert.equal(
      isConcertRow({ secondary_filters_name: 'Música', name: 'Cualquier cosa' }),
      true
    );
    assert.equal(
      isConcertRow({
        secondary_filters_name: 'Cursos i tallers >> Cant, música, dansa i balls',
        name: 'Concert de algo',
      }),
      false
    );
  });

  it('cae al título cuando la taxonomía viene vacía (el CSV real)', () => {
    assert.equal(
      isConcertRow({ secondary_filters_name: '', name: 'Concert de Nadal' }),
      true
    );
    assert.equal(
      isConcertRow({ secondary_filters_name: '', name: 'Taller de guitarra' }),
      false
    );
  });
});

describe('venueLabelFromAddress', () => {
  it('compone calle y número', () => {
    assert.equal(
      venueLabelFromAddress({
        addresses_road_name: 'Carrer de Las Navas de Tolosa',
        addresses_start_street_number: '312',
        addresses_district_name: 'Sant Andreu',
      }),
      'Carrer de Las Navas de Tolosa, 312'
    );
  });

  it('cae al distrito si no hay calle', () => {
    assert.equal(
      venueLabelFromAddress({ addresses_district_name: 'Sant Andreu' }),
      'Sant Andreu'
    );
  });
});

describe('BcnOpenNormalizer', () => {
  const normalizer = new BcnOpenNormalizer();
  const baseRow = {
    register_id: '99400786657',
    name: '"Concert de Nadal", Orquestra de cambra catalana',
    start_date: '2026-12-18T03:00:00+01:00',
    end_date: '2026-12-18T05:00:00+01:00',
    geo_epgs_4326_lat: '41.41693998158291',
    geo_epgs_4326_lon: '2.184931573020558',
    addresses_road_name: 'Carrer de Las Navas de Tolosa',
    addresses_start_street_number: '312',
    addresses_district_name: 'Sant Andreu',
    addresses_town: 'Barcelona',
    values_value: 'https://barcelona.cat/inscripcions',
  };

  it('normaliza un concierto completo', async () => {
    const event = await normalizer.toCanonical(baseRow);
    assert.ok(event);
    assert.equal(event.source, 'bcn_open');
    assert.equal(event.sourceEventId, '99400786657');
    assert.equal(event.occurrences[0].startsAt, '2026-12-18T02:00:00.000Z');
    assert.equal(event.venue.lat, 41.41693998158291);
    assert.equal(event.venue.city, 'Barcelona');
    assert.equal(event.venue.name, 'Carrer de Las Navas de Tolosa, 312');
    assert.equal(event.externalUrl, 'https://barcelona.cat/inscripcions');
    // Sin precio en el CSV: null NUNCA "gratis" (la app lo muestra como consultar).
    assert.equal(event.priceFrom, null);
    assert.equal(event.images.length, 0);
  });

  it('es idempotente: mismo id y mismo venue_id', async () => {
    const a = await normalizer.toCanonical(baseRow);
    const b = await normalizer.toCanonical(baseRow);
    assert.ok(a);
    assert.ok(b);
    assert.equal(a.sourceEventId, b.sourceEventId);
    assert.equal(a.venue.sourceVenueId, b.venue.sourceVenueId);
  });

  it('descarta filas sin coordenadas (el feed no las podría situar)', async () => {
    assert.equal(
      await normalizer.toCanonical({ ...baseRow, geo_epgs_4326_lat: '' }),
      null
    );
  });

  it('descarta filas sin fecha válida', async () => {
    assert.equal(await normalizer.toCanonical({ ...baseRow, start_date: '' }), null);
  });

  it('estima la duración si end_date es anterior al inicio', async () => {
    const event = await normalizer.toCanonical({
      ...baseRow,
      end_date: baseRow.start_date,
    });
    assert.ok(event);
    const hours =
      (new Date(event.occurrences[0].endsAt!).getTime() -
        new Date(event.occurrences[0].startsAt).getTime()) /
      3_600_000;
    assert.equal(hours, 3);
  });

  it('convierte el HTML del timetable en texto', async () => {
    const event = await normalizer.toCanonical({
      ...baseRow,
      timetable: '<table><tr><td>Dijous</td><td>a les 18.00&nbsp;h</td></tr></table>',
    });
    assert.ok(event);
    assert.ok(event.description);
    assert.ok(!event.description!.includes('<'));
  });
});
