import { DurableObject } from 'cloudflare:workers';

const ORIGINS = new Set(['https://panicbutton.si', 'https://imsorrydave.si']);
const MIN_GAP_MS = 10_000; // at most one counted press per 10 s per IP
const HOUR_MAX = 30;       // and at most 30 per rolling hour per IP
const HOUR_MS = 3_600_000;

export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
      INSERT OR IGNORE INTO counter (id, n) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS hits (ip TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS hits_ip_ts ON hits (ip, ts);
    `);
  }

  count() {
    return this.sql.exec('SELECT n FROM counter WHERE id = 1').one().n;
  }

  // Atomic: the DO is single-threaded, so check + insert + increment cannot interleave.
  press(ip) {
    const now = Date.now();
    this.sql.exec('DELETE FROM hits WHERE ts < ?', now - HOUR_MS);
    const w = this.sql.exec('SELECT COUNT(*) AS c, MAX(ts) AS last FROM hits WHERE ip = ?', ip).one();
    if ((w.last !== null && now - w.last < MIN_GAP_MS) || w.c >= HOUR_MAX) {
      const retry = w.c >= HOUR_MAX ? Math.ceil((w.last + HOUR_MS - now) / 1000) : Math.ceil((w.last + MIN_GAP_MS - now) / 1000);
      return { n: this.count(), limited: true, retry: Math.max(1, retry) };
    }
    this.sql.exec('INSERT INTO hits (ip, ts) VALUES (?, ?)', ip, now);
    const n = this.sql.exec('UPDATE counter SET n = n + 1 WHERE id = 1 RETURNING n').one().n;
    return { n, limited: false };
  }
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = origin !== null && ORIGINS.has(origin);
    const cors = allowed
      ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST', 'access-control-max-age': '86400', vary: 'Origin' }
      : {};

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const stub = env.COUNTER.get(env.COUNTER.idFromName('global'));

    if (request.method === 'GET' && url.pathname === '/count') {
      return json({ n: await stub.count() }, 200, cors);
    }

    if (request.method === 'POST' && url.pathname === '/press') {
      if (!allowed) return json({ error: 'origin not allowed' }, 403, cors);
      const ip = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
      const r = await stub.press(ip);
      return r.limited
        ? json({ n: r.n }, 429, { ...cors, 'retry-after': String(r.retry) })
        : json({ n: r.n }, 200, cors);
    }

    return json({ error: 'not found' }, 404, cors);
  },
};
