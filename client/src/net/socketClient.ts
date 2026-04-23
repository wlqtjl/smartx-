/**
 * 实时 WebSocket 客户端（与服务端 /ws 协议对齐）。
 * - 支持可选连接：未配置服务端时退化为本地 EventBus 桥接。
 * - 自动重连（指数退避 + 抖动，上限 30 秒）。
 * - 与 apiClient 共用 session token，以进行鉴权握手。
 */
import { EventBus } from '../core/EventBus';
import { apiClient } from './apiClient';

type ServerMessage =
  | { type: 'pong'; at: number }
  | { type: 'hello'; protocolVersion: number }
  | { type: 'event'; taskId: string | null; event: string; payload: unknown }
  | { type: 'error'; message: string };

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** 把 HTTP(S) 基地址转成 ws(s)://…/ws。 */
const deriveWsUrl = (): string | null => {
  const base = apiClient.getBaseUrl();
  if (!base) return null;
  try {
    const u = new URL(base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
};

class SocketClientImpl {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private subscriptions = new Set<string>();
  private shouldConnect = false;
  private lastConnectedAt = 0;

  /** 打开连接；要求已经 login 过（有 sessionToken）。 */
  connect(): void {
    if (!apiClient.hasBackend()) return;
    const token = apiClient.getToken();
    if (!token) return;
    this.shouldConnect = true;
    this.openSocket(token);
  }

  private openSocket(token: string): void {
    const base = deriveWsUrl();
    if (!base) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;

    const url = `${base}?token=${encodeURIComponent(token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.warn('[socketClient] WebSocket construction failed:', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.lastConnectedAt = Date.now();
      for (const taskId of this.subscriptions) {
        this.sendRaw({ type: 'subscribe', taskId });
      }
      EventBus.emit('socket:open', {});
    });
    ws.addEventListener('message', (ev) => this.handleMessage(ev));
    ws.addEventListener('close', () => {
      this.ws = null;
      EventBus.emit('socket:close', {});
      if (this.shouldConnect) this.scheduleReconnect();
    });
    ws.addEventListener('error', (ev) => {
      console.warn('[socketClient] ws error', ev);
    });
  }

  private handleMessage(ev: MessageEvent): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === 'event') {
      // 将服务端广播事件转发到本地 EventBus，保持与原有监听一致。
      EventBus.emit(msg.event, msg.payload as never);
    } else if (msg.type === 'error') {
      console.warn('[socketClient] server error:', msg.message);
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldConnect) return;
    if (this.reconnectTimer !== null) return;
    const attempt = this.reconnectAttempts++;
    // 指数退避 + 最多 30% 抖动。Math.random 仅用于时序抖动（非安全上下文）。
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt);
    // eslint-disable-next-line sonarjs/pseudo-random -- 时序抖动无安全要求
    const jitter = base * 0.3 * Math.random();
    const delay = Math.round(base + jitter);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      const token = apiClient.getToken();
      if (!token) return;
      this.openSocket(token);
    }, delay);
  }

  private sendRaw(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  subscribe(taskId: string): void {
    this.subscriptions.add(taskId);
    this.sendRaw({ type: 'subscribe', taskId });
  }

  unsubscribe(taskId: string): void {
    this.subscriptions.delete(taskId);
    this.sendRaw({ type: 'unsubscribe', taskId });
  }

  /**
   * 兼容旧 API：用于客户端需要"上报"事件（例如 CheckpointResumeSystem）的场景。
   * 服务端权威后仅作为本地事件回显。
   */
  emit(event: string, payload: unknown): void {
    EventBus.emit(`socket:${event}`, payload);
  }

  close(): void {
    this.shouldConnect = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get lastConnectTimestamp(): number {
    return this.lastConnectedAt;
  }
}

export const socketClient = new SocketClientImpl();
