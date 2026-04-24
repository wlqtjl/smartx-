/**
 * Store 工厂：按 `AppConfig.store.kind` 构造对应后端。
 *
 * 目前 SqliteStore / PostgresStore 只承载 users / sessions / tasks / checkpoints / audit
 * 五个新实体表；FSM 任务与 checkpoint 的**运行时**仍由内存的
 * MigrationStateMachine / CheckpointSystem 管理，SQL 后端在 load/save 之间
 * 通过 `replaceAll()` 做完整快照（与 JsonStore 行为等价）。
 *
 * 这样做的原因：
 *  - PR #2 目标是"消除多实例文件竞争"，只要写入路径通过数据库就达成；
 *  - 把 FSM 拆到按列的关系型存储是 PR #1 / PR #6 里要处理的用户模型重构范畴，
 *    拖进 PR #2 会让 PR 体量不可收敛。
 */
import path from 'node:path';
import type { AppConfig } from '../core/config.js';
import { log } from '../core/logger.js';
import type { MigrationStateMachine } from '../simulation/MigrationStateMachine.js';
import type { CheckpointSystem } from '../simulation/CheckpointSystem.js';
import { JsonStore } from './JsonStore.js';
import type { Store } from './Store.js';

export interface CreateStoreContext {
  fsm: MigrationStateMachine;
  checkpoints: CheckpointSystem;
  config: AppConfig;
}

/** Unified facade — implements `Store` and also carries legacy lifecycle hooks. */
export interface ManagedStore extends Store {
  /** 启动时读取现有状态到内存（FSM / CheckpointSystem / repo maps）。 */
  load(): Promise<void>;
  /** 异步安排一次整体快照保存（debounced）。 */
  scheduleSave(): void;
  /** 立即同步一次写入。 */
  saveNow(): Promise<void>;
  /** `/health` 复用的可写性检测。 */
  checkWritable(): Promise<string | null>;
  /** 关闭底层句柄/连接（优雅退出）。 */
  shutdown(): Promise<void>;
}

export const createStore = async (ctx: CreateStoreContext): Promise<ManagedStore> => {
  const { fsm, checkpoints, config } = ctx;

  if (config.store.kind === 'json') {
    const filePath = config.dataPath ?? path.resolve('data', 'state.json');
    const s = new JsonStore(fsm, checkpoints, filePath);
    log.info('store.init', { kind: 'json', path: filePath });
    return s;
  }

  // SQL-backed adapters: lazy-import so dev environments without better-sqlite3
  // or pg installed still boot cleanly on the JSON path.
  if (config.store.kind === 'sqlite') {
    const { SqliteStore } = await import('./SqliteStore.js');
    const sqlitePath =
      config.store.sqlitePath ?? path.resolve(path.dirname(config.dataPath ?? 'data/state.json'), 'smartx.db');
    const core = new SqliteStore(sqlitePath);
    await core.migrate();
    const wrapped = new SqlBackedStore(core, fsm, checkpoints);
    log.info('store.init', { kind: 'sqlite', path: sqlitePath });
    return wrapped;
  }

  if (config.store.kind === 'postgres') {
    if (!config.store.databaseUrl) throw new Error('DATABASE_URL is required for postgres store');
    const { PostgresStore } = await import('./PostgresStore.js');
    const core = new PostgresStore({
      connectionString: config.store.databaseUrl,
      max: config.store.poolMax,
    });
    await core.migrate();
    const wrapped = new SqlBackedStore(core, fsm, checkpoints);
    log.info('store.init', { kind: 'postgres', poolMax: config.store.poolMax });
    return wrapped;
  }

  throw new Error(`unknown store kind: ${String(config.store.kind)}`);
};

/**
 * SQL 后端包装：把同步的 FSM / CheckpointSystem 通过 debounce 快照写到 SQL。
 * 行为与 JsonStore.scheduleSave() 等价，但落地到关系表而非 JSON 文件。
 */
class SqlBackedStore implements ManagedStore {
  private saveTimer: NodeJS.Timeout | null = null;
  private pending = false;

  constructor(
    private readonly core: Store,
    private readonly fsm: MigrationStateMachine,
    private readonly cpSystem: CheckpointSystem,
  ) {}

  get kind(): Store['kind'] {
    return this.core.kind;
  }

  // Entity repos delegate straight through.
  get users() {
    return this.core.users;
  }
  get sessions() {
    return this.core.sessions;
  }
  get tasks() {
    return this.core.tasks;
  }
  get checkpoints() {
    return this.core.checkpoints;
  }
  get audit() {
    return this.core.audit;
  }

  migrate(): Promise<void> {
    return this.core.migrate();
  }
  tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    return this.core.tx(fn);
  }
  health() {
    return this.core.health();
  }

  async load(): Promise<void> {
    // Restore FSM + checkpoint in-memory state from SQL.
    const tasks = await this.core.tasks.list({ limit: 5000 });
    if (tasks.length > 0) this.fsm.loadSnapshot(tasks);
    const cpEntries = await this.core.checkpoints.dumpAll();
    if (cpEntries.length > 0) this.cpSystem.loadSnapshot(cpEntries);
    log.info('state.restored', { kind: this.core.kind, tasks: tasks.length });
  }

  scheduleSave(): void {
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
    try {
      await this.core.tasks.replaceAll(this.fsm.allTasks());
      await this.core.checkpoints.replaceAll(this.cpSystem.snapshot());
    } catch (err) {
      log.error('state.save.failed', { error: String(err) });
    }
  }

  async checkWritable(): Promise<string | null> {
    const h = await this.core.health();
    return h.ok ? null : h.error ?? 'store unhealthy';
  }

  async shutdown(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.pending) await this.saveNow();
    await this.core.close();
  }

  close(): Promise<void> {
    return this.shutdown();
  }
}
