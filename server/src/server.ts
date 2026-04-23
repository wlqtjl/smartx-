/**
 * HTTP 应用（Express）组装 + WebSocket 附加。
 */
import http from 'node:http';
import express, { type Express } from 'express';
import cors from 'cors';
import { createApiRouter } from './transport/restApi.js';
import { attachWebSocket, type WsHandle } from './transport/wsServer.js';
import { createAppContainer, type AppContainer } from './container.js';
import { log } from './core/logger.js';

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
  /** CORS origin whitelist. Empty array means allow all (dev mode). */
  allowedOrigins?: string[];
}

export const createServer = async (opts: ServerOptions = {}): Promise<SmartXServer> => {
  const container = createAppContainer({ dataPath: opts.dataPath });
  await container.storage.load();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const origins = opts.allowedOrigins ?? [];
  app.use(
    cors({
      origin: origins.length === 0 ? true : origins,
      credentials: false,
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ ok: true, tasks: container.fsm.allTasks().length, uptime: process.uptime() });
  });

  app.use('/api', createApiRouter(container));

  const httpServer = http.createServer(app);
  const ws = attachWebSocket(httpServer, container);

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  const host = opts.host ?? '127.0.0.1';
  const url = `http://${host}:${port}`;

  log.info('server.listening', { url });

  const close = async (): Promise<void> => {
    await ws.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    await container.storage.shutdown();
  };

  return { app, httpServer, container, ws, url, close };
};
