/**
 * Configuración del sistema de ingesta (env vars).
 * Windows de despliegue: worker de Cloudflare / CLI local / tests.
 */

import { parseCities, type CityScopeConfig } from './scopes.ts';

export type Tier = 'T1' | 'T2' | 'T3';

export interface TierParams {
  tier: Tier;
  /** Días de lookahead desde now (además de la ventana de -2h de arranque). */
  lookaheadDays: number;
  /** Tamaño de ventana por scope en días. */
  windowDays: number;
}

export const TIERS: Record<Tier, TierParams> = {
  // Frescura "now/tonight": próximas 48h, cada 30 min.
  T1: { tier: 'T1', lookaheadDays: 2, windowDays: 2 },
  // Estado de venta y repromesis: próximos 7 días, 2× al día.
  T2: { tier: 'T2', lookaheadDays: 7, windowDays: 4 },
  // Catálogo completo: lookahead configurable (default 63 días), 1× al día.
  T3: { tier: 'T3', lookaheadDays: 63, windowDays: 10 },
};

/** Ventana temporal de arranque: coger eventos ya empezados desde -2h. */
export const STARTBACK_HOURS = 2;

export interface DataConfig {
  ticketmasterApiKey: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  adminToken: string;
  env: 'development' | 'production';
  cities: CityScopeConfig[];
  lookaheadDays: number;
  dailyQuota: number;
  countryCode: string;
}

export function parseConfig(
  env: Record<string, string | undefined>
): DataConfig {
  function required(key: string): string {
    const value = env[key];
    if (!value || value.trim() === '') {
      throw new Error(`Falta la variable de entorno requerida: ${key}`);
    }
    return value;
  }

  const lookaheadDays = Number(env['LOOKAHEAD_DAYS'] ?? 63);
  const dailyQuota = Number(env['DAILY_QUOTA'] ?? 4000);

  return {
    ticketmasterApiKey: required('TICKETMASTER_API_KEY'),
    supabaseUrl: required('SUPABASE_URL'),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    adminToken: required('INGEST_ADMIN_TOKEN'),
    env: env['ENV'] === 'production' ? 'production' : 'development',
    cities: parseCities(env['CITIES']),
    lookaheadDays: Number.isFinite(lookaheadDays) && lookaheadDays > 0 ? lookaheadDays : 63,
    dailyQuota: Number.isFinite(dailyQuota) && dailyQuota > 0 ? dailyQuota : 4000,
    countryCode: env['COUNTRY_CODE'] ?? 'ES',
  };
}

export function fromToForTier(tier: Tier, now: Date = new Date()): { from: Date; to: Date } {
  const params = TIERS[tier];
  const from = new Date(now.getTime() - STARTBACK_HOURS * 3_600_000);
  const to = new Date(now.getTime() + params.lookaheadDays * 86_400_000);
  return { from, to };
}

export function tierFromCron(cron: string): Tier {
  if (cron === '0 3,11 * * *') return 'T2';
  if (cron === '0 5 * * *') return 'T3';
  return 'T1'; // '*/30 * * * *' y cualquier otro
}