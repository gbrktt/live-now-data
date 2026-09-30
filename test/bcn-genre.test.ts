import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BCN_TITLE_GENRE,
  genreFromTitle,
} from '../src/normalize/bcn-genre.ts';

describe('BCN_TITLE_GENRE', () => {
  it('tiene entradas y ninguna vacía', () => {
    const keys = Object.keys(BCN_TITLE_GENRE);
    assert.ok(keys.length > 500, `esperaba >500 titulos, hay ${keys.length}`);
    assert.ok(keys.every((k) => k.length > 0));
  });

  it('solo usa generos que la app conoce, o null', () => {
    const valid = new Set(['jazz', 'rock', 'indie', 'electronic', 'pop', null]);
    for (const [title, genre] of Object.entries(BCN_TITLE_GENRE)) {
      assert.ok(
        valid.has(genre),
        `"${title}" -> ${String(genre)} no es un genero de la app`
      );
    }
  });

  // La música clásica es el 40 % de la tabla y la app NO tiene ese género.
  // Decidido: se deja en null en vez de forzar a 'pop'.
  it('la musica clasica queda en null, no forzada a otro genero', () => {
    const classics = Object.values(BCN_TITLE_GENRE).filter((g) => g === null);
    assert.ok(classics.length > 300, `esperaba muchos null, hay ${classics.length}`);
  });
});

describe('genreFromTitle', () => {
  it('recupera el genero de títulos reales de la agenda', () => {
    assert.equal(
      genreFromTitle('Concert "La setena de Beethoven", amb Ludovic Morlot'),
      null // clásica: la app no tiene el género
    );
    assert.equal(genreFromTitle("Concert 'Gipsy Nur Project'"), null);
  });

  it('usa la pista del propio título cuando no está en la tabla', () => {
    assert.equal(genreFromTitle('Nit de jazz obert al barri'), 'jazz');
    assert.equal(genreFromTitle('Festival de rock municipal'), 'rock');
    assert.equal(genreFromTitle('Concerto de música electrónica'), 'electronic');
  });

  it('devuelve null cuando no hay ni tabla ni pista', () => {
    assert.equal(genreFromTitle('Velada sin pistas'), null);
  });

  it('es determinista', () => {
    const title = 'Concert de jazz al carrer';
    assert.equal(genreFromTitle(title), genreFromTitle(title));
  });
});
