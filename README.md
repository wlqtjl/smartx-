# 《数据中心攻坚战》FPS机制 × SmartX迁移技术架构补充文档
> 版本：2.0 | 配套主架构文档 v1.0 使用

---

## 一、FPS 控制器系统

### 1.1 玩家控制器核心

```typescript
// client/src/fps/PlayerController.ts

export interface PlayerState {
  position: THREE.Vector3;
  rotation: THREE.Euler;       // yaw(Y) + pitch(X)，无 roll
  velocity: THREE.Vector3;
  isGrounded: boolean;
  isCrouching: boolean;
  isSprinting: boolean;
  currentZone: DataCenterZone;
  equippedTool: ToolType | null;
  staminaPercent: number;      // 0~100，冷却道疾跑消耗
}

export type DataCenterZone =
  | 'COLD_AISLE'    // 冷风道：狭窄，镜头晃动增强，服务器接入点
  | 'HOT_AISLE'     // 热风道：温度特效（热浪扭曲shader），行动速度-10%
  | 'NETWORK_ROOM'  // 网络间：交换机/防火墙操作区
  | 'STORAGE_ROOM'  // 存储间：SAN/NAS/NVMe操作区
  | 'COMMAND_POST'; // 指挥台：全局大屏监控，TCO分析

export interface MovementConfig {
  walkSpeed: number;        // 3.5 m/s
  sprintSpeed: number;      // 6.0 m/s（冷风道限速4.0）
  crouchSpeed: number;      // 1.8 m/s（机架底部操作）
  headBobFrequency: number; // 步频，走路1.8Hz / 跑步2.8Hz
  headBobAmplitude: {
    walk: number;    // 0.005
    sprint: number;  // 0.012
    coldAisle: number; // 0.018（体现空间局促感）
  };
  mouseSensitivity: number;
  fovDefault: number;  // 75
  fovSprint: number;   // 82（冲刺时FOV轻微拉伸）
}

export class PlayerController {
  private state: PlayerState;
  private config: MovementConfig;
  private camera: THREE.PerspectiveCamera;
  private collisionSystem: CollisionSystem;
  private interactionRaycaster: THREE.Raycaster;

  // 交互检测：准星投射射线，检测可交互对象
  checkInteractable(): InteractableObject | null {
    this.interactionRaycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hits = this.interactionRaycaster.intersectObjects(this.interactionTargets, true);
    if (hits.length > 0 && hits[0].distance < 2.5) {
      return hits[0].object.userData.interactable as InteractableObject;
    }
    return null;
  }

  // 区域进入时触发特效与限速
  onZoneEnter(zone: DataCenterZone): void {
    switch (zone) {
      case 'HOT_AISLE':
        EventBus.emit('fx:heat_distortion', { intensity: 0.3 });
        this.config.walkSpeed *= 0.9;
        break;
      case 'COLD_AISLE':
        EventBus.emit('fx:cold_breath', {});
        this.config.headBobAmplitude.walk = this.config.headBobAmplitude.coldAisle;
        break;
    }
  }
}
```

---

### 1.2 工具装备系统（取代 CS 武器系统）

```typescript
// client/src/fps/ToolSystem.ts

export type ToolType =
  | 'SMART_PROBE'        // 智能采集跳线：插入网口，扫描VMware环境
  | 'FIBER_PATCHER'      // 光纤跳线操作工具：配置网络映射
  | 'DIAGNOSTIC_TABLET'  // 诊断平板：查看VM详情/实时指标
  | 'RECOVERY_KIT'       // 断点恢复工具包：处理迁移中断
  | 'BANDWIDTH_LIMITER'  // 带宽调速器：控制迁移占用带宽
  | 'SNAPSHOT_GUN';      // 快照枪：为VM创建迁移前快照

export interface Tool {
  type: ToolType;
  name: string;
  description: string;
  primaryAction: string;    // 左键：主操作
  secondaryAction: string;  // 右键：副操作（类比CS瞄准镜）
  cooldownMs: number;
  currentCooldown: number;
  model3DPath: string;
  animationSet: ToolAnimationSet;
}

export interface ToolAnimationSet {
  idle: string;
  draw: string;        // 掏出动作
  holster: string;     // 收起动作
  primaryFire: string; // 主操作动画
  reload: string;      // 充电/准备动画
}

// 工具槽位（类比CS武器槽）
export const TOOL_SLOTS: Record<number, ToolType> = {
  1: 'SMART_PROBE',
  2: 'FIBER_PATCHER',
  3: 'DIAGNOSTIC_TABLET',
  4: 'RECOVERY_KIT',
  5: 'BANDWIDTH_LIMITER',
  6: 'SNAPSHOT_GUN',
};

export class ToolSystem {
  private equipped: Tool | null = null;

  // 智能探针插入网口（E键交互后自动调用）
  async activateSmartProbe(targetPort: NetworkPort): Promise<ScanResult> {
    // 1. 播放"插线"动画（0.8s）
    await this.playAnimation('primaryFire', 800);
    // 2. 模拟 vCenter 连接握手（500ms延迟）
    await this.simulateNetworkHandshake(targetPort);
    // 3. 弹出 vCenter 登录界面 或 小游戏（密码破解）
    const credential = await UIManager.showVCenterLoginPanel();
    // 4. 扫描 ESXi 主机并返回结果
    return this.scanESXiEnvironment(credential);
  }
}
```

---

## 二、SmartX 迁移流程状态机（完整实现）

### 2.1 迁移状态机定义

```typescript
// client/src/simulation/MigrationStateMachine.ts

/**
 * V2V迁移完整生命周期状态
 * 对应 SMTX Migration Tool 真实流程
 */
export type MigrationState =
  // === 准备阶段 ===
  | 'IDLE'
  | 'ENV_SCAN'               // 源端环境扫描（vCenter API调用）
  | 'COMPATIBILITY_CHECK'    // 兼容性检测（ESXi版本、VM状态检查）
  | 'NETWORK_MAPPING'        // 网络映射（vSwitch → SmartX Bridge）
  | 'STORAGE_MAPPING'        // 存储映射（Datastore → SmartX存储池）
  | 'PRE_SNAPSHOT'           // 迁移前快照创建
  // === 传输阶段 ===
  | 'FULL_SYNC'              // 全量块级数据同步
  | 'INCREMENTAL_SYNC'       // 增量同步（VM仍在VMware上运行）
  | 'DRIVER_INJECTION'       // VirtIO驱动注入（virt-v2v）
  // === 切换阶段 ===
  | 'CUTOVER_READY'          // 就绪，等待玩家执行切换
  | 'CUTOVER_EXECUTING'      // 切换执行中（VMware端关机 → SmartX端启动）
  | 'POST_CHECK'             // 切换后验证（网络通/服务正常/性能达标）
  // === 终态 ===
  | 'COMPLETED'
  | 'FAILED'
  // === 异常恢复 ===
  | 'PAUSED_NETWORK_FAULT'   // 网络中断，等待恢复
  | 'PAUSED_STORAGE_FAULT'   // 存储故障，等待处理
  | 'RESUMING';              // 断点续传中

export interface MigrationTask {
  id: string;
  vmId: string;
  vmName: string;
  state: MigrationState;
  progress: {
    fullSyncPercent: number;      // 全量同步进度 0~100
    incrementalRounds: number;    // 增量同步轮次
    dataTotalGB: number;
    dataTransferredGB: number;
    transferSpeedMbps: number;
    etaSeconds: number;
  };
  networkMapping: NetworkMapping | null;
  storageMapping: StorageMapping | null;
  driverStatus: DriverInjectionStatus;
  checkpointOffset: number;       // 断点续传偏移量（字节）
  errors: MigrationError[];
  timeline: MigrationTimelineEntry[];
  agentless: true;                // SmartX特性：始终无代理
}

export interface NetworkMapping {
  sourceVSwitch: string;            // VMware虚拟交换机名
  sourcePortGroup: string;          // 端口组
  targetBridgeType: 'standard' | 'distributed'; // SmartX网桥类型
  targetBridgeName: string;
  vlanId: number | null;
  validated: boolean;               // 映射关系是否通过验证
}

export interface StorageMapping {
  sourceDatastore: string;          // VMware Datastore名称
  sourceDiskType: 'thin' | 'thick_eager' | 'thick_lazy';
  targetPoolName: string;           // SmartX存储池名
  targetPoolTier: 'nvme' | 'ssd' | 'hdd';  // 性能等级
  ioLocalityEnabled: boolean;       // SmartX I/O本地化
  rdmaEnabled: boolean;             // RDMA加速
  validated: boolean;
  warningMismatch: StorageMismatchWarning | null;
}

export interface StorageMismatchWarning {
  type: 'PERFORMANCE_DOWNGRADE' | 'CAPACITY_INSUFFICIENT' | 'TIER_MISMATCH';
  message: string;
  // 例：将数据库VM分配到HDD池 → 触发红色警告
  suggestedAction: string;
}

export interface DriverInjectionStatus {
  phase: 'PENDING' | 'INJECTING' | 'COMPLETED' | 'FAILED';
  guestOS: GuestOSType;
  detectedDrivers: DetectedDriver[];
  injectedDrivers: InjectedDriver[];
  // 自动注入：VirtIO网卡驱动、VirtIO磁盘驱动、QEMU Guest Agent
  autoInjected: boolean;  // SmartX virt-v2v特性：无需手动操作
}

export type GuestOSType =
  | 'windows_server_2019' | 'windows_server_2022'
  | 'windows_10' | 'windows_11'
  | 'rhel_7' | 'rhel_8' | 'rhel_9'
  | 'centos_7' | 'ubuntu_20' | 'ubuntu_22'
  | 'debian_11';

export interface DetectedDriver {
  name: string;   // 如 "VMware VMXNET3 网络适配器"
  vendor: 'vmware';
  replacedBy: string;  // 如 "VirtIO Net Driver"
}

export interface InjectedDriver {
  name: string;
  version: string;
  status: 'success' | 'pending' | 'failed';
}
```

---

### 2.2 迁移状态机转换逻辑

```typescript
// client/src/simulation/MigrationStateMachine.ts（续）

export class MigrationStateMachine {
  private tasks: Map<string, MigrationTask> = new Map();

  // 状态转换表（驱动游戏事件触发）
  private readonly TRANSITIONS: Record<MigrationState, MigrationState[]> = {
    IDLE:                   ['ENV_SCAN'],
    ENV_SCAN:               ['COMPATIBILITY_CHECK', 'FAILED'],
    COMPATIBILITY_CHECK:    ['NETWORK_MAPPING', 'FAILED'],
    NETWORK_MAPPING:        ['STORAGE_MAPPING'],
    STORAGE_MAPPING:        ['PRE_SNAPSHOT'],
    PRE_SNAPSHOT:           ['FULL_SYNC'],
    FULL_SYNC:              ['INCREMENTAL_SYNC', 'PAUSED_NETWORK_FAULT', 'PAUSED_STORAGE_FAULT'],
    INCREMENTAL_SYNC:       ['DRIVER_INJECTION', 'PAUSED_NETWORK_FAULT'],
    DRIVER_INJECTION:       ['CUTOVER_READY', 'FAILED'],
    CUTOVER_READY:          ['CUTOVER_EXECUTING'],
    CUTOVER_EXECUTING:      ['POST_CHECK', 'FAILED'],
    POST_CHECK:             ['COMPLETED', 'FAILED'],
    PAUSED_NETWORK_FAULT:   ['RESUMING', 'FAILED'],
    PAUSED_STORAGE_FAULT:   ['RESUMING', 'FAILED'],
    RESUMING:               ['FULL_SYNC', 'INCREMENTAL_SYNC'],
    COMPLETED:              [],
    FAILED:                 [],
  };

  transition(taskId: string, newState: MigrationState, payload?: Partial<MigrationTask>): void {
    const task = this.tasks.get(taskId)!;
    const allowed = this.TRANSITIONS[task.state];
    if (!allowed.includes(newState)) {
      throw new Error(`非法状态转换: ${task.state} → ${newState}`);
    }
    const prev = task.state;
    Object.assign(task, { state: newState, ...payload });
    this.tasks.set(taskId, task);

    // 记录时间线
    task.timeline.push({
      fromState: prev,
      toState: newState,
      timestamp: Date.now(),
      operator: 'player',
    });

    // 广播状态变化给渲染层
    EventBus.emit('migration:stateChange', { taskId, prev, next: newState, task });
  }
}
```

---

## 三、各阶段详细交互实现

### 3.1 阶段一：源端环境扫描（ENV_SCAN）

```typescript
// client/src/simulation/phases/EnvScanPhase.ts

export interface ESXiScanResult {
  vCenterVersion: string;    // 如 "vCenter 7.0 U3"
  esxiHosts: ESXiHost[];
  datastores: Datastore[];
  networks: VirtualNetwork[];
  vms: DiscoveredVM[];
  scanDurationMs: number;
}

export interface ESXiHost {
  name: string;
  ip: string;
  version: string;           // ESXi版本，用于兼容性检查
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

export interface DiscoveredVM {
  moRef: string;            // VMware托管对象引用ID（全局唯一）
  name: string;
  powerState: 'poweredOn' | 'poweredOff' | 'suspended';
  guestOS: GuestOSType;
  cpu: number;
  memoryGB: number;
  disks: VMDisk[];
  nics: VMNIC[];
  snapshotExists: boolean;  // 存在快照会影响迁移速度（需警告）
  toolsVersion: string;     // VMware Tools版本
  toolsRunning: boolean;
}

export interface VMDisk {
  label: string;            // "Hard disk 1"
  capacityGB: number;
  provisionType: 'thin' | 'thick_eager' | 'thick_lazy';
  datastoreName: string;
  path: string;             // "[datastore1] vm/vm.vmdk"
}

export interface VMNIC {
  label: string;            // "Network adapter 1"
  macAddress: string;
  networkName: string;      // vSwitch端口组名
  adapterType: 'vmxnet3' | 'e1000' | 'e1000e';
}

// 游戏中：扫描进行时，机架上的VM指示灯蓝色闪烁
// UI上：滚动列出VM名称、CPU/内存/磁盘大小
export class EnvScanPhase {
  async execute(credential: VCenterCredential): Promise<ESXiScanResult> {
    EventBus.emit('fx:rack_lights_scanning', { color: '#00AAFF', pattern: 'blink' });
    const result = await this.simulateScan(credential);
    EventBus.emit('ui:show_scan_results', result);
    return result;
  }

  private async simulateScan(cred: VCenterCredential): Promise<ESXiScanResult> {
    // 模拟API调用延迟（1.5~3s，体现真实感）
    await delay(1500 + Math.random() * 1500);
    return MockDataGenerator.generateESXiEnvironment(cred);
  }
}
```

---

### 3.2 阶段二：兼容性检测（COMPATIBILITY_CHECK）

```typescript
// client/src/simulation/phases/CompatibilityCheckPhase.ts

export interface CompatibilityReport {
  overallStatus: 'PASS' | 'WARN' | 'BLOCK';
  checks: CompatibilityCheck[];
  blockers: CompatibilityCheck[];    // status=BLOCK的项，必须修复才能继续
  warnings: CompatibilityCheck[];   // status=WARN的项，建议处理
}

export interface CompatibilityCheck {
  category: CheckCategory;
  item: string;
  status: 'PASS' | 'WARN' | 'BLOCK';
  detail: string;
  autoFixable: boolean;    // SmartX可自动修复的问题
  fixAction?: string;      // 自动修复按钮文本
}

export type CheckCategory =
  | 'ESXI_VERSION'         // ESXi版本兼容性
  | 'VM_POWER_STATE'       // VM必须关机或支持热迁移
  | 'SNAPSHOT_STATE'       // 存在快照的处理
  | 'DISK_TYPE'            // 磁盘类型兼容性
  | 'GUEST_OS'             // 客户机OS支持
  | 'DRIVER_SUPPORT'       // 驱动注入支持
  | 'NETWORK_REACHABILITY' // 源端到目标端网络可达
  | 'STORAGE_CAPACITY';    // 目标存储容量是否充足

// 典型检测结果示例（游戏中需全部呈现）
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

// 游戏机制：玩家需要手持"扫描仪"靠近每台服务器，
// 扫描通过的设备绿灯亮起，BLOCK项红灯闪烁要求玩家处理
export class CompatibilityCheckPhase {
  async execute(vms: DiscoveredVM[]): Promise<CompatibilityReport> {
    const checks: CompatibilityCheck[] = [];
    for (const vm of vms) {
      checks.push(...this.checkVM(vm));
      EventBus.emit('fx:vm_scan_light', { vmId: vm.moRef, status: 'scanning' });
      await delay(200); // 逐台扫描动画
    }
    const report = this.buildReport(checks);
    // 触发成就：如果所有检查一次通过
    if (report.overallStatus === 'PASS') {
      EventBus.emit('achievement:clean_environment');
    }
    return report;
  }

  private checkVM(vm: DiscoveredVM): CompatibilityCheck[] {
    const results: CompatibilityCheck[] = [];
    // 快照检查
    if (vm.snapshotExists) {
      results.push({ category: 'SNAPSHOT_STATE', item: `${vm.name} 快照`, status: 'WARN',
        detail: '存在快照链，建议合并后迁移', autoFixable: true, fixAction: '合并快照' });
    }
    // VMware Tools检查
    if (!vm.toolsRunning) {
      results.push({ category: 'DRIVER_SUPPORT', item: `${vm.name} VMware Tools`,
        status: 'WARN', detail: 'VMware Tools未运行，驱动注入将使用离线模式',
        autoFixable: true, fixAction: '使用离线驱动注入' });
    }
    // E1000网卡（性能差，SmartX强制升级）
    if (vm.nics.some(n => n.adapterType !== 'vmxnet3')) {
      results.push({ category: 'DRIVER_SUPPORT', item: `${vm.name} 旧版网卡`,
        status: 'WARN', detail: '检测到 E1000 网卡，将升级为 VirtIO Net（性能提升60%）',
        autoFixable: true, fixAction: '自动升级驱动' });
    }
    return results;
  }
}
```

---

### 3.3 阶段三：网络映射（3D空间划线操作）

```typescript
// client/src/simulation/phases/NetworkMappingPhase.ts

/**
 * 玩家在3D空间中用"光纤工具"从VMware虚拟交换机
 * 拖拽连线到SmartX分布式网桥
 * 
 * 交互：右手持光纤工具，左键点击源端vSwitch，
 *       拖动到目标SmartX Bridge，松开完成映射
 */
export interface NetworkMappingUI {
  sourceVSwitches: VSwitchNode[];       // 左侧：VMware网络
  targetSmartXBridges: BridgeNode[];    // 右侧：SmartX网络
  completedMappings: NetworkMapping[];
  pendingMappings: string[];            // 还未映射的 vSwitch ID
}

export interface VSwitchNode {
  id: string;
  name: string;          // 如 "vSwitch0"
  portGroups: string[];  // 如 ["VM Network", "Management Network"]
  vlanIds: number[];
  position3D: [number, number, number];
  connected: boolean;    // 是否已连线
}

export interface BridgeNode {
  id: string;
  name: string;          // 如 "brbond0"
  type: 'standard' | 'distributed';
  availableBandwidthGbps: number;
  position3D: [number, number, number];
}

// 验证规则：映射关系合法性检查
export const validateNetworkMapping = (
  source: VSwitchNode,
  target: BridgeNode,
  existingMappings: NetworkMapping[]
): { valid: boolean; warning?: string; error?: string } => {
  // 检查目标Bridge是否已被占用
  const alreadyMapped = existingMappings.find(m => m.targetBridgeName === target.name);
  if (alreadyMapped) {
    return { valid: false, error: `${target.name} 已被 ${alreadyMapped.sourceVSwitch} 占用` };
  }
  // 检查VLAN冲突
  const vlanConflict = source.vlanIds.some(v => existingMappings.some(m => m.vlanId === v));
  if (vlanConflict) {
    return { valid: true, warning: `VLAN ID 冲突，请检查隔离配置` };
  }
  return { valid: true };
};
```

---

### 3.4 阶段四：存储映射（拖拽VM到存储池）

```typescript
// client/src/simulation/phases/StorageMappingPhase.ts

/**
 * 关键游戏机制：
 * 玩家必须为每个VM选择合适的存储池
 * 选错性能等级 → 界面爆红 → 扣分
 * SmartX独特功能：I/O本地化 和 RDMA 开关
 */

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
  // 视觉颜色（游戏中存储架对应颜色）
  color: '#FFD700' | '#C0C0C0' | '#CD7F32';  // 金/银/铜
}

export interface StorageMappingRule {
  vmWorkloadType: VMWorkloadType;
  recommendedTier: 'nvme' | 'ssd' | 'hdd';
  reason: string;
}

export type VMWorkloadType =
  | 'DATABASE'     // 数据库：必须NVMe
  | 'WEB_SERVER'   // Web服务器：SSD即可
  | 'FILE_SERVER'  // 文件服务器：HDD可接受
  | 'AD_DC'        // 域控：SSD
  | 'BATCH_JOB'    // 批处理：HDD可接受
  | 'REALTIME';    // 实时计算：必须NVMe + RDMA

export const STORAGE_MAPPING_RULES: StorageMappingRule[] = [
  { vmWorkloadType: 'DATABASE',   recommendedTier: 'nvme', reason: '数据库对IOPS和延迟极度敏感，NVMe可提供微秒级响应' },
  { vmWorkloadType: 'REALTIME',   recommendedTier: 'nvme', reason: '实时计算需要RDMA零拷贝，必须选NVMe池' },
  { vmWorkloadType: 'WEB_SERVER', recommendedTier: 'ssd',  reason: 'Web服务器读多写少，SSD性价比最优' },
  { vmWorkloadType: 'FILE_SERVER',recommendedTier: 'hdd',  reason: '文件服务器大容量需求，HDD成本最低' },
];

// 错误放置惩罚：游戏中的教学机制
export const checkStorageMismatch = (
  vm: DiscoveredVM & { workloadType: VMWorkloadType },
  pool: StoragePool
): StorageMismatchWarning | null => {
  const rule = STORAGE_MAPPING_RULES.find(r => r.vmWorkloadType === vm.workloadType);
  if (!rule) return null;

  const tierOrder = { nvme: 3, ssd: 2, hdd: 1 };
  if (tierOrder[pool.tier] < tierOrder[rule.recommendedTier]) {
    // 数据库VM放HDD池：严重错误
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
  return null;
};
```

---

### 3.5 阶段五：块级数据同步（核心视觉冲击段）

```typescript
// client/src/simulation/phases/DataSyncPhase.ts

export interface DataSyncState {
  taskId: string;
  vmId: string;
  phase: 'FULL_SYNC' | 'INCREMENTAL_SYNC';
  
  // 全量同步参数
  fullSync: {
    totalBlocks: number;         // 总块数（每块4MB）
    transferredBlocks: number;
    speedMbps: number;           // SmartX：800~1200Mbps；VMware热迁移：200~400Mbps
    estimatedRemainSeconds: number;
    agentless: true;             // SmartX直接从存储层读取，无需VM内安装agent
  };

  // 增量同步参数（全量到90%后触发）
  incrementalSync: {
    rounds: number;              // 增量轮次
    dirtiedBlocksPerSecond: number; // 源VM产生的脏块速率
    syncLag: number;             // 同步延迟（块数），越低越好
    readyToCutover: boolean;     // 当syncLag < 100 时，可以切换
  };

  // 游戏中的随机挑战事件
  activeChallenge: SyncChallenge | null;
}

export interface SyncChallenge {
  type: 'NETWORK_JITTER' | 'STORAGE_QUEUE_FULL' | 'SOURCE_VM_SPIKE' | 'BANDWIDTH_STOLEN';
  severity: 'low' | 'medium' | 'high';
  description: string;
  // 玩家操作选项
  responses: ChallengeResponse[];
  timeoutSeconds: number;  // 超时未处理则自动降级处理
}

export interface ChallengeResponse {
  id: string;
  label: string;
  // SmartX应对方案 vs VMware应对方案（SmartX得分更高）
  isSmartXWay: boolean;
  scoreBonus: number;
  effect: string;  // 处理效果描述
}

// 典型挑战事件配置
export const SYNC_CHALLENGES: SyncChallenge[] = [
  {
    type: 'NETWORK_JITTER',
    severity: 'medium',
    description: '检测到网络抖动，数据包丢失率 3%，传输速度下降40%',
    timeoutSeconds: 30,
    responses: [
      {
        id: 'smartx_retry',
        label: '启用SmartX智能断点续传',
        isSmartXWay: true,
        scoreBonus: 100,
        effect: '自动记录传输偏移量，网络恢复后从断点继续，无需重传',
      },
      {
        id: 'restart_transfer',
        label: '重新开始全量传输',
        isSmartXWay: false,
        scoreBonus: -50,
        effect: '重置进度，浪费已传输数据',
      },
      {
        id: 'wait_network',
        label: '等待网络自愈',
        isSmartXWay: false,
        scoreBonus: 20,
        effect: '消极等待，时间成本较高',
      },
    ],
  },
  {
    type: 'BANDWIDTH_STOLEN',
    severity: 'high',
    description: '迁移流量占满 10GbE 上行，生产业务延迟升至 80ms！',
    timeoutSeconds: 20,
    responses: [
      {
        id: 'smartx_qos',
        label: '使用带宽调速器限制迁移至30%带宽',
        isSmartXWay: true,
        scoreBonus: 120,
        effect: '迁移带宽降至 3Gbps，生产延迟恢复正常，迁移继续',
      },
      {
        id: 'pause_migration',
        label: '暂停迁移任务',
        isSmartXWay: false,
        scoreBonus: 30,
        effect: '业务恢复，但迁移时间大幅增加',
      },
    ],
  },
];

// 3D视觉：数据脉冲电缆
export interface DataCableVisual {
  sourcePosition: THREE.Vector3;   // VMware机架端口
  targetPosition: THREE.Vector3;   // SmartX机架端口
  pulsesPerSecond: number;         // 数据速率 → 脉冲频率
  cableColor: string;              // 全量sync: '#0088FF', 增量sync: '#00FF88'
  cableThickness: number;          // 带宽越大越粗
  particleCount: number;           // 数据包粒子数
}
```

---

### 3.6 阶段六：VirtIO驱动注入（virt-v2v）

```typescript
// client/src/simulation/phases/DriverInjectionPhase.ts

/**
 * SmartX 核心差异点：
 * V2V驱动注入完全自动化，无需玩家手动安装驱动
 * 游戏化表现：玩家"按键触发"，系统自动完成
 * 教学目标：让玩家理解VMware专有驱动 → KVM/VirtIO通用驱动的转换
 */

export interface DriverInjectionPlan {
  vmId: string;
  guestOS: GuestOSType;
  steps: DriverInjectionStep[];
  estimatedDurationSeconds: number;
  riskLevel: 'LOW' | 'MEDIUM';  // SmartX自动注入风险极低
}

export interface DriverInjectionStep {
  order: number;
  action: string;
  techDetail: string;     // 技术说明（游戏内教学文本）
  durationMs: number;
  status: 'pending' | 'running' | 'done' | 'failed';
}

// Windows Server 2019 驱动注入计划（游戏内逐步展示）
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
    techDetail: '解析 HKLM\\SYSTEM\\CurrentControlSet\\Services，识别 VMware SVGA/VMXNET3/pvscsi 等驱动',
    durationMs: 1200,
    status: 'pending',
  },
  {
    order: 3,
    action: '注入 VirtIO 磁盘驱动（vioscsi）',
    techDetail: '替换 vmw_pvscsi → vioscsi，确保系统能从 VirtIO 磁盘启动。这是防止"蓝屏"的关键步骤',
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
    techDetail: '修改 Windows Boot Configuration Data，设置正确的存储控制器驱动加载顺序',
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

// 失败场景：游戏中的教学事件
export const INJECTION_FAILURE_SCENARIOS = [
  {
    trigger: 'vmscsi_still_loaded',
    description: '启动失败 - 检测到旧版 VMware 磁盘驱动残留',
    solution: 'SmartX 自动回滚并重试：清除注册表残留项后重新注入',
    vmResult: 'BSOD',  // 失败时VM蓝屏动画
    autoRecover: true,
  },
  {
    trigger: 'missing_virtio_nic',
    description: '虚拟机启动后网卡消失（驱动未正确加载）',
    solution: '启动修复模式，在线安装VirtIO Net驱动',
    vmResult: 'NO_NETWORK',
    autoRecover: true,
  },
];
```

---

### 3.7 终极时刻：Cutover 切换（最高成就感动作）

```typescript
// client/src/simulation/phases/CutoverPhase.ts

export interface CutoverSequence {
  steps: CutoverStep[];
  totalDurationMs: number;
  vmwareShutdownMs: number;    // VMware端关机时间（传统：45~90s）
  smartxBootMs: number;        // SmartX端启动时间（SmartX ELF：5~15s）
  // 性能对比展示（切换后关键数据）
  beforeAfterMetrics: BeforeAfterMetrics;
}

export interface CutoverStep {
  id: string;
  description: string;
  side: 'vmware' | 'smartx' | 'both';
  durationMs: number;
  visualEffect: string;   // 触发的3D动画效果
}

export const CUTOVER_STEPS: CutoverStep[] = [
  {
    id: 'stop_incremental',
    description: '停止增量同步，等待最后一批脏块传输完成',
    side: 'both',
    durationMs: 2000,
    visualEffect: 'data_cable_slowdown',  // 电缆脉冲逐渐减慢
  },
  {
    id: 'vmware_shutdown',
    description: '向 VMware 源端发送关机指令',
    side: 'vmware',
    durationMs: 8000,  // 模拟关机耗时
    visualEffect: 'rack_lights_shutdown',  // 左侧机架灯逐一熄灭
  },
  {
    id: 'final_delta_sync',
    description: '同步最终增量数据（关机后产生的最后脏块）',
    side: 'both',
    durationMs: 1500,
    visualEffect: 'data_cable_final_pulse',  // 最后一次强脉冲
  },
  {
    id: 'smartx_boot',
    description: 'SmartX ELF 虚拟化平台拉起虚拟机',
    side: 'smartx',
    durationMs: 5000,  // ELF快速启动
    visualEffect: 'rack_lights_boot_green',  // 右侧机架灯由黄转绿
  },
  {
    id: 'network_reconnect',
    description: '更新 DNS/ARP 表，业务IP切换至SmartX',
    side: 'smartx',
    durationMs: 1000,
    visualEffect: 'network_reroute_animation',
  },
  {
    id: 'service_verify',
    description: '自动化服务验证（HTTP探活/数据库连接测试）',
    side: 'smartx',
    durationMs: 3000,
    visualEffect: 'service_check_scanlines',
  },
];

export interface BeforeAfterMetrics {
  bootTimeSeconds: { vmware: number; smartx: number };  // 如 65s vs 8s
  iopsAtPeak: { vmware: number; smartx: number };       // 如 5000 vs 18000
  latencyMs: { vmware: number; smartx: number };        // 如 3.2ms vs 0.4ms
  memoryOverheadMB: { vmware: number; smartx: number }; // VMware：128MB/VM；SmartX：40MB/VM
  cpuOverheadPercent: { vmware: number; smartx: number };
}

// 游戏动画导演：控制Cutover全流程的3D表演
export class CutoverDirector {
  async executeCutover(task: MigrationTask): Promise<void> {
    for (const step of CUTOVER_STEPS) {
      // 触发对应3D动画
      EventBus.emit(`fx:${step.visualEffect}`, { vmId: task.vmId });
      // 更新UI进度
      EventBus.emit('ui:cutover_step', { stepId: step.id, status: 'running' });
      await delay(step.durationMs);
      EventBus.emit('ui:cutover_step', { stepId: step.id, status: 'done' });
    }

    // 最终：展示性能对比弹窗（游戏高潮时刻）
    const metrics = this.calculatePerformanceGains(task);
    EventBus.emit('ui:show_performance_comparison', metrics);
    EventBus.emit('fx:victory_particle_burst', { color: '#00FF88' });
    EventBus.emit('audio:play_success_fanfare');
  }
}
```

---

## 四、断点续传系统（关键技术知识点）

```typescript
// client/src/simulation/CheckpointResumeSystem.ts

/**
 * SmartX迁移断点续传技术
 * 教学目标：展示SmartX相比VMware热迁移中断后必须重头开始的优势
 */

export interface MigrationCheckpoint {
  taskId: string;
  vmId: string;
  timestamp: number;
  // 数据传输断点
  lastCompletedBlockOffset: number;   // 已完成的块偏移（字节）
  transferredBlocks: number[];         // 已完成块的位图索引
  totalBlocks: number;
  // 网络状态记录
  networkMetricsAtFailure: {
    packetLoss: number;
    jitterMs: number;
    failureReason: string;
  };
  // 迁移元数据（续传时不需要重新扫描）
  cachedVMMetadata: DiscoveredVM;
  networkMappingSnapshot: NetworkMapping;
  storageMappingSnapshot: StorageMapping;
}

export type ResumeStrategy = 
  | 'FROM_CHECKPOINT'     // 从断点继续（SmartX默认，推荐）
  | 'RESTART_INCREMENTAL' // 仅重做增量同步（适用于已完成全量同步的情况）
  | 'FULL_RESTART';       // 完全重新开始（VMware传统方式）

export class CheckpointResumeSystem {
  private checkpoints: Map<string, MigrationCheckpoint[]> = new Map();

  // 每60秒自动保存断点
  saveCheckpoint(task: MigrationTask): void {
    const checkpoint: MigrationCheckpoint = {
      taskId: task.id,
      vmId: task.vmId,
      timestamp: Date.now(),
      lastCompletedBlockOffset: task.progress.dataTransferredGB * 1024 * 1024 * 1024 / 4,
      transferredBlocks: this.getCompletedBlockBitmap(task),
      totalBlocks: task.progress.dataTotalGB * 1024 * 1024 * 1024 / 4,
      networkMetricsAtFailure: { packetLoss: 0, jitterMs: 0, failureReason: '' },
      cachedVMMetadata: {} as any,
      networkMappingSnapshot: task.networkMapping!,
      storageMappingSnapshot: task.storageMapping!,
    };

    const history = this.checkpoints.get(task.id) || [];
    history.push(checkpoint);
    // 只保留最近5个断点
    this.checkpoints.set(task.id, history.slice(-5));

    // 持久化到 Redis（后端）
    socketClient.emit('checkpoint:save', checkpoint);
  }

  // 计算续传节省的时间（游戏中展示SmartX优势）
  calculateTimeSaved(checkpoint: MigrationCheckpoint): {
    savedPercent: number;
    savedMinutes: number;
    vmwareWouldRestartFrom: string;  // "0%" 表示VMware会从头开始
  } {
    const progress = checkpoint.transferredBlocks.length / checkpoint.totalBlocks;
    const totalEstimatedMinutes = (checkpoint.totalBlocks * 4) / 1024 / 800 * 60; // 800MB/s速率
    return {
      savedPercent: Math.round(progress * 100),
      savedMinutes: Math.round(progress * totalEstimatedMinutes),
      vmwareWouldRestartFrom: '0%',
    };
  }

  // 游戏关卡：断点续传剧情触发
  async handleNetworkFault(task: MigrationTask, faultType: 'link_down' | 'packet_loss' | 'timeout'): Promise<void> {
    // 1. 保存当前断点
    this.saveCheckpoint(task);
    const checkpoint = this.getLatestCheckpoint(task.id)!;

    // 2. 播放故障动画：数据电缆断裂特效
    EventBus.emit('fx:data_cable_break', { taskId: task.id, faultType });
    EventBus.emit('ui:show_fault_dialog', {
      title: '网络中断！',
      description: `已安全保存迁移进度（${Math.round(task.progress.fullSyncPercent)}%）`,
      options: [
        { id: 'resume', label: '网络恢复后自动续传', recommended: true, isSmartXWay: true },
        { id: 'restart', label: '重新开始传输', recommended: false, isSmartXWay: false },
      ],
    });

    // 3. 玩家选择续传方案
    const choice = await UIManager.waitForUserChoice(['resume', 'restart']);

    if (choice === 'resume') {
      // SmartX断点续传：从上次断点继续
      const saved = this.calculateTimeSaved(checkpoint);
      EventBus.emit('ui:show_resume_summary', {
        message: `✅ 断点续传：跳过已完成的 ${saved.savedPercent}% 数据，节省 ${saved.savedMinutes} 分钟`,
        vmwareComparison: `VMware 热迁移中断后需要从 0% 重新开始`,
      });
      await this.resumeFromCheckpoint(task, checkpoint);
    } else {
      // 惩罚：重头开始，展示对比
      EventBus.emit('ui:show_penalty', {
        message: '进度归零。SmartX 的断点续传功能可以避免此类浪费。',
        scorePenalty: -200,
      });
      await this.restartTransfer(task);
    }
  }

  private getLatestCheckpoint(taskId: string): MigrationCheckpoint | null {
    const history = this.checkpoints.get(taskId);
    return history ? history[history.length - 1] : null;
  }

  private getCompletedBlockBitmap(task: MigrationTask): number[] {
    const completedCount = Math.floor(task.progress.dataTransferredGB * 1024 / 4);
    return Array.from({ length: completedCount }, (_, i) => i);
  }

  private async resumeFromCheckpoint(task: MigrationTask, checkpoint: MigrationCheckpoint): Promise<void> {
    // 恢复传输：跳过已完成块
    EventBus.emit('fx:data_cable_reconnect', { taskId: task.id });
    socketClient.emit('migration:resume', { taskId: task.id, checkpointOffset: checkpoint.lastCompletedBlockOffset });
  }

  private async restartTransfer(task: MigrationTask): Promise<void> {
    socketClient.emit('migration:restart', { taskId: task.id });
  }
}
```

---

## 五、切换后验证系统（POST_CHECK）

```typescript
// client/src/simulation/phases/PostCheckPhase.ts

/**
 * 迁移完成后的自动化验证
 * 游戏中：玩家可选择手动逐项验证（高分）或自动验证（低分）
 */

export interface PostCheckItem {
  id: string;
  name: string;
  checkType: 'network' | 'service' | 'performance' | 'data_integrity';
  method: string;         // 验证方法技术说明
  expectedResult: string;
  actualResult?: string;
  status: 'pending' | 'checking' | 'pass' | 'fail';
  scoreWeight: number;    // 手动验证权重（对应游戏得分）
}

export const POST_CHECK_ITEMS: PostCheckItem[] = [
  {
    id: 'network_ping',
    name: '网络连通性',
    checkType: 'network',
    method: 'ICMP Ping + TCP 80/443 探活',
    expectedResult: '响应时间 < 1ms（同机房）',
    status: 'pending',
    scoreWeight: 10,
  },
  {
    id: 'service_http',
    name: 'Web 服务可用性',
    checkType: 'service',
    method: 'HTTP GET 返回 200，响应时间 < 200ms',
    expectedResult: 'HTTP 200 OK',
    status: 'pending',
    scoreWeight: 20,
  },
  {
    id: 'db_connection',
    name: '数据库连接',
    checkType: 'service',
    method: 'TCP 连接 + SELECT 1 查询',
    expectedResult: '连接成功，查询 < 5ms',
    status: 'pending',
    scoreWeight: 25,
  },
  {
    id: 'iops_baseline',
    name: 'I/O 性能基准',
    checkType: 'performance',
    method: 'fio 随机读写测试（30秒）',
    expectedResult: 'IOPS > 迁移前 115%（SmartX NVMe优化）',
    status: 'pending',
    scoreWeight: 20,
  },
  {
    id: 'data_checksum',
    name: '数据完整性校验',
    checkType: 'data_integrity',
    method: 'MD5 校验关键数据文件',
    expectedResult: '与迁移前一致，无数据丢失',
    status: 'pending',
    scoreWeight: 25,
  },
];
```

---

## 六、游戏音效与氛围系统

```typescript
// client/src/audio/DataCenterAudio.ts

export interface AudioConfig {
  ambientSounds: {
    serverHum: { file: string; volume: number; loop: true };      // 服务器风扇轰鸣
    acUnit: { file: string; volume: number; loop: true };          // 空调制冷声
    coldAisleWhoosh: { file: string; volume: number; loop: true }; // 冷风道气流
  };
  interactionSounds: {
    cableInsert: string;       // 插网线音效
    keyboardClick: string;     // 配置参数时的键盘声
    scanBeep: string;          // 扫描VM时的扫描音
    alertBeep: string;         // 警告音（存储配置错误）
    dataTransferHum: string;   // 数据传输时的"电流"声
    cutoverClick: string;      // 扳下电闸的机械音
    bootupChime: string;       // SmartX VM启动成功音效
    vmShutdown: string;        // VMware VM关机电流声
  };
  musicTracks: {
    menuBgm: string;
    level1_tension: string;    // 低压迷离，适合迁移专注操作
    level3_urgent: string;     // 高压紧张，灾难恢复关卡
    cutover_climax: string;    // 高潮音乐（Cutover时播放）
    victory: string;
    failure: string;
  };
}
```

---

## 七、评分系统（与真实迁移质量绑定）

```typescript
// client/src/engine/ScoringSystem.ts

export interface ScoreBreakdown {
  total: number;
  categories: {
    speed: number;              // 完成速度（占30%）
    correctness: number;        // 配置正确性（占30%）
    businessContinuity: number; // 业务连续性（占25%）
    smartxFeatureUsage: number; // SmartX功能使用（占15%）
  };
  bonuses: ScoreBonus[];
  penalties: ScorePenalty[];
}

export interface ScoreBonus {
  reason: string;
  points: number;
  examples: string[];  // 如 "使用断点续传: +150", "存储配置完全正确: +200"
}

export interface ScorePenalty {
  reason: string;
  points: number;  // 负数
}

export const SCORING_RULES = {
  // 奖励：使用SmartX特性
  USED_IO_LOCALITY:        { points: +150, reason: '启用I/O本地化，延迟降低30%' },
  USED_RDMA:               { points: +200, reason: '启用RDMA加速，吞吐提升2x' },
  USED_CHECKPOINT_RESUME:  { points: +150, reason: '使用断点续传，节省重传时间' },
  USED_BANDWIDTH_LIMITER:  { points: +100, reason: '合理控制迁移带宽，保障生产业务' },
  PERFECT_STORAGE_MAPPING: { points: +200, reason: '所有VM存储配置完全匹配工作负载类型' },
  ZERO_DOWNTIME:           { points: +300, reason: '迁移全程业务零中断' },
  AGENTLESS_AWARENESS:     { points: +50,  reason: '未尝试在源VM安装任何agent（理解Agentless特性）' },

  // 惩罚：错误操作
  WRONG_STORAGE_TIER:      { points: -200, reason: '数据库VM放置到HDD存储池，性能严重下降' },
  IGNORED_SNAPSHOT_WARNING:{ points: -100, reason: '未合并快照直接迁移，速度降低40%' },
  MANUAL_RESTART_TRANSFER: { points: -150, reason: '网络中断后选择重新传输，而非断点续传' },
  NETWORK_CONGESTION:      { points: -100, reason: '迁移带宽未限速，导致生产业务延迟飙升' },
  WRONG_NETWORK_MAPPING:   { points: -300, reason: '网络映射错误，VM启动后网络不通' },
};
```

---

## 八、UI设计规范（暗色调+荧光蓝 CloudTower风格）

```typescript
// client/src/theme/cloudtower.theme.ts

export const CLOUDTOWER_THEME = {
  colors: {
    bg: {
      primary: '#0A0E1A',      // 深海军蓝（主背景）
      secondary: '#111827',    // 机架背景
      panel: '#1A2035',        // 面板背景
      panelBorder: '#1E3A5F',  // 面板边框
    },
    accent: {
      primary: '#00B4FF',      // SmartX荧光蓝（主操作按钮）
      success: '#00E676',      // 成功/在线（绿）
      warning: '#FFB300',      // 警告（黄）
      error: '#FF1744',        // 错误/故障（红）
      vmware: '#717171',       // VMware侧：灰色（代表"旧"）
      smartx: '#00B4FF',       // SmartX侧：蓝色（代表"新"）
    },
    text: {
      primary: '#E8EFF7',      // 主文字（近白）
      secondary: '#7A9CC0',    // 次要文字（蓝灰）
      muted: '#3D5A80',        // 禁用/次要
      code: '#00E676',         // 技术参数/数值（绿色等宽字体）
    },
    heatmap: {
      cold: '#0040FF',         // 低利用率（蓝）
      normal: '#00CC44',       // 正常（绿）
      warm: '#FF9900',         // 较高（橙）
      hot: '#FF1100',          // 过载（红）
    },
  },
  typography: {
    fontMono: '"JetBrains Mono", "Fira Code", monospace',  // 数据/参数
    fontDisplay: '"Rajdhani", "Orbitron", sans-serif',      // 标题/HUD
    fontBody: '"Inter", "Noto Sans SC", sans-serif',        // 正文
  },
  // 进度条风格（参考CloudTower真实控制台）
  progressBar: {
    height: '4px',
    borderRadius: '2px',
    background: '#1E3A5F',
    fill: 'linear-gradient(90deg, #0066CC, #00B4FF)',
    shimmer: true,  // 扫光动画
  },
  // 迁移状态指示灯
  statusDots: {
    idle:       '#3D5A80',
    scanning:   '#00B4FF',  // 蓝色闪烁
    migrating:  '#FFB300',  // 黄色呼吸
    completed:  '#00E676',  // 绿色常亮
    failed:     '#FF1744',  // 红色快闪
  },
};
```

---

## 九、AI 助手实现补充指引

### 新增实现优先级（在主文档 P0~P3 基础上追加）

```
P1.5（FPS机制，插入P1和P2之间）:
  ├── fps/PlayerController.ts           → 移动、视角、Zone检测
  ├── fps/ToolSystem.ts                 → 6种工具装备系统
  ├── fps/InteractionSystem.ts          → E键交互、准星检测
  └── fps/HeadBobSystem.ts              → 镜头晃动（冷风道增强）

P2（迁移系统，细化）:
  ├── simulation/MigrationStateMachine.ts  → 状态机（10个状态）
  ├── simulation/phases/EnvScanPhase.ts    → ESXi扫描
  ├── simulation/phases/CompatibilityCheckPhase.ts
  ├── simulation/phases/NetworkMappingPhase.ts  → 3D划线操作
  ├── simulation/phases/StorageMappingPhase.ts  → 拖拽+爆红警告
  ├── simulation/phases/DataSyncPhase.ts        → 全量/增量同步
  ├── simulation/phases/DriverInjectionPhase.ts → virt-v2v注入
  ├── simulation/phases/CutoverPhase.ts         → 切换导演
  ├── simulation/phases/PostCheckPhase.ts       → 迁移后验证
  └── simulation/CheckpointResumeSystem.ts      → 断点续传

P3（体验层，细化）:
  ├── engine/ScoringSystem.ts     → 与SmartX功能使用深度绑定的评分
  ├── audio/DataCenterAudio.ts    → 全套音效
  ├── theme/cloudtower.theme.ts   → CloudTower风格UI
  └── components/MigrationToolUI/ → 1:1还原的迁移工具界面
```

### 关键约束补充
- **SmartX 技术差异必须体现**：所有与 VMware 的对比，SmartX 的优势值需具体量化（如启动时间 65s vs 8s）
- **无代理（Agentless）贯穿始终**：驱动注入时不得提示用户"登录VM安装软件"
- **断点续传是必选项**：网络中断故障处理，SmartX续传路径必须比重新传输节省>50%时间
- **存储错误配置必须爆红**：数据库VM放HDD池时，红色警告动画不可跳过
- **音效与3D动画同步**：Cutover电闸动作与灯光熄灭/亮起严格帧同步（±50ms内）

---

*文档版本：2.0 | 生成日期：2026-04-23 | 配套主架构文档 v1.0*
