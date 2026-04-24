/**
 * UI Store —— 轻量发布订阅状态容器。
 * 由 `UIManager` 单例改成"命令发布者 + 状态可订阅"，React UI 层订阅此状态进行渲染。
 * 各阶段逻辑通过 `UIManager.show*` 返回 Promise，UI 层提交后 Promise resolve。
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
import type { MigrationState } from '../simulation/MigrationStateMachine';
import type { ScoreBreakdown } from '../engine/ScoringSystem';
import type { DataCenterZone } from '../fps/PlayerController';

export interface ScanPanel {
  open: boolean;
}
export interface LoginPanel {
  open: boolean;
  defaultHost?: string;
}
export interface EnvResultPanel {
  open: boolean;
  result: ESXiScanResult | null;
}
export interface CompatPanel {
  open: boolean;
  vms: DiscoveredVM[];
  issues: { vmName: string; severity: 'warn' | 'error'; message: string }[];
}
export interface NetworkPanel {
  open: boolean;
  sources: VSwitchNode[];
  targets: BridgeNode[];
  completed: NetworkMapping[];
}
export interface StoragePanel {
  open: boolean;
  vm: (DiscoveredVM & { workloadType: VMWorkloadType }) | null;
  pools: StoragePool[];
  mapping: StorageMapping | null;
  warning: StorageMismatchWarning | null;
}
export interface ChallengePanel {
  open: boolean;
  challenge: SyncChallenge | null;
}
export interface ScorePanel {
  open: boolean;
  breakdown: ScoreBreakdown | null;
}

export interface HudState {
  zone: DataCenterZone;
  stamina: number;
  tool: string;
  hoverHint: string | null;
  state: MigrationState;
  objective: string;
  fullSyncPercent: number;
  incrementalRounds: number;
  score: number;
}

export interface UiState {
  login: LoginPanel;
  scanProgress: ScanPanel;
  envResult: EnvResultPanel;
  compat: CompatPanel;
  network: NetworkPanel;
  storage: StoragePanel;
  challenge: ChallengePanel;
  score: ScorePanel;
  hud: HudState;
  toast: { id: number; level: 'info' | 'warn' | 'error'; text: string }[];
}

const initial: UiState = {
  login: { open: false },
  scanProgress: { open: false },
  envResult: { open: false, result: null },
  compat: { open: false, vms: [], issues: [] },
  network: { open: false, sources: [], targets: [], completed: [] },
  storage: { open: false, vm: null, pools: [], mapping: null, warning: null },
  challenge: { open: false, challenge: null },
  score: { open: false, breakdown: null },
  hud: {
    zone: 'COMMAND_POST',
    stamina: 100,
    tool: '',
    hoverHint: null,
    state: 'IDLE',
    objective: '前往 [指挥台] 与 vCenter 控制台交互',
    fullSyncPercent: 0,
    incrementalRounds: 0,
    score: 0,
  },
  toast: [],
};

type Listener = (s: UiState) => void;

class UiStoreImpl {
  private state: UiState = initial;
  private listeners = new Set<Listener>();
  private toastSeq = 0;

  get snapshot(): UiState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(partial: Partial<UiState>): void {
    this.state = { ...this.state, ...partial };
    for (const fn of this.listeners) fn(this.state);
  }

  patchHud(p: Partial<HudState>): void {
    this.set({ hud: { ...this.state.hud, ...p } });
  }

  openLogin(defaultHost?: string): void {
    this.set({ login: { open: true, defaultHost } });
  }
  closeLogin(): void {
    this.set({ login: { open: false } });
  }

  openScanProgress(): void {
    this.set({ scanProgress: { open: true } });
  }
  closeScanProgress(): void {
    this.set({ scanProgress: { open: false } });
  }

  openEnvResult(result: ESXiScanResult): void {
    this.set({ envResult: { open: true, result } });
  }
  closeEnvResult(): void {
    this.set({ envResult: { open: false, result: null } });
  }

  openCompat(vms: DiscoveredVM[], issues: CompatPanel['issues']): void {
    this.set({ compat: { open: true, vms, issues } });
  }
  closeCompat(): void {
    this.set({ compat: { open: false, vms: [], issues: [] } });
  }

  openNetwork(sources: VSwitchNode[], targets: BridgeNode[]): void {
    this.set({ network: { open: true, sources, targets, completed: [] } });
  }
  updateNetwork(completed: NetworkMapping[]): void {
    this.set({ network: { ...this.state.network, completed } });
  }
  closeNetwork(): void {
    this.set({
      network: { open: false, sources: [], targets: [], completed: [] },
    });
  }

  openStorage(
    vm: DiscoveredVM & { workloadType: VMWorkloadType },
    pools: StoragePool[],
  ): void {
    this.set({ storage: { open: true, vm, pools, mapping: null, warning: null } });
  }
  updateStorage(mapping: StorageMapping | null, warning: StorageMismatchWarning | null): void {
    this.set({ storage: { ...this.state.storage, mapping, warning } });
  }
  closeStorage(): void {
    this.set({
      storage: { open: false, vm: null, pools: [], mapping: null, warning: null },
    });
  }

  openChallenge(c: SyncChallenge): void {
    this.set({ challenge: { open: true, challenge: c } });
  }
  closeChallenge(): void {
    this.set({ challenge: { open: false, challenge: null } });
  }

  openScore(b: ScoreBreakdown): void {
    this.set({ score: { open: true, breakdown: b } });
  }

  pushToast(level: 'info' | 'warn' | 'error', text: string): void {
    const id = ++this.toastSeq;
    this.set({ toast: [...this.state.toast, { id, level, text }] });
    setTimeout(() => {
      this.set({ toast: this.state.toast.filter((t) => t.id !== id) });
    }, 4000);
  }

  // For tests only: reset to initial state
  _resetForTest(): void {
    this.state = { ...initial };
    this.listeners.clear();
  }
}

export const uiStore = new UiStoreImpl();

// ChallengeResponse re-export for React panel
export type { ChallengeResponse };
