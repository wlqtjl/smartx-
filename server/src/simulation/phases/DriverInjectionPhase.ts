/**
 * 阶段六：DRIVER_INJECTION
 */
import type { DriverInjectionStatus, GuestOSType, MigrationTask } from '@shared/index';
import { EventBus } from '../../core/EventBus.js';
import { delay } from '../../core/utils.js';

export interface DriverInjectionStep {
  order: number;
  action: string;
  techDetail: string;
  durationMs: number;
  status: 'pending' | 'running' | 'done' | 'failed';
}

export interface DriverInjectionPlan {
  vmId: string;
  guestOS: GuestOSType;
  steps: DriverInjectionStep[];
  estimatedDurationSeconds: number;
  riskLevel: 'LOW' | 'MEDIUM';
}

export const WINDOWS_INJECTION_PLAN: DriverInjectionStep[] = [
  { order: 1, action: '挂载目标虚拟机磁盘（只读）', techDetail: 'NBD 挂载 VMDK，无需开机', durationMs: 300, status: 'pending' },
  { order: 2, action: '扫描 Windows 注册表驱动列表', techDetail: '解析 HKLM\\SYSTEM\\CurrentControlSet\\Services', durationMs: 300, status: 'pending' },
  { order: 3, action: '注入 VirtIO 磁盘驱动 vioscsi', techDetail: '替换 vmw_pvscsi → vioscsi', durationMs: 400, status: 'pending' },
  { order: 4, action: '注入 VirtIO 网卡驱动 netkvm', techDetail: '替换 VMware VMXNET3 → VirtIO Net', durationMs: 400, status: 'pending' },
  { order: 5, action: '注入 QEMU Guest Agent', techDetail: '替代 VMware Tools', durationMs: 300, status: 'pending' },
  { order: 6, action: '调整 BCD 启动配置', techDetail: '修改 Boot Configuration Data', durationMs: 200, status: 'pending' },
  { order: 7, action: '驱动完整性验证', techDetail: '校验签名与版本', durationMs: 200, status: 'pending' },
];

export const LINUX_INJECTION_PLAN: DriverInjectionStep[] = [
  { order: 1, action: '挂载磁盘并解析 /etc/fstab', techDetail: 'chroot 到源 VM 根文件系统', durationMs: 200, status: 'pending' },
  { order: 2, action: '重建 initramfs 包含 virtio_blk/virtio_net', techDetail: 'dracut / mkinitramfs', durationMs: 600, status: 'pending' },
  { order: 3, action: '更新 GRUB 配置', techDetail: '调整 root= 设备路径', durationMs: 200, status: 'pending' },
  { order: 4, action: '安装 qemu-guest-agent 离线包', techDetail: 'SmartX 自带离线包', durationMs: 300, status: 'pending' },
];

export class DriverInjectionPhase {
  planFor(guestOS: GuestOSType, vmId: string): DriverInjectionPlan {
    const base = guestOS.startsWith('windows_') ? WINDOWS_INJECTION_PLAN : LINUX_INJECTION_PLAN;
    const steps = base.map((s) => ({ ...s }));
    return {
      vmId,
      guestOS,
      steps,
      estimatedDurationSeconds: Math.round(steps.reduce((s, x) => s + x.durationMs, 0) / 1000),
      riskLevel: 'LOW',
    };
  }

  async execute(task: MigrationTask, plan: DriverInjectionPlan): Promise<DriverInjectionStatus> {
    task.driverStatus.phase = 'INJECTING';
    task.driverStatus.guestOS = plan.guestOS;
    for (const step of plan.steps) {
      step.status = 'running';
      EventBus.emit('ui:injection_step', { taskId: task.id, step });
      await delay(step.durationMs);
      step.status = 'done';
      EventBus.emit('ui:injection_step', { taskId: task.id, step });
    }
    task.driverStatus.phase = 'COMPLETED';
    task.driverStatus.autoInjected = true;
    task.driverStatus.injectedDrivers = [
      { name: 'vioscsi', version: '100.93.104', status: 'success' },
      { name: 'netkvm', version: '100.93.104', status: 'success' },
      { name: 'qemu-guest-agent', version: '7.0.0', status: 'success' },
    ];
    EventBus.emit('migration:driversReady', { taskId: task.id });
    return task.driverStatus;
  }
}
