/**
 * 会话管理（演示级）：登录返回 token，token 存内存。
 * 生产环境应接入 SSO / JWT 等机制。
 */
import { secureToken } from './utils.js';
import type { Session } from '@shared/index';

const SESSION_TTL_MS = 60 * 60 * 1000; // 1h
const PURGE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

class SessionStore {
  private sessions = new Map<string, Session>();
  private purgeTimer: NodeJS.Timeout | null = null;

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

  size(): number {
    return this.sessions.size;
  }

  purgeExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [t, s] of this.sessions) {
      if (s.expiresAt < now) {
        this.sessions.delete(t);
        removed++;
      }
    }
    return removed;
  }

  /** Start a background timer that periodically evicts expired sessions. */
  startPurgeInterval(): void {
    if (this.purgeTimer) return;
    this.purgeTimer = setInterval(() => this.purgeExpired(), PURGE_INTERVAL_MS);
    this.purgeTimer.unref?.();
  }

  stopPurgeInterval(): void {
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
  }
}

export const sessionStore = new SessionStore();
