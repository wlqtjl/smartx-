/**
 * REST API 客户端：与服务端 /api 端点通信。
 * 未配置服务端时，页面仍可运行（使用本地 mock 分支）。
 */

const RAW_BASE = ((): string => {
  // import.meta.env 在 Vite 构建环境下提供；TS 未配置 vite/client 类型，故用宽松读取。
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
  if (metaEnv && typeof metaEnv.VITE_SMARTX_API === 'string') return metaEnv.VITE_SMARTX_API;
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:8787`;
  }
  return '';
})();
const API_BASE = RAW_BASE.replace(/\/+$/, '');

let sessionToken: string | null = null;

export interface SessionInfo {
  token: string;
  playerName: string;
  createdAt: number;
  expiresAt: number;
}

const hasBackend = (): boolean => API_BASE !== '';

const request = async <T>(
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  if (!hasBackend()) throw new Error('backend disabled');
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (sessionToken) headers.set('x-session-token', sessionToken);
  const resp = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${body}`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
};

export const apiClient = {
  hasBackend,

  getBaseUrl(): string {
    return API_BASE;
  },

  getToken(): string | null {
    return sessionToken;
  },

  async login(playerName: string): Promise<SessionInfo> {
    const session = await request<SessionInfo>('/api/auth/session', {
      method: 'POST',
      body: JSON.stringify({ playerName }),
    });
    sessionToken = session.token;
    return session;
  },

  async createTask(vmId: string, vmName: string, dataTotalGB: number): Promise<{ id: string }> {
    return request('/api/migration/tasks', {
      method: 'POST',
      body: JSON.stringify({ vmId, vmName, dataTotalGB }),
    });
  },

  async transition(taskId: string, state: string, note?: string): Promise<unknown> {
    return request(`/api/migration/tasks/${taskId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ state, note }),
    });
  },

  async applyScore(taskId: string, rule: string, examples?: string[]): Promise<unknown> {
    return request(`/api/migration/tasks/${taskId}/score/apply`, {
      method: 'POST',
      body: JSON.stringify({ rule, examples }),
    });
  },

  async saveCheckpoint(taskId: string): Promise<unknown> {
    return request(`/api/migration/tasks/${taskId}/checkpoints`, { method: 'POST' });
  },

  async resume(taskId: string): Promise<unknown> {
    return request(`/api/migration/tasks/${taskId}/resume`, { method: 'POST' });
  },
};
