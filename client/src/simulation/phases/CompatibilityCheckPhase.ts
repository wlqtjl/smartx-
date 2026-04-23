/**
 * 阶段二：兼容性检测（COMPATIBILITY_CHECK）—— §3.2
 */
import { EventBus } from '../../core/EventBus';
import { delay } from '../../core/utils';
import type { DiscoveredVM } from './EnvScanPhase';

export type CheckCategory =
  | 'ESXI_VERSION'
  | 'VM_POWER_STATE'
  | 'SNAPSHOT_STATE'
  | 'DISK_TYPE'
  | 'GUEST_OS'
  | 'DRIVER_SUPPORT'
  | 'NETWORK_REACHABILITY'
  | 'STORAGE_CAPACITY';

export interface CompatibilityCheck {
  category: CheckCategory;
  item: string;
  status: 'PASS' | 'WARN' | 'BLOCK';
  detail: string;
  autoFixable: boolean;
  fixAction?: string;
}

export interface CompatibilityReport {
  overallStatus: 'PASS' | 'WARN' | 'BLOCK';
  checks: CompatibilityCheck[];
  blockers: CompatibilityCheck[];
  warnings: CompatibilityCheck[];
}

export const SAMPLE_CHECKS: CompatibilityCheck[] = [
  {
    category: 'ESXI_VERSION',
    item: 'ESXi 版本检测',
    status: 'PASS',
    detail: 'ESXi 7.0 U3 满足迁移要求（最低 ESXi 6.5）',
    autoFixable: false,
  },
  {
    category: 'SNAPSHOT_STATE',
    item: 'VM快照检测',
    status: 'WARN',
    detail: 'vm-db-01 存在3个快照链，迁移时间将增加约40%。建议迁移前合并快照',
    autoFixable: true,
    fixAction: '立即合并快照',
  },
  {
    category: 'DRIVER_SUPPORT',
    item: 'VMware VMXNET3 驱动',
    status: 'WARN',
    detail: '将自动替换为 VirtIO Net 驱动。Windows系统需重启生效',
    autoFixable: true,
    fixAction: 'SmartX 自动注入驱动',
  },
  {
    category: 'STORAGE_CAPACITY',
    item: '目标存储容量',
    status: 'BLOCK',
    detail: '所选存储池剩余空间 200GB，但VM磁盘需要 350GB。请选择更大容量的存储池',
    autoFixable: false,
  },
];

export class CompatibilityCheckPhase {
  async execute(vms: DiscoveredVM[]): Promise<CompatibilityReport> {
    const checks: CompatibilityCheck[] = [];
    for (const vm of vms) {
      checks.push(...this.checkVM(vm));
      EventBus.emit('fx:vm_scan_light', { vmId: vm.moRef, status: 'scanning' });
      await delay(200);
    }
    const report = this.buildReport(checks);
    if (report.overallStatus === 'PASS') {
      EventBus.emit('achievement:clean_environment');
    }
    return report;
  }

  private checkVM(vm: DiscoveredVM): CompatibilityCheck[] {
    const results: CompatibilityCheck[] = [];
    if (vm.snapshotExists) {
      results.push({
        category: 'SNAPSHOT_STATE',
        item: `${vm.name} 快照`,
        status: 'WARN',
        detail: '存在快照链，建议合并后迁移',
        autoFixable: true,
        fixAction: '合并快照',
      });
    }
    if (!vm.toolsRunning) {
      results.push({
        category: 'DRIVER_SUPPORT',
        item: `${vm.name} VMware Tools`,
        status: 'WARN',
        detail: 'VMware Tools未运行，驱动注入将使用离线模式',
        autoFixable: true,
        fixAction: '使用离线驱动注入',
      });
    }
    if (vm.nics.some((n) => n.adapterType !== 'vmxnet3')) {
      results.push({
        category: 'DRIVER_SUPPORT',
        item: `${vm.name} 旧版网卡`,
        status: 'WARN',
        detail: '检测到 E1000 网卡，将升级为 VirtIO Net（性能提升60%）',
        autoFixable: true,
        fixAction: '自动升级驱动',
      });
    }
    return results;
  }

  private buildReport(checks: CompatibilityCheck[]): CompatibilityReport {
    const blockers = checks.filter((c) => c.status === 'BLOCK');
    const warnings = checks.filter((c) => c.status === 'WARN');
    const overallStatus: CompatibilityReport['overallStatus'] =
      blockers.length > 0 ? 'BLOCK' : warnings.length > 0 ? 'WARN' : 'PASS';
    return { overallStatus, checks, blockers, warnings };
  }
}
