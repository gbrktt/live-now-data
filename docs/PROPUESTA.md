# Capa Canónica de Ingesta de Datos · Propuesta y diseño

> Documento de arquitectura del sistema de recopilación de eventos musicales
> de **Live Now Music**. Describe la visión canónica, el diseño implementado
> (fase 1: Ticketmaster Discovery API), el roadmap multi-fuente y la
> comparación competitiva frente a otras apps de descubrimiento de conciertos.

---

## 0. Resumen ejecutivo

Live Now Music necesita dejar de depender de datos demo y alimentar su UI con
catálogo musical real, fresco y geolocalizado. La solución propuesta —y ya
implementada en su fase 1— es una **capa canónica de ingesta** independiente de
la fuente:

- **Un modelo de datos canónico** (`CanonicalEvent` / `CanonicalVenue` /
  `CanonicalOccurrence`). El orquestador y la persistencia **no conocen la
  fuente**: cualquier proveedor nuevo (Songkick, Bandsintown, agendas locales,
  promotoras) es un *adaptador + normalizador* y **no toca ni la base de datos
  ni la app**.
- **Ingesta idempotente y trazable**: `id = uuid5(source, dominio, idExterno)`.
  Re-ejecutar el barrido N veces actualiza las mismas filas, jamás duplica
  (los favoritos de los usuarios nunca se rompen).
- **Barrido recurrente por frescura** (Cloudflare Cron Triggers): T1 cada
  30 min (48 h), T2 2×/día (7 días), T3 diario (catálogo completo).
- **Presupuesto y reputación de API respetados**: cuota diaria, límite de
  5 req/s, deep-paging (`size × page < 1000`), partición en *scopes*
  `ciudad × ventana` re-ejecutables.
- **Adaptaciones mínimas y aditivas en la app actual**: se conservan las
  mismas pantallas y el mismo contrato `AppEvent`; sólo se han añadido
  `images` y `external_url`, que ya alimentan carátulas y el botón de compra.

Resultado: la app pasa de datos ficticios a catálogo real con **coste marginal
casi nulo** (Cloudflare Workers + cron + Supabase existente) y con un camino
de crecimiento claro hacia multi-fuente y multi-ciudad.

---

## 1. Situación de partida y objetivo

### Antes

- Catálogo compuesto por filas `source='demo'` insertadas por scripts
  (`seed-events.js`, `seed-showcase-events.js`) para validar UI/QA.
- La UI ya consumía `AppEvent` a través de `live-now-api` (Worker Hono) y de la
  RPC `get_nearby_events` (Haversine + filtros de tiempo/género/precio).
- Faltaba el motor que mantuviese el catálogo vivo, geolocalizado y actualizado.

### Objetivo

1. Recopilar **todos los eventos musicales** del territorio objetivo desde
   fuentes oficiales, empezando por Ticketmaster.
2. **Normalizarlos** al contrato que la UI ya espera, sin rediseñar pantallas.
3. **Barrer de forma recurrente** e insertar/actualizar de forma idempotente en
   el modelo de datos existente (`venues`, `events`, `event_instances`).
4. Dejar preparada la arquitectura para **añadir fuentes progresivamente**
   manteniendo la calidad del dato y sin regresiones en la app.
5. Ser **competitivo**: cobertura local, frescura y datos de calidad
   (imagen, precio, coordenadas, hora local correcta, estado de venta).

---

## 2. Principios de diseño

| Principio | Implicación práctica |
|---|---|
| **Canónico** | Un único modelo interno; la fuente sólo aparece en `adapters/` y `normalize/`. |
| **Idempotente** | UUID determinista por clave de negocio; `upsert` con `onConflict: 'id'`. |
| **Aditivo** | El esquema se amplía con columnas nuevas; los datos demo siguen siendo válidos. |
| **Incremental** | El barrido se particiona y se presupuesta: nunca se agota la cuota de la API. |
| **Trazable** | Cada corrida queda en `ingest_runs` con estadísticas y errores; watermark en `ingest_sources`. |
| **Defensivo** | Todo acceso al payload de la fuente es tolerante a campos ausentes o nulos. |
| **Observable** | KPIs por corrida: llamadas, eventos, saltos por inválidos, cuota restante. |
| **Sin acoplamiento a UI** | El contrato `AppEvent` se respeta y se valida en runtime. |

---

## 3. Arquitectura

```
                 ┌──────────────────────────────────────────────┐
   FUENTES       │  Ticketmaster Discovery API v2   (fase 1)    │
   (n)           │  Songkick · Bandsintown · Agendas locales…   │
                 ───────────────┬──────────────────────────────┘
                                 │  EventSourceAdapter
                                 │  (fetch + throttle 5 req/s + paginación deep-paging)
                                 ▼
                 ┌──────────────────────────────────────────────┐
   NORMALIZACIÓN │  Normalizer: payload → CanonicalEvent        │
                 │  · géneros → 5 géneros de la app             │
                 │  · fecha/hora local + timezone → ISO UTC     │
                 │  · precio, imágenes, descripción, estado     │
                 └───────────────┬──────────────────────────────┘
                                 │
                                 ▼
                 ┌──────────────────────────────────────────────┐
   ORQUESTACIÓN  │  Orquestador: scopes (ciudad × ventana)      │
                 │  cuota diaria · deep paging · estadísticas   │
                 └───────────────┬──────────────────────────────┘
                                 │  IngestWriter
                                 ▼
                 ┌──────────────────────────────────────────────
   PERSISTENCIA  │  Supabase (service role)                      │
   (existente)   │  venues · events · event_instances            │
   + gobernanza  │  ingest_sources · ingest_runs · genre_mappings│
                 └───────────────┬──────────────────────────────┘
                                 ▼
                 live-now-api (Worker Hono) ──► App Expo (Live Now Music)
```

### Componentes implementados (`live-now-data`)

| Fichero | Responsabilidad |
|---|---|
| `src/types.ts` | Modelo canónico y contratos (`EventSourceAdapter`, `Normalizer`, `IngestWriter`). |
| `src/adapters/ticketmaster.ts` | Cliente Discovery API v2: autenticación, throttle, paginación y recorte de deep-paging. |
| `src/normalize/ticketmaster.ts` | Payload → canónico: timezone, género, precios, imágenes, descripción, estado, dedupe de imágenes. |
| `src/genre.ts` | Taxonomía Ticketmaster → `jazz/rock/indie/electronic/pop` (exacto + keywords). |
| `src/scopes.ts` | Partición `ciudad × ventana temporal` + parseo de `CITIES`. |
| `src/config.ts` | Env + tiers T1/T2/T3 + mapeo cron → tier. |
| `src/orchestrator.ts` | Pipeline y presupuesto: scopes → fetch → normalizar → persistir. |
| `src/persist/supabase.ts` | Upserts idempotentes (`venues`, `events`, `event_instances`). |
| `src/utils/uuid.ts` | UUID determinista v5 (SHA-256, Web Crypto → Node/Deno/Workers). |
| `src/index.ts` | Worker Cloudflare: `scheduled()` (cron) + `/health`, `/status`, `POST /run`. |
| `src/run-local.ts` | CLI de backfill/pruebas con `--dry-run` y `--scope-limit`. |

### Extensión de la fuente: sólo dos ficheros

1. `src/adapters/<fuente>.ts` → implementa `EventSourceAdapter`.
2. `src/normalize/<fuente>.ts` → implementa `Normalizer`.
3. Registrar sus géneros en `genre_mappings` (tabla, en runtime).

El resto del sistema (orquestador, writer, API, app) **no cambia**.

---

## 4. Modelo de datos canónico

### Clave canónica y procedencia (columnas aditivas)

| Tabla | Columnas nuevas | Uso |
|---|---|---|
| `venues` | `source`, `source_venue_id`, `timezone`, `external_url` | procedencia + trazabilidad |
| `events` | `source`, `source_event_id`, `external_url`, `images`, `metadata`, `ingested_at`, `last_verified_at`, `is_active` | carátulas, botón de compra, auditoría, ocultar cancelados |
| `event_instances` | `source`, `source_instance_id` | ocurrencias idempotentes |

Índices únicos `(source, source_*_id)` → el `upsert` es estable incluso si la
fuente cambia de estrategia de paginación. Las filas demo (`source='demo'`,
id externo `NULL`) no colisionan entre sí (índices estándar, NULLs distintos).

### Hechos verificados del esquema real (auditoría 2026-09-14)

Comprobados contra la BD de producción (Postgres 17.6) porque el dump de julio
estaba desactualizado (`oidvectortypes` de `pg_proc` + sondas PostgREST):

| Hecho | Implicación |
|---|---|
| `favorites.user_id` es **`uuid`** (el dump decía `text`) | Comparar con un parámetro `text` sin cast explícito falla con `42883 operator does not exist: uuid = text`. |
| `get_nearby_events.p_user_id` es **`text`** (11 args, 16 columnas de retorno) | La 0002 replica esa firma al detalle para **reemplazar** (1 solo overload); el cuerpo castea con `p_user_id::uuid` para la comparación con `favorites`. El API siempre envía un uuid válido (incluido el centinela anónimo), así que el cast es seguro. |
| `service_role` **salta RLS** | La ingesta puede escribir; la app nunca ve las tablas de gobernanza. |
| `0001` aplicada (DDL **y** DML: 28 filas en `genre_mappings`) | Base de la ingesta operativa en producción. |
| `live_now` lo mantenía `refresh_event_dates()` (utilidad demo) | Con datos reales hacen falta el cálculo por horario (0002) y acotar la utilidad a demo (0003). |
| `reset_demo_data` usaba `TRUNCATE … CASCADE` | Habría borrado el catálogo real y los favoritos (R1): acotado en 0003. |

Para que este tipo de drift no vuelva a pasar desapercibido, la 0002 lleva un
**guard fail-fast** que aborta con un mensaje legible si la firma viva no
coincide con la esperada (en vez de dejar un `42883` críptico), y el arnés
cubre 3 escenarios (firma real, drift y BD nueva):

```bash
bash scripts/validate-ingest-sql.sh   # 3 escenarios: real, drift y BD nueva
bash scripts/preflight.sh             # auditoría read-only contra la BD real
```

### Gobernanza de la ingesta

| Tabla | Para qué |
|---|---|
| `ingest_sources` | Catálogo de fuentes, estado (`enabled`), configuración y **watermark** de la última corrida. |
| `ingest_runs` | Historial de corridas: tier, scope, `stats` (llamadas, eventos, inválidos), `status`, `error`. |
| `genre_mappings` | Mapa `proveedor → género de la app` **sin recompilar**: se puede ampliar en caliente. |

RLS activado en las tres: sólo accesibles con `service_role` (el Worker de
ingesta). La app nunca las lee.

---

## 5. Estrategia de barrido (frescura sin agotar cuotas)

| Tier | Cron | Alcance | Ventana por scope | Motivo |
|---|---|---|---|---|
| **T1** | `*/30 * * * *` | próximas 48 h | 2 días | Frescura `now`/`tonight`: cancelaciones, repromesis, venta de última hora. |
| **T2** | `0 3,11 * * *` | próximos 7 días | 4 días | Estado de venta y fechas inmediatas. |
| **T3** | `0 5 * * *` | catálogo (63 días por defecto) | 10 días | Cobertura completa diaria. |

- **Scopes**: `ciudad × ventana` con clave determinista
  (`madrid-2026-09-14--2026-09-24`), lo que hace cada consulta acotada,
  re-ejecutable y depurable.
- **Presupuesto**: `DAILY_QUOTA` (por defecto 4000 de las 5000 llamadas/día de
  Ticketmaster) y `maxPagesPerScope = 5` (5 × 200 = 1000, el límite de
  deep-paging de la API).
- **Reputación**: throttle de 200 ms entre llamadas (5 req/s) con `429`
  tratado como error explícito.
- **Ventana de arranque**: `now − 2 h`, para no perder eventos ya empezados
  (que son los que alimentan la vista “en directo”).

---

## 6. Calidad del dato y normalización

| Dimensión | Tratamiento implementado |
|---|---|
| **Género** | Taxonomía explícita + reglas por palabra clave → 5 géneros de la app. Sin coincidencia ⇒ `null` (la UI ya lo tolera) y **fila en `genre_mappings`** para mapear después sin tocar código. |
| **Fecha/hora** | Se convierte hora local + `timezone` a **ISO UTC** con `Intl` (`longOffset`); si el payload no trae `dateTime` se reconstruye desde `localDate`/`localTime`. Se evita el clásico desfase de conciertos “a las 21:00” mostrados a la hora equivocada. |
| **Duración** | `end.dateTime` de la fuente; si falta, se estima 3 h. |
| **Precio** | Se prefieren rangos `standard`; `priceFrom`/`priceTo` redondeados a 2 decimales; moneda guardada en `metadata`. |
| **Imágenes** | Hasta 5, priorizando ratios 3_2 / 16_9 / 4_3 (mejor encaje en las carátulas), con deduplicación por URL. Alimentan `EventCard`, `HeroEventCard` y el detalle. |
| **Descripción** | `info` + `pleaseNote` limpiados y truncados a 600 caracteres. |
| **Estado de venta** | `dates.status.code` → `off-sale/cancelled/postponed…` ⇒ `is_active=false`; la API **no sirve** eventos inactivos (feed, detalle, búsqueda y favoritos). |
| **Ventas/venue** | Nombre, dirección, ciudad, coordenadas y URL del venue. Sin coordenadas ⇒ se descarta el evento (la UI es geo-first). |
| **Auditoría** | `metadata` guarda género/subgénero del proveedor, estado y moneda; `last_verified_at` marca cada confirmación de la fuente. |

**Robustez**: todos los accesos al payload son defensivos; un evento
incompleto se contabiliza como `skippedInvalid` en las estadísticas en vez de
romper la corrida.

---

## 7. Integración con la UI actual (sin rediseño)

La app no se ha reescrito: se han adaptado **contratos y presentación**.

| Área | Adaptación | Efecto en la UI |
|---|---|---|
| Contrato `AppEvent` (shared) | `+ images`, `+ external_url` (opcionales) y validación runtime | Aditivo: la app antigua seguiría funcionando. |
| Feed (`get_nearby_events`) | Filtro `is_active` + `live_now` calculado por horario | Los eventos cancelados desaparecen; “en directo” funciona con eventos reales. |
| Detalle (`/events/:id`) | Devuelve `images`/`external_url`; 404 si el evento está inactivo | Carátula real + **botón “Comprar entradas”** que abre la taquilla oficial. |
| Favoritos | Filtra eventos inactivos | Sin favoritos fantasma de eventos cancelados. |
| Búsqueda | Filtra eventos inactivos | Coherente con el feed. |
| Fallback de imágenes | `mockImages` sólo en `__DEV__` y sólo si el evento **no** trae `images` | Producción nunca muestra imágenes ficticias. |

---

## 8. Roadmap multi-fuente por fases

### Fase 1 — Ticketmaster (implementada)

- [x] Modelo canónico, contratos, orquestador, writer idempotente y gobernanza.
- [x] Adaptador + normalizador Ticketmaster (música, España, deep-paging).
- [x] Tiers T1/T2/T3 con cron y presupuesto; CLI de backfill con `--dry-run`.
- [x] Migración de BD aditiva + índice canónico + tablas de ingesta.
- [x] Vistas afectadas (feed, detalle, búsqueda, favoritos) con `is_active`.
- [x] 29 tests en `live-now-data` (normalización, scopes, géneros, UUID) y
      39 en `live-now-api` (contrato + visibilidad).

### Fase 2 — Segunda fuente (Songkick o Bandsintown) *(siguiente)*

- [ ] `adapters/<fuente>.ts` + `normalize/<fuente>.ts` (la API de la app **no cambia**).
- [ ] `ingest_sources` activa la fuente y fija su propio watermark.
- [ ] **Resolución de entidades** (ver §9): mismo concierto en 2 fuentes ⇒ 1 fila.
- [ ] Criterio de salida: ≥ 95 % de eventos de la fuente nueva deduplicados.

### Fase 3 — Agendas locales y salas

- [ ] Agendas municipales/autonómicas, salas y promotoras (RSS/JSON/CSV).
- [ ] Adaptador genérico `FeedsAdapter` (iCal/RSS) reutilizable por venue.
- [ ] Criterio de salida: cobertura de salas pequeñas (donde las APIs globales
      tienen huecos) con `noise_level`/aforo informados.

### Fase 4 — Descubrimiento y verificación

- [ ] Descubrimiento de URLs de programas por ciudad (sitemap/feed) antes de
      cualquier extracción HTML; crawler respetuoso (`robots.txt`, 1 req/s,
      User-Agent identificable, sólo datos públicos de evento).
- [ ] Verificación cruzada: 2 fuentes coinciden ⇒ mayor confianza
      (`last_verified_at`, `metadata.sources[]`).

### Fase 5 — Señales de la comunidad

- [ ] Reportes de usuarios (“ya no existe”, “cambió de hora”), ratings de sala.
- [ ] Cola de revisión con impacto directo en `is_active` y prioridad de barrido.

---

## 9. Resolución de entidades entre fuentes (diseño)

Con una fuente, la clave canónica es trivial (`source + source_event_id`). Con
varias fuentes, el mismo concierto puede llegar dos veces y **no** queremos
duplicarlo en la UI ni romper favoritos.

**Huella de identidad** (fingerprint):

```
norm(title) + fecha (tolerancia ±3 h) + venue geo (≤ 200 m) + artistas
```

**Estrategia progresiva** (sin sobrediseñar):

1. **Tabla de alias** `event_aliases (source, source_event_id, event_id, confidence)`.
   Cada evento ingerido registra su alias. Si la huella coincide con un
   canónico existente, el alias apunta al canónico.
2. **Umbrales**: ≥ 0,90 ⇒ fusión automática; 0,70–0,90 ⇒ cola de revisión
   (`metadata.needs_review`); < 0,70 ⇒ eventos distintos.
3. **Fusión sin perder favoritos**: nunca se borran filas. Las instancias del
   evento perdedor se **repuntan** al evento canónico
   (`event_instances.event_id = canónico`) y el perdedor queda
   `is_active=false` con `metadata.merged_into`.
4. **Política de ganador**: fuente más oficial > datos más ricos (imagen,
   precio, descripción) > antigüedad de ingesta.

Esto mantiene los UUID deterministas por fuente (trazabilidad) y una única
fila visible en la app.

---

## 10. Observabilidad, SLOs y KPIs

Todo sale de `ingest_runs` y `ingest_sources` (sin herramientas extra).

| KPI | Definición | Objetivo |
|---|---|---|
| **Frescura (SLO)** | p95 antigüedad de `last_verified_at` para eventos de las próximas 24 h | < 30 min (T1) |
| **Cobertura de imagen** | % eventos activos con ≥1 imagen | ≥ 85 % |
| **Cobertura de precio** | % eventos activos con `price_from` | ≥ 70 % (donde la fuente lo publique) |
| **Cobertura de género** | % eventos activos con género mapeado | ≥ 80 % |
| **Geolocalización** | % eventos con coordenadas | 100 % (por diseño) |
| **Fiabilidad** | % corridas `success` sobre total | ≥ 99 % |
| **Presupuesto** | `apiCalls` / `DAILY_QUOTA` | < 60 % |
| **Multi-fuente** | % eventos con > 1 fuente | creciente (fase 2+) |
| **Descartes** | `skippedInvalid` / `fetched` | < 10 % |

**Alertas mínimas**: 2 corridas fallidas consecutivas · `fetched = 0` inesperado
· presupuesto > 80 % · incumplimiento del SLO de frescura. Se pueden disparar
desde un cron de Cloudflare que consulte `/status` del worker.

---

## 11. Comparativa competitiva

Posicionamiento cualitativo (hipótesis a validar con investigación de mercado;
sin cifras inventadas):

| Dimensión | Bandsintown | Songkick | DICE | Resident Advisor | **Live Now Music (propuesta)** |
|---|---|---|---|---|---|
| Foco | Seguir artistas/alertas | Listados de conciertos | Curación + venta | Escena electrónica | **“Qué pasa ahora cerca de mí”** |
| Frescura intradía | Media | Media | Media | Media | **Alta (barrido 30 min)** |
| Cobertura local (salas pequeñas) | Depende de ticketeras | Huecos | Sólo eventos que vende | Sólo electrónica | **Multi-fuente: huecos cubiertos por agendas locales (fase 3)** |
| Modelo de datos | Propietario | Propietario | Propietario | Propietario | **Canónico multi-fuente, auditable** |
| Geolocalización “a pie” | Limitada | Limitada | Limitada | Limitada | **Radio configurable (5–50 km), mapa** |
| Al comprar | Enlace externo | Enlace externo | Vende entradas | Enlace externo | **Enlace a taquilla oficial (`external_url`) + calendario + offline** |
| Editorial/curación | Baja | Media | **Alta** | **Alta** | Media hoy → colecciones (roadmap) |
| Alertas de artista | **Alta** | Media | Baja | Baja | No (roadmap fase 5) |

**Ventajas competitivas reales de este diseño**

1. **Frescura por tiers**: ningún catálogo generalista refresca cada 30 min las
   próximas 48 h; es lo que hace fiable el caso “esta noche / en directo”.
2. **Multi-fuente canónica desde el día 1**: la competencia está atada a su
   inventario (DICE) o a su base de artistas (Bandsintown). Aquí la cobertura
   local se amplía añadiendo adaptadores, sin rehacer producto.
3. **Coste marginal**: Workers + cron + Supabase ya existentes; añadir ciudad o
   fuente es configuración, no infraestructura.
4. **Calidad verificable**: `metadata`, `last_verified_at` y dedupe permiten
   medir y demostrar la calidad del dato (argumento comercial y de QA).
5. **Sin fricción en la app**: respeta el contrato existente; el usuario gana
   carátulas reales, precios y botón de compra sin cambiar de flujo.

**Dónde no somos líderes (y plan para cerrarlo)**: alertas/seguimiento de
artistas y curación editorial. Roadmap: fase 5 (señales de comunidad) y
colecciones editoriales propias apoyadas en el catálogo canónico.

---

## 12. Operación

### Despliegue

```bash
cd live-now-data
npm install
npx wrangler secret put TICKETMASTER_API_KEY   # API key (Consumer Key)
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put INGEST_ADMIN_TOKEN     # protege POST /run
npx wrangler deploy
```

`wrangler.jsonc` ya declara los tres crons (T1/T2/T3) y `ENV`,
`CITIES`, `LOOKAHEAD_DAYS` y `DAILY_QUOTA` como variables.

### Backfill inicial (una vez, antes del primer cron)

```bash
# 1) Migraciones (aditivas + guardas de drift)
#    0001 esquema canónico · 0002 feed (is_active + live_now) · 0003 protección demo
cd ../live-now-music && supabase db push --linked

# 2) Auditoría read-only: ¿el entorno es el esperado?
cd ../live-now-data && bash scripts/preflight.sh

# 3) Carga real: primero en seco, luego en serie
npm run dry-run -- --tier T3 --scope-limit 1
npm run run -- --tier T3
```

> Orden obligatorio: **0002 y 0003 antes del backfill**. Hasta que 0002 se
> aplique, los eventos ingeridos saldrían con `live_now = false` (el filtro
> `now` sí funcionaría, pero la insignia de "en directo" no).

### Diagnóstico

- `GET /health` → liveness.
- `GET /status` → fuentes, última corrida por tier, estadísticas y errores.
- `POST /run?tier=t1|t2|t3` con cabecera `x-admin-token` → corrida manual.

### Runbook (incidentes típicos)

| Síntoma | Causa probable | Acción |
|---|---|---|
| `fetched = 0` en un scope | Ciudad sin coordenadas o ventana vacía | Revisar `CITIES` y la ventana del tier. |
| `429` de la API | Throttle agotado | El orquestador espera; si persiste, subir el intervalo o reducir scopes. |
| Eventos duplicados | Fallo de `onConflict`/índice | Verificar índices únicos `(source, source_*_id)`. |
| Feed sin eventos nuevos | Cron pausado o token inválido | `GET /status` y `wrangler tail`. |
| Conciertos con hora desplazada | `timezone` ausente en payload | Revisar la fila en `genre_mappings`/`metadata`; el normalizador registra el caso. |
| SLO de frescura incumplido | T1 no se ejecuta | Revisar crons y `DAILY_QUOTA`. |
| Error `42883 operator does not exist: uuid = text` al migrar | Drift de tipos (el dump estaba desactualizado) | No parchear con un cast: comprobar la firma real con `preflight.sh` y ajustar la migración. |
| `could not choose the best candidate function` en la RPC | Dos sobrecargas de `get_nearby_events` | Comparar firmas y eliminar la sobrante; la 0002 ya aborta si detecta ambigüedad. |
| Un `reset-demo` / `refresh-dates` no cambia nada | Comportamiento esperado desde 0003: sólo tocan `source='demo'` | Consultar el reparto con `ingest_scope_status()`. |

### Utilidades demo y datos reales (migración 0003)

`reset_demo_data()`, `reset_demo_data_jazz()`, `reset_demo_data_latenight()` y
`refresh_event_dates()` son herramientas de QA expuestas por la API en `/dev/*`.
Antes de la 0003 hacían `TRUNCATE … CASCADE` y reescribían fechas de **todas**
las instancias: con catálogo real eso equivalía a borrarlo.

Desde la 0003 quedan acotadas a `source='demo'`, con `EXECUTE` restringido a
`service_role`, y `ingest_scope_status()` permite auditar el reparto:

```sql
select public.ingest_scope_status();
-- { "demo_events": 25, "ingested_events": 0, "inactive_events": 0, ... }
```

---

## 13. Seguridad y cumplimiento

- **Sólo datos públicos de eventos** (título, sala, fecha, precio publicado,
  enlace oficial). No se recopilan datos personales de asistentes.
- **Crawling legítimo**: en fases futuras, `robots.txt` respetado, rate limit
  conservador (1 req/s), User-Agent identificable y preferencia por feed
  sindicado o API frente al HTML.
- **Secretos**: sólo en `wrangler secret` / `.dev.vars` (nunca en el repo;
  `.gitignore` creado). `service_role` **jamás** en la app móvil.
- **RLS**: las tablas de ingesta quedan cerradas; la app lee exclusivamente a
  través de `live-now-api`.
- **Atribución**: `external_url` y `source` permiten citar al proveedor y al
  enlace oficial de compra (buena práctica y requisito de las APIs).
- **Privacidad**: la geolocalización del usuario no se persiste; sólo se usa
  como parámetro de consulta.

---

## 14. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Cuota de API insuficiente | Cobertura incompleta | Scopes priorizados por proximidad temporal + `DAILY_QUOTA` + ampliación con 2ª fuente. |
| Cambio de esquema en la fuente | Normalización rota | Accesos defensivos, tests de normalización con payloads reales, `metadata` crudo. |
| Duplicados al añadir fuentes | Mala UX + favoritos rotos | Alias + fingerprint + fusión por repunte (§9). |
| Eventos obsoletos servidos | Pérdida de confianza | `is_active` + `last_verified_at` + tiers cortos. |
| Coste de crecimiento | Sostenibilidad | Workers/cron de coste fijo; añadir ciudad = configuración. |
| Dependencia de una sola fuente | Fragilidad comercial | Roadmap multi-fuente ya diseñado. |

---

## 15. Entregables

| Entregable | Ubicación |
|---|---|
| Worker de ingesta canónico | `/Users/gb/Downloads/live-now-data` |
| Migración de esquema + gobernanza | `live-now-music/supabase/migrations/20260914000001_ingest_canonical.sql` |
| Feed alineado con la ingesta (is_active + live_now, con guarda de drift) | `live-now-music/supabase/migrations/20260914000002_events_active_and_live.sql` |
| Protección del catálogo ingerido (utilidades demo acotadas) | `live-now-music/supabase/migrations/20260914000003_protect_ingested_data.sql` |
| Arnés de validación SQL (3 escenarios) | `live-now-music/scripts/validate-ingest-sql.sh` |
| Auditoría preflight de la BD real | `live-now-data/scripts/preflight.sh` |
| Adaptación del API (feed, detalle, búsqueda, favoritos) | `live-now-api/src/services/*.ts`, `src/utils/appEvent.ts` |
| Contrato `AppEvent` extendido | `/Users/gb/Downloads/shared/events.ts` |
| Documentación de operación | `live-now-data/README.md` |
| Propuesta y arquitectura | `live-now-data/docs/PROPUESTA.md` (este documento) |

---

## 16. Checklist de puesta en marcha

- [x] Código del worker + tests (36) y typecheck.
- [x] Migraciones escritas: 0001 canónica, 0002 feed (firma real `uuid` + guarda
      de drift) y 0003 protección del catálogo ingerido.
- [x] Arnés SQL con 3 escenarios (real / drift / BD nueva): 17 aserciones OK.
- [x] Preflight read-only contra la BD real (`live-now-data/scripts/preflight.sh`):
      18 OK / 0 fallos (2026-09-22).
- [x] API adaptada con filtros de visibilidad y tests (39).
- [x] Contrato compartido y app preparados (imágenes reales + CTA de compra).
- [x] Documentación de operación y propuesta.
- [x] Migraciones 0001–0003 aplicadas en producción
      (`supabase migration list` → Local = Remote; verificado 2026-09-22).
- [x] `TICKETMASTER_API_KEY` cargado como secret del worker
      (`wrangler secret list` lo confirma).
- [x] `bash scripts/preflight.sh` → OK (las 4 secciones).
- [x] Backfill inicial: 81 eventos / 32 venues ingeridos (2026-09-22).
- [x] `wrangler deploy` (crons T1/T2/T3 activos; último 2026-09-22).
- [x] Verificar `/status` y el feed real en la app
      (`/status` → run `success`; feed `now`/`tonight` → 200).

> Todo el checklist queda cerrado (2026-09-22). Se corrigieron dos bugs que
> impedían registrar runs en producción: `fetch` invocado como método de
> instancia (`Illegal invocation` en workerd) y `ingest_runs.stats NOT NULL`
> roto en el path de error. Tests de regresión en
> `test/ticketmaster-adapter.test.ts`.