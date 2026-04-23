/**
 * 服务端事件总线：与客户端 EventBus 接口一致，支持跨模块解耦。
 * 服务端用它驱动 WebSocket 广播。
 */
type Handler = (payload: unknown) => void;

export class EventBusImpl {
  private map = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): () => void {
    if (!this.map.has(event)) this.map.set(event, new Set());
    this.map.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off(event: string, handler: Handler): void {
    this.map.get(event)?.delete(handler);
  }

  emit(event: string, payload?: unknown): void {
    const handlers = this.map.get(event);
    if (!handlers) return;
    for (const h of Array.from(handlers)) {
      try {
        h(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${event}" threw:`, err);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export const EventBus = new EventBusImpl();
