import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { addDaysIso } from '../providers/google/civil';
import {
  collect,
  contextSchema,
  dateSchema,
  locked,
  packet,
  today,
  type WorkflowEnv,
} from './core';
import { weekly } from './gmail';
import { fetchLatest } from './live';
import { handleMcp } from './mcp';
import { homePage, privacyPage } from './pages';

export function authorized(header: string | undefined, secret: string | undefined) {
  if (!secret || secret.length < 32 || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const app = new Hono<{ Bindings: WorkflowEnv }>();
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  await next();
});
app.use('*', bodyLimit({ maxSize: 65536 }));
app.get('/health', (c) => c.json({ service: 'personal-health-workflow', status: 'alive' }));
app.get('/', (c) => c.html(homePage));
app.get('/privacy', (c) => c.html(privacyPage));
app.use('*', async (c, next) => {
  const admin = authorized(c.req.header('Authorization'), c.env.ADMIN_TOKEN);
  const reader = authorized(c.req.header('Authorization'), c.env.READ_TOKEN);
  if (!admin && !(reader && (c.req.method === 'GET' || c.req.path === '/mcp')))
    return c.json({ error: 'Unauthorized' }, 401);
  await next();
});
app.get('/status', async (c) =>
  c.json({
    attempts: (await c.env.DB.prepare('SELECT * FROM attempts').all()).results,
    deliveries: (
      await c.env.DB.prepare('SELECT * FROM deliveries ORDER BY week DESC LIMIT 12').all()
    ).results,
  }),
);
app.get('/export', async (c) => {
  const end = c.req.query('end') ?? addDaysIso(today(), -1);
  const start = c.req.query('start') ?? addDaysIso(end, -6);
  return c.json(await packet(c.env, start, end));
});
app.put('/context', async (c) => {
  const rows = z
    .array(contextSchema)
    .max(200)
    .parse(await c.req.json());
  if (rows.length)
    await c.env.DB.batch(
      rows.map((r) =>
        c.env.DB.prepare(`INSERT INTO context VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET day=excluded.day,kind=excluded.kind,title=excluded.title,
    minutes=excluded.minutes,intensity=excluded.intensity,notes=excluded.notes`).bind(
          r.id,
          r.day,
          r.kind,
          r.title,
          r.minutes ?? null,
          r.intensity ?? null,
          r.notes ?? null,
        ),
      ),
    );
  return c.json({ saved: rows.length });
});
app.delete('/context/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM context WHERE id=?').bind(c.req.param('id')).run();
  return c.json({ deleted: true });
});
app.post('/sync', async (c) => {
  const { start, end, streams } = z
    .object({
      start: dateSchema,
      end: dateSchema,
      streams: z
        .array(z.enum(['resting_heart_rate', 'hrv']))
        .min(1)
        .max(2)
        .optional(),
    })
    .strict()
    .parse(await c.req.json());
  // Short manual backfills prevent request timeouts; repeat for older weeks.
  if (Date.parse(end) - Date.parse(start) > 6 * 86400000)
    return c.json({ error: 'Maximum 7 days per sync' }, 400);
  const result = await locked(c.env, 'sync', () =>
    collect(
      c.env,
      start,
      end,
      undefined,
      streams ? { only: streams, preserveEmpty: true } : undefined,
    ),
  );
  return c.json({ status: result ?? 'busy' });
});
app.post('/weekly-run', async (c) => c.json({ status: await weekly(c.env) }));
app.post('/fetch-latest', async (c) => c.json(await fetchLatest(c.env)));
app.post('/mcp', handleMcp);
app.onError((err, c) =>
  c.json(
    {
      error:
        err instanceof z.ZodError || err instanceof RangeError
          ? 'Invalid input'
          : 'Operation failed; inspect /status',
    },
    err instanceof z.ZodError || err instanceof RangeError ? 400 : 500,
  ),
);
export default {
  async fetch(req: Request, env: WorkflowEnv, ctx: ExecutionContext) {
    const path = new URL(req.url).pathname;
    if (
      path.startsWith('/.well-known/') ||
      path === '/live-mcp' ||
      path === '/authorize' ||
      path.startsWith('/oauth/')
    ) {
      const { oauthFetch } = await import('./oauth');
      return oauthFetch(req, env, ctx);
    }
    return app.fetch(req, env, ctx);
  },
  async scheduled(event: ScheduledController, env: WorkflowEnv) {
    const now = new Date(event.scheduledTime);
    const end = today(now);
    await locked(env, 'sync', () => collect(env, addDaysIso(end, -6), end));
    if (event.cron === '0 1 * * MON') await weekly(env, now);
    await env.DB.prepare('DELETE FROM oauth_attempts WHERE reset_at < ?').bind(Date.now()).run();
  },
};
