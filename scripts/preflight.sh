#!/usr/bin/env bash
#
# Preflight (SOLO LECTURA) del entorno de ingesta contra la BD real.
#
# Comprueba, antes de un backfill, que el esquema desplegado es el que el
# worker de ingesta y la app esperan. Detecta el tipo de drift que provocó el
# fallo de la migración 0002 (`favorites.user_id` es uuid, no text).
#
# Uso:  bash scripts/preflight.sh
# Lee SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY de .dev.vars (este repo) o de
# ../live-now-api/.dev.vars. No escribe nada en la base de datos.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ✔ $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ✘ $1"; }

read_var() { # $1 fichero  $2 clave
  [ -f "$1" ] || return 1
  local v
  v=$(grep -m1 "^$2=" "$1" | cut -d= -f2- | tr -d '"')
  [ -n "$v" ] && printf '%s' "$v"
}

ENV_FILE="$HERE/.dev.vars"
[ -f "$ENV_FILE" ] || ENV_FILE="$HERE/../live-now-api/.dev.vars"
URL=$(read_var "$ENV_FILE" SUPABASE_URL || true)
KEY=$(read_var "$ENV_FILE" SUPABASE_SERVICE_ROLE_KEY || true)

if [ -z "${URL:-}" ] || [ -z "${KEY:-}" ]; then
  echo "ERROR: faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (buscado en $ENV_FILE)" >&2
  exit 2
fi

HDR=(-H "apikey: $KEY" -H "Authorization: Bearer $KEY")
ANON="00000000-0000-0000-0000-000000000000"

req()   { curl -s "$URL/rest/v1/$1" "${HDR[@]}"; }
count() { curl -s -I "$URL/rest/v1/$1" "${HDR[@]}" -H 'Prefer: count=exact' -H 'Range: 0-0' \
          | grep -i '^content-range' | sed -E 's#.*/([0-9]*).*#\1#' | tr -d '\r'; }
rpc()   { curl -s -X POST "$URL/rest/v1/rpc/$1" "${HDR[@]}" -H 'Content-Type: application/json' -d "${2:-{\}}"; }

echo "[preflight] destino: $URL"
echo "[preflight] entorno:  $ENV_FILE"
echo "[preflight] 1) esquema canónico (migración 20260914000001)"
for spec in \
  "events:select=id,source,source_event_id,images,external_url,metadata,ingested_at,last_verified_at,is_active&limit=1" \
  "venues:select=id,source,source_venue_id,timezone,external_url&limit=1" \
  "event_instances:select=id,source,source_instance_id&limit=1"
do
  table="${spec%%:*}"; query="${spec#*:}"
  body=$(req "$table?$query")
  if [[ "$body" == *'"code"'* ]]; then
    bad "$table → columnas canónicas NO disponibles: $(cut -c1-160 <<<"$body")"
  else
    ok "$table → columnas canónicas presentes"
  fi
done

for t in ingest_sources ingest_runs genre_mappings; do
  # status HTTP en vez de adivinar por "code" en el body: ingest_sources
  # tiene columna real `code` (p. ej. "ticketmaster") y select=* la devuelve,
  # lo que hacía falsos positivos de "tabla ausente" con filas presentes.
  status=$(curl -s -o /dev/null -w '%{http_code}' "$URL/rest/v1/$t?select=*&limit=1" "${HDR[@]}" || echo 000)
  if [[ ! "$status" =~ ^2 ]]; then bad "tabla $t ausente (HTTP $status)"; else ok "tabla $t presente"; fi
echo "[preflight] 2) gobernanza y RLS (service_role debe saltar RLS)"
gm=$(count genre_mappings)
if [[ "${gm:-x}" =~ ^[0-9]+$ ]] && [ "${gm:-0}" -ge 1 ]; then
  ok "genre_mappings con $gm filas visibles con service_role (bypass RLS correcto)"
else
  bad "genre_mappings no visible como service_role (¿clave anon? ¿RLS sin bypass?)"
fi

echo "[preflight] 3) contrato de la RPC get_nearby_events"
RPC_ARGS="{\"p_lat\":40.4168,\"p_lng\":-3.7038,\"p_radius_km\":50,\"p_time_range\":\"any\",\"p_user_id\":\"$ANON\",\"p_genre\":null,\"p_live_only\":false,\"p_min_price\":null,\"p_max_price\":null,\"p_sort\":\"distance\",\"p_limit\":1}"
rows=$(rpc get_nearby_events "$RPC_ARGS")
if [[ "$rows" == *'"code"'* ]]; then
  bad "RPC no invocable: $(cut -c1-160 <<<"$rows")"
else
  ncols=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(len(d[0]) if d else 0)" "$rows" 2>/dev/null || echo 0)
  if [ "$ncols" = "16" ]; then ok "RPC devuelve 16 columnas (contrato estable)"; else bad "RPC devuelve $ncols columnas (esperado 16)"; fi
fi

probe=$(rpc get_nearby_events "${RPC_ARGS//$ANON/no-es-uuid}")
if [[ "$probe" == *22P02* ]]; then
  ok "p_user_id y favorites.user_id son uuid (22P02 ante valor no-uuid)"
else
  bad "p_user_id NO se comporta como uuid: $(cut -c1-160 <<<"$probe")"
fi

echo "[preflight] 4) protección de datos ingeridos (migración 20260914000003)"
scope=$(rpc ingest_scope_status '{}')
if [[ "$scope" == *'"code"'* ]]; then
  bad "0003 pendiente: falta ingest_scope_status() y las utilidades demo NO están acotadas a demo"
else
  ok "0003 aplicada: utilidades demo acotadas a source='demo' → $scope"
fi

echo ""
echo "-------------------------------------------"
echo "Comprobaciones OK: $PASS   Fallos: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "RESULTADO: PREFLIGHT FALLÓ — no lances el backfill hasta resolverlo"
  exit 1
fi
echo "RESULTADO: OK — entorno listo para la ingesta"
done