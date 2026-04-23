import { randomBytes, randomUUID } from 'node:crypto';

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** 生成用于会话/任务标识的加密安全 ID。 */
export const secureId = (prefix = ''): string => `${prefix}${randomUUID()}`;

/** 生成不可预测的 token（32 字节十六进制）。 */
export const secureToken = (): string => randomBytes(32).toString('hex');
