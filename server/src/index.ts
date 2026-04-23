/**
 * 入口：监听 SMARTX_PORT 环境变量（默认 8787）。
 */
import { createServer } from './server.js';
import { log } from './core/logger.js';

const PORT = Number(process.env.SMARTX_PORT ?? 8787);
const HOST = process.env.SMARTX_HOST ?? '0.0.0.0';
const DATA_PATH = process.env.SMARTX_DATA_PATH;
const allowedOrigins = (process.env.SMARTX_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const main = async (): Promise<void> => {
  const server = await createServer({
    port: PORT,
    host: HOST,
    dataPath: DATA_PATH,
    allowedOrigins,
  });

  const shutdown = async (): Promise<void> => {
    log.info('server.shutdown.begin');
    try {
      await server.close();
    } finally {
      log.info('server.shutdown.done');
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
};

main().catch((err) => {
  log.error('server.bootstrap.failed', { error: String(err) });
  process.exit(1);
});
