/**
 * WebSocket 服务器：按任务订阅广播迁移事件。
 * 客户端握手：
 *   1. 连接 /ws?token=<sessionToken>
 *   2. server → { type: 'hello', protocolVersion: N }
 *   3. client → { type: 'subscribe', taskId }
 *
 * 生产加固：
 *   - 若配置了 Origin 白名单，会在升级阶段拒绝未匹配的 Origin。
 *   - 心跳：每 HEARTBEAT_MS 发送一次 ws-level ping；连续 2 次未收到 pong 即关闭连接。
 *   - 每连接最多订阅 `config.wsMaxSubscriptions` 个任务（超限忽略）。
 *   - 每连接消息大小限制（8 KB）与 JSON schema 校验（zod）。
 */
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { AppContainer } from '../container.js';
import type { ServerMessage } from '@shared/index';
import { WS_PROTOCOL_VERSION } from '@shared/index';
import { log } from '../core/logger.js';
import type { AppConfig } from '../core/config.js';
import { wsClientMessage } from './validation.js';

// 事件转发过滤：以这些前缀开头的事件会被广播给订阅客户端。
const FORWARDED_PREFIXES = ['migration:', 'ui:', 'fx:', 'audio:', 'checkpoint:', 'achievement:'];

const MAX_MESSAGE_BYTES = 8 * 1024;
const HEARTBEAT_MS = 30_000;

interface ClientMeta {
  token: string;
  playerName: string;
  subscriptions: Set<string>; // taskIds, '*' for broadcast
  alive: boolean;
}

const send = (ws: WebSocket, msg: ServerMessage): void => {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      log.warn('ws.send.failed', { error: String(err) });
    }
  }
};

const extractToken = (req: IncomingMessage): string | null => {
  const url = req.url ?? '';
  const idx = url.indexOf('?');
  if (idx < 0) return null;
  const params = new URLSearchParams(url.slice(idx + 1));
  return params.get('token');
};

const extractTaskIdFromPayload = (payload: unknown): string | null => {
  if (payload && typeof payload === 'object') {
    const t = (payload as { taskId?: unknown }).taskId;
    if (typeof t === 'string') return t;
    const task = (payload as { task?: { id?: unknown } }).task;
    if (task && typeof task === 'object' && typeof task.id === 'string') return task.id;
  }
  return null;
};

const isOriginAllowed = (origin: string | undefined, allowlist: string[]): boolean => {
  if (allowlist.length === 0) return true; // dev mode (config layer enforces prod requirement)
  if (!origin) return false;
  return allowlist.includes(origin);
};

export interface WsHandle {
  wss: WebSocketServer;
  close: () => Promise<void>;
  clientCount: () => number;
}

export const attachWebSocket = (
  httpServer: Server,
  app: AppContainer,
  config: AppConfig,
): WsHandle => {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, ClientMeta>();

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin, config.wsAllowedOrigins)) {
      log.warn('ws.origin.rejected', { origin });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = extractToken(req);
    const session = app.sessions.get(token);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, {
        token: session.token,
        playerName: session.playerName,
        subscriptions: new Set(),
        alive: true,
      });
      send(ws, { type: 'hello', protocolVersion: WS_PROTOCOL_VERSION });
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.on('pong', () => {
      const meta = clients.get(ws);
      if (meta) meta.alive = true;
    });

    ws.on('message', (raw: RawData) => {
      if (raw instanceof Buffer && raw.byteLength > MAX_MESSAGE_BYTES) {
        send(ws, { type: 'error', message: 'message too large' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        send(ws, { type: 'error', message: 'invalid JSON' });
        return;
      }
      const validated = wsClientMessage.safeParse(parsed);
      if (!validated.success) {
        send(ws, { type: 'error', message: 'invalid message' });
        return;
      }
      const msg = validated.data;
      const meta = clients.get(ws);
      if (!meta) return;
      switch (msg.type) {
        case 'subscribe':
          if (meta.subscriptions.size >= config.wsMaxSubscriptions) {
            send(ws, { type: 'error', message: 'subscription limit reached' });
            return;
          }
          meta.subscriptions.add(msg.taskId);
          break;
        case 'unsubscribe':
          meta.subscriptions.delete(msg.taskId);
          break;
        case 'ping':
          send(ws, { type: 'pong', at: Date.now() });
          break;
      }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', (err) => log.warn('ws.error', { error: String(err) }));
  });

  // 应用级心跳：定期 ping，两次未回 pong 即断开。
  const heartbeat = setInterval(() => {
    for (const [ws, meta] of clients) {
      if (!meta.alive) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        clients.delete(ws);
        continue;
      }
      meta.alive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // 桥接：EventBus → 所有订阅了该 task 的客户端
  const bridge = (event: string, payload: unknown): void => {
    if (!FORWARDED_PREFIXES.some((p) => event.startsWith(p))) return;
    const taskId = extractTaskIdFromPayload(payload);
    const msg: ServerMessage = { type: 'event', taskId, event, payload };
    const serialized = JSON.stringify(msg);
    for (const [ws, meta] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const subscribed =
        meta.subscriptions.has('*') || (taskId !== null && meta.subscriptions.has(taskId));
      if (subscribed) {
        try {
          ws.send(serialized);
        } catch (err) {
          log.warn('ws.forward.failed', { error: String(err) });
        }
      }
    }
  };

  // 订阅所有潜在事件：我们 monkey-patch emit 以便统一转发
  const originalEmit = app.eventBus.emit.bind(app.eventBus);
  app.eventBus.emit = (event: string, payload?: unknown): void => {
    originalEmit(event, payload);
    bridge(event, payload);
  };

  const close = async (): Promise<void> => {
    clearInterval(heartbeat);
    for (const ws of clients.keys()) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };

  return { wss, close, clientCount: () => clients.size };
};
