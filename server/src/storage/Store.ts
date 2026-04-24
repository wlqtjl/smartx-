/**
 * 统一的持久化抽象（Store 接口）。
 *
 * 背景：旧版只有 `JsonStore` 单文件快照，随着鉴权（PR #1）、ACL（PR #6）落地，
 * 需要跨多实例可靠的关系型存储。本接口按实体分组（users/sessions/tasks/
 * checkpoints/audit），配合 `tx()` 多表事务、`health()` 探针。
 *
 * 三个内置实现：
 *  - JsonStore：单文件 JSON，仅开发环境；不支持多实例。
 *  - SqliteStore：`better-sqlite3`，WAL 模式，单节点生产可用。
 *  - PostgresStore：`pg` 连接池 + 咨询锁，多节点生产推荐。
 *
 * 目前 tasks/checkpoints 路径由 MigrationStateMachine / CheckpointSystem 持有
 * 内存状态，Store 负责快照式落盘与重启回放；users/sessions/audit 在 PR #1/#6
 * 中会转为逐行增删改查，因此这里按最终形态设计接口，先行提供基础方法。
 */
import type { MigrationCheckpoint, MigrationTask } from '@shared/index';

/** 数据库 schema 版本号。代码里读到的 = 期望值，真实值从 `schema_meta` 表里读。 */
export const STORAGE_SCHEMA_VERSION = 2;

/** 用户记录（PR #1 填充） */
export interface StoredUser {
  id: string;
  login: string;
  passwordHash: string | null;
  oidcSubject: string | null;
  roles: string[];
  createdAt: number;
  disabledAt: number | null;
}

/** 服务端会话记录（PR #1 填充） */
export interface StoredSession {
  sid: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  refreshHash: string | null;
  revokedAt: number | null;
}

/** 审计日志条目（PR #6 填充） */
export interface AuditLogEntry {
  id?: string;
  userId: string | null;
  action: string;
  target: string | null;
  at: number;
  details: Record<string, unknown> | null;
}

export interface UsersRepo {
  get(id: string): Promise<StoredUser | null>;
  findByLogin(login: string): Promise<StoredUser | null>;
  findByOidcSubject(sub: string): Promise<StoredUser | null>;
  upsert(user: StoredUser): Promise<void>;
  list(opts?: { limit?: number }): Promise<StoredUser[]>;
  delete(id: string): Promise<void>;
}

export interface SessionsRepo {
  get(sid: string): Promise<StoredSession | null>;
  upsert(session: StoredSession): Promise<void>;
  revoke(sid: string, at: number): Promise<void>;
  deleteExpired(now: number): Promise<number>;
  list(opts?: { userId?: string; limit?: number }): Promise<StoredSession[]>;
}

export interface TasksRepo {
  get(id: string): Promise<MigrationTask | null>;
  list(opts?: { ownerUserId?: string; limit?: number }): Promise<MigrationTask[]>;
  upsert(task: MigrationTask): Promise<void>;
  delete(id: string): Promise<void>;
  /** 批量替换（快照恢复 / 导入使用）。 */
  replaceAll(tasks: MigrationTask[]): Promise<void>;
}

export interface CheckpointsRepo {
  listForTask(taskId: string): Promise<MigrationCheckpoint[]>;
  append(checkpoint: MigrationCheckpoint): Promise<void>;
  deleteForTask(taskId: string): Promise<void>;
  /** 快照恢复：一次性装入所有任务的 checkpoint 列表。 */
  replaceAll(entries: Array<[string, MigrationCheckpoint[]]>): Promise<void>;
  /** 供内存态 CheckpointSystem.snapshot() 消费的全量导出。 */
  dumpAll(): Promise<Array<[string, MigrationCheckpoint[]]>>;
}

export interface AuditRepo {
  append(entry: AuditLogEntry): Promise<void>;
  list(opts?: { userId?: string; since?: number; limit?: number }): Promise<AuditLogEntry[]>;
}

export interface StoreHealth {
  ok: boolean;
  latencyMs: number;
  schemaVersion: number;
  migrationsApplied: string[];
  /** 额外诊断信息（可读性错误描述）。 */
  error?: string;
}

export interface Store {
  readonly kind: 'json' | 'sqlite' | 'postgres';
  readonly users: UsersRepo;
  readonly sessions: SessionsRepo;
  readonly tasks: TasksRepo;
  readonly checkpoints: CheckpointsRepo;
  readonly audit: AuditRepo;

  /** 启动时幂等地运行迁移。实现内部通过文件锁 / 咨询锁避免并发冲突。 */
  migrate(): Promise<void>;

  /**
   * 多表原子写入。JsonStore 退化为串行（单文件），SQL 后端使用 BEGIN/COMMIT。
   * 回调里应该只使用**同一个** store（不要嵌套打开新连接）。
   */
  tx<T>(fn: (s: Store) => Promise<T>): Promise<T>;

  /** 探活 + 版本号，供 `/health` 消费。 */
  health(): Promise<StoreHealth>;

  /** 关闭底层连接/句柄。 */
  close(): Promise<void>;
}
