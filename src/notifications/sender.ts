/**
 * Emisor de recordatorios: orquesta la lógica pura (`reminders.ts`) con las
 * consultas a Supabase y el envío a Expo (`expo.ts`).
 *
 * Flujo de una pasada:
 *   1) Instancias favoritas que empiezan en [now, now + withinHours].
 *   2) Tokens activos de esos usuarios.
 *   3) Pares ya notificados (notification_log) → se descartan.
 *   4) Se construyen los mensajes y se envían a Expo en chunks de 100.
 *   5) Se registra en notification_log lo enviado (idempotencia futura).
 *
 * Nunca lanza por un fallo de envío: un cron roto no debe tumbar el worker.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sendPushChunk } from './expo.ts';
import {
  buildPushMessages,
  chunkMessages,
  REMINDER_KIND,
  selectReminders,
  type PushMessage,
  type ReminderCandidate,
} from './reminders.ts';

export type SenderEnv = {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

export type SenderOptions = {
  /** Ventana de anticipación del aviso, en horas (default 6). */
  withinHours?: number;
  /** Reloj inyectable para tests. */
  now?: Date;
  /** Cliente inyectable para tests (si no, se crea desde env). */
  supabase?: SupabaseClient;
  /** Envío inyectable para tests. */
  sendChunk?: typeof sendPushChunk;
};

export type SenderResult = {
  candidates: number;
  sent: number;
  logged: number;
  errors: string[];
};

type InstanceMeta = {
  title: string;
  venueName: string | null;
  city: string | null;
  startsAt: string;
};

function serviceClient(env: SenderEnv): SupabaseClient {
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Falta SUPABASE_SECRET_KEY (o SUPABASE_SERVICE_ROLE_KEY)');
  return createClient(env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Ejecuta una pasada de recordatorios. Devuelve métricas para el log del cron;
 * los errores se acumulan en `errors` en vez de propagarse.
 */
export async function runReminderPass(
  env: SenderEnv,
  options: SenderOptions = {}
): Promise<SenderResult> {
  const now = options.now ?? new Date();
  const withinHours = options.withinHours ?? 6;
  const supabase = options.supabase ?? serviceClient(env);
  const send = options.sendChunk ?? sendPushChunk;

  const result: SenderResult = { candidates: 0, sent: 0, logged: 0, errors: [] };

  const from = new Date(now.getTime() - 2 * 3_600_000).toISOString(); // ya empezados (-2h)
  const to = new Date(now.getTime() + withinHours * 3_600_000).toISOString();

  // 1) Instancias que empiezan en la ventana, con su evento y venue.
  const { data: instances, error: instErr } = await supabase
    .from('event_instances')
    .select(
      `id, starts_at,
       events:event_id ( id, title, is_active, venue_id, venues:venue_id ( name, city ) )`
    )
    .gte('starts_at', from)
    .lte('starts_at', to);

  if (instErr) {
    result.errors.push(`instancias: ${instErr.message}`);
    return result;
  }

  type EventRel = {
    id: string;
    title: string;
    is_active: boolean | null;
    venue_id: string;
    venues: { name: string | null; city: string | null } | null;
  };
  type InstRow = {
    id: string;
    starts_at: string;
    events: EventRel | EventRel[];
  };

  const instRows = (instances ?? []) as unknown as InstRow[];

  // Solo instancias activas (evento no cancelado/aparcado por la fuente).
  const activeInstanceIds = new Set<string>();
  const instanceMeta = new Map<string, InstanceMeta>();

  for (const row of instRows) {
    const ev = Array.isArray(row.events) ? row.events[0] : row.events;
    if (!ev || ev.is_active === false) continue;
    const venue = Array.isArray(ev.venues) ? ev.venues[0] : ev.venues;
    activeInstanceIds.add(row.id);
    instanceMeta.set(row.id, {
      title: ev.title ?? '',
      venueName: venue?.name ?? null,
      city: venue?.city ?? null,
      startsAt: row.starts_at,
    });
  }

  if (activeInstanceIds.size === 0) return result;

  // 2) Favoritos de esas instancias → qué usuarios hay que avisar.
  const ids = [...activeInstanceIds];
  const { data: favs, error: favErr } = await supabase
    .from('favorites')
    .select('user_id, event_instance_id')
    .in('event_instance_id', ids);

  if (favErr) {
    result.errors.push(`favoritos: ${favErr.message}`);
    return result;
  }

  const favRows = (favs ?? []) as Array<{
    user_id: string;
    event_instance_id: string;
  }>;

  if (favRows.length === 0) return result;

  const userIds = [...new Set(favRows.map((f) => f.user_id))];

  // 3) Tokens activos de esos usuarios.
  const { data: tokens, error: tokErr } = await supabase
    .from('push_tokens')
    .select('user_id, token')
    .in('user_id', userIds)
    .eq('is_active', true);

  if (tokErr) {
    result.errors.push(`tokens: ${tokErr.message}`);
    return result;
  }

  const tokensByUser = new Map<string, string[]>();
  for (const t of (tokens ?? []) as Array<{ user_id: string; token: string }>) {
    const list = tokensByUser.get(t.user_id) ?? [];
    list.push(t.token);
    tokensByUser.set(t.user_id, list);
  }

  // 4) Candidatos = cada favorito cruzado con cada token del usuario.
  const candidates: ReminderCandidate[] = [];
  for (const fav of favRows) {
    const meta = instanceMeta.get(fav.event_instance_id);
    const userTokens = tokensByUser.get(fav.user_id);
    if (!meta || !userTokens) continue;
    for (const token of userTokens) {
      candidates.push({
        userId: fav.user_id,
        eventInstanceId: fav.event_instance_id,
        title: meta.title,
        venueName: meta.venueName,
        city: meta.city,
        startsAt: meta.startsAt,
        token,
      });
    }
  }

  result.candidates = candidates.length;
  if (candidates.length === 0) return result;

  // 5) Pares ya notificados → se descartan (idempotencia entre pasadas).
  const favInstanceIds = [...new Set(favRows.map((f) => f.event_instance_id))];
  const { data: logged, error: logErr } = await supabase
    .from('notification_log')
    .select('user_id, event_instance_id')
    .in('user_id', userIds)
    .in('event_instance_id', favInstanceIds)
    .eq('kind', REMINDER_KIND);

  if (logErr) {
    result.errors.push(`notification_log(read): ${logErr.message}`);
    // No abortamos: es preferible un posible reenvío a no enviar nunca.
  }

  const notified = ((logged ?? []) as Array<{
    user_id: string;
    event_instance_id: string;
  }>).map((n) => ({ userId: n.user_id, eventInstanceId: n.event_instance_id }));

  const selected = selectReminders(candidates, notified, { now, withinHours });
  if (selected.length === 0) return result;

  // 6) Envío por chunks de 100 (límite de Expo).
  const messages: PushMessage[] = buildPushMessages(selected, now);
  const chunks = chunkMessages(messages, 100);

  for (const chunk of chunks) {
    try {
      await send(chunk);
      result.sent += chunk.length;
    } catch (error) {
      result.errors.push(`envío: ${(error as Error).message}`);
    }
  }

  // 7) Registrar en notification_log lo enviado (una fila por par único).
  const uniquePairs = new Map<string, { user_id: string; event_instance_id: string }>();
  for (const c of selected) {
    uniquePairs.set(`${c.userId}::${c.eventInstanceId}`, {
      user_id: c.userId,
      event_instance_id: c.eventInstanceId,
    });
  }

  const logRows = [...uniquePairs.values()].map((p) => ({
    user_id: p.user_id,
    event_instance_id: p.event_instance_id,
    kind: REMINDER_KIND,
  }));

  if (logRows.length > 0) {
    const { error: writeErr } = await supabase
      .from('notification_log')
      .upsert(logRows, {
        onConflict: 'user_id,event_instance_id,kind',
        ignoreDuplicates: true,
      });
    if (writeErr) {
      result.errors.push(`notification_log(write): ${writeErr.message}`);
    } else {
      result.logged = logRows.length;
    }
  }

  return result;
}

