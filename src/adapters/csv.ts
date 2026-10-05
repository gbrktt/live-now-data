/**
 * Parser CSV RFC 4180, sin dependencias.
 *
 * Existe por la fuente de datos abiertos de Barcelona (C1), cuyo CSV:
 *   · viene en UTF-16LE (por eso aparecen bytes NUL intercalados);
 *   · trae campos entrecomillados con comas y saltos de línea dentro (el
 *     `timetable` es HTML multilínea), así que partir por líneas NO vale.
 *
 * Todo es defensivo: un CSV municipal roto no debe tumbar la ingesta.
 */

import type { IngestScope, RawEventBatch, SourceCode, EventSourceAdapter } from '../types.ts';

/**
 * Decodifica los bytes del recurso.
 * Detección por orden (cada fuente publica distinto):
 *   · BOM UTF-16LE (FF FE) → Barcelona (su CSV viene en UTF-16LE).
 *   · UTF-8 válido → la mayoría.
 *   · UTF-8 inválido → ISO-8859-1/windows-1252 (Madrid: Latin-1 acentuado,
 *     verificado 2026-10-05 con `TextDecoder({fatal:true})` sobre el CSV real).
 */
export function decodeCsvBytes(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  // BOM UTF-16LE: FF FE. TextDecoder lo respeta, pero lo quitamos por si el
  // runtime no lo hace y el primer header saliera con un carácter basura.
  if (view.length >= 2 && view[0] === 0xff && view[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(view.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(view);
  } catch {
    // Sin `fatal` TextDecoder sustituye los bytes Latin-1 por U+FFFD y el id
    // (` ID-EVENTO`) y los títulos quedarían corruptos.
    return new TextDecoder('windows-1252').decode(view);
  }
}

/**
 * Convierte texto CSV en filas de celdas, respetando comillas dobles y los
 * saltos de línea embebidos. `maxRows` corta pronto: la ingesta solo mira los
 * eventos de la ventana, no las 3.500 filas.
 *
 * `separator`: `,` (Barcelona, por defecto) o `;` (Madrid, ISO-8859-1).
 */
export function parseCsv(
  text: string,
  maxRows = Number.POSITIVE_INFINITY,
  separator = ','
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    // Evita una fila fantasma final causada por el salto de línea terminal.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < n) {
    if (rows.length > maxRows) break;
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // Comilla escapada: "" dentro de un campo entrecomillado.
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === separator) {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // \r\n o \r suelto.
      if (text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

/** Convierte filas + cabecera en objetos, descartando filas descuadradas. */
export function toRecords(
  text: string,
  maxRows = Number.POSITIVE_INFINITY,
  separator = ','
): Record<string, string>[] {
  const rows = parseCsv(text, maxRows + 1, separator);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  // El CSV de Barcelona viene en UTF-16 y su PRIMERA columna arrastra un BOM
  // UTF-8: `register_id` llega como "﻿99400786657". Sin quitarlo, el id es
  // distinta cadena cada vez y la idempotencia por `uuid5(source, id)` se
  // rompe: cada corrida crearía eventos nuevos en vez de actualizarlos.
  header[0] = stripBom(header[0]);
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length && out.length < maxRows; r += 1) {
    const cells = rows[r];
    if (cells.length !== header.length) continue;
    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c += 1) {
      record[header[c]] = c === 0 ? stripBom(cells[c]) : cells[c];
    }
    out.push(record);
  }
  return out;
}

/** Quita el BOM U+FEFF inicial, si lo hay. */
export function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
