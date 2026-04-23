/**
 * 共享类型定义：客户端与服务器之间的 DTO 合同。
 * 任一侧修改结构时应同步另一侧并更新测试。
 */

// ============================================================
// Credential / Session
// ============================================================

export interface VCenterCredential {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface Session {
  token: string;
  playerName: string;
  createdAt: number;
  expiresAt: number;
}

// ============================================================
// Environment Scan
// ============================================================

export type GuestOSType =
  | 'windows_server_2019'
  | 'windows_server_2022'
  | 'windows_10'
  | 'windows_11'
  | 'rhel_7'
  | 'rhel_8'
  | 'rhel_9'
  | 'centos_7'
  | 'ubuntu_20'
  | 'ubuntu_22'
  | 'debian_11';

export interface ESXiHost {
  name: string;
  ip: string;
  version: string;
  cpuModel: string;
  totalCPU: number;
  totalMemoryGB: number;
  vmCount: number;
  status: 'connected' | 'disconnected' | 'maintenance';
  connectionState: 'ok' | 'notResponding' | 'unknown';
}

export interface Datastore {
  name: string;
  type: 'VMFS' | 'NFS' | 'vSAN';
  capacityGB: number;
  usedGB: number;
  iops: number;
  latencyMs: number;
}

export interface VirtualNetwork {
  name: string;
  vlanId: number | null;
  type: 'standard' | 'distributed';
}

export interface VMDisk {
  label: string;
  capacityGB: number;
  provisionType: 'thin' | 'thick_eager' | 'thick_lazy';
  datastoreName: string;
  path: string;
}

export interface VMNIC {
  label: string;
  macAddress: string;
  networkName: string;
  adapterType: 'vmxnet3' | 'e1000' | 'e1000e';
}

export interface DiscoveredVM {
  moRef: string;
  name: string;
  powerState: 'poweredOn' | 'poweredOff' | 'suspended';
  guestOS: GuestOSType;
  cpu: number;
  memoryGB: number;
  disks: VMDisk[];
  nics: VMNIC[];
  snapshotExists: boolean;
  toolsVersion: string;
  toolsRunning: boolean;
}

export interface ESXiScanResult {
  vCenterVersion: string;
  esxiHosts: ESXiHost[];
  datastores: Datastore[];
  networks: VirtualNetwork[];
  vms: DiscoveredVM[];
  scanDurationMs: number;
}

// ============================================================
// Compatibility
// ============================================================

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

// ============================================================
// Network Mapping
// ============================================================

export interface NetworkMapping {
  sourceVSwitch: string;
  sourcePortGroup: string;
  targetBridgeType: 'standard' | 'distributed';
  targetBridgeName: string;
  vlanId: number | null;
  validated: boolean;
}

export interface VSwitchNode {
  id: string;
  name: string;
  portGroups: string[];
  vlanIds: number[];
  position3D: [number, number, number];
  connected: boolean;
}

export interface BridgeNode {
  id: string;
  name: string;
  type: 'standard' | 'distributed';
  availableBandwidthGbps: number;
  position3D: [number, number, number];
}

// ============================================================
// Storage Mapping
// ============================================================

export type VMWorkloadType =
  | 'DATABASE'
  | 'WEB_SERVER'
  | 'FILE_SERVER'
  | 'AD_DC'
  | 'BATCH_JOB'
  | 'REALTIME';

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
  color: string;
}

// ============================================================
// Migration State Machine
// ============================================================

export type MigrationState =
  | 'IDLE'
  | 'ENV_SCAN'
  | 'COMPATIBILITY_CHECK'
  | 'NETWORK_MAPPING'
  | 'STORAGE_MAPPING'
  | 'PRE_SNAPSHOT'
  | 'FULL_SYNC'
  | 'INCREMENTAL_SYNC'
  | 'DRIVER_INJECTION'
  | 'CUTOVER_READY'
  | 'CUTOVER_EXECUTING'
  | 'POST_CHECK'
  | 'COMPLETED'
  | 'FAILED'
  | 'PAUSED_NETWORK_FAULT'
  | 'PAUSED_STORAGE_FAULT'
  | 'RESUMING';

export interface DetectedDriver {
  name: string;
  vendor: 'vmware';
  replacedBy: string;
}

export interface InjectedDriver {
  name: string;
  version: string;
  status: 'success' | 'pending' | 'failed';
}

export interface DriverInjectionStatus {
  phase: 'PENDING' | 'INJECTING' | 'COMPLETED' | 'FAILED';
  guestOS: GuestOSType;
  detectedDrivers: DetectedDriver[];
  injectedDrivers: InjectedDriver[];
  autoInjected: boolean;
}

export interface MigrationError {
  code: string;
  message: string;
  timestamp: number;
}

export interface MigrationTimelineEntry {
  fromState: MigrationState;
  toState: MigrationState;
  timestamp: number;
  operator: 'player' | 'system';
  note?: string;
}

export interface MigrationProgress {
  fullSyncPercent: number;
  incrementalRounds: number;
  dataTotalGB: number;
  dataTransferredGB: number;
  transferSpeedMbps: number;
  etaSeconds: number;
}

export interface MigrationTask {
  id: string;
  vmId: string;
  vmName: string;
  state: MigrationState;
  progress: MigrationProgress;
  networkMapping: NetworkMapping | null;
  storageMapping: StorageMapping | null;
  driverStatus: DriverInjectionStatus;
  checkpointOffset: number;
  errors: MigrationError[];
  timeline: MigrationTimelineEntry[];
  agentless: true;
  storageWarning?: StorageMismatchWarning | null;
  ownerSession?: string;
}

// ============================================================
// Checkpoints
// ============================================================

export interface MigrationCheckpoint {
  taskId: string;
  vmId: string;
  timestamp: number;
  lastCompletedBlockOffset: number;
  transferredBlocks: number[];
  totalBlocks: number;
  networkMetricsAtFailure: {
    packetLoss: number;
    jitterMs: number;
    failureReason: string;
  };
  cachedVMMetadata: DiscoveredVM | null;
  networkMappingSnapshot: NetworkMapping | null;
  storageMappingSnapshot: StorageMapping | null;
}

export type ResumeStrategy = 'FROM_CHECKPOINT' | 'RESTART_INCREMENTAL' | 'FULL_RESTART';

// ============================================================
// Scoring
// ============================================================

export interface ScoreBonus {
  reason: string;
  points: number;
  examples?: string[];
}

export interface ScorePenalty {
  reason: string;
  points: number; // negative
}

export interface ScoreBreakdown {
  total: number;
  categories: {
    speed: number;
    correctness: number;
    businessContinuity: number;
    smartxFeatureUsage: number;
  };
  bonuses: ScoreBonus[];
  penalties: ScorePenalty[];
}

export const SCORING_RULES = {
  USED_IO_LOCALITY: { points: +150, reason: '启用I/O本地化，延迟降低30%' },
  USED_RDMA: { points: +200, reason: '启用RDMA加速，吞吐提升2x' },
  USED_CHECKPOINT_RESUME: { points: +150, reason: '使用断点续传，节省重传时间' },
  USED_BANDWIDTH_LIMITER: { points: +100, reason: '合理控制迁移带宽，保障生产业务' },
  PERFECT_STORAGE_MAPPING: { points: +200, reason: '所有VM存储配置完全匹配工作负载类型' },
  ZERO_DOWNTIME: { points: +300, reason: '迁移全程业务零中断' },
  AGENTLESS_AWARENESS: { points: +50, reason: '未尝试在源VM安装任何agent（理解Agentless特性）' },
  WRONG_STORAGE_TIER: { points: -200, reason: '数据库VM放置到HDD存储池，性能严重下降' },
  IGNORED_SNAPSHOT_WARNING: { points: -100, reason: '未合并快照直接迁移，速度降低40%' },
  MANUAL_RESTART_TRANSFER: { points: -150, reason: '网络中断后选择重新传输，而非断点续传' },
  NETWORK_CONGESTION: { points: -100, reason: '迁移带宽未限速，导致生产业务延迟飙升' },
  WRONG_NETWORK_MAPPING: { points: -300, reason: '网络映射错误，VM启动后网络不通' },
} as const;

export type ScoringRuleKey = keyof typeof SCORING_RULES;

// ============================================================
// Post-check
// ============================================================

export interface PostCheckItem {
  id: string;
  name: string;
  checkType: 'network' | 'service' | 'performance' | 'data_integrity';
  method: string;
  expectedResult: string;
  actualResult?: string;
  status: 'pending' | 'checking' | 'pass' | 'fail';
  scoreWeight: number;
}

// ============================================================
// Cutover metrics
// ============================================================

export interface BeforeAfterMetrics {
  bootTimeSeconds: { vmware: number; smartx: number };
  iopsAtPeak: { vmware: number; smartx: number };
  latencyMs: { vmware: number; smartx: number };
  memoryOverheadMB: { vmware: number; smartx: number };
  cpuOverheadPercent: { vmware: number; smartx: number };
}

// ============================================================
// Wire protocol (WebSocket)
// ============================================================

/** Messages client → server */
export type ClientMessage =
  | { type: 'subscribe'; taskId: string }
  | { type: 'unsubscribe'; taskId: string }
  | { type: 'ping'; at: number };

/** Messages server → client */
export type ServerMessage =
  | { type: 'pong'; at: number }
  | { type: 'hello'; protocolVersion: number }
  | { type: 'event'; taskId: string | null; event: string; payload: unknown }
  | { type: 'error'; message: string };

export const WS_PROTOCOL_VERSION = 1;
