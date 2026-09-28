/**
 * UUID determinista (estilo v5) a partir de claves estables de negocio.
 *
 * Usa SHA-256 vía Web Crypto → funciona en Node, Deno y Cloudflare Workers.
 * Garantiza que `source + id externo` mapee SIEMPRE al mismo UUID,
 * lo que hace los upserts idempotentes y los favoritos estables.
 */

async function sha256Hex(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    data as unknown as BufferSource
  );
  return new Uint8Array(digest);
}

/** UUID determinista (versión 5, variante RFC 4122) de una lista de claves. */
export async function deterministicUuid(parts: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const joined = parts.join('::');
  const bytes = await sha256Hex(encoder.encode(joined));

  // Fijar versión 5 y variante 10xx
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes.slice(0, 16), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}