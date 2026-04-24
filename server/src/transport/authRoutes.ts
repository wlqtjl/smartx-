/**
 * PR #1：`/api/auth/*` REST 路由（密码登录 + OIDC + 刷新 + 登出 + 我）。
 *
 * 与既有的 guest `/api/auth/session` 并存。若 `config.auth.jwtSecret` 未配置，
 * 本模块不会被挂载；此时服务器仅支持 guest 会话（受 `SMARTX_ALLOW_GUEST_LOGIN` 控制）。
 */
import { Router, type Request, type Response } from 'express';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import type { AppContainer } from '../container.js';
import type { AppConfig } from '../core/config.js';
import { AuthError, type AuthenticatedUser } from '../auth/authService.js';
import { OidcError } from '../auth/oidcService.js';
import { log } from '../core/logger.js';
import { validateBody, passwordRegisterBody, passwordLoginBody, refreshBody } from './validation.js';

const asError = (code: number, message: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message, ...extra },
});

interface AuthReq extends Request {
  auth?: { user: AuthenticatedUser; sid: string };
}

/** Parse `Authorization: Bearer <token>` without regex (ReDoS-free). */
const extractBearer = (req: Request): string | null => {
  const h = req.header('authorization');
  if (!h) return null;
  const trimmed = h.trim();
  const prefix = 'bearer ';
  if (trimmed.length <= prefix.length) return null;
  if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix) return null;
  const token = trimmed.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
};

const makeLoginLimiter = (): RateLimitRequestHandler =>
  rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const body = req.body as { login?: unknown } | undefined;
      const login = typeof body?.login === 'string' ? body.login.trim().toLowerCase() : 'anon';
      return `${login}:${req.ip ?? 'unknown'}`;
    },
    handler: (_req, res) => {
      res.status(429).json(asError(429, 'too many login attempts, slow down'));
    },
  });

/** Generic per-IP limiter for other auth routes (refresh/logout/me/oidc). */
const makeAuthLimiter = (limit: number): RateLimitRequestHandler =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? 'unknown',
    handler: (_req, res) => {
      res.status(429).json(asError(429, 'rate limit exceeded, slow down'));
    },
  });

const mapAuthErrorStatus = (code: AuthError['code']): number => {
  switch (code) {
    case 'invalid_credentials':
      return 401;
    case 'user_disabled':
      return 403;
    case 'session_revoked':
      return 401;
    case 'token_expired':
      return 401;
    case 'token_invalid':
      return 401;
    case 'conflict':
      return 409;
  }
};

export const createAuthRouter = (app: AppContainer, config: AppConfig): Router => {
  const r = Router();
  if (!app.auth) {
    // Guard: caller should not mount this if auth is disabled. Keep a 404 handler
    // so unintentional exposure fails safely.
    r.use((_req, res) => void res.status(404).end());
    return r;
  }

  const loginLimiter = makeLoginLimiter();
  // 20/min for refresh/logout/me/oidc — tight enough to block brute force on
  // stolen-token probing yet generous for legitimate SPA polling.
  const authLimiter = makeAuthLimiter(20);
  const auth = app.auth;

  // ── Password register (dev / admin-only) ─────────────────────────────
  r.post(
    '/password/register',
    authLimiter,
    validateBody(passwordRegisterBody),
    async (req, res) => {
      if (!config.auth.allowSelfRegister) {
        res.status(403).json(asError(403, 'self-registration disabled'));
        return;
      }
      const body = (req as Request & { validBody: { login: string; password: string; roles?: string[] } }).validBody;
      try {
        const user = await auth.registerPassword(body);
        res.status(201).json({ user });
      } catch (err) {
        if (err instanceof AuthError) {
          res.status(mapAuthErrorStatus(err.code)).json(asError(mapAuthErrorStatus(err.code), err.message, { reason: err.code }));
          return;
        }
        log.error('auth.register.error', { error: String((err as Error).message ?? err) });
        res.status(500).json(asError(500, 'internal error'));
      }
    },
  );

  // ── Password login ───────────────────────────────────────────────────
  r.post(
    '/password/login',
    loginLimiter,
    validateBody(passwordLoginBody),
    async (req, res) => {
      const body = (req as Request & { validBody: { login: string; password: string } }).validBody;
      try {
        const pair = await auth.loginPassword(body);
        res.status(200).json(pair);
      } catch (err) {
        if (err instanceof AuthError) {
          res.status(mapAuthErrorStatus(err.code)).json(asError(mapAuthErrorStatus(err.code), err.message, { reason: err.code }));
          return;
        }
        log.error('auth.login.error', { error: String((err as Error).message ?? err) });
        res.status(500).json(asError(500, 'internal error'));
      }
    },
  );

  // ── Refresh ──────────────────────────────────────────────────────────
  r.post('/refresh', authLimiter, validateBody(refreshBody), async (req, res) => {
    const body = (req as Request & { validBody: { refreshToken: string } }).validBody;
    try {
      const pair = await auth.refresh(body.refreshToken);
      res.status(200).json(pair);
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(mapAuthErrorStatus(err.code)).json(asError(mapAuthErrorStatus(err.code), err.message, { reason: err.code }));
        return;
      }
      log.error('auth.refresh.error', { error: String((err as Error).message ?? err) });
      res.status(500).json(asError(500, 'internal error'));
    }
  });

  // ── Logout ───────────────────────────────────────────────────────────
  r.post('/logout', authLimiter, async (req: AuthReq, res: Response) => {
    const token = extractBearer(req);
    if (!token) {
      // Fast-path: no bearer → nothing to revoke. Stay 204 idempotent.
      res.status(204).end();
      return;
    }
    try {
      const principal = await auth.verifyAccessToken(token);
      await auth.logout(principal.sid, principal.id);
      res.status(204).end();
    } catch {
      // Token invalid / expired: logout is idempotent — still 204.
      res.status(204).end();
    }
  });

  // ── Me ───────────────────────────────────────────────────────────────
  r.get('/me', authLimiter, async (req, res) => {
    const token = extractBearer(req);
    if (!token) {
      res.status(401).json(asError(401, 'missing bearer token'));
      return;
    }
    try {
      const principal = await auth.verifyAccessToken(token);
      res.status(200).json({ user: { id: principal.id, login: principal.login, roles: principal.roles } });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(mapAuthErrorStatus(err.code)).json(asError(mapAuthErrorStatus(err.code), err.message, { reason: err.code }));
        return;
      }
      res.status(401).json(asError(401, 'invalid token'));
    }
  });

  // ── OIDC ─────────────────────────────────────────────────────────────
  r.get('/oidc/start', authLimiter, (_req, res) => {
    if (!app.oidc) {
      res.status(501).json(asError(501, 'OIDC not configured'));
      return;
    }
    const url = app.oidc.startAuthorizationUrl();
    res.redirect(302, url);
  });

  r.get('/oidc/callback', authLimiter, async (req, res) => {
    if (!app.oidc) {
      res.status(501).json(asError(501, 'OIDC not configured'));
      return;
    }
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!state) {
      res.status(400).json(asError(400, 'missing state'));
      return;
    }
    try {
      const pair = await app.oidc.handleCallback(auth, req.query as Record<string, string>, state);
      res.status(200).json(pair);
    } catch (err) {
      if (err instanceof OidcError) {
        res.status(400).json(asError(400, err.message, { reason: err.code }));
        return;
      }
      log.error('auth.oidc.callback.error', { error: String((err as Error).message ?? err) });
      res.status(500).json(asError(500, 'oidc callback failed'));
    }
  });

  return r;
};
