import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { apiClient } from './apiClient';

describe('apiClient', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ token: 't1', playerName: 'Alice', createdAt: 0, expiresAt: 1 }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports backend available under jsdom (falls back to window.location host)', () => {
    expect(apiClient.hasBackend()).toBe(true);
    expect(apiClient.getBaseUrl()).toMatch(/^http:\/\/.+:8787$/);
  });

  it('login stores token and returns session info', async () => {
    const session = await apiClient.login('Alice');
    expect(session.token).toBe('t1');
    expect(apiClient.getToken()).toBe('t1');
  });

  it('includes x-session-token header after login', async () => {
    await apiClient.login('Alice');
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'task-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await apiClient.createTask('vm-1', 'VM-1', 10);
    expect(result).toEqual({ id: 'task-1' });

    const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const init = call?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('x-session-token')).toBe('t1');
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      vmId: 'vm-1',
      vmName: 'VM-1',
      dataTotalGB: 10,
    });
  });

  it('throws with status when server returns non-ok', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(apiClient.transition('t', 'ENV_SCAN')).rejects.toThrow(/HTTP 500/);
  });

  it('returns undefined for 204 No Content', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const r = await apiClient.saveCheckpoint('t1');
    expect(r).toBeUndefined();
  });
});
