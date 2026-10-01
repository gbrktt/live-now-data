#!/usr/bin/env node
/**
 * Runner local (CLI) del barrido de ingesta.
 *
 * Útil para backfill y pruebas sin desplegar el worker:
 *   npm run run            # barrido completo T3 contra la BD real
 *   npm run dry-run        # solo consulta a Ticketmaster, NO escribe
 *   node src/run-local.ts --tier T1 --dry-run
 *   node src/run-local.ts --cities "madrid|40.4168,-3.7038|50"
 *   node src/run-local.ts --tier T3 --scope-mode country    # barrido por país
 *   node src/run-local.ts --tier T3 --scope-mode hybrid     # país + ciudades
 *   node src/run-local.ts --scope-limit 1     # solo el primer scope (prueba)
 *
 * Por defecto el modo de barrido es el de cada tier (T1 ciudad, T2/T3 país);
 * `--scope-mode` lo fuerza.
 *
 * Lee las variables de un `.dev.vars` en la raíz del repo y de process.env.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BcnOpenAdapter } from './adapters/bcn-open.ts';
import { TicketmasterAdapter } from './adapters/ticketmaster.ts';
import { fromToForTier, parseConfig, scopeModeForTier, TIERS, type Tier } from './config.ts';
import { TicketmasterNormalizer } from './normalize/ticketmaster.ts';
import { BcnOpenNormalizer } from './normalize/bcn-open.ts';
import { runIngest } from './orchestrator.ts';
import { SupabaseWriter } from './persist/supabase.ts';
import { parseScopeMode, type CityScopeConfig, type ScopeMode } from './scopes.ts';
import type { IngestScope, SourceCode } from './types.ts';

function loadDevVars(): Record<string, string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', '.dev.vars'), 'utf8');
    const vars: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

function parseTier(value: string | undefined): Tier {
  const upper = value?.toUpperCase();
  if (upper && upper in TIERS) return upper as Tier;
  return 'T3';
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function parseSource(value: string | undefined): SourceCode {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'bcn_open' || v === 'bcn' || v === 'bcnopen') return 'bcn_open';
  return 'ticketmaster';
}

function parseFlags(argv: string[]): {
  dryRun: boolean;
  tier: Tier;
  scopeLimit: number;
  citiesArg: string | null;
  scopeMode: ScopeMode | undefined;
  source: SourceCode;
} {
  return {
    dryRun: argv.includes('--dry-run'),
    tier: parseTier(getArg('--tier')),
    scopeLimit: Number(getArg('--scope-limit') ?? 0),
    citiesArg: getArg('--cities') ?? null,
    scopeMode: parseScopeMode(getArg('--scope-mode')),
    source: parseSource(getArg('--source')),
  };
}

function parseCityEntry(entry: string): CityScopeConfig {
  const [city, latlong, radius] = entry.split('|');
  const [lat, lng] = (latlong ?? '').split(',');
  const latNum = Number(lat);
  const lngNum = Number(lng);
  const radiusKm = Number(radius);
  if (
    !city ||
    !Number.isFinite(latNum) ||
    !Number.isFinite(lngNum) ||
    !Number.isFinite(radiusKm)
  ) {
    throw new Error(
      `CITY inválida: "${entry}". Formato: nombre|lat,lng|radioKm`
    );
  }
  return {
    city,
    latlong: `${latNum},${lngNum}`,
    radiusKm,
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const env = {
    ...loadDevVars(),
    ...process.env,
  } as Record<string, string | undefined>;

  const config = parseConfig(env);
  const cities = flags.citiesArg
    ? flags.citiesArg
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(parseCityEntry)
    : [...config.cities];
  const effectiveCities = flags.scopeLimit > 0 ? cities.slice(0, 1) : cities;

  const { from, to } = fromToForTier(flags.tier);
  const writer = new SupabaseWriter({
    url: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    dryRun: flags.dryRun,
  });

  // Cada fuente trae su adapter + normalizer. El resto (orquestador, writer,
  // dedupe) es idéntico: añadir una fuente NO toca la base de datos ni la app.
  const isBcn = flags.source === 'bcn_open';
  const adapter = isBcn
    ? new BcnOpenAdapter({ url: config.bcnOpenUrl })
    : new TicketmasterAdapter({ apiKey: config.ticketmasterApiKey });
  const normalizer = isBcn
    ? new BcnOpenNormalizer()
    : new TicketmasterNormalizer();

  // La agenda municipal no se particiona por ciudad: devuelve el fichero
  // entero y el adaptador filtra por la ventana del scope.
  const scopes: IngestScope[] | undefined = isBcn
    ? [
        {
          key: `bcn-open-${from.toISOString()}--${to.toISOString()}`,
          source: flags.source,
          params: { from: from.toISOString(), to: to.toISOString() },
        },
      ]
    : undefined;

  console.log(
    `[live-now-data] source=${flags.source} tier=${flags.tier} ` +
      `dryRun=${flags.dryRun} from=${from.toISOString()} to=${to.toISOString()}`
  );
  const scopeMode = flags.scopeMode ?? config.scopeMode ?? scopeModeForTier(flags.tier, config.scopeMode);
  if (!isBcn) {
    console.log(
      `[live-now-data] scopeMode=${scopeMode}` +
        (scopeMode === 'country'
          ? ` país=${config.countryCode} (sin geo)`
          : ` ciudades: ${effectiveCities
              .map((c) => `${c.city}@${c.radiusKm}km`)
              .join(', ')}`)
    );
  } else {
    console.log('[live-now-data] fuente municipal: un único scope por ventana');
  }
  console.log(`[live-now-data] cuota diaria=${config.dailyQuota}`);

  const result = await runIngest({
    source: flags.source,
    adapter,
    normalizer,
    writer,
    from,
    to,
    cities: effectiveCities,
    countryCode: config.countryCode,
    scopeMode,
    scopes,
    windowDays: TIERS[flags.tier].windowDays,
    dailyQuota: config.dailyQuota,
    maxScopes: flags.scopeLimit,
    onPage: (scope, stats) => {
      console.log(
        `  [scope] ${scope.key} · llamadas=${stats.apiCalls} ` +
          `fetched=${stats.fetched} eventos=${stats.eventsUpserted}`
      );
    },
  });

  console.log('\n--- Resultado ---');
  console.log(JSON.stringify(result, null, 2));

  if (result.status === 'budget-exhausted') {
    process.exitCode = 3;
  }
}

main().catch((error: unknown) => {
  console.error('\n[live-now-data] ERROR:', error);
  process.exit(1);
});