/**
 * SmartX V2V 迁移完整生命周期状态机 —— 对应主架构文档 §2。
 */
import { EventBus } from '../core/EventBus';
import type { NetworkMapping } from './phases/NetworkMappingPhase';
import type { StorageMapping, StorageMismatchWarning } from './phases/StorageMappingPhase';

export type MigrationState =
  | 'IDLE'
  | 'ENV_SCAN'
  | 'COMPATIBILITY_CHECK'
  | 'NETWORK_MAPPING'
  | 'STORAGE_MAPPING'
  | 'PRE_SNAPSHOT'
  | 'FULL_SYNC'
  | 'INCREMENTAL_SYNC'
  | 'DRIVER_INJECTION'
  | 'CUTOVER_READY'
  | 'CUTOVER_EXECUTING'
  | 'POST_CHECK'
  | 'COMPLETED'
  | 'FAILED'
  | 'PAUSED_NETWORK_FAULT'
  | 'PAUSED_STORAGE_FAULT'
  | 'RESUMING';

export type GuestOSType =
  | 'windows_server_2019'
  | 'windows_server_2022'
  | 'windows_10'
  | 'windows_11'
  | 'rhel_7'
  | 'rhel_8'
  | 'rhel_9'
  | 'centos_7'
  | 'ubuntu_20'
  | 'ubuntu_22'
  | 'debian_11';

export interface DetectedDriver {
  name: string;
  vendor: 'vmware';
  replacedBy: string;
}

export interface InjectedDriver {
  name: string;
  version: string;
  status: 'success' | 'pending' | 'failed';
}

export interface DriverInjectionStatus {
  phase: 'PENDING' | 'INJECTING' | 'COMPLETED' | 'FAILED';
  guestOS: GuestOSType;
  detectedDrivers: DetectedDriver[];
  injectedDrivers: InjectedDriver[];
  autoInjected: boolean;
}

export interface MigrationError {
  code: string;
  message: string;
  timestamp: number;
}

export interface MigrationTimelineEntry {
  fromState: MigrationState;
  toState: MigrationState;
  timestamp: number;
  operator: 'player' | 'system';
  note?: string;
}

export interface MigrationTask {
  id: string;
  vmId: string;
  vmName: string;
  state: MigrationState;
  progress: {
    fullSyncPercent: number;
    incrementalRounds: number;
    dataTotalGB: number;
    dataTransferredGB: number;
    transferSpeedMbps: number;
    etaSeconds: number;
  };
  networkMapping: NetworkMapping | null;
  storageMapping: StorageMapping | null;
  driverStatus: DriverInjectionStatus;
  checkpointOffset: number;
  errors: MigrationError[];
  timeline: MigrationTimelineEntry[];
  agentless: true;
  storageWarning?: StorageMismatchWarning | null;
}

export class MigrationStateMachine {
  private tasks: Map<string, MigrationTask> = new Map();

  /** 合法状态迁移表 —— 与 §2.2 完全一致 */
  private readonly TRANSITIONS: Record<MigrationState, MigrationState[]> = {
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

  createTask(vmId: string, vmName: string, dataTotalGB: number): MigrationTask {
    const task: MigrationTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
      driverStatus: {
        phase: 'PENDING',
        guestOS: 'windows_server_2019',
        detectedDrivers: [],
        injectedDrivers: [],
        autoInjected: true,
      },
      checkpointOffset: 0,
      errors: [],
      timeline: [],
      agentless: true,
    };
    this.tasks.set(task.id, task);
    EventBus.emit('migration:created', { task });
    return task;
  }

  getTask(taskId: string): MigrationTask | undefined {
    return this.tasks.get(taskId);
  }

  allTasks(): MigrationTask[] {
    return Array.from(this.tasks.values());
  }

  canTransition(current: MigrationState, next: MigrationState): boolean {
    return this.TRANSITIONS[current].includes(next);
  }

  transition(
    taskId: string,
    newState: MigrationState,
    payload?: Partial<MigrationTask>,
    operator: 'player' | 'system' = 'player',
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);

    const allowed = this.TRANSITIONS[task.state];
    if (!allowed.includes(newState)) {
      throw new Error(`非法状态转换: ${task.state} → ${newState}`);
    }
    const prev = task.state;
    Object.assign(task, payload ?? {}, { state: newState });
    this.tasks.set(taskId, task);

    task.timeline.push({
      fromState: prev,
      toState: newState,
      timestamp: Date.now(),
      operator,
    });

    EventBus.emit('migration:stateChange', { taskId, prev, next: newState, task });
  }

  recordError(taskId: string, code: string, message: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.errors.push({ code, message, timestamp: Date.now() });
    EventBus.emit('migration:error', { taskId, code, message });
  }
}
