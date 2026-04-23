/**
 * 断点续传系统 —— 服务端权威保存点。
 */
import type { MigrationCheckpoint, MigrationTask } from '@shared/index';
import { EventBus } from '../core/EventBus.js';

const BLOCK_SIZE_BYTES = 4 * 1024 * 1024; // 4MB
const BLOCK_SIZE_MB = 4;
const EXPECTED_TRANSFER_SPEED_MBPS = 800;
const MAX_HISTORY = 5;

export class CheckpointSystem {
  private history = new Map<string, MigrationCheckpoint[]>();

  saveCheckpoint(task: MigrationTask): MigrationCheckpoint {
    const totalBlocks = Math.ceil((task.progress.dataTotalGB * 1024 ** 3) / BLOCK_SIZE_BYTES);
    const completedBlocks = Math.floor(
      (task.progress.dataTransferredGB * 1024 ** 3) / BLOCK_SIZE_BYTES,
    );
    const checkpoint: MigrationCheckpoint = {
      taskId: task.id,
      vmId: task.vmId,
      timestamp: Date.now(),
      lastCompletedBlockOffset: completedBlocks * BLOCK_SIZE_BYTES,
      transferredBlocks: Array.from({ length: completedBlocks }, (_, i) => i),
      totalBlocks,
      networkMetricsAtFailure: { packetLoss: 0, jitterMs: 0, failureReason: '' },
      cachedVMMetadata: null,
      networkMappingSnapshot: task.networkMapping,
      storageMappingSnapshot: task.storageMapping,
    };
    const list = this.history.get(task.id) ?? [];
    list.push(checkpoint);
    this.history.set(task.id, list.slice(-MAX_HISTORY));
    task.checkpointOffset = checkpoint.lastCompletedBlockOffset;
    EventBus.emit('checkpoint:save', checkpoint);
    return checkpoint;
  }

  getHistory(taskId: string): MigrationCheckpoint[] {
    return this.history.get(taskId) ?? [];
  }

  getLatest(taskId: string): MigrationCheckpoint | null {
    const list = this.history.get(taskId);
    return list && list.length > 0 ? list[list.length - 1] : null;
  }

  calculateTimeSaved(cp: MigrationCheckpoint): {
    savedPercent: number;
    savedMinutes: number;
    vmwareWouldRestartFrom: string;
  } {
    const progress =
      cp.totalBlocks === 0 ? 0 : cp.transferredBlocks.length / cp.totalBlocks;
    const totalEstimatedMinutes =
      ((cp.totalBlocks * BLOCK_SIZE_MB) / 1024 / EXPECTED_TRANSFER_SPEED_MBPS) * 60;
    return {
      savedPercent: Math.round(progress * 100),
      savedMinutes: Math.round(progress * totalEstimatedMinutes),
      vmwareWouldRestartFrom: '0%',
    };
  }

  /** Replace all history when reloading from persistence. */
  loadSnapshot(entries: Array<[string, MigrationCheckpoint[]]>): void {
    this.history.clear();
    for (const [k, v] of entries) this.history.set(k, v.slice(-MAX_HISTORY));
  }

  snapshot(): Array<[string, MigrationCheckpoint[]]> {
    return Array.from(this.history.entries());
  }
}
