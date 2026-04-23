/**
 * 阶段六：VirtIO 驱动注入（DRIVER_INJECTION）—— §3.6
 * SmartX 差异点：全自动、无代理。
 */
import { EventBus } from '../../core/EventBus';
import { delay } from '../../core/utils';
import type {
  DriverInjectionStatus,
  GuestOSType,
  MigrationTask,
} from '../MigrationStateMachine';

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
  {
    order: 1,
    action: '挂载目标虚拟机磁盘（只读）',
    techDetail: 'SmartX以NBD协议挂载源VM的VMDK，无需开机',
    durationMs: 800,
    status: 'pending',
  },
  {
    order: 2,
    action: '扫描 Windows 注册表驱动列表',
    techDetail:
      '解析 HKLM\\SYSTEM\\CurrentControlSet\\Services，识别 VMware SVGA/VMXNET3/pvscsi 等驱动',
    durationMs: 1200,
    status: 'pending',
  },
  {
    order: 3,
    action: '注入 VirtIO 磁盘驱动（vioscsi）',
    techDetail:
      '替换 vmw_pvscsi → vioscsi，确保系统能从 VirtIO 磁盘启动。这是防止"蓝屏"的关键步骤',
    durationMs: 2000,
    status: 'pending',
  },
  {
    order: 4,
    action: '注入 VirtIO 网卡驱动（netkvm）',
    techDetail: '替换 VMware VMXNET3 → VirtIO Net（netkvm），网络性能提升约60%',
    durationMs: 1500,
    status: 'pending',
  },
  {
    order: 5,
    action: '注入 QEMU Guest Agent',
    techDetail: '替代 VMware Tools，提供内存气球、快照通知等管理能力',
    durationMs: 1000,
    status: 'pending',
  },
  {
    order: 6,
    action: '调整 BCD 启动配置',
    techDetail:
      '修改 Windows Boot Configuration Data，设置正确的存储控制器驱动加载顺序',
    durationMs: 600,
    status: 'pending',
  },
  {
    order: 7,
    action: '驱动完整性验证',
    techDetail: '校验注入的驱动签名和版本，确保与目标OS版本匹配',
    durationMs: 500,
    status: 'pending',
  },
];

export const LINUX_INJECTION_PLAN: DriverInjectionStep[] = [
  {
    order: 1,
    action: '挂载磁盘并解析 /etc/fstab',
    techDetail: 'chroot 到源 VM 根文件系统',
    durationMs: 600,
    status: 'pending',
  },
  {
    order: 2,
    action: '重建 initramfs 以包含 virtio_blk/virtio_net',
    techDetail: 'dracut / mkinitramfs 重新打包启动镜像',
    durationMs: 2500,
    status: 'pending',
  },
  {
    order: 3,
    action: '更新 GRUB 配置',
    techDetail: '调整 root= 设备路径及内核参数',
    durationMs: 500,
    status: 'pending',
  },
  {
    order: 4,
    action: '安装 qemu-guest-agent 包（离线）',
    techDetail: 'SmartX 自带离线包，无需联网',
    durationMs: 900,
    status: 'pending',
  },
];

export const INJECTION_FAILURE_SCENARIOS = [
  {
    trigger: 'vmscsi_still_loaded',
    description: '启动失败 - 检测到旧版 VMware 磁盘驱动残留',
    solution: 'SmartX 自动回滚并重试：清除注册表残留项后重新注入',
    vmResult: 'BSOD' as const,
    autoRecover: true,
  },
  {
    trigger: 'missing_virtio_nic',
    description: '虚拟机启动后网卡消失（驱动未正确加载）',
    solution: '启动修复模式，在线安装VirtIO Net驱动',
    vmResult: 'NO_NETWORK' as const,
    autoRecover: true,
  },
];

export class DriverInjectionPhase {
  planFor(guestOS: GuestOSType, vmId: string): DriverInjectionPlan {
    const steps = guestOS.startsWith('windows_')
      ? [...WINDOWS_INJECTION_PLAN]
      : [...LINUX_INJECTION_PLAN];
    const estimatedDurationSeconds = Math.round(
      steps.reduce((s, x) => s + x.durationMs, 0) / 1000,
    );
    return {
      vmId,
      guestOS,
      steps: steps.map((s) => ({ ...s })),
      estimatedDurationSeconds,
      riskLevel: 'LOW',
    };
  }

  async execute(task: MigrationTask, plan: DriverInjectionPlan): Promise<DriverInjectionStatus> {
    task.driverStatus.phase = 'INJECTING';
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
