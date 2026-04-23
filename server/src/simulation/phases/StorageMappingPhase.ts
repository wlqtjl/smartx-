/**
 * 阶段四：STORAGE_MAPPING —— 工作负载 ↔ 存储池匹配规则。
 */
import type {
  DiscoveredVM,
  StorageMapping,
  StorageMismatchWarning,
  StoragePool,
  VMWorkloadType,
} from '@shared/index';
import { EventBus } from '../../core/EventBus.js';

export interface StorageMappingRule {
  vmWorkloadType: VMWorkloadType;
  recommendedTier: 'nvme' | 'ssd' | 'hdd';
  reason: string;
}

export const STORAGE_MAPPING_RULES: StorageMappingRule[] = [
  { vmWorkloadType: 'DATABASE', recommendedTier: 'nvme', reason: '数据库对IOPS和延迟极度敏感，NVMe可提供微秒级响应' },
  { vmWorkloadType: 'REALTIME', recommendedTier: 'nvme', reason: '实时计算需要RDMA零拷贝，必须选NVMe池' },
  { vmWorkloadType: 'WEB_SERVER', recommendedTier: 'ssd', reason: 'Web服务器读多写少，SSD性价比最优' },
  { vmWorkloadType: 'AD_DC', recommendedTier: 'ssd', reason: '域控对延迟敏感，SSD 已足够' },
  { vmWorkloadType: 'FILE_SERVER', recommendedTier: 'hdd', reason: '文件服务器大容量需求，HDD成本最低' },
  { vmWorkloadType: 'BATCH_JOB', recommendedTier: 'hdd', reason: '批处理吞吐优先，HDD 够用' },
];

export const STORAGE_TIER_PRIORITY = { nvme: 3, ssd: 2, hdd: 1 } as const;

export type WorkloadVM = DiscoveredVM & { workloadType: VMWorkloadType };

export const checkStorageMismatch = (
  vm: WorkloadVM,
  pool: StoragePool,
): StorageMismatchWarning | null => {
  const rule = STORAGE_MAPPING_RULES.find((r) => r.vmWorkloadType === vm.workloadType);
  if (!rule) return null;

  if (STORAGE_TIER_PRIORITY[pool.tier] < STORAGE_TIER_PRIORITY[rule.recommendedTier]) {
    if (vm.workloadType === 'DATABASE' && pool.tier === 'hdd') {
      return {
        type: 'PERFORMANCE_DOWNGRADE',
        message: `⚠️ 严重警告：${vm.name} 为数据库工作负载，放置到HDD池将导致IOPS降低90%，延迟从<1ms增至15ms+！`,
        suggestedAction: '立即迁移至NVMe存储池',
      };
    }
    return {
      type: 'TIER_MISMATCH',
      message: `性能等级不匹配：建议使用 ${rule.recommendedTier.toUpperCase()} 池。${rule.reason}`,
      suggestedAction: `切换到 ${rule.recommendedTier.toUpperCase()} 存储池`,
    };
  }

  const requiredGB = vm.disks.reduce((s, d) => s + d.capacityGB, 0);
  if (requiredGB / 1024 > pool.availableTB) {
    return {
      type: 'CAPACITY_INSUFFICIENT',
      message: `容量不足：${vm.name} 需要 ${requiredGB}GB，但 ${pool.name} 剩余 ${(pool.availableTB * 1024).toFixed(0)}GB`,
      suggestedAction: '选择容量更大的存储池或清理空间',
    };
  }
  return null;
};

export class StorageMappingPhase {
  private completed = new Map<string, StorageMapping>();

  constructor(readonly pools: StoragePool[]) {}

  assign(
    vm: WorkloadVM,
    poolId: string,
    options: { ioLocality?: boolean; rdma?: boolean } = {},
  ): { mapping: StorageMapping; warning: StorageMismatchWarning | null } {
    const pool = this.pools.find((p) => p.id === poolId);
    if (!pool) throw new Error(`未知存储池: ${poolId}`);

    const warning = checkStorageMismatch(vm, pool);
    const mapping: StorageMapping = {
      sourceDatastore: vm.disks[0]?.datastoreName ?? 'unknown',
      sourceDiskType: vm.disks[0]?.provisionType ?? 'thin',
      targetPoolName: pool.name,
      targetPoolTier: pool.tier,
      ioLocalityEnabled: options.ioLocality ?? pool.ioLocalitySupport,
      rdmaEnabled: options.rdma ?? pool.rdmaSupport,
      validated: warning === null || warning.type !== 'PERFORMANCE_DOWNGRADE',
      warningMismatch: warning,
    };
    this.completed.set(vm.moRef, mapping);

    if (warning) {
      EventBus.emit('fx:storage_mismatch_flash', { vmId: vm.moRef, severity: warning.type });
      EventBus.emit('ui:show_storage_warning', { vm, pool, warning });
    }
    return { mapping, warning };
  }

  getMapping(vmId: string): StorageMapping | undefined {
    return this.completed.get(vmId);
  }
}
