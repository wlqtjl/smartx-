/**
 * 轻量 request-id + access-log 中间件。
 * - 为每个请求附加 `req.id`（6 字节随机 hex 或来自 `X-Request-Id` 头）。
 * - 在响应头回写 `X-Request-Id`，便于端到端追踪。
 * - 请求完成时写一条 `http.access` 日志。
 */
import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { log } from './logger.js';

export interface RequestWithId extends Request {
  id: string;
}

export const requestId = (req: Request, res: Response, next: NextFunction): void => {
  const header = req.header('x-request-id');
  const id =
    typeof header === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(header)
      ? header
      : randomBytes(6).toString('hex');
  (req as RequestWithId).id = id;
  res.setHeader('X-Request-Id', id);
  next();
};

export const accessLog = (req: Request, res: Response, next: NextFunction): void => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
    log.info('http.access', {
      requestId: (req as RequestWithId).id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durMs,
      ip: req.ip,
    });
  });
  next();
};
