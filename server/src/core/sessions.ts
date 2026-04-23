/**
 * 会话管理（演示级）：登录返回 token，token 存内存。
 * 生产环境应接入 SSO / JWT 等机制。
 */
import { secureToken } from './utils.js';
import type { Session } from '@shared/index';

const SESSION_TTL_MS = 60 * 60 * 1000; // 1h

class SessionStore {
  private sessions = new Map<string, Session>();

  create(playerName: string): Session {
    const token = secureToken();
    const now = Date.now();
    const session: Session = {
      token,
      playerName: playerName.slice(0, 64),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.set(token, session);
    return session;
  }

  get(token: string | undefined | null): Session | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  delete(token: string): void {
    this.sessions.delete(token);
  }

  purgeExpired(): void {
    const now = Date.now();
    for (const [t, s] of this.sessions) {
      if (s.expiresAt < now) this.sessions.delete(t);
    }
  }
}

export const sessionStore = new SessionStore();
