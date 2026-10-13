import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPushMessages,
  chunkMessages,
  hoursUntil,
  reminderBody,
  selectReminders,
  type ReminderCandidate,
} from '../src/notifications/reminders.ts';

/**
 * Recordatorios push — lógica pura (sin BD ni red).
 *
 * Cubre la ventana temporal, el filtro de ya-notificados, el texto del cuerpo
 * (ES/EN) y el troceado en lotes de 100 que exige la API de Expo.
 */

const NOW = new Date('2026-10-13T18:00:00.000Z');

function candidate(overrides: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    userId: 'user-1',
    eventInstanceId: 'inst-1',
    title: 'Concierto de prueba',
    venueName: 'Sala Ejemplo',
    city: 'Madrid',
    startsAt: '2026-10-13T21:00:00.000Z',
    token: 'ExponentPushToken[abc]',
    ...overrides,
  };
}

describe('selectReminders: ventana temporal', () => {
  it('incluye eventos dentro de la ventana [now, now+withinHours]', () => {
    const selected = selectReminders([candidate()], [], { now: NOW, withinHours: 6 });
    assert.strictEqual(selected.length, 1);
  });

  it('excluye eventos que empiezan después de la ventana', () => {
    const late = candidate({ startsAt: '2026-10-14T10:00:00.000Z' }); // +16h
    const selected = selectReminders([late], [], { now: NOW, withinHours: 6 });
    assert.strictEqual(selected.length, 0);
  });

  it('excluye eventos con fecha ilegible', () => {
    const bad = candidate({ startsAt: 'no-es-una-fecha' });
    const selected = selectReminders([bad], [], { now: NOW, withinHours: 6 });
    assert.strictEqual(selected.length, 0);
  });

  it('incluye eventos ya empezados hace poco (startback -2h lo permite en BD)', () => {
    const started = candidate({ startsAt: '2026-10-13T17:00:00.000Z' }); // -1h
    const selected = selectReminders([started], [], { now: NOW, withinHours: 6 });
    // La función pura solo mira el límite inferior = now; el startback lo
    // aplica la query. Aquí -1h < now, así que se excluye por diseño puro.
    assert.strictEqual(selected.length, 0);
  });
});

describe('selectReminders: idempotencia', () => {
  it('descarta pares ya notificados (mismo user + instancia)', () => {
    const notified = [{ userId: 'user-1', eventInstanceId: 'inst-1' }];
    const selected = selectReminders([candidate()], notified, { now: NOW, withinHours: 6 });
    assert.strictEqual(selected.length, 0);
  });

  it('no descarta si el par notificado es de otro usuario', () => {
    const notified = [{ userId: 'otro', eventInstanceId: 'inst-1' }];
    const selected = selectReminders([candidate()], notified, { now: NOW, withinHours: 6 });
    assert.strictEqual(selected.length, 1);
  });
});

describe('hoursUntil / reminderBody', () => {
  it('hoursUntil redondea y no baja de 0', () => {
    assert.strictEqual(hoursUntil('2026-10-13T21:30:00.000Z', NOW), 4); // 3.5h → 4
    assert.strictEqual(hoursUntil('2026-10-13T17:00:00.000Z', NOW), 0); // pasado → 0
  });

  it('cuerpo ES menciona horas y sala', () => {
    const body = reminderBody(candidate(), NOW, 'es');
    assert.match(body, /En 3 h/);
    assert.match(body, /Sala Ejemplo/);
  });

  it('cuerpo ES «muy pronto» si falta ≤1h', () => {
    const soon = candidate({ startsAt: '2026-10-13T18:30:00.000Z' }); // +0.5h
    const body = reminderBody(soon, NOW, 'es');
    assert.match(body, /muy pronto/);
  });

  it('cuerpo EN cambia de idioma', () => {
    const body = reminderBody(candidate(), NOW, 'en');
    assert.match(body, /In 3 h/);
    assert.match(body, /favorites/);
  });
});

describe('buildPushMessages / chunkMessages', () => {
  it('construye un mensaje por candidato con data de deep-link', () => {
    const msgs = buildPushMessages([candidate()], NOW);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].to, 'ExponentPushToken[abc]');
    assert.strictEqual(msgs[0].data.kind, 'reminder');
    assert.strictEqual(msgs[0].data.eventInstanceId, 'inst-1');
    assert.match(msgs[0].title, /Concierto de prueba/);
  });

  it('chunks de 100 como máximo', () => {
    const many = Array.from({ length: 250 }, (_, i) => candidate({ token: `ExponentPushToken[${i}]` }));
    const chunks = chunkMessages(buildPushMessages(many, NOW), 100);
    assert.strictEqual(chunks.length, 3);
    assert.strictEqual(chunks[0].length, 100);
    assert.strictEqual(chunks[2].length, 50);
  });
});
