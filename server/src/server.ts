/**
 * HTTP 应用（Express）组装 + WebSocket 附加。
 */
import http from 'node:http';
import path from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createApiRouter } from './transport/restApi.js';
import { attachWebSocket, type WsHandle } from './transport/wsServer.js';
import { createAppContainer, type AppContainer } from './container.js';
import { log } from './core/logger.js';
import { requestId, accessLog } from './core/httpMiddleware.js';
import type { AppConfig } from './core/config.js';
import { STORAGE_SCHEMA_VERSION } from './storage/Store.js';

export interface SmartXServer {
  app: Express;
  httpServer: http.Server;
  container: AppContainer;
  ws: WsHandle;
  url: string;
  close: () => Promise<void>;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  dataPath?: string;
  /** CORS origin whitelist. Empty array means allow all (dev mode only). */
  allowedOrigins?: string[];
  /** Full parsed config. If provided, overrides individual fields above. */
  config?: AppConfig;
}

/**
 * Build an AppConfig from either a supplied partial config or legacy option fields.
 * Tests still call createServer({ port, host, dataPath }).
 */
const resolveConfig = (opts: ServerOptions): AppConfig => {
  if (opts.config) return opts.config;
  return {
    nodeEnv: (process.env.NODE_ENV as AppConfig['nodeEnv']) ?? 'development',
    host: opts.host ?? '127.0.0.1',
    port: opts.port ?? 0,
    dataPath: opts.dataPath,
    allowedOrigins: opts.allowedOrigins ?? [],
    wsAllowedOrigins: opts.allowedOrigins ?? [],
    rateLimitPerMin: 600, // generous default for tests
    wsMaxSubscriptions: 16,
    wsIdleTimeoutMs: 60_000,
    staticRoot: undefined,
    logLevel: 'info',
    store: { kind: 'json', poolMax: 10 },
  };
};

export const createServer = async (opts: ServerOptions = {}): Promise<SmartXServer> => {
  const config = resolveConfig(opts);
  const container = await createAppContainer({ dataPath: config.dataPath, config });
  await container.storage.load();
  container.sessions.startPurgeInterval();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // honor X-Forwarded-For behind a single reverse proxy
  app.use(requestId);
  app.use(accessLog);
  app.use(express.json({ limit: '1mb' }));

  const origins = config.allowedOrigins;
  app.use(
    cors({
      origin: origins.length === 0 ? true : origins,
      credentials: false,
    }),
  );

  const startedAt = Date.now();

  // /health performs a filesystem probe; /metrics walks internal maps. Both are
  // public, so cap their rate per-IP to protect against hammer-the-probe attacks.
  const probeLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  app.use('/health', probeLimiter);
  app.use('/metrics', probeLimiter);

  app.get('/health', async (_req: Request, res: Response) => {
    const [storageErr, storeHealth] = await Promise.all([
      container.storage.checkWritable(),
      container.storage.health(),
    ]);
    const ok = storageErr === null && storeHealth.ok;
    res.status(ok ? 200 : 503).json({
      ok,
      tasks: container.fsm.allTasks().length,
      sessions: container.sessions.size(),
      wsClients: wsHandleRef?.clientCount() ?? 0,
      schemaVersion: storeHealth.schemaVersion || STORAGE_SCHEMA_VERSION,
      storageError: storageErr,
      store: {
        kind: container.storage.kind,
        latencyMs: storeHealth.latencyMs,
        migrationsApplied: storeHealth.migrationsApplied,
      },
      uptime: process.uptime(),
    });
  });

  app.get('/metrics', (_req: Request, res: Response) => {
    // Minimal Prometheus-compatible text format without adding a runtime dep.
    const lines = [
      '# HELP smartx_tasks_total Number of migration tasks tracked by the FSM.',
      '# TYPE smartx_tasks_total gauge',
      `smartx_tasks_total ${container.fsm.allTasks().length}`,
      '# HELP smartx_sessions Number of active in-memory sessions.',
      '# TYPE smartx_sessions gauge',
      `smartx_sessions ${container.sessions.size()}`,
      '# HELP smartx_ws_clients Number of connected WebSocket clients.',
      '# TYPE smartx_ws_clients gauge',
      `smartx_ws_clients ${wsHandleRef?.clientCount() ?? 0}`,
      '# HELP smartx_uptime_seconds Process uptime in seconds.',
      '# TYPE smartx_uptime_seconds counter',
      `smartx_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
      '# HELP smartx_schema_version Persistence schema version.',
      '# TYPE smartx_schema_version gauge',
      `smartx_schema_version ${STORAGE_SCHEMA_VERSION}`,
      '',
    ];
    res.type('text/plain; version=0.0.4').send(lines.join('\n'));
  });

  app.use('/api', createApiRouter(container, config));

  // Optional static serving of the built client (same-origin deployments).
  if (config.staticRoot) {
    const staticDir = path.resolve(config.staticRoot);
    // Cap SPA-fallback traffic to avoid arbitrary-path filesystem churn.
    const staticLimiter = rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    });
    app.use(staticLimiter);
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
      res.sendFile(path.join(staticDir, 'index.html'));
    });
    log.info('server.static', { root: staticDir });
  }

  const httpServer = http.createServer(app);
  let wsHandleRef: WsHandle | undefined;
  const ws = attachWebSocket(httpServer, container, config);
  wsHandleRef = ws;

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, () => resolve());
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const url = `http://${config.host}:${port}`;

  log.info('server.listening', { url, nodeEnv: config.nodeEnv });

  const close = async (): Promise<void> => {
    container.sessions.stopPurgeInterval();
    await ws.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    await container.storage.shutdown();
  };

  return { app, httpServer, container, ws, url, close };
};
