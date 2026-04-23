/**
 * 阶段四：存储映射（STORAGE_MAPPING）—— §3.4
 * 玩家拖拽 VM 到存储池；错误配置触发爆红警告。
 */
import { EventBus } from '../../core/EventBus';
import type { DiscoveredVM } from './EnvScanPhase';

export interface StorageMismatchWarning {
  type: 'PERFORMANCE_DOWNGRADE' | 'CAPACITY_INSUFFICIENT' | 'TIER_MISMATCH';
  message: string;
  suggestedAction: string;
}

export interface StorageMapping {
  sourceDatastore: string;
  sourceDiskType: 'thin' | 'thick_eager' | 'thick_lazy';
  targetPoolName: string;
  targetPoolTier: 'nvme' | 'ssd' | 'hdd';
  ioLocalityEnabled: boolean;
  rdmaEnabled: boolean;
  validated: boolean;
  warningMismatch: StorageMismatchWarning | null;
}

export interface StoragePool {
  id: string;
  name: string;
  tier: 'nvme' | 'ssd' | 'hdd';
  totalTB: number;
  availableTB: number;
  maxIOPS: number;
  avgLatencyMs: number;
  ioLocalitySupport: boolean;
  rdmaSupport: boolean;
  color: '#FFD700' | '#C0C0C0' | '#CD7F32';
}

export type VMWorkloadType =
  | 'DATABASE'
  | 'WEB_SERVER'
  | 'FILE_SERVER'
  | 'AD_DC'
  | 'BATCH_JOB'
  | 'REALTIME';

export interface StorageMappingRule {
  vmWorkloadType: VMWorkloadType;
  recommendedTier: 'nvme' | 'ssd' | 'hdd';
  reason: string;
}

export const STORAGE_MAPPING_RULES: StorageMappingRule[] = [
  {
    vmWorkloadType: 'DATABASE',
    recommendedTier: 'nvme',
    reason: '数据库对IOPS和延迟极度敏感，NVMe可提供微秒级响应',
  },
  {
    vmWorkloadType: 'REALTIME',
    recommendedTier: 'nvme',
    reason: '实时计算需要RDMA零拷贝，必须选NVMe池',
  },
  {
    vmWorkloadType: 'WEB_SERVER',
    recommendedTier: 'ssd',
    reason: 'Web服务器读多写少，SSD性价比最优',
  },
  {
    vmWorkloadType: 'AD_DC',
    recommendedTier: 'ssd',
    reason: '域控对延迟敏感，SSD 已足够',
  },
  {
    vmWorkloadType: 'FILE_SERVER',
    recommendedTier: 'hdd',
    reason: '文件服务器大容量需求，HDD成本最低',
  },
  {
    vmWorkloadType: 'BATCH_JOB',
    recommendedTier: 'hdd',
    reason: '批处理吞吐优先，HDD 够用',
  },
];

export const checkStorageMismatch = (
  vm: DiscoveredVM & { workloadType: VMWorkloadType },
  pool: StoragePool,
): StorageMismatchWarning | null => {
  const rule = STORAGE_MAPPING_RULES.find((r) => r.vmWorkloadType === vm.workloadType);
  if (!rule) return null;

  const tierOrder = { nvme: 3, ssd: 2, hdd: 1 } as const;
  if (tierOrder[pool.tier] < tierOrder[rule.recommendedTier]) {
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

  // 容量不足
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
  private completed: Map<string, StorageMapping> = new Map();

  constructor(readonly pools: StoragePool[]) {}

  /** 玩家将 VM 放到某个池；返回警告或成功映射 */
  assign(
    vm: DiscoveredVM & { workloadType: VMWorkloadType },
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
