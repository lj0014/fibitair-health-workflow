import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FitbitApiError } from '../../../src/lib/errors';
import { GoogleClient } from '../../../src/providers/google/client';
import { createMockEnv } from '../../helpers/mock-env';

const Schema = z.object({ ok: z.boolean() });
const future = () => String(Math.floor(Date.now() / 1000) + 3600);

describe('GoogleClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('GETs against health.googleapis.com with a Bearer token and parses the schema', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env = createMockEnv({ access_token: 'tok', refresh_token: 'r', expires_at: future() });

    const out = await new GoogleClient(env).requestJson(Schema, { path: '/v4/users/me/profile' });

    expect(out).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://health.googleapis.com/v4/users/me/profile');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('POSTs a JSON body with Content-Type application/json', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env = createMockEnv({ access_token: 'tok', refresh_token: 'r', expires_at: future() });

    await new GoogleClient(env).requestJson(Schema, {
      path: '/v4/users/me/dataTypes/steps/dataPoints:dailyRollUp',
      method: 'POST',
      json: { windowSizeDays: 1 },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ windowSizeDays: 1 }));
  });

  it('appends defined query params and skips undefined ones', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env = createMockEnv({ access_token: 'tok', refresh_token: 'r', expires_at: future() });

    await new GoogleClient(env).requestJson(Schema, {
      path: '/v4/users/me/dataSources',
      query: { pageSize: 50, pageToken: undefined },
    });

    const [url] = fetchMock.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.searchParams.get('pageSize')).toBe('50');
    expect(u.searchParams.has('pageToken')).toBe(false);
  });

  it('reuses sleep pages only within a collection and keeps different pages separate', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);
    const env = createMockEnv({ access_token: 'tok', refresh_token: 'r', expires_at: future() });
    const path = '/v4/users/me/dataTypes/sleep/dataPoints:reconcile';
    const client = new GoogleClient(env, true);
    await client.requestJson(Schema, { path, query: { pageSize: 30 } });
    await client.requestJson(Schema, { path, query: { pageSize: 30, pageToken: 'next' } });
    await client.requestJson(Schema, { path, query: { pageSize: 30 } });
    await client.requestJson(Schema, { path, query: { pageSize: 30, pageToken: 'next' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await new GoogleClient(env, true).requestJson(Schema, { path, query: { pageSize: 30 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a failed sleep page rather than caching the failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('failed', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);
    const env = createMockEnv({ access_token: 'tok', refresh_token: 'r', expires_at: future() });
    const client = new GoogleClient(env, true);
    const req = { path: '/v4/users/me/dataTypes/sleep/dataPoints:reconcile' };
    await expect(client.requestJson(Schema, req)).rejects.toBeInstanceOf(FitbitApiError);
    await expect(client.requestJson(Schema, req)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes once and retries after a 401, then succeeds', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({ access_token: 'fresh', expires_in: 3599, token_type: 'Bearer' }),
          { status: 200 },
        );
      }
      // First API hit 401, second (after refresh) succeeds.
      const apiCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('health.google'));
      return apiCalls.length <= 1
        ? new Response('unauthorized', { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    // expired-ish token so the flow is realistic; readStoredTokens still returns it
    const env = createMockEnv({ access_token: 'stale', refresh_token: 'r', expires_at: future() });

    const out = await new GoogleClient(env).requestJson(Schema, { path: '/v4/users/me/profile' });

    expect(out).toEqual({ ok: true });
    // token endpoint was hit exactly once during recovery
    expect(
      fetchMock.mock.calls.filter(([u]) => String(u).includes('oauth2.googleapis.com')).length,
    ).toBe(1);
  });

  it('throws FitbitApiError on a non-2xx API response', async () => {
    const fetchMock = vi.fn(
      async () => new Response('boom', { status: 500, statusText: 'Server Error' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env = createMockEnv({ access_token: 'tok', refresh_token: 'r', expires_at: future() });

    await expect(
      new GoogleClient(env).requestJson(Schema, { path: '/v4/users/me/profile' }),
    ).rejects.toBeInstanceOf(FitbitApiError);
  });

  it('throws FitbitApiError with a raw-body preview when schema validation fails', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ wrong: 1 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env = createMockEnv({ access_token: 'tok', refresh_token: 'r', expires_at: future() });

    await expect(
      new GoogleClient(env).requestJson(Schema, { path: '/v4/users/me/profile' }),
    ).rejects.toThrow(/Schema validation failed/);
  });
});
