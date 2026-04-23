/**
 * 简易事件总线 —— 渲染层/模拟层/UI层解耦。
 * 所有跨模块通讯一律通过 EventBus.emit / on。
 */
type Handler = (payload: any) => void;

class EventBusImpl {
  private map: Map<string, Set<Handler>> = new Map();

  on(event: string, handler: Handler): () => void {
    if (!this.map.has(event)) this.map.set(event, new Set());
    this.map.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off(event: string, handler: Handler): void {
    this.map.get(event)?.delete(handler);
  }

  emit(event: string, payload?: any): void {
    const handlers = this.map.get(event);
    if (!handlers) return;
    // 复制一份，避免回调中 off 造成迭代异常
    for (const h of Array.from(handlers)) {
      try {
        h(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${event}" threw:`, err);
      }
    }
  }

  once(event: string, handler: Handler): void {
    const dispose = this.on(event, (p) => {
      dispose();
      handler(p);
    });
  }

  clear(): void {
    this.map.clear();
  }
}

export const EventBus = new EventBusImpl();
