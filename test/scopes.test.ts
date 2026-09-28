import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildScopes, parseCities } from '../src/scopes.ts';

const FIXED_FROM = new Date('2026-09-14T00:00:00Z');
const FIXED_TO = new Date('2026-09-24T00:00:00Z');

describe('buildScopes', () => {
  it('particiona en 1 ventana de 10 días para un rango de 10 días', () => {
    const scopes = buildScopes({
      cities: [{ city: 'Madrid', latlong: '40.41,-3.70', radiusKm: 50 }],
      from: FIXED_FROM,
      to: FIXED_TO,
      windowDays: 10,
      source: 'ticketmaster',
      countryCode: 'ES',
    });
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0].params.countryCode, 'ES');
    assert.equal(scopes[0].params.unit, 'km');
    assert.equal(scopes[0].key, 'Madrid-2026-09-14--2026-09-24');
  });

  it('crea varias ventanas para rangos largos', () => {
    // 14-sep → 24-oct = 40 días → 4 ventanas de 10 días
    const scopes = buildScopes({
      cities: [{ city: 'Madrid', latlong: '40.41,-3.70', radiusKm: 50 }],
      from: FIXED_FROM,
      to: new Date('2026-10-24T00:00:00Z'),
      windowDays: 10,
      source: 'ticketmaster',
      countryCode: 'ES',
    });
    assert.equal(scopes.length, 4);
    const windowsSoFar = new Set();
    for (const s of scopes) {
      assert.ok(!windowsSoFar.has(s.key));
      windowsSoFar.add(s.key);
    }
  });

  it('multiplica por número de ciudades', () => {
    const scopes = buildScopes({
      cities: parseCities('a|1,1|10;b|2,2|10'),
      from: FIXED_FROM,
      to: FIXED_TO,
      windowDays: 10,
      source: 'ticketmaster',
      countryCode: 'ES',
    });
    assert.equal(scopes.length, 2);
  });

  it('devuelve vacío si el rango está invertido', () => {
    const scopes = buildScopes({
      cities: parseCities('a|1,1|10'),
      from: FIXED_TO,
      to: FIXED_FROM,
      windowDays: 10,
      source: 'ticketmaster',
      countryCode: 'ES',
    });
    assert.equal(scopes.length, 0);
  });
});

describe('parseCities', () => {
  it('parsea el formato nombre|lat,lng|radio separado por ;', () => {
    const cities = parseCities('madrid|40.4168,-3.7038|50;bcn|41.3874,2.1686|40');
    assert.equal(cities.length, 2);
    assert.deepEqual(
      cities.map((c) => c.city),
      ['madrid', 'bcn']
    );
    assert.equal(cities[0].latlong, '40.4168,-3.7038');
    assert.equal(cities[0].radiusKm, 50);
  });

  it('usa radios por defecto si faltan', () => {
    assert.equal(parseCities('madrid|40.41,-3.70|')[0].radiusKm, 50);
  });

  it('usa las ciudades por defecto si la env está vacía', () => {
    assert.ok(parseCities('').length >= 5);
    assert.ok(parseCities(undefined).length >= 5);
  });

  it('lanza error en formato inválido', () => {
    assert.throws(() => parseCities('madrid||50'));
    assert.throws(() => parseCities('madrid|no-num,-3.70|50'));
  });
});