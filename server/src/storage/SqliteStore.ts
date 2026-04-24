/**
 * SqliteStore：基于 better-sqlite3 的同步驱动，单节点生产可用。
 * 并发控制：
 *  - 启用 WAL 模式；
 *  - 迁移阶段用 `BEGIN EXCLUSIVE` 串行化；
 *  - tx() 使用事务；
 *  - better-sqlite3 本身线程安全（同进程内），故单 Node 实例足够。
 */
import Database from 'better-sqlite3';
import type { Database as SqliteDB } from 'better-sqlite3';
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
  type MigrationDialect,
  type SqlRunner,
} from './migrate.js';

const buildRunner = (db: SqliteDB) => ({
  exec(sql: string): void {
    db.exec(sql);
  },
  queryOne<T>(sql: string, params: unknown[] = []): T | null {
    return (db.prepare(sql).get(...(params as unknown[])) as T) ?? null;
  },
  run(sql: string, params: unknown[] = []): void {
    db.prepare(sql).run(...(params as unknown[]));
  },
  all<T>(sql: string, params: unknown[] = []): T[] {
    return db.prepare(sql).all(...(params as unknown[])) as T[];
  },
});

type SqliteRunner = ReturnType<typeof buildRunner>;

// The runner satisfies the SqlRunner interface (sync variants of the union).
const asGeneric = (r: SqliteRunner): SqlRunner => r;

export class SqliteStore implements Store {
  readonly kind = 'sqlite' as const;
  private db: SqliteDB;
  private runner: ReturnType<typeof buildRunner>;

  constructor(private readonly filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.runner = buildRunner(this.db);
  }

  async migrate(): Promise<void> {
    const files = await loadMigrations();
    // BEGIN EXCLUSIVE 串行化：多实例指向同一 sqlite 文件时仍安全。
    this.db.exec('BEGIN EXCLUSIVE');
    try {
      const applied = await applyPending({ jsonType: 'TEXT', runner: asGeneric(this.runner) }, files);
      this.db.exec('COMMIT');
      if (applied.length > 0) log.info('store.migrate.applied', { count: applied.length, applied });
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* no-op */
      }
      throw err;
    }
  }

  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    // better-sqlite3 is synchronous but fn is async; use IMMEDIATE + explicit commit/rollback.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* no-op */
      }
      throw err;
    }
  }

  async health(): Promise<StoreHealth> {
    const t0 = Date.now();
    try {
      const row = this.runner.queryOne<{ value: string }>(
        `SELECT value FROM schema_meta WHERE key = 'version'`,
      );
      const applied = await listApplied({ jsonType: 'TEXT', runner: asGeneric(this.runner) });
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
    this.db.close();
  }

  async rollbackLatest(): Promise<string[]> {
    const files = await loadMigrations();
    this.db.exec('BEGIN EXCLUSIVE');
    try {
      const done = await rollbackApplied({ jsonType: 'TEXT', runner: asGeneric(this.runner) }, files);
      this.db.exec('COMMIT');
      return done;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* no-op */
      }
      throw err;
    }
  }

  readonly users: UsersRepo = {
    get: async (id) => mapUser(this.runner.queryOne(`SELECT * FROM users WHERE id = ?`, [id])),
    findByLogin: async (login) =>
      mapUser(this.runner.queryOne(`SELECT * FROM users WHERE login = ?`, [login])),
    findByOidcSubject: async (sub) =>
      mapUser(this.runner.queryOne(`SELECT * FROM users WHERE oidc_subject = ?`, [sub])),
    upsert: async (u) => {
      const now = Date.now();
      this.runner.run(
        `INSERT INTO users(id, login, password_hash, oidc_subject, roles, created_at, updated_at, disabled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           login=excluded.login,
           password_hash=excluded.password_hash,
           oidc_subject=excluded.oidc_subject,
           roles=excluded.roles,
           updated_at=excluded.updated_at,
           disabled_at=excluded.disabled_at`,
        [
          u.id,
          u.login,
          u.passwordHash,
          u.oidcSubject,
          JSON.stringify(u.roles),
          u.createdAt,
          now,
          u.disabledAt,
        ],
      );
    },
    list: async (opts) => {
      const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
      const rows = this.runner.all<Record<string, unknown>>(
        `SELECT * FROM users ORDER BY created_at ASC LIMIT ?`,
        [limit],
      );
      return rows.map((r) => mapUser(r)).filter((u): u is StoredUser => u !== null);
    },
    delete: async (id) => {
      this.runner.run(`DELETE FROM users WHERE id = ?`, [id]);
    },
  };

  readonly sessions: SessionsRepo = {
    get: async (sid) =>
      mapSession(this.runner.queryOne(`SELECT * FROM sessions WHERE sid = ?`, [sid])),
    upsert: async (s) => {
      const now = Date.now();
      this.runner.run(
        `INSERT INTO sessions(sid, user_id, created_at, updated_at, expires_at, refresh_hash, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET
           user_id=excluded.user_id,
           updated_at=excluded.updated_at,
           expires_at=excluded.expires_at,
           refresh_hash=excluded.refresh_hash,
           revoked_at=excluded.revoked_at`,
        [s.sid, s.userId, s.createdAt, now, s.expiresAt, s.refreshHash, s.revokedAt],
      );
    },
    revoke: async (sid, at) => {
      this.runner.run(`UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE sid = ?`, [
        at,
        Date.now(),
        sid,
      ]);
    },
    deleteExpired: async (now) => {
      const info = this.db
        .prepare(`DELETE FROM sessions WHERE expires_at < ?`)
        .run(now);
      return info.changes ?? 0;
    },
    list: async (opts) => {
      const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
      const sql = opts?.userId
        ? `SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
        : `SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?`;
      const params = opts?.userId ? [opts.userId, limit] : [limit];
      return this.runner
        .all<Record<string, unknown>>(sql, params)
        .map((r) => mapSession(r))
        .filter((s): s is StoredSession => s !== null);
    },
  };

  readonly tasks: TasksRepo = {
    get: async (id) => {
      const row = this.runner.queryOne<{ payload_json: string }>(
        `SELECT payload_json FROM tasks WHERE id = ?`,
        [id],
      );
      return row ? (JSON.parse(row.payload_json) as MigrationTask) : null;
    },
    list: async (opts) => {
      const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 5000);
      const sql = opts?.ownerUserId
        ? `SELECT payload_json FROM tasks WHERE owner_user_id = ? ORDER BY created_at ASC LIMIT ?`
        : `SELECT payload_json FROM tasks ORDER BY created_at ASC LIMIT ?`;
      const params = opts?.ownerUserId ? [opts.ownerUserId, limit] : [limit];
      const rows = this.runner.all<{ payload_json: string }>(sql, params);
      return rows.map((r) => JSON.parse(r.payload_json) as MigrationTask);
    },
    upsert: async (t) => {
      const now = Date.now();
      this.runner.run(
        `INSERT INTO tasks(id, owner_user_id, vm_id, state, data_total_gb, created_at, updated_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           owner_user_id=excluded.owner_user_id,
           vm_id=excluded.vm_id,
           state=excluded.state,
           data_total_gb=excluded.data_total_gb,
           updated_at=excluded.updated_at,
           payload_json=excluded.payload_json`,
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
      this.runner.run(`DELETE FROM tasks WHERE id = ?`, [id]);
      this.runner.run(`DELETE FROM task_timeline WHERE task_id = ?`, [id]);
    },
    replaceAll: async (tasks) => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec('DELETE FROM tasks');
        this.db.exec('DELETE FROM task_timeline');
        const stmt = this.db.prepare(
          `INSERT INTO tasks(id, owner_user_id, vm_id, state, data_total_gb, created_at, updated_at, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const now = Date.now();
        for (const t of tasks) {
          stmt.run(
            t.id,
            t.ownerSession ?? null,
            t.vmId,
            t.state,
            t.progress?.dataTotalGB ?? 0,
            now,
            now,
            JSON.stringify(t),
          );
        }
        this.db.exec('COMMIT');
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* no-op */
        }
        throw err;
      }
    },
  };

  readonly checkpoints: CheckpointsRepo = {
    listForTask: async (taskId) => {
      const rows = this.runner.all<{ payload_json: string }>(
        `SELECT payload_json FROM checkpoints WHERE task_id = ? ORDER BY seq ASC`,
        [taskId],
      );
      return rows.map((r) => JSON.parse(r.payload_json) as MigrationCheckpoint);
    },
    append: async (cp) => {
      const row = this.runner.queryOne<{ max_seq: number | null }>(
        `SELECT MAX(seq) AS max_seq FROM checkpoints WHERE task_id = ?`,
        [cp.taskId],
      );
      const seq = (row?.max_seq ?? 0) + 1;
      const id = `${cp.taskId}:${seq}`;
      this.runner.run(
        `INSERT INTO checkpoints(id, task_id, seq, last_offset, at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, cp.taskId, seq, cp.lastCompletedBlockOffset, cp.timestamp, JSON.stringify(cp)],
      );
    },
    deleteForTask: async (taskId) => {
      this.runner.run(`DELETE FROM checkpoints WHERE task_id = ?`, [taskId]);
    },
    replaceAll: async (entries) => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec('DELETE FROM checkpoints');
        const stmt = this.db.prepare(
          `INSERT INTO checkpoints(id, task_id, seq, last_offset, at, payload_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const [taskId, cps] of entries) {
          cps.forEach((cp, idx) => {
            const seq = idx + 1;
            stmt.run(
              `${taskId}:${seq}`,
              taskId,
              seq,
              cp.lastCompletedBlockOffset,
              cp.timestamp,
              JSON.stringify(cp),
            );
          });
        }
        this.db.exec('COMMIT');
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* no-op */
        }
        throw err;
      }
    },
    dumpAll: async () => {
      const rows = this.runner.all<{ task_id: string; payload_json: string; seq: number }>(
        `SELECT task_id, payload_json, seq FROM checkpoints ORDER BY task_id, seq`,
      );
      const map = new Map<string, MigrationCheckpoint[]>();
      for (const r of rows) {
        if (!map.has(r.task_id)) map.set(r.task_id, []);
        map.get(r.task_id)!.push(JSON.parse(r.payload_json) as MigrationCheckpoint);
      }
      return Array.from(map.entries());
    },
  };

  readonly audit: AuditRepo = {
    append: async (entry) => {
      const id = entry.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      this.runner.run(
        `INSERT INTO audit_log(id, user_id, action, target, at, details_json) VALUES (?, ?, ?, ?, ?, ?)`,
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
      const rows = this.runner.all<Record<string, unknown>>(sql, params);
      return rows.map((r) => ({
        id: r.id as string,
        userId: (r.user_id as string) ?? null,
        action: r.action as string,
        target: (r.target as string) ?? null,
        at: Number(r.at),
        details: r.details_json ? (JSON.parse(r.details_json as string) as Record<string, unknown>) : null,
      }));
    },
  };
}

// Used to satisfy TS `STORAGE_SCHEMA_VERSION` import
void STORAGE_SCHEMA_VERSION;

const mapUser = (r: Record<string, unknown> | null): StoredUser | null => {
  if (!r) return null;
  return {
    id: r.id as string,
    login: r.login as string,
    passwordHash: ((r.password_hash as string) ?? null) || null,
    oidcSubject: ((r.oidc_subject as string) ?? null) || null,
    roles: typeof r.roles === 'string' ? (JSON.parse(r.roles) as string[]) : [],
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
