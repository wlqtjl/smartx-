/**
 * 工具装备系统 —— 对应主架构文档 §1.2。
 * 取代 CS 武器系统：6 种工具 + 主/副动作 + 冷却。
 */
import { EventBus } from '../core/EventBus';
import { delay } from '../core/utils';
import { UIManager } from '../ui/UIManager';
import type { VCenterCredential } from '../core/credential';
import type { ESXiScanResult } from '../simulation/phases/EnvScanPhase';
import { MockDataGenerator } from '../mock/MockDataGenerator';

export type ToolType =
  | 'SMART_PROBE'
  | 'FIBER_PATCHER'
  | 'DIAGNOSTIC_TABLET'
  | 'RECOVERY_KIT'
  | 'BANDWIDTH_LIMITER'
  | 'SNAPSHOT_GUN';

export interface ToolAnimationSet {
  idle: string;
  draw: string;
  holster: string;
  primaryFire: string;
  reload: string;
}

export interface Tool {
  type: ToolType;
  name: string;
  description: string;
  primaryAction: string;
  secondaryAction: string;
  cooldownMs: number;
  currentCooldown: number;
  model3DPath: string;
  animationSet: ToolAnimationSet;
}

export interface NetworkPort {
  id: string;
  label: string;
  rackId: string;
}

export interface ScanResult extends ESXiScanResult {
  triggeredBy: ToolType;
}

export const TOOL_SLOTS: Record<number, ToolType> = {
  1: 'SMART_PROBE',
  2: 'FIBER_PATCHER',
  3: 'DIAGNOSTIC_TABLET',
  4: 'RECOVERY_KIT',
  5: 'BANDWIDTH_LIMITER',
  6: 'SNAPSHOT_GUN',
};

const ANIM = (prefix: string): ToolAnimationSet => ({
  idle: `${prefix}_idle`,
  draw: `${prefix}_draw`,
  holster: `${prefix}_holster`,
  primaryFire: `${prefix}_fire`,
  reload: `${prefix}_reload`,
});

export const TOOL_CATALOG: Record<ToolType, Tool> = {
  SMART_PROBE: {
    type: 'SMART_PROBE',
    name: '智能采集跳线',
    description: '插入 ESXi 主机网口，扫描 VMware 环境',
    primaryAction: '插线扫描',
    secondaryAction: '查看握手日志',
    cooldownMs: 1500,
    currentCooldown: 0,
    model3DPath: '/models/tools/smart_probe.glb',
    animationSet: ANIM('smart_probe'),
  },
  FIBER_PATCHER: {
    type: 'FIBER_PATCHER',
    name: '光纤跳线工具',
    description: '从 vSwitch 拖拽到 SmartX Bridge 完成网络映射',
    primaryAction: '起/落线',
    secondaryAction: '取消本次连线',
    cooldownMs: 300,
    currentCooldown: 0,
    model3DPath: '/models/tools/fiber_patcher.glb',
    animationSet: ANIM('fiber_patcher'),
  },
  DIAGNOSTIC_TABLET: {
    type: 'DIAGNOSTIC_TABLET',
    name: '诊断平板',
    description: '查看 VM 详情与实时指标',
    primaryAction: '打开面板',
    secondaryAction: '截图记录',
    cooldownMs: 200,
    currentCooldown: 0,
    model3DPath: '/models/tools/tablet.glb',
    animationSet: ANIM('tablet'),
  },
  RECOVERY_KIT: {
    type: 'RECOVERY_KIT',
    name: '断点恢复工具包',
    description: '处理迁移中断，触发断点续传',
    primaryAction: '续传',
    secondaryAction: '查看断点历史',
    cooldownMs: 1000,
    currentCooldown: 0,
    model3DPath: '/models/tools/recovery_kit.glb',
    animationSet: ANIM('recovery_kit'),
  },
  BANDWIDTH_LIMITER: {
    type: 'BANDWIDTH_LIMITER',
    name: '带宽调速器',
    description: '控制迁移占用带宽，保障生产业务',
    primaryAction: '调速',
    secondaryAction: '查看 QoS 曲线',
    cooldownMs: 300,
    currentCooldown: 0,
    model3DPath: '/models/tools/bandwidth.glb',
    animationSet: ANIM('bandwidth'),
  },
  SNAPSHOT_GUN: {
    type: 'SNAPSHOT_GUN',
    name: '快照枪',
    description: '为 VM 创建迁移前快照',
    primaryAction: '打快照',
    secondaryAction: '查看快照链',
    cooldownMs: 1200,
    currentCooldown: 0,
    model3DPath: '/models/tools/snapshot_gun.glb',
    animationSet: ANIM('snapshot_gun'),
  },
};

export class ToolSystem {
  private equipped: Tool | null = null;

  equip(type: ToolType): void {
    const next = { ...TOOL_CATALOG[type], currentCooldown: 0 };
    if (this.equipped?.type === type) return;
    const prev = this.equipped;
    this.equipped = next;
    EventBus.emit('tool:switch', { prev: prev?.type ?? null, next: type });
  }

  equipBySlot(slot: number): void {
    const type = TOOL_SLOTS[slot];
    if (type) this.equip(type);
  }

  get current(): Tool | null {
    return this.equipped;
  }

  /** 推进冷却时间；由渲染循环调用 */
  tick(dt: number): void {
    if (this.equipped && this.equipped.currentCooldown > 0) {
      this.equipped.currentCooldown = Math.max(0, this.equipped.currentCooldown - dt * 1000);
    }
  }

  private async playAnimation(key: keyof ToolAnimationSet, durationMs: number): Promise<void> {
    if (!this.equipped) return;
    const animName = this.equipped.animationSet[key];
    EventBus.emit('tool:anim', { tool: this.equipped.type, anim: animName });
    await delay(durationMs);
  }

  private async simulateNetworkHandshake(port: NetworkPort): Promise<void> {
    EventBus.emit('tool:handshake', { port });
    await delay(500);
  }

  private async scanESXiEnvironment(cred: VCenterCredential): Promise<ScanResult> {
    const env = await MockDataGenerator.generateESXiEnvironment(cred);
    return { ...env, triggeredBy: 'SMART_PROBE' };
  }

  /** 智能探针插入网口（E 键交互后自动调用） */
  async activateSmartProbe(targetPort: NetworkPort): Promise<ScanResult> {
    if (this.equipped?.type !== 'SMART_PROBE') {
      throw new Error('需要装备智能采集跳线（SMART_PROBE）');
    }
    if (this.equipped.currentCooldown > 0) {
      throw new Error('工具冷却中');
    }
    this.equipped.currentCooldown = this.equipped.cooldownMs;

    await this.playAnimation('primaryFire', 800);
    await this.simulateNetworkHandshake(targetPort);
    const credential = await UIManager.showVCenterLoginPanel();
    return this.scanESXiEnvironment(credential);
  }
}
