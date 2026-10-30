import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoogleHealthProvider } from '../../src/providers/google';
import { reconcile } from '../../src/providers/google/reconcile';
import {
  collect,
  dates,
  exerciseOverlapWarnings,
  locked,
  packet,
  previousWeek,
  statistics,
  today,
  type WorkflowEnv,
} from '../../src/workflow/core';
import { mime, weekly } from '../../src/workflow/gmail';
import { fetchLatest } from '../../src/workflow/live';
import { app, authorized } from '../../src/workflow/worker';

function environment() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('migrations/0001_archive.sql', 'utf8'));
  db.exec(readFileSync('migrations/0002_oauth_attempts.sql', 'utf8'));
  const prepare = (sql: string) => {
    let args: any[] = [];
    const stmt = {
      bind: (...values: any[]) => {
        args = values;
        return stmt;
      },
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
      all: async () => ({ results: db.prepare(sql).all(...args) }),
    };
    return stmt;
  };
  return {
    DB: {
      prepare,
      batch: async (stmts: any[]) => {
        db.exec('BEGIN');
        try {
          const results = await Promise.all(stmts.map((s) => s.run()));
          db.exec('COMMIT');
          return results;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    ADMIN_TOKEN: 'a'.repeat(64),
    READ_TOKEN: 'b'.repeat(64),
  } as unknown as WorkflowEnv;
}
const headers = { Authorization: `Bearer ${'a'.repeat(64)}`, 'Content-Type': 'application/json' };
function provider(fail = false) {
  return {
    getActivityTimeSeries: async () => {
      if (fail) throw new Error('sensitive payload');
      return { points: [{ dateTime: '2026-10-27', value: 5000 }] };
    },
    getSleepRange: async () => [],
    getHeartRateRange: async () => [],
    getHRV: async () => [],
    getRespiratoryRate: async () => [],
    getSpO2: async () => [],
    getSkinTemperature: async () => [],
    getDailyAggregate: async () => [],
    getHeartRateRollups: async () => [],
    getExerciseRecords: async () => [],
    getDetailedRecords: async () => [],
    getHourlySteps: async () => [],
    getSleepDetails: async () => [],
    listDevices: async () => [],
  } as unknown as GoogleHealthProvider;
}
afterEach(() => vi.unstubAllGlobals());
describe('workflow', () => {
  it('flags only overlapping same-type exercise without deleting records', () => {
    const session = (type: string, startTime: string, endTime: string) => ({
      exerciseType: type,
      interval: { startTime, endTime },
    });
    const data = [
      session('RUN', '2026-10-27T01:00:00Z', '2026-10-27T02:00:00Z'),
      session('RUN', '2026-10-27T01:30:00Z', '2026-10-27T02:30:00Z'),
      session('WALK', '2026-10-27T01:30:00Z', '2026-10-27T02:30:00Z'),
      session('RUN', '2026-10-27T02:30:00Z', '2026-10-27T03:00:00Z'),
    ];
    expect(
      exerciseOverlapWarnings(
        [{ day: '2026-10-27', stream: 'exercise', data, fetched_at: '' }],
        '2026-10-27',
        '2026-10-27',
      ),
    ).toEqual([{ day: '2026-10-27', possibleOverlappingPairs: 1 }]);
    expect(data).toHaveLength(4);
  });
  it('targeted backfill leaves unrelated and empty days intact', async () => {
    const env = environment();
    await env.DB.prepare('INSERT INTO observations(day,stream,data,fetched_at) VALUES(?,?,?,?)')
      .bind('2026-10-27', 'hrv', '[{"dailyRmssd":42}]', 'old')
      .run();
    const status = await collect(env, '2026-10-27', '2026-10-27', provider(), {
      only: ['hrv'],
      preserveEmpty: true,
    });
    expect(status).toEqual({ hrv: 'empty' });
    const result = await packet(env, '2026-10-27', '2026-10-27');
    expect(result.observations).toContainEqual(
      expect.objectContaining({ stream: 'hrv', data: [{ dailyRmssd: 42 }] }),
    );
  });
  it('fetches the source on demand and returns an explicit freshness result', async () => {
    const env = environment();
    const source = provider();
    const read = vi.spyOn(source, 'getSleepRange');
    const result = await fetchLatest(env, 7, source);
    expect(read).toHaveBeenCalledOnce();
    expect(result.refreshSucceeded).toBe(true);
    expect(result.packet.end).toBe(today());
    expect(result.packet.observations.length).toBe(196);
    const failed = await fetchLatest(env, 7, provider(true));
    expect(failed.refreshSucceeded).toBe(false);
    expect(failed.refreshStatus).toMatchObject({ steps: 'error' });
  });
  it('does not claim a fresh fetch when another collector owns the lock', async () => {
    const env = environment();
    await locked(env, 'sync', async () => {
      const result = await fetchLatest(env);
      expect(result.refreshSucceeded).toBe(false);
      expect(result.refreshStatus).toBe('busy');
    });
    await expect(fetchLatest(env, 90)).rejects.toThrow();
    expect((await app.request('/fetch-latest', { method: 'POST' }, env)).status).toBe(401);
  });
  it('uses Shanghai days and complete previous calendar week', () => {
    expect(today(new Date('2026-10-25T17:00:00Z'))).toBe('2026-10-26');
    expect(previousWeek(new Date('2026-10-26T01:00:00Z'))).toEqual({
      start: '2026-10-19',
      end: '2026-10-25',
    });
    expect(() => dates('2026-02-30', '2026-03-02')).toThrow();
    expect(() => dates('2026-10-29', '2026-10-28')).toThrow();
    expect(() => dates('2020-01-01', '2026-10-28')).toThrow();
  });
  it('fails closed on missing and malformed credentials', () => {
    expect(authorized(undefined, undefined)).toBe(false);
    expect(authorized('Bearer short', 'short')).toBe(false);
    expect(authorized('Bearer wrong', 'a'.repeat(64))).toBe(false);
    expect(authorized(headers.Authorization, 'a'.repeat(64))).toBe(true);
  });
  it('protects exports and restricts reader writes', async () => {
    const env = environment();
    expect((await app.request('/export', {}, env)).status).toBe(401);
    expect(
      (
        await app.request(
          '/context',
          { method: 'PUT', headers: { Authorization: `Bearer ${env.READ_TOKEN}` }, body: '[]' },
          env,
        )
      ).status,
    ).toBe(401);
    expect((await app.request('/health', {}, env)).status).toBe(200);
    const homepage = await app.request('/', {}, env);
    expect(homepage.status).toBe(200);
    expect(await homepage.text()).toContain('Personal Health Archive');
    const privacy = await app.request('/privacy', {}, env);
    expect(privacy.status).toBe(200);
    expect(await privacy.text()).toContain('隐私权政策');
    expect(
      (
        await app.request(
          '/weekly-run',
          { method: 'POST', headers: { Authorization: `Bearer ${env.READ_TOKEN}` } },
          env,
        )
      ).status,
    ).toBe(401);
    const weeklyResult = await app.request('/weekly-run', { method: 'POST', headers }, env);
    expect(await weeklyResult.json()).toEqual({ status: 'disabled' });
  });
  it('round-trips Unicode context and rejects invalid dates', async () => {
    const env = environment();
    const row = { id: '1', day: '2026-10-27', kind: 'research', title: '论文实验' };
    expect(
      (await app.request('/context', { method: 'PUT', headers, body: JSON.stringify([row]) }, env))
        .status,
    ).toBe(200);
    const data = await packet(env, '2026-10-26', '2026-11-01');
    expect(data.context[0]).toMatchObject(row);
    expect(
      (await app.request('/export?start=2026-02-30&end=2026-03-01', { headers }, env)).status,
    ).toBe(400);
  });
  it('upserts idempotently and preserves successful observations on failure', async () => {
    const env = environment();
    await collect(env, '2026-10-27', '2026-10-28', provider());
    await collect(env, '2026-10-27', '2026-10-28', provider());
    await collect(env, '2026-10-27', '2026-10-28', provider(true));
    const data = await packet(env, '2026-10-27', '2026-10-28');
    expect(data.observations).toHaveLength(56);
    expect(data.statistics.period.steps?.mean).toBe(5000);
    expect(data.statistics.period.steps?.validDays).toBe(1);
    expect(data.statistics.period.hrv?.mean).toBeNull();
    expect(data.latestAttempts).toContainEqual(
      expect.objectContaining({ stream: 'steps', status: 'error' }),
    );
    expect(JSON.stringify(data)).not.toContain('sensitive payload');
  });
  it('does not treat missing sleep stages as zero sleep', () => {
    const stats = statistics(
      [{ day: '2026-10-27', stream: 'sleep', data: [{ minutesAsleep: 0 }], fetched_at: '' }],
      '2026-10-27',
      '2026-10-27',
    );
    expect(stats.sleep?.mean).toBeNull();
  });
  it('keeps detailed baseline records in the archive without sending them in every packet', async () => {
    const env = environment();
    for (const [day, stream] of [
      ['2026-10-26', 'spo2_samples'],
      ['2026-10-26', 'spo2'],
      ['2026-10-27', 'spo2_samples'],
    ]) {
      await env.DB.prepare('INSERT INTO observations(day,stream,data,fetched_at) VALUES(?,?,?,?)')
        .bind(day, stream, '[1]', 'now')
        .run();
    }
    const recent = await packet(env, '2026-10-27', '2026-10-27');
    expect(recent.observations.map((r) => `${r.day}:${r.stream}`)).toEqual([
      '2026-10-26:spo2',
      '2026-10-27:spo2_samples',
    ]);
    const old = await packet(env, '2026-10-26', '2026-10-26');
    expect(old.observations.map((r) => r.stream)).toContain('spo2_samples');
  });
  it('serializes concurrent sync attempts and releases locks after errors', async () => {
    const env = environment();
    await locked(env, 'sync', async () =>
      expect(await locked(env, 'sync', async () => 'bad')).toBeNull(),
    );
    await expect(
      locked(env, 'sync', async () => {
        throw new Error('test');
      }),
    ).rejects.toThrow();
    expect(await locked(env, 'sync', async () => 'ok')).toBe('ok');
  });
  it('follows all pages and rejects repeated page tokens', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({ dataPoints: [{ id: 1 }], nextPageToken: 'p2' })
      .mockResolvedValueOnce({ dataPoints: [{ id: 2 }] });
    expect(await reconcile({ requestJson }, 'sleep', 30)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(requestJson.mock.calls[1]?.[1].query.pageToken).toBe('p2');
    requestJson.mockResolvedValue({ nextPageToken: 'loop' });
    await expect(reconcile({ requestJson }, 'sleep', 30)).rejects.toThrow('Repeated');
  });
  it('refuses silent truncation at page budget', async () => {
    let page = 0;
    await expect(
      reconcile(
        { requestJson: vi.fn(async () => ({ nextPageToken: String(++page) })) as any },
        'sleep',
        30,
      ),
    ).rejects.toThrow('budget');
  });
  it('rejects email header injection and encodes Chinese body', () => {
    expect(() => mime('me@gmail.com\r\nBcc: attacker@x.com', '2026-10-19', 'x')).toThrow();
    const raw = mime('me@gmail.com', '2026-10-19', '睡眠数据');
    expect(Buffer.from(raw.split('\r\n\r\n')[1]!, 'base64').toString()).toBe('睡眠数据');
  });
  it('does not send when disabled and sends once when enabled', async () => {
    const env = environment();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'mock' }))
      .mockResolvedValueOnce(Response.json({ id: 'm1' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await weekly(env)).toBe('disabled');
    expect(fetcher).not.toHaveBeenCalled();
    Object.assign(env, {
      WEEKLY_EMAIL: 'true',
      SELF_EMAIL: 'me@gmail.com',
      GMAIL_CLIENT_ID: 'id',
      GMAIL_CLIENT_SECRET: 'secret',
      GMAIL_REFRESH_TOKEN: 'token',
    });
    expect(await weekly(env)).toBe('sent');
    expect(await weekly(env)).toBe('already_reserved');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('flags ambiguous send errors without automatic resend', async () => {
    const env = environment();
    Object.assign(env, {
      WEEKLY_EMAIL: 'true',
      SELF_EMAIL: 'me@gmail.com',
      GMAIL_CLIENT_ID: 'id',
      GMAIL_CLIENT_SECRET: 'secret',
      GMAIL_REFRESH_TOKEN: 'token',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    expect(await weekly(env)).toBe('needs_review');
    expect(await weekly(env)).toBe('already_reserved');
  });
});
