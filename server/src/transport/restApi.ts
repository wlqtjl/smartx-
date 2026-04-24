/**
 * REST 路由：涵盖会话、扫描、兼容性、网络/存储映射、同步、驱动注入、切换、验证、断点、评分。
 * 所有写操作要求 X-Session-Token header（由 /api/auth/session 创建）。
 *
 * 输入校验统一通过 `validation.ts` 的 zod schema 完成；路由内只处理业务逻辑。
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import type { AppContainer } from '../container.js';
import {
  IllegalTransitionError,
  MigrationStateMachine,
  TaskNotFoundError,
} from '../simulation/MigrationStateMachine.js';
import { NetworkMappingPhase } from '../simulation/phases/NetworkMappingPhase.js';
import { StorageMappingPhase } from '../simulation/phases/StorageMappingPhase.js';
import { DataSyncPhase } from '../simulation/phases/DataSyncPhase.js';
import type { ScoringRuleKey } from '@shared/index';
import { log } from '../core/logger.js';
import type { AppConfig } from '../core/config.js';
import {
  authSessionBody,
  credentialBody,
  compatBody,
  createTaskBody,
  transitionBody,
  networkMappingBody,
  storageMappingBody,
  syncStartBody,
  driverInjectionBody,
  scoreApplyBody,
  validateBody,
} from './validation.js';

const asError = (code: number, message: string) => ({ error: { code, message } });

interface WithValid<T> extends Request {
  validBody: T;
  session?: { token: string };
}

/**
 * PR #1: authentication gate. Accepts either
 *   - `Authorization: Bearer <JWT>` (real identity via `AuthService`), or
 *   - legacy `x-session-token` (in-memory guest session).
 *
 * On success, populates `req.session = { token }` for downstream owner-check code
 * (the rest of the router uses `session.token` as an opaque principal id).
 */
const requireSession =
  (app: AppContainer) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Prefer Bearer JWT when AuthService is configured.
    const authHeader = req.header('authorization');
    const bearer = authHeader ? /^Bearer\s+(.+)$/i.exec(authHeader.trim())?.[1] : undefined;
    if (bearer && app.auth) {
      try {
        const principal = await app.auth.verifyAccessToken(bearer);
        // Use `userId` as the stable owner key so JWT-authenticated callers map onto
        // the same owner regardless of sid rotation.
        (req as Request & { session: { token: string; kind: 'jwt' } }).session = {
          token: principal.id,
          kind: 'jwt',
        };
        next();
        return;
      } catch {
        res.status(401).json(asError(401, 'invalid or expired access token'));
        return;
      }
    }
    // Fallback: legacy guest token.
    const token = req.header('x-session-token') ?? undefined;
    const session = app.sessions.get(token);
    if (!session) {
      res.status(401).json(asError(401, 'invalid or missing session token'));
      return;
    }
    (req as Request & { session: typeof session }).session = session;
    next();
  };

const wrap =
  (fn: (req: Request, res: Response) => Promise<void> | void) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch(next);
  };

/** Build a rate limiter keyed by session token (falls back to IP). */
const makeLimiter = (perMin: number, windowMs = 60_000): RateLimitRequestHandler =>
  rateLimit({
    windowMs,
    limit: perMin,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      // Prefer Bearer so JWT-authenticated traffic shares a per-user bucket.
      const authHeader = req.header('authorization');
      if (authHeader) {
        const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
        if (m) return `bearer:${m[1]}`;
      }
      return req.header('x-session-token') ?? req.ip ?? 'unknown';
    },
    handler: (_req, res) => {
      res.status(429).json(asError(429, 'rate limit exceeded, slow down'));
    },
  });

export const createApiRouter = (app: AppContainer, config: AppConfig): Router => {
  const r = Router();

  // Auth endpoints get a stricter limit to deter brute force.
  const authLimiter = makeLimiter(Math.min(10, config.rateLimitPerMin));
  // Expensive operations (scans, sync start, cutover) share one bucket.
  const heavyLimiter = makeLimiter(Math.max(5, Math.floor(config.rateLimitPerMin / 2)));
  // Generic writes fall back to the configured per-minute quota.
  const writeLimiter = makeLimiter(config.rateLimitPerMin);

  // ------------ Auth ------------
  r.post(
    '/auth/session',
    authLimiter,
    validateBody(authSessionBody),
    wrap((req, res) => {
      if (!config.auth.allowGuestLogin) {
        res.status(403).json(asError(403, 'guest login disabled; use /api/auth/password/login or /api/auth/oidc/start'));
        return;
      }
      const body = (req as WithValid<{ playerName?: string }>).validBody;
      const playerName =
        body.playerName && body.playerName.length > 0 ? body.playerName : 'Anonymous';
      const session = app.sessions.create(playerName);
      res.status(201).json(session);
    }),
  );

  r.delete(
    '/auth/session',
    requireSession(app),
    wrap((req, res) => {
      const token = req.header('x-session-token');
      if (token) app.sessions.delete(token);
      res.status(204).end();
    }),
  );

  // ------------ Environment scan ------------
  r.post(
    '/environment/scan',
    heavyLimiter,
    requireSession(app),
    validateBody(credentialBody),
    wrap(async (req, res) => {
      const cred = (req as WithValid<Record<string, unknown>>).validBody;
      const result = await app.envScan.execute(cred as never);
      res.json(result);
    }),
  );

  // ------------ Compatibility ------------
  r.post(
    '/compatibility/check',
    writeLimiter,
    requireSession(app),
    validateBody(compatBody),
    wrap(async (req, res) => {
      const body = (req as WithValid<{ vms: unknown[] }>).validBody;
      const report = await app.compat.execute(body.vms as never);
      res.json(report);
    }),
  );

  // ------------ Tasks ------------
  r.get(
    '/migration/tasks',
    requireSession(app),
    wrap((_req, res) => {
      res.json(app.fsm.allTasks());
    }),
  );

  r.post(
    '/migration/tasks',
    writeLimiter,
    requireSession(app),
    validateBody(createTaskBody),
    wrap((req, res) => {
      const body = (req as WithValid<{ vmId: string; vmName: string; dataTotalGB: number }>)
        .validBody;
      const { session } = req as Request & { session: { token: string } };
      const task = app.fsm.createTask(body.vmId, body.vmName, body.dataTotalGB, session.token);
      res.status(201).json(task);
    }),
  );

  r.get(
    '/migration/tasks/:id',
    requireSession(app),
    wrap((req, res) => {
      const task = app.fsm.getTask(req.params.id);
      if (!task) {
        res.status(404).json(asError(404, 'task not found'));
        return;
      }
      res.json(task);
    }),
  );

  r.post(
    '/migration/tasks/:id/transition',
    writeLimiter,
    requireSession(app),
    validateBody(transitionBody),
    wrap((req, res) => {
      const body = (req as WithValid<{ state: string; note?: string }>).validBody;
      const task = app.fsm.transition(
        req.params.id,
        body.state as never,
        undefined,
        'player',
        body.note,
      );
      res.json(task);
    }),
  );

  // ------------ Network mapping ------------
  r.post(
    '/migration/tasks/:id/network-mapping',
    writeLimiter,
    requireSession(app),
    validateBody(networkMappingBody),
    wrap((req, res) => {
      const task = app.fsm.requireTask(req.params.id);
      const body = (
        req as WithValid<{
          sources: unknown[];
          targets: unknown[];
          sourceId: string;
          targetId: string;
        }>
      ).validBody;
      let phase = app.networkMappings.get(task.id);
      if (!phase) {
        phase = new NetworkMappingPhase(body.sources as never, body.targets as never);
        app.networkMappings.set(task.id, phase);
      }
      const result = phase.attemptMapping(body.sourceId, body.targetId);
      if (!result.ok) {
        res
          .status(400)
          .json({ ...asError(400, result.error ?? 'mapping failed'), warning: result.warning });
        return;
      }
      task.networkMapping = result.mapping ?? task.networkMapping;
      res.json({
        ok: true,
        mapping: result.mapping,
        warning: result.warning,
        completed: phase.isComplete(),
      });
    }),
  );

  // ------------ Storage mapping ------------
  r.post(
    '/migration/tasks/:id/storage-mapping',
    writeLimiter,
    requireSession(app),
    validateBody(storageMappingBody),
    wrap((req, res) => {
      const task = app.fsm.requireTask(req.params.id);
      const body = (
        req as WithValid<{
          pools: unknown[];
          vm: unknown;
          poolId: string;
          options?: Record<string, boolean>;
        }>
      ).validBody;
      let phase = app.storageMappings.get(task.id);
      if (!phase) {
        phase = new StorageMappingPhase(body.pools as never);
        app.storageMappings.set(task.id, phase);
      }
      const { mapping, warning } = phase.assign(body.vm as never, body.poolId, body.options ?? {});
      task.storageMapping = mapping;
      task.storageWarning = warning;
      res.json({ mapping, warning });
    }),
  );

  // ------------ Data sync ------------
  r.post(
    '/migration/tasks/:id/sync/start',
    heavyLimiter,
    requireSession(app),
    validateBody(syncStartBody),
    wrap((req, res) => {
      const task = app.fsm.requireTask(req.params.id);
      const body = (req as WithValid<{ speedMbps?: number }>).validBody;
      const speedMbps =
        typeof body.speedMbps === 'number' && body.speedMbps > 0
          ? Math.min(100_000, body.speedMbps)
          : 800;
      let phase = app.dataSyncs.get(task.id);
      if (!phase) {
        phase = new DataSyncPhase();
        app.dataSyncs.set(task.id, phase);
      }
      phase.start(task, speedMbps);
      res.json({ ok: true, speedMbps });
    }),
  );

  r.post(
    '/migration/tasks/:id/sync/stop',
    writeLimiter,
    requireSession(app),
    wrap((req, res) => {
      const phase = app.dataSyncs.get(req.params.id);
      phase?.stop();
      res.json({ ok: true });
    }),
  );

  r.post(
    '/migration/tasks/:id/sync/incremental',
    heavyLimiter,
    requireSession(app),
    wrap(async (req, res) => {
      const task = app.fsm.requireTask(req.params.id);
      let phase = app.dataSyncs.get(task.id);
      if (!phase) {
        phase = new DataSyncPhase();
        app.dataSyncs.set(task.id, phase);
      }
      await phase.runIncrementalRounds(task);
      res.json({ ok: true, rounds: task.progress.incrementalRounds });
    }),
  );

  // ------------ Driver injection ------------
  r.post(
    '/migration/tasks/:id/driver-injection',
    heavyLimiter,
    requireSession(app),
    validateBody(driverInjectionBody),
    wrap(async (req, res) => {
      const task = app.fsm.requireTask(req.params.id);
      const body = (req as WithValid<{ guestOS?: string }>).validBody;
      const guestOS = body.guestOS ?? task.driverStatus.guestOS;
      const plan = app.driverInjection.planFor(guestOS as never, task.vmId);
      const status = await app.driverInjection.execute(task, plan);
      res.json({ plan, status });
    }),
  );

  // ------------ Cutover ------------
  r.post(
    '/migration/tasks/:id/cutover',
    heavyLimiter,
    requireSession(app),
    wrap(async (req, res) => {
      const task = app.fsm.requireTask(req.params.id);
      const metrics = await app.cutover.executeCutover(task);
      res.json(metrics);
    }),
  );

  // ------------ Post-check ------------
  r.post(
    '/migration/tasks/:id/post-check',
    heavyLimiter,
    requireSession(app),
    wrap(async (_req, res) => {
      const items = await app.postCheck.runAuto();
      res.json(items);
    }),
  );

  // ------------ Checkpoints ------------
  r.get(
    '/migration/tasks/:id/checkpoints',
    requireSession(app),
    wrap((req, res) => {
      res.json(app.checkpoints.getHistory(req.params.id));
    }),
  );

  r.post(
    '/migration/tasks/:id/checkpoints',
    writeLimiter,
    requireSession(app),
    wrap((req, res) => {
      const task = app.fsm.requireTask(req.params.id);
      const cp = app.checkpoints.saveCheckpoint(task);
      res.status(201).json(cp);
    }),
  );

  r.post(
    '/migration/tasks/:id/resume',
    writeLimiter,
    requireSession(app),
    wrap((req, res) => {
      const task = app.fsm.requireTask(req.params.id);
      const latest = app.checkpoints.getLatest(task.id);
      if (!latest) {
        res.status(404).json(asError(404, 'no checkpoint available'));
        return;
      }
      task.checkpointOffset = latest.lastCompletedBlockOffset;
      const saved = app.checkpoints.calculateTimeSaved(latest);
      res.json({ checkpoint: latest, saved });
    }),
  );

  // ------------ Scoring ------------
  r.get(
    '/migration/tasks/:id/score',
    requireSession(app),
    wrap((req, res) => {
      res.json(app.scoring.for(req.params.id).finalize());
    }),
  );

  r.post(
    '/migration/tasks/:id/score/apply',
    writeLimiter,
    requireSession(app),
    validateBody(scoreApplyBody),
    wrap((req, res) => {
      app.fsm.requireTask(req.params.id); // ensure exists
      const body = (req as WithValid<{ rule: string; examples?: string[] }>).validBody;
      app.scoring.for(req.params.id).apply(body.rule as ScoringRuleKey, body.examples);
      res.json(app.scoring.for(req.params.id).finalize());
    }),
  );

  // ------------ Error handler ------------
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof TaskNotFoundError) {
      res.status(404).json(asError(404, err.message));
      return;
    }
    if (err instanceof IllegalTransitionError) {
      res.status(409).json(asError(409, err.message));
      return;
    }
    log.error('http.error', { error: String(err) });
    res.status(500).json(asError(500, 'internal server error'));
  });

  return r;
};

/** Helper only used by tests. */
export const __debug = { MigrationStateMachine };
