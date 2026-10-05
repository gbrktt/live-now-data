/**
 * Conversión de hora local + timezone → ISO UTC, compartida por los
 * normalizadores de fuentes con API (Ticketmaster) y municipales (Madrid).
 *
 * Extraído de `normalize/ticketmaster.ts` (2026-10-05) para reutilizarlo sin
 * duplicar: Madrid publica `FECHA` (fecha local) + `HORA` ("19:00") y debe
 * llegar al mismo instante UTC que vería la app.
 */

/** Label "GMT+02:00|GMT-05:00" de Intl → minutos de offset. */
export function parseOffsetMinutes(label: string): number {
  const m = /([+-])(\d{2}):?(\d{2})/.exec(label);
  if (!m) return 0;
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

export function offsetLabelForZone(timezone: string, at: Date): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    const part = fmt.formatToParts(at).find((p) => p.type === 'timeZoneName');
    return part?.value ?? 'GMT+00:00';
  } catch {
    return 'GMT+00:00';
  }
}

function hourValid(h: number): boolean {
  return Number.isFinite(h) && h >= 0 && h <= 23;
}
function minuteValid(m: number): boolean {
  return Number.isFinite(m) && m >= 0 && m <= 59;
}

/** Convierte fecha/hora local + timezone del evento a ISO UTC. */
export function zonedLocalToUtc(
  localDate: string,
  localTime: string,
  timezone: string | null
): string | null {
  const [y, mo, d] = localDate.split('-').map(Number);
  const [hh, mm] = (localTime || '00:00:00').split(':').map(Number);
  if (![y, mo, d].every(Number.isFinite) || !hourValid(hh) || !minuteValid(mm)) {
    return null;
  }
  // Primera aproximación: interpretar la hora local como UTC para obtener offset.
  const guess = new Date(Date.UTC(y, mo - 1, d, hh, mm));
  const offset = timezone
    ? parseOffsetMinutes(offsetLabelForZone(timezone, guess))
    : 0;
  const utc = new Date(guess.getTime() - offset * 60_000);
  return Number.isNaN(utc.getTime()) ? null : utc.toISOString();
}
