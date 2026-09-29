import crypto from 'node:crypto';

export function createWebSocketTickets({ sessions, origin, now = Date.now, ttlMs = 60000, maxTickets = 128 }) {
  const tickets = new Map();
  function prune() {
    for (const [ticket, entry] of tickets) {
      if (entry.expires <= now() || (sessions.get(entry.session) || 0) <= now()) tickets.delete(ticket);
    }
  }
  return {
    issue(session) {
      prune();
      const sessionExpiry = sessions.get(session) || 0;
      if (sessionExpiry <= now()) throw new Error('Browser session expired');
      while (tickets.size >= maxTickets) tickets.delete(tickets.keys().next().value);
      const ticket = crypto.randomBytes(32).toString('hex');
      const expiresAt = Math.min(now() + ttlMs, sessionExpiry);
      tickets.set(ticket, { session, expires: expiresAt });
      return { ticket, expiresAt };
    },
    consume(ticket, requestOrigin) {
      prune();
      if (requestOrigin !== origin || !/^[a-f0-9]{64}$/.test(ticket || '')) return false;
      const entry = tickets.get(ticket);
      if (!entry) return false;
      tickets.delete(ticket);
      return entry.expires > now() && (sessions.get(entry.session) || 0) > now();
    }
  };
}
