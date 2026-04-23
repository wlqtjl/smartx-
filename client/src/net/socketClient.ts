/**
 * Socket 客户端占位：真实部署中应接入 socket.io 或原生 WebSocket。
 * 当前实现只在本地回显事件，便于离线开发/类型校验。
 */
import { EventBus } from '../core/EventBus';

class SocketClientImpl {
  emit(event: string, payload: any): void {
    EventBus.emit(`socket:${event}`, payload);
    // 在真实实现中这里会写入 WebSocket
  }
}

export const socketClient = new SocketClientImpl();
