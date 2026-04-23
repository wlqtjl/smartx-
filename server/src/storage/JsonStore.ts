/**
 * 简易持久化：将任务与断点以 JSON 文件形式落盘。
 * 适用于单实例演示。启动时恢复，写入采用异步 + 去抖。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MigrationCheckpoint, MigrationTask } from '@shared/index';
import { log } from '../core/logger.js';
import type { MigrationStateMachine } from '../simulation/MigrationStateMachine.js';
import type { CheckpointSystem } from '../simulation/CheckpointSystem.js';

interface Snapshot {
  tasks: MigrationTask[];
  checkpoints: Array<[string, MigrationCheckpoint[]]>;
  savedAt: number;
}

const DEFAULT_PATH = path.resolve('data', 'state.json');

export class JsonStore {
  private saveTimer: NodeJS.Timeout | null = null;
  private pending = false;

  constructor(
    private readonly fsm: MigrationStateMachine,
    private readonly checkpoints: CheckpointSystem,
    private readonly filePath: string = DEFAULT_PATH,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as Snapshot;
      if (Array.isArray(data.tasks)) this.fsm.loadSnapshot(data.tasks);
      if (Array.isArray(data.checkpoints)) this.checkpoints.loadSnapshot(data.checkpoints);
      log.info('state.restored', { path: this.filePath, tasks: data.tasks?.length ?? 0 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('state.restore.failed', { error: String(err) });
      }
    }
  }

  /** Debounced save (200ms). */
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
    const data: Snapshot = {
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

  async shutdown(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.pending) await this.saveNow();
  }
}
