/**
 * WebSocket 服务器：按任务订阅广播迁移事件。
 * 客户端握手：
 *   1. 连接 /ws?token=<sessionToken>
 *   2. server → { type: 'hello', protocolVersion: N }
 *   3. client → { type: 'subscribe', taskId }
 */
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { AppContainer } from '../container.js';
import type { ClientMessage, ServerMessage } from '@shared/index';
import { WS_PROTOCOL_VERSION } from '@shared/index';
import { log } from '../core/logger.js';

// 事件转发过滤：以这些前缀开头的事件会被广播给订阅客户端。
const FORWARDED_PREFIXES = ['migration:', 'ui:', 'fx:', 'audio:', 'checkpoint:', 'achievement:'];

const MAX_MESSAGE_BYTES = 8 * 1024;

interface ClientMeta {
  token: string;
  playerName: string;
  subscriptions: Set<string>; // taskIds, '*' for broadcast
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

export interface WsHandle {
  wss: WebSocketServer;
  close: () => Promise<void>;
}

export const attachWebSocket = (httpServer: Server, app: AppContainer): WsHandle => {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, ClientMeta>();

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws')) {
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
      });
      send(ws, { type: 'hello', protocolVersion: WS_PROTOCOL_VERSION });
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.on('message', (raw: RawData) => {
      if (raw instanceof Buffer && raw.byteLength > MAX_MESSAGE_BYTES) {
        send(ws, { type: 'error', message: 'message too large' });
        return;
      }
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        send(ws, { type: 'error', message: 'invalid JSON' });
        return;
      }
      const meta = clients.get(ws);
      if (!meta) return;
      switch (msg.type) {
        case 'subscribe':
          if (typeof msg.taskId === 'string' && msg.taskId.length > 0) {
            meta.subscriptions.add(msg.taskId);
          }
          break;
        case 'unsubscribe':
          meta.subscriptions.delete(msg.taskId);
          break;
        case 'ping':
          send(ws, { type: 'pong', at: Date.now() });
          break;
        default:
          send(ws, { type: 'error', message: 'unknown message type' });
      }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', (err) => log.warn('ws.error', { error: String(err) }));
  });

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

  return { wss, close };
};
