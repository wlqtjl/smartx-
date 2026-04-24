/**
 * zod 输入校验 schemas + 统一校验中间件。
 *
 * 设计原则：
 *  1. 对 REST body / WS 消息的入参提供单一声明性来源，避免手写的 if/typeof 分支。
 *  2. 失败统一返回 400 `{ error: { code, message, issues } }`。
 *  3. 新端点**必须**走这里；已有手写校验会逐步迁移。
 */
import type { Request, Response, NextFunction } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { SCORING_RULES } from '@shared/index';

const MAX_DATA_TOTAL_GB = 65536;

/** 字符串裁剪 + 非空 */
const trimmed = (max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(max));

// ---------- Auth ----------
export const authSessionBody = z
  .object({
    playerName: trimmed(64).optional(),
  })
  .strict();

// PR #1: password register / login / refresh
export const passwordRegisterBody = z
  .object({
    login: trimmed(128),
    password: z.string().min(8).max(256),
    roles: z.array(trimmed(64)).max(16).optional(),
  })
  .strict();

export const passwordLoginBody = z
  .object({
    login: trimmed(128),
    password: z.string().min(1).max(256),
  })
  .strict();

export const refreshBody = z
  .object({
    refreshToken: z.string().min(10).max(8192),
  })
  .strict();

// ---------- Env scan / credentials ----------
export const credentialBody = z
  .object({
    host: trimmed(253),
    port: z.number().int().positive().max(65535),
    username: trimmed(128),
    password: z.string().min(1).max(256),
  })
  .strict();

// ---------- Compatibility ----------
export const compatBody = z
  .object({
    vms: z.array(z.unknown()).max(1024),
  })
  .strict();

// ---------- Task lifecycle ----------
export const createTaskBody = z
  .object({
    vmId: trimmed(128),
    vmName: trimmed(128),
    dataTotalGB: z.number().positive().max(MAX_DATA_TOTAL_GB),
  })
  .strict();

export const transitionBody = z
  .object({
    state: trimmed(64),
    note: z.string().max(512).optional(),
  })
  .strict();

// ---------- Network / Storage mapping ----------
export const networkMappingBody = z
  .object({
    sources: z.array(z.unknown()).max(128),
    targets: z.array(z.unknown()).max(128),
    sourceId: trimmed(128),
    targetId: trimmed(128),
  })
  .strict();

export const storageMappingBody = z
  .object({
    pools: z.array(z.unknown()).max(128),
    vm: z.unknown(),
    poolId: trimmed(128),
    options: z.record(z.string(), z.boolean()).optional(),
  })
  .strict();

// ---------- Data sync ----------
export const syncStartBody = z
  .object({
    speedMbps: z.number().positive().max(100_000).optional(),
  })
  .strict();

// ---------- Driver injection ----------
export const driverInjectionBody = z
  .object({
    guestOS: trimmed(64).optional(),
  })
  .strict();

// ---------- Scoring ----------
const scoringRuleKeys = Object.keys(SCORING_RULES) as [string, ...string[]];
export const scoreApplyBody = z
  .object({
    rule: z.enum(scoringRuleKeys),
    examples: z.array(z.string().max(128)).max(64).optional(),
  })
  .strict();

// ---------- WebSocket messages ----------
export const wsClientMessage = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('subscribe'),
      taskId: trimmed(128),
    })
    .strict(),
  z
    .object({
      type: z.literal('unsubscribe'),
      taskId: trimmed(128),
    })
    .strict(),
  z.object({ type: z.literal('ping') }).strict(),
]);

// ---------- Middleware ----------
export interface ValidatedRequest<T> extends Request {
  validBody: T;
}

export const validateBody =
  <S extends ZodTypeAny>(schema: S) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      res.status(400).json({
        error: {
          code: 400,
          message: 'validation failed',
          issues,
        },
      });
      return;
    }
    (req as unknown as { validBody: unknown }).validBody = parsed.data;
    next();
  };
