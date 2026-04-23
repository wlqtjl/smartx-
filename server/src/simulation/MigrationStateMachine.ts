/**
 * 服务端权威 MigrationStateMachine。
 * 合法转换表与客户端完全对齐；REST / WebSocket 依赖本实现执行转换并广播事件。
 */
import type {
  DriverInjectionStatus,
  MigrationError,
  MigrationState,
  MigrationTask,
  MigrationTimelineEntry,
} from '@shared/index';
import { EventBus } from '../core/EventBus.js';
import { secureId } from '../core/utils.js';

const TRANSITIONS: Record<MigrationState, MigrationState[]> = {
  IDLE: ['ENV_SCAN'],
  ENV_SCAN: ['COMPATIBILITY_CHECK', 'FAILED'],
  COMPATIBILITY_CHECK: ['NETWORK_MAPPING', 'FAILED'],
  NETWORK_MAPPING: ['STORAGE_MAPPING'],
  STORAGE_MAPPING: ['PRE_SNAPSHOT'],
  PRE_SNAPSHOT: ['FULL_SYNC'],
  FULL_SYNC: ['INCREMENTAL_SYNC', 'PAUSED_NETWORK_FAULT', 'PAUSED_STORAGE_FAULT'],
  INCREMENTAL_SYNC: ['DRIVER_INJECTION', 'PAUSED_NETWORK_FAULT'],
  DRIVER_INJECTION: ['CUTOVER_READY', 'FAILED'],
  CUTOVER_READY: ['CUTOVER_EXECUTING'],
  CUTOVER_EXECUTING: ['POST_CHECK', 'FAILED'],
  POST_CHECK: ['COMPLETED', 'FAILED'],
  PAUSED_NETWORK_FAULT: ['RESUMING', 'FAILED'],
  PAUSED_STORAGE_FAULT: ['RESUMING', 'FAILED'],
  RESUMING: ['FULL_SYNC', 'INCREMENTAL_SYNC'],
  COMPLETED: [],
  FAILED: [],
};

export class IllegalTransitionError extends Error {
  constructor(public readonly from: MigrationState, public readonly to: MigrationState) {
    super(`非法状态转换: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`未知任务: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

const initialDriverStatus = (): DriverInjectionStatus => ({
  phase: 'PENDING',
  guestOS: 'windows_server_2019',
  detectedDrivers: [],
  injectedDrivers: [],
  autoInjected: true,
});

export class MigrationStateMachine {
  private tasks = new Map<string, MigrationTask>();

  static canTransition(from: MigrationState, to: MigrationState): boolean {
    return TRANSITIONS[from].includes(to);
  }

  createTask(
    vmId: string,
    vmName: string,
    dataTotalGB: number,
    ownerSession?: string,
  ): MigrationTask {
    const task: MigrationTask = {
      id: secureId('task-'),
      vmId,
      vmName,
      state: 'IDLE',
      progress: {
        fullSyncPercent: 0,
        incrementalRounds: 0,
        dataTotalGB,
        dataTransferredGB: 0,
        transferSpeedMbps: 0,
        etaSeconds: 0,
      },
      networkMapping: null,
      storageMapping: null,
      driverStatus: initialDriverStatus(),
      checkpointOffset: 0,
      errors: [],
      timeline: [],
      agentless: true,
      ownerSession,
    };
    this.tasks.set(task.id, task);
    EventBus.emit('migration:created', { task });
    return task;
  }

  getTask(taskId: string): MigrationTask | undefined {
    return this.tasks.get(taskId);
  }

  requireTask(taskId: string): MigrationTask {
    const t = this.tasks.get(taskId);
    if (!t) throw new TaskNotFoundError(taskId);
    return t;
  }

  allTasks(): MigrationTask[] {
    return Array.from(this.tasks.values());
  }

  deleteTask(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }

  /** 替换内部任务列表（持久化层恢复用）。 */
  loadSnapshot(tasks: MigrationTask[]): void {
    this.tasks.clear();
    for (const t of tasks) this.tasks.set(t.id, t);
  }

  transition(
    taskId: string,
    newState: MigrationState,
    payload?: Partial<MigrationTask>,
    operator: 'player' | 'system' = 'player',
    note?: string,
  ): MigrationTask {
    const task = this.requireTask(taskId);
    if (!MigrationStateMachine.canTransition(task.state, newState)) {
      throw new IllegalTransitionError(task.state, newState);
    }
    const prev = task.state;
    Object.assign(task, payload ?? {}, { state: newState });

    const entry: MigrationTimelineEntry = {
      fromState: prev,
      toState: newState,
      timestamp: Date.now(),
      operator,
      note,
    };
    task.timeline.push(entry);
    EventBus.emit('migration:stateChange', { taskId, prev, next: newState, task });
    return task;
  }

  recordError(taskId: string, code: string, message: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const err: MigrationError = { code, message, timestamp: Date.now() };
    task.errors.push(err);
    EventBus.emit('migration:error', { taskId, code, message });
  }
}
