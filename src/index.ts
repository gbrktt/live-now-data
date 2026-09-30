/**
 * Worker de ingesta con Cron Triggers de Cloudflare.
 *
 * · scheduled(): ejecuta el barrido según la frecuencia del trigger.
 * · fetch():    /health (público), /status y POST /run (token admin).
 */

import { createClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { TicketmasterAdapter } from './adapters/ticketmaster.ts';
import {
  fromToForTier,
  parseConfig,
  scopeModeForTier,
  TIERS,
  tierFromCron,
  type Tier,
} from './config.ts';
import { TicketmasterNormalizer } from './normalize/ticketmaster.ts';
import { runIngest } from './orchestrator.ts';
import { SupabaseWriter } from './persist/supabase.ts';
import type { IngestResult } from './types.ts';

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
  // Index signature para poder pasar Env a parseConfig (Record<string, string|undefined>).
  [key: string]: string | undefined;
}

const SOURCE = 'ticketmaster' as const;

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

async function runOnce(env: Env, tier: Tier, dryRun: boolean): Promise<RunOnceResult> {
  const config = parseConfig(env);
  const { from, to } = fromToForTier(tier);
  const writer = new SupabaseWriter({
    url: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    dryRun,
  });
  const adapter = new TicketmasterAdapter({
    apiKey: config.ticketmasterApiKey,
  });
  const normalizer = new TicketmasterNormalizer();

  const result = await runIngest({
    source: SOURCE,
    adapter,
    normalizer,
    writer,
    from,
    to,
    cities: config.cities,
    countryCode: config.countryCode,
    scopeMode: scopeModeForTier(tier, config.scopeMode),
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
  watermarkTo: Date | null
): Promise<void> {
  const client = createSupabase(env);
  const finishedAt = new Date().toISOString();

  const { error: insertError } = await client.from('ingest_runs').insert({
    source: SOURCE,
    tier,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt,
    status: error ? 'failed' : (result?.status ?? 'empty'),
    // La columna ingest_runs.stats es NOT NULL: en el path de error (sin
    // result) hay que enviar {} para que el registro del fallo no reviente.
    stats: result?.stats ?? {},
    error: error
      ? { message: error instanceof Error ? error.message : String(error) }
      : null,
  });
  if (insertError) throw insertError;

  const { error: upsertError } = await client
    .from('ingest_sources')
    .upsert(
      {
        code: SOURCE,
        name: 'Ticketmaster Discovery API',
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
    dryRun?: boolean;
  };
  const tier: Tier =
    body.tier && body.tier.toUpperCase() in TIERS
      ? (body.tier.toUpperCase() as Tier)
      : 'T1';
  const dryRun = body.dryRun === true;
  const startedAt = new Date();

  try {
    const { result, from, to } = await runOnce(c.env, tier, dryRun);
    if (!dryRun) {
      await recordRun(c.env, tier, startedAt, result, null, to);
    }
    return c.json({
      ok: true,
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
      await recordRun(c.env, tier, startedAt, null, error, null).catch(
        (recordError) => {
          console.error('[ingest] recordRun falló', recordError);
        }
      );
    }
    return c.json(
      {
        ok: false,
        tier,
        error: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

/** Ejecuta el barrido para la frecuencia indicada por el cron. */
async function executeScheduled(env: Env, cron: string): Promise<void> {
  const tier = tierFromCron(cron);
  const startedAt = new Date();
  try {
    const { result, to } = await runOnce(env, tier, false);
    await recordRun(env, tier, startedAt, result, null, to);
    console.log(
      `[ingest] tier=${tier} status=${result.status}`,
      result.stats,
      `scopes=${result.scopesProcessed}`
    );
  } catch (error) {
    console.error(`[ingest] tier=${tier} ERROR`, error);
    await recordRun(env, tier, startedAt, null, error, null).catch(
      (recordError) => {
        console.error('[ingest] recordRun falló en scheduled', recordError);
      }
    );
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