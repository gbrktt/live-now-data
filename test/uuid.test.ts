import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicUuid, isUuid } from '../src/utils/uuid.ts';

describe('deterministicUuid', () => {
  it('genera uuids con formato válido', async () => {
    const id = await deterministicUuid(['ticketmaster', 'event', 'abc']);
    assert.ok(isUuid(id));
  });

  it('es determinista para la misma clave', async () => {
    const a = await deterministicUuid(['ticketmaster', 'event', 'abc']);
    const b = await deterministicUuid(['ticketmaster', 'event', 'abc']);
    assert.equal(a, b);
  });

  it('difiere para claves distintas', async () => {
    const a = await deterministicUuid(['ticketmaster', 'event', 'abc']);
    const b = await deterministicUuid(['ticketmaster', 'event', 'abd']);
    assert.notEqual(a, b);
  });

  it('fija versión 5 y variante RFC 4122', async () => {
    const id = await deterministicUuid(['x', 'y', 'z']);
    assert.equal(id[14], '5');
    assert.ok(['8', '9', 'a', 'b'].includes(id[19]));
  });
});