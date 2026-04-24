/**
 * 最小化迁移执行器（纯 SQL 文件 + 版本表）。
 *
 * 设计要点：
 *  - 迁移文件命名 `NNNN_name.up.sql` / `NNNN_name.down.sql`，按数字前缀排序。
 *  - 版本信息写入 `schema_meta` 表：
 *      version -> 已应用迁移 id（最高者），
 *      "mig:<id>" -> applied_at 时间戳（便于列出已应用迁移）。
 *  - 并发安全由调用方保证（SQLite: BEGIN EXCLUSIVE；Postgres: pg_advisory_lock）。
 *  - 放弃引入 `knex` 作为运行时依赖，纯 SQL 就能满足 PR#2 的"up/down 文件"需求。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SqlRunner {
  exec(sql: string): Promise<void> | void;
  queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null> | (T | null);
  /** 用于批量插入 schema_meta 等非返回结果的语句。 */
  run(sql: string, params?: unknown[]): Promise<void> | void;
  /** SELECT * 这种多行返回由 all() 提供。适配器必须实现。 */
  all<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> | T[];
}

export interface MigrationDialect {
  /** ${JSON} 占位符替换为方言类型。 */
  jsonType: 'JSONB' | 'TEXT';
  runner: SqlRunner;
}

export interface MigrationFile {
  id: string; // "0001_init"
  up: string;
  down: string;
}

/**
 * 读取 migrations 目录，按 id 升序返回。
 * 目录位置：与本文件同级的 `migrations/`。
 */
export const loadMigrations = async (dir?: string): Promise<MigrationFile[]> => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = dir ?? path.join(here, 'migrations');
  const files = await fs.readdir(root);
  const ups = files.filter((f) => f.endsWith('.up.sql')).sort();
  const out: MigrationFile[] = [];
  for (const up of ups) {
    const id = up.replace(/\.up\.sql$/, '');
    const down = `${id}.down.sql`;
    const [upSql, downSql] = await Promise.all([
      fs.readFile(path.join(root, up), 'utf8'),
      fs.readFile(path.join(root, down), 'utf8').catch(() => ''),
    ]);
    out.push({ id, up: upSql, down: downSql });
  }
  return out;
};

const substitute = (sql: string, dialect: MigrationDialect): string =>
  sql.replace(/\$\{JSON\}/g, dialect.jsonType);

/**
 * 幂等应用所有未执行迁移。返回新应用的 id 列表。
 * 调用方已持有互斥锁。
 */
export const applyPending = async (
  dialect: MigrationDialect,
  files: MigrationFile[],
): Promise<string[]> => {
  // 确保 schema_meta 存在：第一次运行时用 0001_init 的 up 来创建；这里独立创建一次。
  await dialect.runner.exec(
    `CREATE TABLE IF NOT EXISTS schema_meta (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       applied_at BIGINT NOT NULL
     )`,
  );
  const applied = await listApplied(dialect);
  const pending = files.filter((f) => !applied.includes(f.id));
  const now = Date.now();
  const newlyApplied: string[] = [];
  for (const file of pending) {
    const sql = substitute(file.up, dialect);
    await dialect.runner.exec(sql);
    await dialect.runner.run(
      `INSERT INTO schema_meta(key, value, applied_at) VALUES (?, ?, ?)`,
      [`mig:${file.id}`, '1', now],
    );
    newlyApplied.push(file.id);
  }
  // 记录最新版本号（取 id 前缀数字）
  const latest = [...applied, ...newlyApplied].sort().pop();
  if (latest) {
    const version = String(parseInt(latest.split('_')[0] ?? '0', 10));
    await upsertMeta(dialect, 'version', version, now);
  }
  return newlyApplied;
};

/** 列出已应用迁移 id。 */
export const listApplied = async (dialect: MigrationDialect): Promise<string[]> => {
  // 某些后端（如 Postgres）可能还没建表
  try {
    const rows = await dialect.runner.all<{ key: string }>(
      `SELECT key FROM schema_meta WHERE key LIKE 'mig:%'`,
    );
    return rows.map((r) => r.key.replace(/^mig:/, '')).sort();
  } catch {
    return [];
  }
};

const upsertMeta = async (
  dialect: MigrationDialect,
  key: string,
  value: string,
  at: number,
): Promise<void> => {
  const existing = await dialect.runner.queryOne<{ key: string }>(
    `SELECT key FROM schema_meta WHERE key = ?`,
    [key],
  );
  if (existing) {
    await dialect.runner.run(
      `UPDATE schema_meta SET value = ?, applied_at = ? WHERE key = ?`,
      [value, at, key],
    );
  } else {
    await dialect.runner.run(
      `INSERT INTO schema_meta(key, value, applied_at) VALUES (?, ?, ?)`,
      [key, value, at],
    );
  }
};

/** 回滚最后一批迁移（supply ids 可选；不给则回滚全部）。 */
export const rollbackApplied = async (
  dialect: MigrationDialect,
  files: MigrationFile[],
  ids?: string[],
): Promise<string[]> => {
  const applied = await listApplied(dialect);
  const target = (ids && ids.length > 0 ? ids : applied).filter((id) => applied.includes(id));
  // 从最新到最旧执行 down
  const ordered = [...target].sort().reverse();
  const done: string[] = [];
  for (const id of ordered) {
    const file = files.find((f) => f.id === id);
    if (!file || !file.down.trim()) continue;
    const sql = substitute(file.down, dialect);
    await dialect.runner.exec(sql);
    await dialect.runner.run(`DELETE FROM schema_meta WHERE key = ?`, [`mig:${id}`]);
    done.push(id);
  }
  return done;
};
