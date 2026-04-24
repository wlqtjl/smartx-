import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { socketClient } from './socketClient';
import { apiClient } from './apiClient';
import { EventBus } from '../core/EventBus';

interface MockWebSocket {
  url: string;
  readyState: number;
  sent: string[];
  listeners: Record<string, Array<(ev: unknown) => void>>;
  addEventListener(ev: string, cb: (e: unknown) => void): void;
  send(data: string): void;
  close(): void;
  dispatch(ev: string, payload?: unknown): void;
}

function createMockWebSocketClass(): {
  ctor: new (url: string) => MockWebSocket;
  instances: MockWebSocket[];
} {
  const instances: MockWebSocket[] = [];
  class MWS implements MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    url: string;
    readyState = MWS.CONNECTING;
    sent: string[] = [];
    listeners: Record<string, Array<(ev: unknown) => void>> = {};
    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }
    addEventListener(ev: string, cb: (e: unknown) => void): void {
      (this.listeners[ev] ??= []).push(cb);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.readyState = MWS.CLOSED;
      this.dispatch('close');
    }
    dispatch(ev: string, payload?: unknown): void {
      for (const cb of this.listeners[ev] ?? []) cb(payload ?? {});
    }
  }
  return { ctor: MWS as unknown as new (url: string) => MockWebSocket, instances };
}

describe('socketClient', () => {
  let original: typeof WebSocket;
  let instances: MockWebSocket[] = [];

  beforeEach(async () => {
    original = globalThis.WebSocket;
    const { ctor, instances: inst } = createMockWebSocketClass();
    instances = inst;
    vi.stubGlobal('WebSocket', ctor);
    // Ensure apiClient has a token so connect() proceeds
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ token: 'session-xyz', playerName: 'T', createdAt: 0, expiresAt: 1 }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await apiClient.login('T');
  });

  afterEach(() => {
    socketClient.close();
    vi.unstubAllGlobals();
    globalThis.WebSocket = original;
  });

  it('opens a WebSocket with the session token and ws:// scheme', () => {
    socketClient.connect();
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toMatch(/^ws:\/\//);
    expect(instances[0].url).toContain('token=session-xyz');
    expect(instances[0].url).toMatch(/\/ws\?token=/);
  });

  it('sends subscribe frames after connection opens', () => {
    socketClient.connect();
    const ws = instances[0];
    ws.readyState = 1; // OPEN
    ws.dispatch('open');
    socketClient.subscribe('task-1');
    expect(ws.sent.map((s) => JSON.parse(s))).toContainEqual({ type: 'subscribe', taskId: 'task-1' });
  });

  it('forwards server `event` messages to the EventBus', () => {
    socketClient.connect();
    const ws = instances[0];
    ws.readyState = 1;
    ws.dispatch('open');

    const spy = vi.fn();
    const off = EventBus.on('migration:progress', spy);
    ws.dispatch('message', {
      data: JSON.stringify({
        type: 'event',
        taskId: 't',
        event: 'migration:progress',
        payload: { progress: { fullSyncPercent: 42 } },
      }),
    });
    expect(spy).toHaveBeenCalledWith({ progress: { fullSyncPercent: 42 } });
    off();
  });

  it('re-sends pending subscriptions after reconnect', () => {
    socketClient.connect();
    const ws1 = instances[0];
    ws1.readyState = 1;
    ws1.dispatch('open');
    socketClient.subscribe('task-7');
    ws1.close();

    // simulate reconnect by calling connect() again (production uses setTimeout)
    socketClient.connect();
    const ws2 = instances[1];
    ws2.readyState = 1;
    ws2.dispatch('open');
    const sent = ws2.sent.map((s) => JSON.parse(s));
    expect(sent).toContainEqual({ type: 'subscribe', taskId: 'task-7' });
  });

  it('isOpen reflects underlying readyState', () => {
    expect(socketClient.isOpen()).toBe(false);
    socketClient.connect();
    const ws = instances[0];
    ws.readyState = 1;
    ws.dispatch('open');
    expect(socketClient.isOpen()).toBe(true);
  });
});
