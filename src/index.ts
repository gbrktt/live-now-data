/**
 * Worker de ingesta con Cron Triggers de Cloudflare.
 *
 * · scheduled(): ejecuta el barrido según la frecuencia del trigger.
 * · fetch():    /health (público), /status y POST /run (token admin).
 */

import { createClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { BcnOpenAdapter } from './adapters/bcn-open.ts';
import { MadridOpenAdapter } from './adapters/madrid-open.ts';
import { TicketmasterAdapter } from './adapters/ticketmaster.ts';
import {
  fromToForTier,
  parseConfig,
  scopeModeForTier,
  TIERS,
  tierFromCron,
  type Tier,
} from './config.ts';
import { BcnOpenNormalizer } from './normalize/bcn-open.ts';
import { MadridOpenNormalizer } from './normalize/madrid-open.ts';
import { TicketmasterNormalizer } from './normalize/ticketmaster.ts';
import { runIngest } from './orchestrator.ts';
import { SupabaseWriter } from './persist/supabase.ts';
import type {
  EventSourceAdapter,
  IngestResult,
  IngestScope,
  Normalizer,
  SourceCode,
} from './types.ts';

export interface Env {
  TICKETMASTER_API_KEY: string;
  SUPABASE_URL: string;
  /** Clave de administrador nueva (`sb_secret_…`) — la preferida. */
  SUPABASE_SECRET_KEY?: string;
  /** Clave de administrador legacy (JWT) — deprecada por Supabase. */
  SUPABASE_SERVICE_ROLE_KEY?: string;
  INGEST_ADMIN_TOKEN: string;
  ENV?: string;
  CITIES?: string;
  LOOKAHEAD_DAYS?: string;
  DAILY_QUOTA?: string;
  COUNTRY_CODE?: string;
  /** Fuerza el modo de barrido (`city`/`country`/`hybrid`) en todos los tiers. */
  SCOPE_MODE?: string;
  /** URL override del CSV de Madrid (por defecto, la de datos.madrid.es). */
  MADRID_OPEN_URL?: string;
  /** `false` apaga la agenda de Madrid sin desplegar. */
  MADRID_OPEN_ENABLED?: string;
  // Index signature para poder pasar Env a parseConfig (Record<string, string|undefined>).
  [key: string]: string | undefined;
}

/**
 * Serializa un error de forma legible. Supabase y el propio fetch lancan
 * objetos planos (`{message, code, details}`), no `Error`: sin esto la ruta
 * `/run` respondía `[object Object]` y no había forma de diagnosticar.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const parts = [record['message'], record['code'], record['details'], record['hint']]
      .filter((v) => typeof v === 'string' && v.length > 0)
      .map(String);
    if (parts.length > 0) return parts.join(' | ');
    try {
      return JSON.stringify(error).slice(0, 300);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}

const SOURCE = 'ticketmaster' as const;
const SOURCE_BCN = 'bcn_open' as const;
const SOURCE_MADRID = 'madrid_open' as const;

const SOURCE_NAMES: Record<string, string> = {
  ticketmaster: 'Ticketmaster Discovery API',
  bcn_open: 'Agenda Cultural de Barcelona (datos abiertos)',
  madrid_open: 'Agenda cultural de Madrid (datos abiertos)',
};

function createSupabase(env: Env) {
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error('Falta SUPABASE_SECRET_KEY (o SUPABASE_SERVICE_ROLE_KEY legacy)');
  }
  return createClient(env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface RunOnceResult {
  result: IngestResult;
  from: Date;
  to: Date;
}

async function runOnce(
  env: Env,
  tier: Tier,
  dryRun: boolean,
  source: SourceCode = SOURCE
): Promise<RunOnceResult> {
  const config = parseConfig(env);
  const { from, to } = fromToForTier(tier);
  const writer = new SupabaseWriter({
    url: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    dryRun,
  });

  // Cada fuente trae su adapter + normalizer. Orquestador, writer y dedupe son
  // los mismos: añadir una fuente NO toca la base de datos ni la app.
  const isMunicipal = source === SOURCE_BCN || source === SOURCE_MADRID;
  let adapter: EventSourceAdapter;
  let normalizer: Normalizer<unknown>;
  if (source === SOURCE_BCN) {
    adapter = new BcnOpenAdapter({ url: config.bcnOpenUrl });
    normalizer = new BcnOpenNormalizer();
  } else if (source === SOURCE_MADRID) {
    adapter = new MadridOpenAdapter({ url: config.madridOpenUrl });
    normalizer = new MadridOpenNormalizer();
  } else {
    adapter = new TicketmasterAdapter({ apiKey: config.ticketmasterApiKey });
    normalizer = new TicketmasterNormalizer();
  }

  // Las agendas municipales no se particionan por ciudad: un único scope por
  // ventana (el adaptador filtra el fichero entero).
  const scopes: IngestScope[] | undefined = isMunicipal
    ? [
        {
          key: `${source}-${from.toISOString()}--${to.toISOString()}`,
          source,
          params: { from: from.toISOString(), to: to.toISOString() },
        },
      ]
    : undefined;

  const result = await runIngest({
    source,
    adapter,
    normalizer,
    writer,
    from,
    to,
    cities: config.cities,
    countryCode: config.countryCode,
    scopeMode: scopeModeForTier(tier, config.scopeMode),
    scopes,
    windowDays: TIERS[tier].windowDays,
    dailyQuota: config.dailyQuota,
  });

  return { result, from, to };
}

async function recordRun(
  env: Env,
  tier: Tier,
  startedAt: Date,
  result: IngestResult | null,
  error: unknown,
  watermarkTo: Date | null,
  source: SourceCode = SOURCE
): Promise<void> {
  const client = createSupabase(env);
  const finishedAt = new Date().toISOString();

  const { error: insertError } = await client.from('ingest_runs').insert({
    source,
    tier,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt,
    status: error ? 'failed' : (result?.status ?? 'empty'),
    // La columna ingest_runs.stats es NOT NULL: en el path de error (sin
    // result) hay que enviar {} para que el registro del fallo no reviente.
    stats: result?.stats ?? {},
    error: error
      ? { message: describeError(error) }
      : null,
  });
  if (insertError) throw insertError;

  const { error: upsertError } = await client
    .from('ingest_sources')
    .upsert(
      {
        code: source,
        name: SOURCE_NAMES[source] ?? source,
        enabled: true,
        config: { tiers: Object.values(TIERS) },
        last_run_at: finishedAt,
        last_watermark: watermarkTo?.toISOString() ?? null,
      },
      { onConflict: 'code' }
    );
  if (upsertError) throw upsertError;
}

function isAuthorized(
  c: { req: { header(name: string): string | undefined } },
  env: Env
): boolean {
  const bearer = c.req.header('Authorization');
  const token = bearer?.startsWith('Bearer ')
    ? bearer.slice(7)
    : c.req.header('x-ingest-token');
  return token === env.INGEST_ADMIN_TOKEN;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) =>
  c.json({ ok: true, service: 'live-now-ingest', ts: new Date().toISOString() })
);

app.get('/status', async (c) => {
  if (!isAuthorized(c, c.env)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const client = createSupabase(c.env);
  const [{ data: runs }, { data: sources }] = await Promise.all([
    client
      .from('ingest_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(10),
    client.from('ingest_sources').select('*'),
  ]);
  return c.json({ sources: sources ?? [], runs: runs ?? [] });
});

app.post('/run', async (c) => {
  if (!isAuthorized(c, c.env)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    tier?: string;
    dryRun?: boolean | string;
    source?: string;
  };
  // Hono + workerd: en POST `c.req.query()` puede devolver `{}` aunque la URL
  // traiga query (medido 2026-10-05: `?tier=T2&source=madrid_open` se ignoraba
  // y corría T1/ticketmaster). La URL cruda; el cuerpo manda si la trae.
  const rawQuery = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const query = { ...rawQuery, ...c.req.query() };
  const tierRaw = body.tier ?? query['tier'];
  const tier: Tier =
    typeof tierRaw === 'string' && tierRaw.toUpperCase() in TIERS
      ? (tierRaw.toUpperCase() as Tier)
      : 'T1';
  const sourceRaw = body.source ?? query['source'];
  const source: SourceCode =
    sourceRaw === SOURCE_BCN || sourceRaw === SOURCE_MADRID ? sourceRaw : SOURCE;
  const dryRunRaw = body.dryRun ?? query['dryRun'];
  const dryRun = dryRunRaw === true || dryRunRaw === 'true' || dryRunRaw === '1';
  const startedAt = new Date();

  try {
    const { result, from, to } = await runOnce(c.env, tier, dryRun, source);
    if (!dryRun) {
      await recordRun(c.env, tier, startedAt, result, null, to, source);
    }
    return c.json({
      ok: true,
      source,
      tier,
      dryRun,
      from: from.toISOString(),
      to: to.toISOString(),
      status: result.status,
      stats: result.stats,
      scopesProcessed: result.scopesProcessed,
      lastScope: result.lastScope,
    });
  } catch (error) {
    if (!dryRun) {
      await recordRun(c.env, tier, startedAt, null, error, null, source).catch(
        (recordError) => {
          console.error('[ingest] recordRun falló', recordError);
        }
      );
    }
    return c.json(
      {
        ok: false,
        source,
        tier,
        error: describeError(error),
      },
      500
    );
  }
});

/** Ejecuta el barrido de UNA fuente para la frecuencia indicada por el cron. */
async function runSourceScheduled(
  env: Env,
  tier: Tier,
  source: SourceCode
): Promise<void> {
  const startedAt = new Date();
  try {
    const { result, to } = await runOnce(env, tier, false, source);
    await recordRun(env, tier, startedAt, result, null, to, source);
    console.log(
      `[ingest] source=${source} tier=${tier} status=${result.status}`,
      result.stats,
      `scopes=${result.scopesProcessed}`
    );
  } catch (error) {
    console.error(`[ingest] source=${source} tier=${tier} ERROR`, describeError(error));
    await recordRun(env, tier, startedAt, null, error, null, source).catch(
      (recordError) => {
        console.error('[ingest] recordRun falló en scheduled', recordError);
      }
    );
  }
}

/**
 * Fuentes que corren en cada cron.
 *
 * Ticketmaster va siempre: T1 (48 h, cada 30 min) es su frescura.
 * Las agendas municipales NO van en T1: son ~9,4 MB por corrida (BCN 7,8 +
 * Madrid 1,6) y 48 corridas diarias para documentos que se actualizan a
 * diario. Con T2 (2×/día) y T3 (1×/día) basta (mismo criterio medido para
 * BCN: de ~373 MB/día a ~23 MB/día; Madrid añade ~3 MB/día).
 */
function sourcesForTier(
  tier: Tier,
  bcnEnabled: boolean,
  madridEnabled: boolean
): SourceCode[] {
  if (tier === 'T1') return [SOURCE];
  const municipal: SourceCode[] = [];
  if (bcnEnabled) municipal.push(SOURCE_BCN);
  if (madridEnabled) municipal.push(SOURCE_MADRID);
  return municipal.length === 0 ? [SOURCE] : [SOURCE, ...municipal];
}

async function executeScheduled(env: Env, cron: string): Promise<void> {
  const tier = tierFromCron(cron);
  const config = parseConfig(env);
  const sources = sourcesForTier(
    tier,
    config.bcnOpenEnabled !== false,
    config.madridOpenEnabled !== false
  );
  for (const source of sources) {
    await runSourceScheduled(env, tier, source);
  }
}

export default {
  async scheduled(
    controller: { cron: string },
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<void> {
    const { cron } = controller;
    console.log(`[ingest] cron trigger "${cron}"`);
    ctx.waitUntil(executeScheduled(env, cron));
  },

  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    return app.fetch(
      request,
      env,
      ctx as Parameters<typeof app.fetch>[2]
    );
  },
};