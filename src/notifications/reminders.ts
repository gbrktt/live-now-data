/**
 * Recordatorios de eventos favoritos (lógica pura, sin I/O).
 *
 * Regla de negocio de la PRIMERA señal de push: avisar al usuario de que un
 * evento que guardó en favoritos empieza dentro de una ventana cercana (p. ej.
 * «esta noche» / «en X horas»). Es accionable y usa SOLO datos que ya existen
 * (`favorites` + `event_instances` + `push_tokens`); no depende del campo de
 * artista, que el modelo canónico todavía no tiene.
 *
 * La idempotencia la garantiza `notification_log` en BD, pero la decidimos
 * también aquí (el emisor solo pasa a esta capa los pares ya NO notificados),
 * de modo que la función queda pura y se testea sin base de datos.
 */

/** Evento favorito de un usuario, con su instancia y token de destino. */
export type ReminderCandidate = {
  userId: string;
  /** id de `event_instances` (la fila concreta que empieza). */
  eventInstanceId: string;
  title: string;
  venueName: string | null;
  city: string | null;
  /** Inicio en ISO. */
  startsAt: string;
  /** Token de Expo del dispositivo destino. */
  token: string;
};

/** Par ya registrado en `notification_log` (user + instancia + tipo). */
export type NotifiedKey = {
  userId: string;
  eventInstanceId: string;
};

/** Mensaje listo para la API de Expo Push. */
export type PushMessage = {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  data: { eventInstanceId: string; kind: 'reminder' };
};

export const REMINDER_KIND = 'reminder' as const;

function isNotified(
  candidate: ReminderCandidate,
  notified: Set<string>
): boolean {
  return notified.has(`${candidate.userId}::${candidate.eventInstanceId}`);
}

/**
 * Filtra los candidatos cuyo inicio cae en [now, now + withinHours] y que aún
 * no están en el log. El origen se pasa como `now` para que sea determinista
 * en los tests.
 */
export function selectReminders(
  candidates: ReminderCandidate[],
  notified: NotifiedKey[],
  options: { now: Date; withinHours: number }
): ReminderCandidate[] {
  const notifiedSet = new Set(
    notified.map((n) => `${n.userId}::${n.eventInstanceId}`)
  );
  const from = options.now.getTime();
  const to = from + options.withinHours * 3_600_000;

  return candidates.filter((candidate) => {
    if (isNotified(candidate, notifiedSet)) return false;

    const startMs = Date.parse(candidate.startsAt);
    if (Number.isNaN(startMs)) return false; // fecha ilegible: no avisar

    return startMs >= from && startMs <= to;
  });
}

/** Cuánto falta para el inicio, redondeado, en horas (mínimo 0). */
export function hoursUntil(startsAt: string, now: Date): number {
  const startMs = Date.parse(startsAt);
  if (Number.isNaN(startMs)) return 0;
  const diff = startMs - now.getTime();
  return Math.max(0, Math.round(diff / 3_600_000));
}

/**
 * Texto del cuerpo del recordatorio. Español e inglés según `locale`.
 * Sin depender de i18n de la app (el emisor vive en otro repositorio): aquí
 * solo hay dos cadenas por idioma y se resuelven con el locale del usuario
 * guardado junto al token (ver sender.ts).
 */
export function reminderBody(
  candidate: ReminderCandidate,
  now: Date,
  locale: 'es' | 'en' = 'es'
): string {
  const where = candidate.venueName ?? candidate.city ?? '';
  const hours = hoursUntil(candidate.startsAt, now);

  if (locale === 'en') {
    const place = where ? ` at ${where}` : '';
    return hours <= 1
      ? `Starting soon${place} — don’t miss it!`
      : `In ${hours} h${place}. Saved in your favorites.`;
  }

  const place = where ? ` en ${where}` : '';
  return hours <= 1
    ? `Empieza muy pronto${place}. ¡No te lo pierdas!`
    : `En ${hours} h${place}. Lo tienes en favoritos.`;
}

/** Convierte candidatos seleccionados en mensajes de Expo Push. */
export function buildPushMessages(
  selected: ReminderCandidate[],
  now: Date,
  localeOf: (userId: string) => 'es' | 'en' = () => 'es'
): PushMessage[] {
  return selected.map((candidate) => ({
    to: candidate.token,
    title: '🎵 ' + candidate.title,
    body: reminderBody(candidate, now, localeOf(candidate.userId)),
    sound: 'default',
    data: { eventInstanceId: candidate.eventInstanceId, kind: REMINDER_KIND },
  }));
}

/**
 * Expo acepta como máximo 100 notificaciones por request; troceamos para no
 * pisarnos con el límite (respeta el contrato público de su API).
 */
export function chunkMessages(messages: PushMessage[], size = 100): PushMessage[][] {
  if (size <= 0) return [messages];
  const chunks: PushMessage[][] = [];
  for (let i = 0; i < messages.length; i += size) {
    chunks.push(messages.slice(i, i + size));
  }
  return chunks;
}

/**
 * De la respuesta de Expo, qué tokens deben apagarse. `DeviceNotRegistered`
 * significa app desinstalada o token revocado: marcarlo inactivo evita gastar
 * cuota en envíos que nunca llegarán.
 */
export function tokensToDeactivate(receipts: ExpoReceipt[]): string[] {
  return receipts
    .filter((r) => r.status === 'error' && r.details?.error === 'DeviceNotRegistered')
    .map((r) => r.to)
    .filter((token): token is string => typeof token === 'string');
}

export type ExpoReceipt = {
  to?: string;
  status?: 'ok' | 'error';
  details?: { error?: string };
};
