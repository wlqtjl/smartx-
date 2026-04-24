/**
 * PostgresStore：基于 `pg` 的连接池驱动，多实例生产推荐。
 *
 * 并发控制：
 *  - 迁移阶段用 `pg_advisory_lock(<key>)` 全局串行化（多实例同时启动也安全）；
 *  - tx() 使用 `BEGIN/COMMIT`；
 *  - JSON 列使用 JSONB。
 */
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { MigrationCheckpoint, MigrationTask } from '@shared/index';
import { log } from '../core/logger.js';
import type {
  AuditLogEntry,
  AuditRepo,
  CheckpointsRepo,
  SessionsRepo,
  Store,
  StoreHealth,
  StoredSession,
  StoredUser,
  TasksRepo,
  UsersRepo,
} from './Store.js';
import { STORAGE_SCHEMA_VERSION } from './Store.js';
import {
  applyPending,
  listApplied,
  loadMigrations,
  rollbackApplied,
  type SqlRunner,
} from './migrate.js';

/**
 * 咨询锁 key —— 任意固定 64-bit 整数即可，值本身无语义，只需在本数据库内
 * **唯一且稳定**，让多实例同时启动时彼此看到同一把锁。
 *
 * 取值来源：`crc32('smartx.migrations') = 913782401`（十进制）。
 * 如与其他应用共享 Postgres 实例，请确认对方未使用同值（pg_advisory 锁空间
 * 是全库共享的）。需要切换时同步更新常量即可，不会影响已落地的迁移记录。
 */
const MIGRATION_ADVISORY_LOCK_KEY = 913_782_401n;

/** 把 `?` 占位符逐个转成 `$1,$2...`。 */
const qmarkToDollars = (sql: string): string => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

const buildRunner = (
  exec: (sql: string, params?: unknown[]) => Promise<QueryResult<QueryResultRow>>,
): SqlRunner & { all: <T>(sql: string, params?: unknown[]) => Promise<T[]> } => ({
  async exec(sql: string): Promise<void> {
    // multi-statement — pg supports it in simple query protocol (no params).
    await exec(sql);
  },
  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const r = await exec(qmarkToDollars(sql), params);
    return (r.rows[0] as T) ?? null;
  },
  async run(sql: string, params: unknown[] = []): Promise<void> {
    await exec(qmarkToDollars(sql), params);
  },
  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await exec(qmarkToDollars(sql), params);
    return r.rows as T[];
  },
});

export interface PostgresStoreOptions {
  connectionString: string;
  max?: number;
}

export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;
  private pool: Pool;
  private runner: ReturnType<typeof buildRunner>;

  constructor(opts: PostgresStoreOptions) {
    this.pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 10,
    });
    this.runner = buildRunner((sql, params) => this.pool.query(sql, params as unknown[]));
  }

  async migrate(): Promise<void> {
    const files = await loadMigrations();
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
      // Dedicated runner bound to this client so migration runs in one session.
      const clientRunner = buildRunner((sql, params) => client.query(sql, params as unknown[]));
      const applied = await applyPending({ jsonType: 'JSONB', runner: clientRunner }, files);
      if (applied.length > 0) log.info('store.migrate.applied', { count: applied.length, applied });
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [
          MIGRATION_ADVISORY_LOCK_KEY.toString(),
        ]);
      } catch {
        /* no-op */
      }
      client.release();
    }
  }

  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txStore = new PgTxStore(client);
      const result = await fn(txStore);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* no-op */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async health(): Promise<StoreHealth> {
    const t0 = Date.now();
    try {
      const row = await this.runner.queryOne<{ value: string }>(
        `SELECT value FROM schema_meta WHERE key = 'version'`,
      );
      const applied = await listApplied({ jsonType: 'JSONB', runner: this.runner });
      return {
        ok: true,
        latencyMs: Date.now() - t0,
        schemaVersion: row ? Number(row.value) : 0,
        migrationsApplied: applied,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        schemaVersion: 0,
        migrationsApplied: [],
        error: String((err as Error).message ?? err),
      };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async rollbackLatest(): Promise<string[]> {
    const files = await loadMigrations();
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
      const clientRunner = buildRunner((sql, params) => client.query(sql, params as unknown[]));
      const done = await rollbackApplied({ jsonType: 'JSONB', runner: clientRunner }, files);
      return done;
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [
          MIGRATION_ADVISORY_LOCK_KEY.toString(),
        ]);
      } catch {
        /* no-op */
      }
      client.release();
    }
  }

  readonly users: UsersRepo = makeUsersRepo(() => this.runner);
  readonly sessions: SessionsRepo = makeSessionsRepo(() => this.runner);
  readonly tasks: TasksRepo = makeTasksRepo(() => this.runner);
  readonly checkpoints: CheckpointsRepo = makeCheckpointsRepo(() => this.runner);
  readonly audit: AuditRepo = makeAuditRepo(() => this.runner);
}

void STORAGE_SCHEMA_VERSION;

// ────────────────────────────────────────────────────────────────────────────
// Tx-bound inner store. Uses the client directly so everything stays in one
// transaction. Repos are re-created per tx to close over the bound runner.
// ────────────────────────────────────────────────────────────────────────────
class PgTxStore implements Store {
  readonly kind = 'postgres' as const;
  readonly users: UsersRepo;
  readonly sessions: SessionsRepo;
  readonly tasks: TasksRepo;
  readonly checkpoints: CheckpointsRepo;
  readonly audit: AuditRepo;
  private runner: ReturnType<typeof buildRunner>;

  constructor(private readonly client: PoolClient) {
    this.runner = buildRunner((sql, params) => client.query(sql, params as unknown[]));
    this.users = makeUsersRepo(() => this.runner);
    this.sessions = makeSessionsRepo(() => this.runner);
    this.tasks = makeTasksRepo(() => this.runner);
    this.checkpoints = makeCheckpointsRepo(() => this.runner);
    this.audit = makeAuditRepo(() => this.runner);
  }

  async migrate(): Promise<void> {
    throw new Error('migrate() must be called on the root store, not inside tx()');
  }
  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    // Nested transactions: run inline (pg savepoints omitted for simplicity).
    return fn(this);
  }
  async health(): Promise<StoreHealth> {
    return { ok: true, latencyMs: 0, schemaVersion: 0, migrationsApplied: [] };
  }
  async close(): Promise<void> {
    /* lifecycle managed by outer */
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Repo factories (shared between PostgresStore and PgTxStore).
// ────────────────────────────────────────────────────────────────────────────
type AsyncRunner = ReturnType<typeof buildRunner>;

const makeUsersRepo = (getRunner: () => AsyncRunner): UsersRepo => ({
  get: async (id) => mapUser(await getRunner().queryOne(`SELECT * FROM users WHERE id = ?`, [id])),
  findByLogin: async (login) =>
    mapUser(await getRunner().queryOne(`SELECT * FROM users WHERE login = ?`, [login])),
  findByOidcSubject: async (sub) =>
    mapUser(await getRunner().queryOne(`SELECT * FROM users WHERE oidc_subject = ?`, [sub])),
  upsert: async (u) => {
    const now = Date.now();
    await getRunner().run(
      `INSERT INTO users(id, login, password_hash, oidc_subject, roles, created_at, updated_at, disabled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         login=EXCLUDED.login,
         password_hash=EXCLUDED.password_hash,
         oidc_subject=EXCLUDED.oidc_subject,
         roles=EXCLUDED.roles,
         updated_at=EXCLUDED.updated_at,
         disabled_at=EXCLUDED.disabled_at`,
      [u.id, u.login, u.passwordHash, u.oidcSubject, JSON.stringify(u.roles), u.createdAt, now, u.disabledAt],
    );
  },
  list: async (opts) => {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
    const rows = await getRunner().all<Record<string, unknown>>(
      `SELECT * FROM users ORDER BY created_at ASC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => mapUser(r)).filter((u): u is StoredUser => u !== null);
  },
  delete: async (id) => {
    await getRunner().run(`DELETE FROM users WHERE id = ?`, [id]);
  },
});

const makeSessionsRepo = (getRunner: () => AsyncRunner): SessionsRepo => ({
  get: async (sid) =>
    mapSession(await getRunner().queryOne(`SELECT * FROM sessions WHERE sid = ?`, [sid])),
  upsert: async (s) => {
    const now = Date.now();
    await getRunner().run(
      `INSERT INTO sessions(sid, user_id, created_at, updated_at, expires_at, refresh_hash, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET
         user_id=EXCLUDED.user_id,
         updated_at=EXCLUDED.updated_at,
         expires_at=EXCLUDED.expires_at,
         refresh_hash=EXCLUDED.refresh_hash,
         revoked_at=EXCLUDED.revoked_at`,
      [s.sid, s.userId, s.createdAt, now, s.expiresAt, s.refreshHash, s.revokedAt],
    );
  },
  revoke: async (sid, at) => {
    await getRunner().run(
      `UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE sid = ?`,
      [at, Date.now(), sid],
    );
  },
  deleteExpired: async (now) => {
    const r = await getRunner().all<{ sid: string }>(
      `DELETE FROM sessions WHERE expires_at < ? RETURNING sid`,
      [now],
    );
    return r.length;
  },
  list: async (opts) => {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
    const sql = opts?.userId
      ? `SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?`;
    const params = opts?.userId ? [opts.userId, limit] : [limit];
    const rows = await getRunner().all<Record<string, unknown>>(sql, params);
    return rows.map((r) => mapSession(r)).filter((s): s is StoredSession => s !== null);
  },
});

const makeTasksRepo = (getRunner: () => AsyncRunner): TasksRepo => ({
  get: async (id) => {
    const row = await getRunner().queryOne<{ payload_json: unknown }>(
      `SELECT payload_json FROM tasks WHERE id = ?`,
      [id],
    );
    return row ? parseJsonPayload<MigrationTask>(row.payload_json) : null;
  },
  list: async (opts) => {
    const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 5000);
    const sql = opts?.ownerUserId
      ? `SELECT payload_json FROM tasks WHERE owner_user_id = ? ORDER BY created_at ASC LIMIT ?`
      : `SELECT payload_json FROM tasks ORDER BY created_at ASC LIMIT ?`;
    const params = opts?.ownerUserId ? [opts.ownerUserId, limit] : [limit];
    const rows = await getRunner().all<{ payload_json: unknown }>(sql, params);
    return rows.map((r) => parseJsonPayload<MigrationTask>(r.payload_json));
  },
  upsert: async (t) => {
    const now = Date.now();
    await getRunner().run(
      `INSERT INTO tasks(id, owner_user_id, vm_id, state, data_total_gb, created_at, updated_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)
       ON CONFLICT(id) DO UPDATE SET
         owner_user_id=EXCLUDED.owner_user_id,
         vm_id=EXCLUDED.vm_id,
         state=EXCLUDED.state,
         data_total_gb=EXCLUDED.data_total_gb,
         updated_at=EXCLUDED.updated_at,
         payload_json=EXCLUDED.payload_json`,
      [
        t.id,
        t.ownerSession ?? null,
        t.vmId,
        t.state,
        t.progress?.dataTotalGB ?? 0,
        now,
        now,
        JSON.stringify(t),
      ],
    );
  },
  delete: async (id) => {
    await getRunner().run(`DELETE FROM tasks WHERE id = ?`, [id]);
    await getRunner().run(`DELETE FROM task_timeline WHERE task_id = ?`, [id]);
  },
  replaceAll: async (tasks) => {
    await getRunner().run(`DELETE FROM tasks`);
    await getRunner().run(`DELETE FROM task_timeline`);
    const now = Date.now();
    for (const t of tasks) {
      await getRunner().run(
        `INSERT INTO tasks(id, owner_user_id, vm_id, state, data_total_gb, created_at, updated_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)`,
        [
          t.id,
          t.ownerSession ?? null,
          t.vmId,
          t.state,
          t.progress?.dataTotalGB ?? 0,
          now,
          now,
          JSON.stringify(t),
        ],
      );
    }
  },
});

const makeCheckpointsRepo = (getRunner: () => AsyncRunner): CheckpointsRepo => ({
  listForTask: async (taskId) => {
    const rows = await getRunner().all<{ payload_json: unknown }>(
      `SELECT payload_json FROM checkpoints WHERE task_id = ? ORDER BY seq ASC`,
      [taskId],
    );
    return rows.map((r) => parseJsonPayload<MigrationCheckpoint>(r.payload_json));
  },
  append: async (cp) => {
    const row = await getRunner().queryOne<{ max_seq: number | null }>(
      `SELECT MAX(seq) AS max_seq FROM checkpoints WHERE task_id = ?`,
      [cp.taskId],
    );
    const seq = (row?.max_seq ?? 0) + 1;
    const id = `${cp.taskId}:${seq}`;
    await getRunner().run(
      `INSERT INTO checkpoints(id, task_id, seq, last_offset, at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?::jsonb)`,
      [id, cp.taskId, seq, cp.lastCompletedBlockOffset, cp.timestamp, JSON.stringify(cp)],
    );
  },
  deleteForTask: async (taskId) => {
    await getRunner().run(`DELETE FROM checkpoints WHERE task_id = ?`, [taskId]);
  },
  replaceAll: async (entries) => {
    await getRunner().run(`DELETE FROM checkpoints`);
    for (const [taskId, cps] of entries) {
      for (let i = 0; i < cps.length; i++) {
        const cp = cps[i]!;
        const seq = i + 1;
        await getRunner().run(
          `INSERT INTO checkpoints(id, task_id, seq, last_offset, at, payload_json)
           VALUES (?, ?, ?, ?, ?, ?::jsonb)`,
          [`${taskId}:${seq}`, taskId, seq, cp.lastCompletedBlockOffset, cp.timestamp, JSON.stringify(cp)],
        );
      }
    }
  },
  dumpAll: async () => {
    const rows = await getRunner().all<{ task_id: string; payload_json: unknown; seq: number }>(
      `SELECT task_id, payload_json, seq FROM checkpoints ORDER BY task_id, seq`,
    );
    const map = new Map<string, MigrationCheckpoint[]>();
    for (const r of rows) {
      if (!map.has(r.task_id)) map.set(r.task_id, []);
      map.get(r.task_id)!.push(parseJsonPayload<MigrationCheckpoint>(r.payload_json));
    }
    return Array.from(map.entries());
  },
});

const makeAuditRepo = (getRunner: () => AsyncRunner): AuditRepo => ({
  append: async (entry) => {
    const id = entry.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await getRunner().run(
      `INSERT INTO audit_log(id, user_id, action, target, at, details_json)
       VALUES (?, ?, ?, ?, ?, ?::jsonb)`,
      [
        id,
        entry.userId,
        entry.action,
        entry.target,
        entry.at,
        entry.details ? JSON.stringify(entry.details) : null,
      ],
    );
  },
  list: async (opts) => {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
    let sql = `SELECT * FROM audit_log WHERE 1=1`;
    const params: unknown[] = [];
    if (opts?.userId) {
      sql += ` AND user_id = ?`;
      params.push(opts.userId);
    }
    if (typeof opts?.since === 'number') {
      sql += ` AND at >= ?`;
      params.push(opts.since);
    }
    sql += ` ORDER BY at DESC LIMIT ?`;
    params.push(limit);
    const rows = await getRunner().all<Record<string, unknown>>(sql, params);
    return rows.map((r) => ({
      id: r.id as string,
      userId: (r.user_id as string) ?? null,
      action: r.action as string,
      target: (r.target as string) ?? null,
      at: Number(r.at),
      details: r.details_json ? parseJsonPayload<Record<string, unknown>>(r.details_json) : null,
    }));
  },
});

const parseJsonPayload = <T>(raw: unknown): T => {
  if (raw == null) return {} as T;
  if (typeof raw === 'object') return raw as T;
  return JSON.parse(String(raw)) as T;
};

const mapUser = (r: Record<string, unknown> | null): StoredUser | null => {
  if (!r) return null;
  return {
    id: r.id as string,
    login: r.login as string,
    passwordHash: ((r.password_hash as string) ?? null) || null,
    oidcSubject: ((r.oidc_subject as string) ?? null) || null,
    roles: typeof r.roles === 'string' ? (JSON.parse(r.roles) as string[]) : Array.isArray(r.roles) ? (r.roles as string[]) : [],
    createdAt: Number(r.created_at),
    disabledAt: r.disabled_at != null ? Number(r.disabled_at) : null,
  };
};

const mapSession = (r: Record<string, unknown> | null): StoredSession | null => {
  if (!r) return null;
  return {
    sid: r.sid as string,
    userId: r.user_id as string,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    refreshHash: ((r.refresh_hash as string) ?? null) || null,
    revokedAt: r.revoked_at != null ? Number(r.revoked_at) : null,
  };
};
