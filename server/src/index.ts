/**
 * 入口：解析环境变量，启动 HTTP + WS 服务。
 */
import { createServer } from './server.js';
import { log } from './core/logger.js';
import { loadConfig } from './core/config.js';

const main = async (): Promise<void> => {
  const config = loadConfig();
  log.setLevel(config.logLevel);
  const server = await createServer({ config });

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
