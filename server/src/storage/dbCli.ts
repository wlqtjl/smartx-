#!/usr/bin/env node
/**
 * DB 管理 CLI：
 *   - migrate          执行所有未应用的 up 迁移
 *   - migrate:down     回滚最近一次（或全部）迁移
 *   - status           打印当前 schemaVersion + 已应用迁移列表
 *   - seed             插入最小 smoke-test 数据（一个 demo 用户 + 空任务）
 *   - import:json      从 JsonStore 的 state.json 快照导入到 SQL 后端
 *
 * 入口脚本：`npm run db:migrate` / `db:migrate:down` / `db:status` / `db:seed` / `import:json`。
 * 通过 env 选择后端：`SMARTX_STORE=sqlite|postgres`、`DATABASE_URL`、`SMARTX_SQLITE_PATH`。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { log } from '../core/logger.js';
import type { Store } from './Store.js';
import type { MigrationCheckpoint, MigrationTask } from '@shared/index';

type Cmd = 'migrate' | 'migrate:down' | 'status' | 'seed' | 'import:json';

const openCore = async (): Promise<
  { store: Store; rollbackLatest: () => Promise<string[]>; kind: string } | null
> => {
  const config = loadConfig(process.env);
  if (config.store.kind === 'sqlite') {
    const { SqliteStore } = await import('./SqliteStore.js');
    const sqlitePath =
      config.store.sqlitePath ??
      path.resolve(path.dirname(config.dataPath ?? 'data/state.json'), 'smartx.db');
    const s = new SqliteStore(sqlitePath);
    return { store: s, rollbackLatest: () => s.rollbackLatest(), kind: 'sqlite' };
  }
  if (config.store.kind === 'postgres') {
    if (!config.store.databaseUrl) throw new Error('DATABASE_URL is required');
    const { PostgresStore } = await import('./PostgresStore.js');
    const s = new PostgresStore({
      connectionString: config.store.databaseUrl,
      max: config.store.poolMax,
    });
    return { store: s, rollbackLatest: () => s.rollbackLatest(), kind: 'postgres' };
  }
  log.warn('db.cli.noop', {
    reason: 'SMARTX_STORE is json; nothing to migrate. Set SMARTX_STORE=sqlite|postgres.',
  });
  return null;
};

const runMigrate = async (): Promise<void> => {
  const ctx = await openCore();
  if (!ctx) return;
  await ctx.store.migrate();
  const h = await ctx.store.health();
  log.info('db.migrate.done', {
    kind: ctx.kind,
    schemaVersion: h.schemaVersion,
    migrationsApplied: h.migrationsApplied,
  });
  await ctx.store.close();
};

const runMigrateDown = async (): Promise<void> => {
  const ctx = await openCore();
  if (!ctx) return;
  const rolled = await ctx.rollbackLatest();
  log.info('db.migrate.down.done', { kind: ctx.kind, rolled });
  await ctx.store.close();
};

const runStatus = async (): Promise<void> => {
  const ctx = await openCore();
  if (!ctx) return;
  const h = await ctx.store.health();
  // Plain-text print for humans + machine-readable JSON line via logger.
  // eslint-disable-next-line no-console
  console.log(
    `store=${ctx.kind} schemaVersion=${h.schemaVersion} migrations=[${h.migrationsApplied.join(', ')}] latencyMs=${h.latencyMs}`,
  );
  await ctx.store.close();
};

const runSeed = async (): Promise<void> => {
  const ctx = await openCore();
  if (!ctx) return;
  await ctx.store.migrate();
  const now = Date.now();
  await ctx.store.users.upsert({
    id: 'demo-user',
    login: 'demo',
    passwordHash: null,
    oidcSubject: null,
    roles: ['operator'],
    createdAt: now,
    disabledAt: null,
  });
  await ctx.store.audit.append({
    userId: 'demo-user',
    action: 'seed',
    target: null,
    at: now,
    details: { note: 'initial seed' },
  });
  log.info('db.seed.done', { kind: ctx.kind });
  await ctx.store.close();
};

/** Migrate a legacy JSON snapshot into the configured SQL backend. */
const runImportJson = async (): Promise<void> => {
  const ctx = await openCore();
  if (!ctx) {
    log.error('db.import.noop', { reason: 'target store must be sqlite|postgres' });
    return;
  }
  const config = loadConfig(process.env);
  const jsonPath = config.dataPath ?? path.resolve('data', 'state.json');
  let raw: string;
  try {
    raw = await fs.readFile(jsonPath, 'utf8');
  } catch (err) {
    log.error('db.import.read-failed', { path: jsonPath, error: String(err) });
    await ctx.store.close();
    process.exitCode = 1;
    return;
  }
  const snap = JSON.parse(raw) as {
    tasks?: MigrationTask[];
    checkpoints?: Array<[string, MigrationCheckpoint[]]>;
  };
  await ctx.store.migrate();
  if (Array.isArray(snap.tasks)) await ctx.store.tasks.replaceAll(snap.tasks);
  if (Array.isArray(snap.checkpoints)) await ctx.store.checkpoints.replaceAll(snap.checkpoints);
  log.info('db.import.done', {
    kind: ctx.kind,
    tasks: snap.tasks?.length ?? 0,
    checkpointGroups: snap.checkpoints?.length ?? 0,
  });
  await ctx.store.close();
};

const main = async (): Promise<void> => {
  const cmd = (process.argv[2] ?? '') as Cmd;
  switch (cmd) {
    case 'migrate':
      return runMigrate();
    case 'migrate:down':
      return runMigrateDown();
    case 'status':
      return runStatus();
    case 'seed':
      return runSeed();
    case 'import:json':
      return runImportJson();
    default:
      // eslint-disable-next-line no-console
      console.error(
        `Usage: db-cli <migrate|migrate:down|status|seed|import:json>\n` +
          `Env: SMARTX_STORE=sqlite|postgres  DATABASE_URL=...  SMARTX_SQLITE_PATH=...`,
      );
      process.exitCode = 2;
  }
};

main().catch((err) => {
  log.error('db.cli.failed', { error: String((err as Error).stack ?? err) });
  process.exitCode = 1;
});
