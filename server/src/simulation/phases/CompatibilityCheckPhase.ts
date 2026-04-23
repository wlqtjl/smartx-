/**
 * 阶段二：COMPATIBILITY_CHECK
 */
import type {
  CompatibilityCheck,
  CompatibilityReport,
  DiscoveredVM,
} from '@shared/index';
import { EventBus } from '../../core/EventBus.js';
import { delay } from '../../core/utils.js';

const checkOneVM = (vm: DiscoveredVM): CompatibilityCheck[] => {
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
};

export const buildReport = (checks: CompatibilityCheck[]): CompatibilityReport => {
  const blockers = checks.filter((c) => c.status === 'BLOCK');
  const warnings = checks.filter((c) => c.status === 'WARN');
  const overallStatus: CompatibilityReport['overallStatus'] =
    blockers.length > 0 ? 'BLOCK' : warnings.length > 0 ? 'WARN' : 'PASS';
  return { overallStatus, checks, blockers, warnings };
};

export class CompatibilityCheckPhase {
  async execute(vms: DiscoveredVM[]): Promise<CompatibilityReport> {
    const checks: CompatibilityCheck[] = [];
    for (const vm of vms) {
      checks.push(...checkOneVM(vm));
      EventBus.emit('fx:vm_scan_light', { vmId: vm.moRef, status: 'scanning' });
      // 小停顿让 UI 可以看到光效；总时间在测试中也控制在 1s 内。
      await delay(80);
    }
    const report = buildReport(checks);
    if (report.overallStatus === 'PASS') {
      EventBus.emit('achievement:clean_environment', {});
    }
    return report;
  }
}
