import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeById } from '../src/persist/supabase.ts';

// Regresión del fallo medido 2026-10-05 en live-now-ingest:
// «ON CONFLICT DO UPDATE command cannot affect row a second time»
// cuando el mismo id aparece dos veces en un lote de upsert.
describe('dedupeById', () => {
  it('elimina filas con el mismo id, quedándose con la última', () => {
    const rows = dedupeById([
      { id: 'a', title: 'viejo' },
      { id: 'b', title: 'único' },
      { id: 'a', title: 'nuevo' },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(
      rows.find((r) => r['id'] === 'a')?.['title'],
      'nuevo'
    );
  });

  it('deja intacto un lote sin duplicados', () => {
    const rows = dedupeById([{ id: 'a' }, { id: 'b' }]);
    assert.equal(rows.length, 2);
  });
});
