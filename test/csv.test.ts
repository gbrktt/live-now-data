import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCsvBytes, parseCsv, stripBom, toRecords } from '../src/adapters/csv.ts';

describe('decodeCsvBytes', () => {
  it('decodifica UTF-16LE (el CSV de Barcelona)', () => {
    // "id;nombre\n" en UTF-16LE con BOM.
    const bytes = new Uint8Array([
      0xff, 0xfe, 0x69, 0x00, 0x64, 0x00, 0x3b, 0x00, 0x6e, 0x00, 0x6f, 0x00, 0x6d, 0x00, 0x62, 0x00,
      0x72, 0x00, 0x65, 0x00, 0x0a, 0x00,
    ]);
    assert.equal(decodeCsvBytes(bytes.buffer), 'id;nombre\n');
  });

  it('decodifica UTF-8 si no hay BOM UTF-16', () => {
    const bytes = new TextEncoder().encode('id,nombre\n1,cançó\n');
    assert.equal(decodeCsvBytes(bytes.buffer), 'id,nombre\n1,cançó\n');
  });

  it('decodifica ISO-8859-1/windows-1252 (el CSV de Madrid)', () => {
    // "Título" en Latin-1: 0x54 0xED 0x74 0x75 0x6C 0x6F (í = 0xED).
    // Sin la caída a windows-1252, TextDecoder(utf-8) pondría U+FFFD y el
    // id/títulos quedarían corruptos (rompería la idempotencia del upsert).
    const bytes = new Uint8Array([0x54, 0xed, 0x74, 0x75, 0x6c, 0x6f]);
    assert.equal(decodeCsvBytes(bytes.buffer), 'Título');
  });
});

describe('parseCsv', () => {
  it('parte por comas respetando comillas', () => {
    const rows = parseCsv('a,b\n"x,1",y\n');
    assert.deepEqual(rows, [
      ['a', 'b'],
      ['x,1', 'y'],
    ]);
  });

  // El `timetable` del CSV es HTML con <br> y saltos de línea reales.
  it('respeta saltos de línea dentro de un campo entrecomillado', () => {
    const rows = parseCsv('a,b\n"linea1\nlinea2",z\n');
    assert.deepEqual(rows[1], ['linea1\nlinea2', 'z']);
  });

  it('unescape de comillas dobles ("" dentro de campo)', () => {
    const rows = parseCsv('a\n"He said ""hi"""\n');
    assert.deepEqual(rows[1], ['He said "hi"']);
  });

  it('acepta CRLF y no crea fila fantasma al final', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n');
    assert.equal(rows.length, 2);
  });

  it('tolera el BOM pegado al primer campo', () => {
    const rows = parseCsv('﻿register_id,name\n1,x\n');
    assert.equal(rows[0][0], '﻿register_id');
    assert.equal(stripBom(rows[0][0]), 'register_id');
  });

  it('devuelve vacío con texto vacío', () => {
    assert.deepEqual(parseCsv(''), []);
  });

  it('acepta separador ";" (el CSV de Madrid)', () => {
    const rows = parseCsv('a;b\n"x;1";y\n', Number.POSITIVE_INFINITY, ';');
    assert.deepEqual(rows, [
      ['a', 'b'],
      ['x;1', 'y'],
    ]);
    // Con el separador por defecto (,) no partiría por punto y coma.
    assert.deepEqual(parseCsv('a;b\n'), [['a;b']]);
  });
});

describe('toRecords', () => {
  it('mapea cabecera a objetos y quita el BOM de la primera columna', () => {
    // Regresión real: el `register_id` llegaba como "﻿99400786657" y eso
    // rompía la idempotencia (uuid5 sobre una id distinta cada vez).
    const records = toRecords('﻿register_id,name\n99400786657,Concert\n');
    assert.equal(records.length, 1);
    assert.equal(records[0]['register_id'], '99400786657');
    assert.equal(records[0]['name'], 'Concert');
  });

  it('descarta filas descuadradas en vez de inventar valores', () => {
    const records = toRecords('a,b,c\n1,2,3\n4,5\n6,7,8\n');
    assert.equal(records.length, 2);
  });

  it('respeta maxRows', () => {
    const text = 'a\n1\n2\n3\n4\n';
    assert.equal(toRecords(text, 2).length, 2);
  });

  it('toRecords con ";" mapea la cabecera de Madrid (con espacio inicial)', () => {
    const text = ' ID-EVENTO;TITULO\n50430557;Concierto\n';
    const records = toRecords(text, Number.POSITIVE_INFINITY, ';');
    assert.equal(records.length, 1);
    // toRecords hace trim() a la cabecera: " ID-EVENTO" → "ID-EVENTO".
    assert.equal(records[0]['ID-EVENTO'], '50430557');
    assert.equal(records[0]['TITULO'], 'Concierto');
  });
});
