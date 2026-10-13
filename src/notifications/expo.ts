/**
 * Cliente mínimo de Expo Push Service (`https://exp.host/--/api/v2/push/send`).
 *
 * Gratis y sin cuenta de terceros: se autentica con el propio token del
 * dispositivo (`ExponentPushToken[…]`). El worker de Cloudflare tiene `fetch`
 * global, igual que cualquier runtime de Workers.
 */

import type { PushMessage } from './reminders.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export type ExpoPushResponse = {
  data?: Array<{
    status: 'ok' | 'error';
    id?: string;
    message?: string;
    details?: { error?: string };
  }>;
};

/**
 * Envía un lote (≤100 mensajes). Devuelve siempre la respuesta parseada; los
 * errores por mensaje llegan dentro de `data`, no como excepción, así que el
 * emisor puede decidir token a token qué apagar.
 */
export async function sendPushChunk(
  messages: PushMessage[],
  fetchImpl: typeof fetch = fetch
): Promise<ExpoPushResponse> {
  if (messages.length === 0) return { data: [] };

  const res = await fetchImpl(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Recomendado por Expo para aceptar payloads y respuestas JSON.
      accept: 'application/json',
    },
    body: JSON.stringify(messages),
  });

  if (!res.ok) {
    throw new Error(`Expo Push respondió ${res.status}`);
  }

  return (await res.json()) as ExpoPushResponse;
}
