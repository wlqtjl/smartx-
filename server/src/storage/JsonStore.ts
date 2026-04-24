/**
 * Dev-only JSON 单文件适配器，实现统一 `Store` 接口。
 *
 * 行为特征：
 *  - 所有实体（users/sessions/tasks/checkpoints/audit）**全部驻留内存**；
 *  - 写入时 debounce 200 ms 后落盘整份 `state.json`；
 *  - 文件版本低于当前代码 → 启动升级；高于当前代码 → 只读拒写，避免降级吞数据；
 *  - 多实例指向同一文件**不安全**，生产请切换到 SqliteStore / PostgresStore。
 *
 * 为保持与 `JsonStore`（一阶段实现）向后兼容，snapshot 文件保留旧字段
 * `tasks` / `checkpoints`；新实体写入同一 JSON 的新字段下，旧代码读到未知字段忽略即可。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MigrationCheckpoint, MigrationTask } from '@shared/index';
import { log } from '../core/logger.js';
import type { MigrationStateMachine } from '../simulation/MigrationStateMachine.js';
import type { CheckpointSystem } from '../simulation/CheckpointSystem.js';
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

interface Snapshot {
  schemaVersion?: number;
  tasks: MigrationTask[];
  checkpoints: Array<[string, MigrationCheckpoint[]]>;
  users?: StoredUser[];
  sessions?: StoredSession[];
  auditLog?: AuditLogEntry[];
  savedAt: number;
}

const DEFAULT_PATH = path.resolve('data', 'state.json');

/**
 * 主实现：兼容旧调用者（`storage.load() / scheduleSave() / saveNow() / checkWritable() / shutdown()`）
 * 同时实现新的 `Store` 接口。
 */
export class JsonStore implements Store {
  readonly kind = 'json' as const;

  private saveTimer: NodeJS.Timeout | null = null;
  private pending = false;
  /** 若读取快照时发现版本过新，则设为 true，避免覆盖写入。 */
  private readOnly = false;

  // In-memory rows for the new entity groups. Populated on load(), mutated by repos.
  private usersMap = new Map<string, StoredUser>();
  private sessionsMap = new Map<string, StoredSession>();
  private auditList: AuditLogEntry[] = [];

  constructor(
    private readonly fsm: MigrationStateMachine,
    private readonly cpSystem: CheckpointSystem,
    private readonly filePath: string = DEFAULT_PATH,
  ) {}

  get path(): string {
    return this.filePath;
  }

  get isReadOnly(): boolean {
    return this.readOnly;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as Snapshot;
      const version = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;
      if (version > STORAGE_SCHEMA_VERSION) {
        this.readOnly = true;
        log.warn('state.schema.newer', {
          path: this.filePath,
          fileSchema: version,
          codeSchema: STORAGE_SCHEMA_VERSION,
        });
        return;
      }
      if (version < STORAGE_SCHEMA_VERSION) {
        log.info('state.schema.upgrade', {
          path: this.filePath,
          from: version,
          to: STORAGE_SCHEMA_VERSION,
        });
      }
      if (Array.isArray(data.tasks)) this.fsm.loadSnapshot(data.tasks);
      if (Array.isArray(data.checkpoints)) this.cpSystem.loadSnapshot(data.checkpoints);
      if (Array.isArray(data.users)) {
        for (const u of data.users) this.usersMap.set(u.id, u);
      }
      if (Array.isArray(data.sessions)) {
        for (const s of data.sessions) this.sessionsMap.set(s.sid, s);
      }
      if (Array.isArray(data.auditLog)) {
        this.auditList = data.auditLog.slice(0, 10_000); // defensive cap
      }
      log.info('state.restored', {
        path: this.filePath,
        tasks: data.tasks?.length ?? 0,
        schemaVersion: version,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('state.restore.failed', { error: String(err) });
      }
    }
  }

  /** Debounced save (200ms). */
  scheduleSave(): void {
    if (this.readOnly) return;
    this.pending = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.pending) return;
      this.pending = false;
      void this.saveNow();
    }, 200);
    this.saveTimer.unref?.();
  }

  async saveNow(): Promise<void> {
    if (this.readOnly) {
      log.warn('state.save.skipped.readonly', {
        path: this.filePath,
        reason:
          'persisted snapshot schemaVersion is newer than the running code; refusing to overwrite. Upgrade the deployment or restore from an older backup.',
      });
      return;
    }
    const data: Snapshot = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      tasks: this.fsm.allTasks(),
      checkpoints: this.cpSystem.snapshot(),
      users: Array.from(this.usersMap.values()),
      sessions: Array.from(this.sessionsMap.values()),
      auditLog: this.auditList,
      savedAt: Date.now(),
    };
    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      log.error('state.save.failed', { error: String(err) });
    }
  }

  /**
   * 探测持久化目录是否可写（供 /health 使用）。
   * 失败返回错误信息；成功返回 null。
   */
  async checkWritable(): Promise<string | null> {
    if (this.readOnly) return 'storage is read-only (schema too new)';
    const dir = path.dirname(this.filePath);
    const probe = path.join(dir, `.health-${process.pid}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(probe, '1', 'utf8');
      await fs.unlink(probe);
      return null;
    } catch (err) {
      return String((err as Error).message ?? err);
    }
  }

  async shutdown(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.pending) await this.saveNow();
  }

  // ──────────────────────────────────────────────────────────────────────
  // Store interface
  // ──────────────────────────────────────────────────────────────────────
  async migrate(): Promise<void> {
    // JSON store 没有真正的 schema — schemaVersion 在 load/save 时处理。
  }

  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    // Single-file in-memory, no concurrent writers within one process → sufficient.
    return fn(this);
  }

  async health(): Promise<StoreHealth> {
    const t0 = Date.now();
    // Note: avoid calling checkWritable() here because callers (e.g. /health)
    // invoke both health() and checkWritable() concurrently and the probe file
    // uses a per-pid name — two concurrent probes would race on unlink.
    return {
      ok: !this.readOnly,
      latencyMs: Date.now() - t0,
      schemaVersion: this.readOnly ? 0 : STORAGE_SCHEMA_VERSION,
      migrationsApplied: ['0001_init'], // 纯语义占位
      ...(this.readOnly ? { error: 'storage is read-only (schema too new)' } : {}),
    };
  }

  async close(): Promise<void> {
    await this.shutdown();
  }

  readonly users: UsersRepo = {
    get: async (id) => this.usersMap.get(id) ?? null,
    findByLogin: async (login) => {
      for (const u of this.usersMap.values()) if (u.login === login) return u;
      return null;
    },
    findByOidcSubject: async (sub) => {
      for (const u of this.usersMap.values()) if (u.oidcSubject === sub) return u;
      return null;
    },
    upsert: async (u) => {
      this.usersMap.set(u.id, u);
      this.scheduleSave();
    },
    list: async (opts) => {
      const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
      return Array.from(this.usersMap.values()).slice(0, limit);
    },
    delete: async (id) => {
      this.usersMap.delete(id);
      this.scheduleSave();
    },
  };

  readonly sessions: SessionsRepo = {
    get: async (sid) => this.sessionsMap.get(sid) ?? null,
    upsert: async (s) => {
      this.sessionsMap.set(s.sid, s);
      this.scheduleSave();
    },
    revoke: async (sid, at) => {
      const s = this.sessionsMap.get(sid);
      if (s) {
        this.sessionsMap.set(sid, { ...s, revokedAt: at });
        this.scheduleSave();
      }
    },
    deleteExpired: async (now) => {
      let removed = 0;
      for (const [sid, s] of this.sessionsMap) {
        if (s.expiresAt < now) {
          this.sessionsMap.delete(sid);
          removed++;
        }
      }
      if (removed > 0) this.scheduleSave();
      return removed;
    },
    list: async (opts) => {
      const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
      const all = Array.from(this.sessionsMap.values());
      const filtered = opts?.userId ? all.filter((s) => s.userId === opts.userId) : all;
      return filtered.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },
  };

  readonly tasks: TasksRepo = {
    get: async (id) => this.fsm.allTasks().find((t) => t.id === id) ?? null,
    list: async (opts) => {
      const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 5000);
      const all = this.fsm.allTasks();
      const filtered = opts?.ownerUserId
        ? all.filter((t) => t.ownerSession === opts.ownerUserId)
        : all;
      return filtered.slice(0, limit);
    },
    upsert: async (_t) => {
      // MigrationStateMachine owns task mutations in the JSON-backed path; this
      // method is a no-op — FSM event → scheduleSave() already covers it.
      this.scheduleSave();
    },
    delete: async (_id) => {
      this.scheduleSave();
    },
    replaceAll: async (tasks) => {
      this.fsm.loadSnapshot(tasks);
      this.scheduleSave();
    },
  };

  readonly checkpoints: CheckpointsRepo = {
    listForTask: async (taskId) => {
      const entry = this.cpSystem.snapshot().find(([k]) => k === taskId);
      return entry?.[1] ?? [];
    },
    append: async (_cp) => {
      // CheckpointSystem handles mutation; scheduleSave on checkpoint:save event.
      this.scheduleSave();
    },
    deleteForTask: async (_taskId) => {
      this.scheduleSave();
    },
    replaceAll: async (entries) => {
      this.cpSystem.loadSnapshot(entries);
      this.scheduleSave();
    },
    dumpAll: async () => this.cpSystem.snapshot(),
  };

  readonly audit: AuditRepo = {
    append: async (entry) => {
      this.auditList.unshift(entry);
      if (this.auditList.length > 10_000) this.auditList.length = 10_000;
      this.scheduleSave();
    },
    list: async (opts) => {
      const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
      let rows = this.auditList;
      if (opts?.userId) rows = rows.filter((e) => e.userId === opts.userId);
      if (typeof opts?.since === 'number') rows = rows.filter((e) => e.at >= opts.since!);
      return rows.slice(0, limit);
    },
  };
}

// Re-export for back-compat with the pre-PR#2 import site:
// `import { STORAGE_SCHEMA_VERSION } from './storage/JsonStore.js'`
export { STORAGE_SCHEMA_VERSION };
