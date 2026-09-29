import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebSocketTickets } from './browser-websocket-auth.js';

const origin = 'https://browser.example.test';
function fixture(options = {}) {
  let time = 1000;
  const sessions = new Map([['session-a', 100000], ['session-b', 2000]]);
  const tickets = createWebSocketTickets({ sessions, origin, now: () => time, ...options });
  return { sessions, tickets, advance: value => { time += value; } };
}

test('valid session issues a ticket usable once without a cookie', () => {
  const { tickets } = fixture();
  const { ticket, expiresAt } = tickets.issue('session-a');
  assert.match(ticket, /^[a-f0-9]{64}$/);
  assert.equal(expiresAt, 61000);
  assert.equal(tickets.consume(ticket, origin), true);
  assert.equal(tickets.consume(ticket, origin), false);
});

test('missing, unknown, tampered and cross-origin tickets are rejected', () => {
  const { tickets } = fixture();
  const { ticket } = tickets.issue('session-a');
  assert.equal(tickets.consume('', origin), false);
  assert.equal(tickets.consume('f'.repeat(64), origin), false);
  assert.equal(tickets.consume(ticket + 'a', origin), false);
  assert.equal(tickets.consume(ticket, 'https://unrelated.example'), false);
  assert.equal(tickets.consume(ticket, ''), false);
  assert.equal(tickets.consume(ticket, origin), true);
});

test('ticket lifetime is bounded by its own TTL and the browser session', () => {
  const { tickets, advance } = fixture();
  const a = tickets.issue('session-a');
  const b = tickets.issue('session-b');
  assert.equal(b.expiresAt, 2000);
  advance(1001);
  assert.equal(tickets.consume(b.ticket, origin), false);
  assert.throws(() => tickets.issue('session-b'), /expired/);
  advance(60000);
  assert.equal(tickets.consume(a.ticket, origin), false);
});

test('revoking a session also invalidates its tickets', () => {
  const { sessions, tickets } = fixture();
  const { ticket } = tickets.issue('session-a');
  sessions.delete('session-a');
  assert.equal(tickets.consume(ticket, origin), false);
  assert.throws(() => tickets.issue('unknown'), /expired/);
});

test('ticket storage is bounded and independent viewers have distinct tickets', () => {
  const { tickets } = fixture({ maxTickets: 2 });
  const a = tickets.issue('session-a');
  const b = tickets.issue('session-a');
  const c = tickets.issue('session-a');
  assert.notEqual(b.ticket, c.ticket);
  assert.equal(tickets.consume(a.ticket, origin), false);
  assert.equal(tickets.consume(b.ticket, origin), true);
  assert.equal(tickets.consume(c.ticket, origin), true);
});
