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

  it('mapea flamenco y mundo a pop (datos reales ES 2026-09-30)', () => {
    // 27 de los 43 eventos ES de 7 días venían como `World / Flamenco` y
    // caían a null: invisibles al filtrar por género.
    assert.equal(mapGenre('World', 'Flamenco'), 'pop');
    assert.equal(mapGenre('World', 'World'), 'pop');
    assert.equal(mapGenre('World Music', undefined), 'pop');
    assert.equal(mapGenre('Folk', 'Flamenco Fusion'), 'pop');
    assert.equal(mapGenre('Latin', 'Salsa'), 'pop');
  });

  // El sesgo histórico (78 % `pop`) venía de que `subGenre` ganaba siempre:
  // `Rock / Pop` (10 de 43 eventos) se etiquetaba pop. Ahora manda el género.
  it('el subgénero amplio "pop" cede ante el género declarado', () => {
    assert.equal(mapGenre('Rock', 'Pop'), 'rock');
    assert.equal(mapGenre('Jazz', 'Pop'), 'jazz');
    assert.equal(mapGenre('Electronic', 'Pop'), 'electronic');
    assert.equal(mapGenre('Indie & Alternative', 'Pop'), 'indie');
  });

  it('mantiene la prioridad del subgénero cuando es específico', () => {
    assert.equal(mapGenre('Rock', 'Smooth Jazz'), 'jazz');
    assert.equal(mapGenre('EDM/Electronic', 'Techno'), 'electronic');
    assert.equal(mapGenre('Rock', 'Hard Rock'), 'rock');
  });

  it('un género pop sin subgénero sigue siendo pop', () => {
    assert.equal(mapGenre('Pop', null), 'pop');
    assert.equal(mapGenre('Pop', undefined), 'pop');
    assert.equal(mapGenre(undefined, 'Pop'), 'pop');
  });

  it('mapea la música clásica (género añadido el 2026-09-30)', () => {
    // Antes estos títulos devolvían null y quedaban invisibles al filtrar.
    assert.equal(mapGenre('Classical', 'Classical/Vocal'), 'classical');
    assert.equal(mapGenre('Classical', undefined), 'classical');
    assert.equal(mapGenre(undefined, 'Opera'), 'classical');
    assert.equal(mapGenre(undefined, 'Coral'), 'classical');
    // Por keyword, sin coincidencia exacta.
    assert.equal(mapGenre('undefined', 'Concert de música clàssica'), 'classical');
    assert.equal(mapGenre('undefined', 'Òpera de Verdi'), 'classical');
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