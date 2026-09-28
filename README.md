# live-now-data · Canonical Data Ingestion Layer

Sistema canónico de ingesta de eventos para **Live Now Music**. Parte de un
modelo de datos único e independiente de la fuente; **toda fuente nueva es un
adaptador + normalizador**, sin tocar el orquestador ni la app.

```
  Fuentes (hoy: Ticketmaster Discovery API v2)
       │  EventSourceAdapter (fetch + throttle + paginación)
       ▼
  Normalizer ──► CanonicalEvent / CanonicalVenue / CanonicalOccurrence
       │
       ▼
  IngestWriter (idempotente: UUID determinista por clave de negocio)
       │
       ▼
  Supabase (venues / events / event_instances + gobernanza)
       │
       ▼
  live-now-api ──► app Live Now (Expo)
```

## Principios

1. **Canónico y multi-fuente**: el orquestador y el writer solo conocen el
   modelo canónico (`src/types.ts`).
2. **Idempotente**: `id = uuid5(source, dominio, idExterno)` → re-ejecutar un
   barrido N veces actualiza la misma fila, nunca duplica (favoritos estables).
3. **Incremental y presupuestado**: partición por `ciudad × ventana temporal`;
   respeta cuota diaria y deep-paging de la fuente.
4. **Observable**: cada corrida se registra en `ingest_runs` (stats + errores)
   y el watermark en `ingest_sources`.
5. **Contrato validado**: los campos emitidos coinciden con el `AppEvent` que
   consume la app (aparece con `images` y `external_url`).

## Estructura

```
src/
  types.ts                  modelo canónico y contratos (adapter/normalizer/writer)
  genre.ts                  taxonomía Ticketmaster → géneros de la app
  scopes.ts                 partición ciudad × ventana + parseo de CITIES
  config.ts                 env + tiers T1/T2/T3 y ventanas temporales
  adapters/ticketmaster.ts  cliente Discovery API v2 (5 req/s, 5000/día)
  normalize/ticketmaster.ts Discovery payload → CanonicalEvent
  persist/supabase.ts       upserts idempotentes (service role)
  orchestrator.ts           pipeline: scopes → fetch → normalizar → persistir
  run-local.ts              CLI de backfill (dry-run incluido)
  index.ts                  worker Cloudflare: cron triggers + /run /status /health
```

## Configuración

```bash
cp .dev.vars.example .dev.vars
# rellena TICKETMASTER_API_KEY, SUPABASE_SERVICE_ROLE_KEY, INGEST_ADMIN_TOKEN
```

| Variable | Descripción |
|---|---|
| `TICKETMASTER_API_KEY` | API key de la Discovery API (developer.ticketmaster.com) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase (service role, solo backend) |
| `INGEST_ADMIN_TOKEN` | Token de los endpoints `/status` y `POST /run` |
| `CITIES` | `nombre\|lat,lng\|radioKm` separados por `;` |
| `LOOKAHEAD_DAYS` | Días de catálogo (T3), por defecto 63 |
| `DAILY_QUOTA` | Límite de llamadas/día (Ticketmaster: 5000), por defecto 4000 |
| `COUNTRY_CODE` | Código de país para la consulta (por defecto `ES`) |

## Uso

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test (sin red, fixtures locales)

# Backfill / pruebas sin tocar la BD:
npm run dry-run                       # consulta a Ticketmaster, NO escribe
npm run dry-run -- --tier T1          # solo próximas 48h
npm run dry-run -- --scope-limit 1    # solo el primer scope

# Requisito del runner: Node ≥ 22.18 con type-stripping (ejecuta los `.ts`
# directamente, sin build). El código debe mantenerse en sintaxis "erasable"
# (`tsc` lo impone con `erasableSyntaxOnly`): sin parameter properties,
# enums ni namespaces.

# Backfill real:
npm run run -- --tier T3              # catálogo completo (España)
npm run run -- --cities "madrid|40.4168,-3.7038|50"
```

## Frecuencias (worker Cloudflare)

| Trigger | Tier | Alcance | Por qué |
|---|---|---|---|
| `*/30 * * * *` | T1 | próximas 48h | frescura `now`/`tonight` (cancelaciones, repromesis, salidas) |
| `0 3,11 * * *` | T2 | próximos 7 días | estado de venta y fechas próximas |
| `0 5 * * *` | T3 | catálogo +63 días | cobertura completa diaria |

Despliegue:

```bash
npx wrangler secret put TICKETMASTER_API_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put INGEST_ADMIN_TOKEN
npx wrangler deploy
```

## Migración de BD

El esquema canónico se aplica con tres migraciones **aditivas** del repo
`live-now-music/supabase/migrations` (compatibles con los datos demo
`source='demo'`):

| Migración | Qué hace |
|---|---|
| `20260914000001_ingest_canonical.sql` | Columnas de procedencia (`source`, ids externos, `images`, `metadata`, `is_active`…), índices únicos de upsert y tablas de gobernanza (`ingest_sources`, `ingest_runs`, `genre_mappings`). |
| `20260914000002_events_active_and_live.sql` | Feed alineado con la ingesta: oculta cancelados (`is_active=false`) y calcula `live_now` por horario. Replica la **firma real** de la RPC (`p_user_id uuid`) y aborta con un mensaje legible si el esquema ha derivado. |
| `20260914000003_protect_ingested_data.sql` | Acota las utilidades demo (`reset_demo_data*`, `refresh_event_dates`) a `source='demo'` para que no puedan borrar ni reescribir el catálogo ingerido. Añade `ingest_scope_status()`. |

### Esquema real verificado (auditoría 2026-09-14)

El dump de julio estaba desactualizado; los hechos comprobados contra la BD de
producción (Postgres 17.6) son:

- `favorites.user_id` es **`uuid`** (no `text`) y `get_nearby_events.p_user_id`
  también es **`uuid`** → la migración 0002 replica esa firma exacta.
- La RPC devuelve **16 columnas**: el contrato con `live-now-api` no cambia.
- `service_role` **salta RLS**, así que la ingesta puede escribir; la app nunca
  ve las tablas de gobernanza.

## Añadir una fuente nueva

1. Implementar `EventSourceAdapter` (`src/adapters/<fuente>.ts`): fetch +
   paginación + throttle de esa API.
2. Implementar `Normalizer` (`src/normalize/<fuente>.ts`): payload → canónico.
3. Registrar en `genre_mappings` los géneros de la fuente.
4. El orquestador, el writer y la app **no cambian**.

## Documentación y validación

- **Propuesta y arquitectura completa** (visión canónica, roadmap multi-fuente,
  KPIs, comparativa competitiva, runbook):
  [`docs/PROPUESTA.md`](./docs/PROPUESTA.md).
- **Validación de las migraciones SQL** sin tocar la BD real (Postgres efímero
  con datos demo previos). Cubre 3 escenarios —esquema real, drift de tipos y
  BD nueva— y verifica cancelados, `live_now`, idempotencia, índice único y
  que las utilidades demo no tocan el catálogo ingerido:

  ```bash
  cd ../live-now-music && bash scripts/validate-ingest-sql.sh
  ```

- **Preflight del entorno real** (solo lectura, contra la BD desplegada):
  esquema canónico, gobernanza, RLS con `service_role`, contrato de 16 columnas
  de la RPC, tipo `uuid` de `p_user_id` y si las utilidades demo están acotadas.
  Debe salir OK antes de un backfill:

  ```bash
  bash scripts/preflight.sh
  ```

- **Verificación del contrato `AppEvent`** en el backend:
  `cd ../live-now-api && npm test` (incluye `isVisibleEvent`).