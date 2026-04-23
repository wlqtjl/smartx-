/**
 * 通用工具函数
 */
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * 生成一个短随机 ID，用于 UI 展示 / 事件追踪等非安全上下文。
 * 不得用于认证令牌、会话标识等安全相关场景。
 */
export const uid = (prefix = ''): string =>
  // eslint-disable-next-line -- 非安全上下文，Math.random 足够
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
