/**
 * UIManager —— 迁移流程与 UI 层的异步桥接。
 *
 * 每个 `show*` 方法弹出对应的 React 面板并返回 Promise；React 面板
 * 通过 `submit*` / `cancel*` 解决 Promise，由此把"玩家在 UI 上的操作"
 * 转换成迁移流水线的下一步输入。
 */
import type { VCenterCredential } from '../core/credential';
import type { ESXiScanResult, DiscoveredVM } from '../simulation/phases/EnvScanPhase';
import type {
  VSwitchNode,
  BridgeNode,
  NetworkMapping,
} from '../simulation/phases/NetworkMappingPhase';
import type {
  StoragePool,
  StorageMapping,
  VMWorkloadType,
  StorageMismatchWarning,
} from '../simulation/phases/StorageMappingPhase';
import type { SyncChallenge, ChallengeResponse } from '../simulation/phases/DataSyncPhase';
import type { ScoreBreakdown } from '../engine/ScoringSystem';
import { EventBus } from '../core/EventBus';
import { uiStore } from './uiStore';

type Resolver<T> = (value: T) => void;

export interface NetworkMappingSubmission {
  mappings: NetworkMapping[];
}

export interface StorageSubmission {
  poolId: string;
  ioLocality: boolean;
  rdma: boolean;
}

class UIManagerImpl {
  private pendingLogin: Resolver<VCenterCredential> | null = null;
  private pendingCompat: Resolver<void> | null = null;
  private pendingEnvAck: Resolver<void> | null = null;
  private pendingNetwork: Resolver<NetworkMappingSubmission> | null = null;
  private pendingStorage: Resolver<StorageSubmission> | null = null;
  private pendingChallenge: Resolver<ChallengeResponse> | null = null;
  private pendingChoice: Resolver<string> | null = null;

  /** vCenter 登录面板：返回玩家输入凭据 */
  showVCenterLoginPanel(defaultHost = '10.0.0.1'): Promise<VCenterCredential> {
    EventBus.emit('ui:open_vcenter_login', { defaultHost });
    uiStore.openLogin(defaultHost);
    return new Promise((resolve) => {
      this.pendingLogin = resolve;
    });
  }
  submitVCenterLogin(cred: VCenterCredential): void {
    const r = this.pendingLogin;
    this.pendingLogin = null;
    uiStore.closeLogin();
    r?.(cred);
  }

  /** 扫描结果面板：展示后等待玩家点击 "下一步" */
  showScanResultsPanel(result: ESXiScanResult): Promise<void> {
    uiStore.openEnvResult(result);
    return new Promise((resolve) => {
      this.pendingEnvAck = resolve;
    });
  }
  acknowledgeScanResults(): void {
    const r = this.pendingEnvAck;
    this.pendingEnvAck = null;
    uiStore.closeEnvResult();
    r?.();
  }

  /** 兼容性报告面板 */
  showCompatibilityReport(
    vms: DiscoveredVM[],
    issues: { vmName: string; severity: 'warn' | 'error'; message: string }[],
  ): Promise<void> {
    uiStore.openCompat(vms, issues);
    return new Promise((resolve) => {
      this.pendingCompat = resolve;
    });
  }
  acknowledgeCompatibility(): void {
    const r = this.pendingCompat;
    this.pendingCompat = null;
    uiStore.closeCompat();
    r?.();
  }

  /** 网络映射面板：玩家把每个 vSwitch 配对到 Bridge，确认后 resolve */
  showNetworkMappingPanel(
    sources: VSwitchNode[],
    targets: BridgeNode[],
  ): Promise<NetworkMappingSubmission> {
    uiStore.openNetwork(sources, targets);
    return new Promise((resolve) => {
      this.pendingNetwork = resolve;
    });
  }
  submitNetworkMapping(submission: NetworkMappingSubmission): void {
    const r = this.pendingNetwork;
    this.pendingNetwork = null;
    uiStore.closeNetwork();
    r?.(submission);
  }
  updateNetworkMappingState(completed: NetworkMapping[]): void {
    uiStore.updateNetwork(completed);
  }

  /** 存储映射面板 */
  showStorageMappingPanel(
    vm: DiscoveredVM & { workloadType: VMWorkloadType },
    pools: StoragePool[],
  ): Promise<StorageSubmission> {
    uiStore.openStorage(vm, pools);
    return new Promise((resolve) => {
      this.pendingStorage = resolve;
    });
  }
  submitStorageMapping(submission: StorageSubmission): void {
    const r = this.pendingStorage;
    this.pendingStorage = null;
    uiStore.closeStorage();
    r?.(submission);
  }
  updateStoragePreview(mapping: StorageMapping | null, warning: StorageMismatchWarning | null): void {
    uiStore.updateStorage(mapping, warning);
  }

  /** 同步挑战面板 */
  showSyncChallengeModal(c: SyncChallenge): Promise<ChallengeResponse> {
    uiStore.openChallenge(c);
    return new Promise((resolve) => {
      this.pendingChallenge = resolve;
    });
  }
  submitChallengeResponse(resp: ChallengeResponse): void {
    const r = this.pendingChallenge;
    this.pendingChallenge = null;
    uiStore.closeChallenge();
    r?.(resp);
  }

  /** 结算面板（非阻塞，仅显示） */
  showScorePanel(breakdown: ScoreBreakdown): void {
    uiStore.openScore(breakdown);
  }

  /** 通用 toast 通知 */
  toast(level: 'info' | 'warn' | 'error', text: string): void {
    uiStore.pushToast(level, text);
  }

  /** 兼容旧接口：等待玩家在有限选项中做选择（未接 UI 时直接 resolve 第一项） */
  waitForUserChoice(options: string[]): Promise<string> {
    EventBus.emit('ui:await_choice', { options });
    return new Promise((resolve) => {
      this.pendingChoice = resolve;
    });
  }
  submitUserChoice(choice: string): void {
    const r = this.pendingChoice;
    this.pendingChoice = null;
    r?.(choice);
  }
}

export const UIManager = new UIManagerImpl();

