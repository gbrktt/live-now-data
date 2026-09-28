import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapGenre } from '../src/genre.ts';

describe('mapGenre', () => {
  it('mapea subgénero exacto', () => {
    assert.equal(mapGenre('Rock', 'Hard Rock'), 'rock');
    assert.equal(mapGenre('Jazz & Blues', 'Vocal Jazz'), 'jazz');
    assert.equal(mapGenre('EDM/Electronic', 'Techno'), 'electronic');
    assert.equal(mapGenre('Rock', 'Smooth Jazz'), 'jazz');
  });

  it('cae al género exacto cuando no hay subgénero', () => {
    assert.equal(mapGenre('Indie & Alternative', undefined), 'indie');
    assert.equal(mapGenre('Pop', null), 'pop');
    assert.equal(mapGenre('Dance/Electronic', ''), 'electronic');
  });

  it('tolera mayúsculas, espacios y &', () => {
    assert.equal(mapGenre('  ROCK ', '  '), 'rock');
    assert.equal(mapGenre('R&B', null), 'jazz');
    assert.equal(mapGenre('indie & alternative', 'Indie Rock'), 'indie');
  });

  it('usa reglas por keyword como fallback', () => {
    assert.equal(mapGenre('Heavy Metal', undefined), 'rock');
    assert.equal(mapGenre('Electronic', 'Deep House'), 'electronic');
    assert.equal(mapGenre('undefined', 'Indie Folk'), 'indie');
  });

  it('mapea géneros latinos a pop (verificado con datos reales ES)', () => {
    assert.equal(mapGenre('Latin', 'Latin'), 'pop');
    assert.equal(mapGenre('Latin', 'Reggaeton'), 'pop');
    assert.equal(mapGenre('Latin', 'Urbano'), 'pop');
  });

  it('devuelve null para géneros desconocidos', () => {
    assert.equal(mapGenre('Comedy', null), null);
    assert.equal(mapGenre(null, null), null);
    assert.equal(mapGenre(undefined, 'Sports'), null);
    assert.equal(mapGenre('Miscellaneous', 'Other'), null);
  });

  it('no rompe con nombres vacíos', () => {
    assert.equal(mapGenre('', ''), null);
    assert.equal(mapGenre(' ', '  '), null);
  });
});