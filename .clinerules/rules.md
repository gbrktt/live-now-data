# live-now-data — reglas del proyecto

> Capa canónica de ingesta de **Live Now Music**. Última revisión: 2026-09-22.

## Arquitectura (premisas vinculantes)
- Modelo canónico único en `src/types.ts` (`CanonicalEvent`/`CanonicalVenue`/`CanonicalOccurrence`
  y contratos adapter/normalizer/writer).
- **Toda fuente nueva = adaptador + normalizador**, sin tocar el orquestador ni el writer.
- Idempotencia obligatoria: `id = uuid5(source, dominio, idExterno)` → re-ejecutar un barrido
  actualiza la fila, nunca duplica.
- Incremental y presupuestado: partición por ciudad × ventana temporal; respeta cuota diaria y
  deep-paging de la fuente.
- Observable: cada corrida se registra en `ingest_runs` (stats + errores) y el watermark en
  `ingest_sources`.
- Contrato validado: los campos emitidos coinciden con el `AppEvent` que consume la app
  (incluye `images` y `external_url`).

## Edición y lectura
- Ediciones quirúrgicas (bloques SEARCH/REPLACE o `insert_line`) para cambios <20% del fichero;
  escritura completa solo para ficheros nuevos.
- No formatees a mano; no conectes a Supabase en vivo para leer el esquema (usa `src/types.ts`
  y las migraciones de `../live-now-api/supabase/migrations/`).

## Comandos
| Comando | Propósito |
|---------|-----------|
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `node --test test/*.test.ts` |
| `npm run dry-run` | corrida local sin persistir |
| `npm run dev` / `npm run deploy` | `wrangler dev` / `wrangler deploy` |

## Definition of Done
`npm run typecheck` limpio + `npm test` verde antes de dar cualquier tarea por terminada.
