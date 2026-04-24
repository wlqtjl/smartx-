/**
 * 简易持久化：将任务与断点以 JSON 文件形式落盘。
 * 适用于单实例演示。启动时恢复，写入采用异步 + 去抖。
 *
 * 快照带 `schemaVersion`。版本不匹配时：
 *  - 旧版本（< 当前）：尝试尽力兼容读取（忽略未知字段），并在下一次保存时升级。
 *  - 新版本（> 当前）：记录警告但不覆盖，防止降级部署吞数据。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MigrationCheckpoint, MigrationTask } from '@shared/index';
import { log } from '../core/logger.js';
import type { MigrationStateMachine } from '../simulation/MigrationStateMachine.js';
import type { CheckpointSystem } from '../simulation/CheckpointSystem.js';

export const STORAGE_SCHEMA_VERSION = 1;

interface Snapshot {
  schemaVersion?: number;
  tasks: MigrationTask[];
  checkpoints: Array<[string, MigrationCheckpoint[]]>;
  savedAt: number;
}

const DEFAULT_PATH = path.resolve('data', 'state.json');

export class JsonStore {
  private saveTimer: NodeJS.Timeout | null = null;
  private pending = false;
  /** 若读取快照时发现版本过新，则设为 true，避免覆盖写入。 */
  private readOnly = false;

  constructor(
    private readonly fsm: MigrationStateMachine,
    private readonly checkpoints: CheckpointSystem,
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
      if (Array.isArray(data.checkpoints)) this.checkpoints.loadSnapshot(data.checkpoints);
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
        reason: 'persisted snapshot schemaVersion is newer than the running code; refusing to overwrite. Upgrade the deployment or restore from an older backup.',
      });
      return;
    }
    const data: Snapshot = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      tasks: this.fsm.allTasks(),
      checkpoints: this.checkpoints.snapshot(),
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
}
