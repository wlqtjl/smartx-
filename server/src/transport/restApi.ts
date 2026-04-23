/**
 * REST 路由：涵盖会话、扫描、兼容性、网络/存储映射、同步、驱动注入、切换、验证、断点、评分。
 * 所有写操作要求 X-Session-Token header（由 /api/auth/session 创建）。
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { AppContainer } from '../container.js';
import {
  IllegalTransitionError,
  MigrationStateMachine,
  TaskNotFoundError,
} from '../simulation/MigrationStateMachine.js';
import { validateCredential } from '../simulation/phases/EnvScanPhase.js';
import { NetworkMappingPhase } from '../simulation/phases/NetworkMappingPhase.js';
import { StorageMappingPhase } from '../simulation/phases/StorageMappingPhase.js';
import { DataSyncPhase } from '../simulation/phases/DataSyncPhase.js';
import { SCORING_RULES, type ScoringRuleKey } from '@shared/index';
import { log } from '../core/logger.js';

const MAX_DATA_TOTAL_GB = 65536;

const asError = (code: number, message: string) => ({ error: { code, message } });

const requireSession =
  (app: AppContainer) =>
  (req: Request, res: Response, next: NextFunction): void => {
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

export const createApiRouter = (app: AppContainer): Router => {
  const r = Router();

  // ------------ Auth ------------
  r.post(
    '/auth/session',
    wrap((req, res) => {
      const body = (req.body ?? {}) as { playerName?: unknown };
      const playerName = typeof body.playerName === 'string' && body.playerName.trim().length > 0
        ? body.playerName.trim()
        : 'Anonymous';
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
    requireSession(app),
    wrap(async (req, res) => {
      const cred = req.body;
      const err = validateCredential(cred);
      if (err) {
        res.status(400).json(asError(400, err));
        return;
      }
      const result = await app.envScan.execute(cred);
      res.json(result);
    }),
  );

  // ------------ Compatibility ------------
  r.post(
    '/compatibility/check',
    requireSession(app),
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { vms?: unknown };
      if (!Array.isArray(body.vms)) {
        res.status(400).json(asError(400, 'vms[] required'));
        return;
      }
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
    requireSession(app),
    wrap((req, res) => {
      const body = (req.body ?? {}) as { vmId?: unknown; vmName?: unknown; dataTotalGB?: unknown };
      const vmId = typeof body.vmId === 'string' ? body.vmId.trim() : '';
      const vmName = typeof body.vmName === 'string' ? body.vmName.trim() : '';
      const dataTotalGB = typeof body.dataTotalGB === 'number' ? body.dataTotalGB : NaN;
      if (!vmId || !vmName) {
        res.status(400).json(asError(400, 'vmId and vmName required'));
        return;
      }
      if (
        !Number.isFinite(dataTotalGB) ||
        dataTotalGB <= 0 ||
        dataTotalGB > MAX_DATA_TOTAL_GB
      ) {
        res.status(400).json(asError(400, `dataTotalGB must be in (0, ${MAX_DATA_TOTAL_GB}]`));
        return;
      }
      const { session } = req as Request & { session: { token: string } };
      const task = app.fsm.createTask(vmId, vmName, dataTotalGB, session.token);
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
    requireSession(app),
    wrap((req, res) => {
      const body = (req.body ?? {}) as { state?: unknown; note?: unknown };
      if (typeof body.state !== 'string') {
        res.status(400).json(asError(400, 'state required'));
        return;
      }
      const task = app.fsm.transition(
        req.params.id,
        body.state as never,
        undefined,
        'player',
        typeof body.note === 'string' ? body.note : undefined,
      );
      res.json(task);
    }),
  );

  // ------------ Network mapping ------------
  r.post(
    '/migration/tasks/:id/network-mapping',
    requireSession(app),
    wrap((req, res) => {
      const task = app.fsm.requireTask(req.params.id);
      const body = (req.body ?? {}) as {
        sources?: unknown;
        targets?: unknown;
        sourceId?: unknown;
        targetId?: unknown;
      };
      if (!Array.isArray(body.sources) || !Array.isArray(body.targets)) {
        res.status(400).json(asError(400, 'sources[] and targets[] required'));
        return;
      }
      if (typeof body.sourceId !== 'string' || typeof body.targetId !== 'string') {
        res.status(400).json(asError(400, 'sourceId/targetId required'));
        return;
      }
      let phase = app.networkMappings.get(task.id);
      if (!phase) {
        phase = new NetworkMappingPhase(body.sources as never, body.targets as never);
        app.networkMappings.set(task.id, phase);
      }
      const result = phase.attemptMapping(body.sourceId, body.targetId);
      if (!result.ok) {
        res.status(400).json({ ...asError(400, result.error ?? 'mapping failed'), warning: result.warning });
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
    requireSession(app),
    wrap((req, res) => {
      const task = app.fsm.requireTask(req.params.id);
      const body = (req.body ?? {}) as {
        pools?: unknown;
        vm?: unknown;
        poolId?: unknown;
        options?: unknown;
      };
      if (!Array.isArray(body.pools) || typeof body.poolId !== 'string' || !body.vm) {
        res.status(400).json(asError(400, 'pools[], poolId and vm required'));
        return;
      }
      let phase = app.storageMappings.get(task.id);
      if (!phase) {
        phase = new StorageMappingPhase(body.pools as never);
        app.storageMappings.set(task.id, phase);
      }
      const { mapping, warning } = phase.assign(
        body.vm as never,
        body.poolId,
        (body.options as Record<string, boolean> | undefined) ?? {},
      );
      task.storageMapping = mapping;
      task.storageWarning = warning;
      res.json({ mapping, warning });
    }),
  );

  // ------------ Data sync ------------
  r.post(
    '/migration/tasks/:id/sync/start',
    requireSession(app),
    wrap((req, res) => {
      const task = app.fsm.requireTask(req.params.id);
      const body = (req.body ?? {}) as { speedMbps?: unknown; tickMs?: unknown };
      const speedMbps = typeof body.speedMbps === 'number' && body.speedMbps > 0
        ? Math.min(100_000, body.speedMbps)
        : 800;
      const tickMs = typeof body.tickMs === 'number' && body.tickMs > 0
        ? Math.min(5000, Math.max(50, body.tickMs))
        : 200;
      let phase = app.dataSyncs.get(task.id);
      if (!phase) {
        phase = new DataSyncPhase();
        app.dataSyncs.set(task.id, phase);
      }
      phase.start(task, speedMbps, tickMs);
      res.json({ ok: true, speedMbps, tickMs });
    }),
  );

  r.post(
    '/migration/tasks/:id/sync/stop',
    requireSession(app),
    wrap((req, res) => {
      const phase = app.dataSyncs.get(req.params.id);
      phase?.stop();
      res.json({ ok: true });
    }),
  );

  r.post(
    '/migration/tasks/:id/sync/incremental',
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
    requireSession(app),
    wrap(async (req, res) => {
      const task = app.fsm.requireTask(req.params.id);
      const body = (req.body ?? {}) as { guestOS?: unknown };
      const guestOS = typeof body.guestOS === 'string' ? body.guestOS : task.driverStatus.guestOS;
      const plan = app.driverInjection.planFor(guestOS as never, task.vmId);
      const status = await app.driverInjection.execute(task, plan);
      res.json({ plan, status });
    }),
  );

  // ------------ Cutover ------------
  r.post(
    '/migration/tasks/:id/cutover',
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
    requireSession(app),
    wrap((req, res) => {
      const task = app.fsm.requireTask(req.params.id);
      const cp = app.checkpoints.saveCheckpoint(task);
      res.status(201).json(cp);
    }),
  );

  r.post(
    '/migration/tasks/:id/resume',
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
    requireSession(app),
    wrap((req, res) => {
      app.fsm.requireTask(req.params.id); // ensure exists
      const body = (req.body ?? {}) as { rule?: unknown; examples?: unknown };
      if (typeof body.rule !== 'string' || !(body.rule in SCORING_RULES)) {
        res.status(400).json(asError(400, 'unknown scoring rule'));
        return;
      }
      const examples = Array.isArray(body.examples)
        ? body.examples.filter((x): x is string => typeof x === 'string')
        : undefined;
      app.scoring.for(req.params.id).apply(body.rule as ScoringRuleKey, examples);
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
