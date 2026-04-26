/**
 * 应用入口：Three.js 场景 + FPS 输入 + 事件驱动的迁移剧情 + React UI。
 *
 * 教程关玩法：
 *  1. 玩家站在指挥台。走到"vCenter 控制台"，按 E。
 *  2. UI 弹出登录面板 → 玩家提交 → 服务端/本地扫描 → 兼容性报告。
 *  3. 玩家穿过走廊进入【网络间】，与网络控制台交互 → 完成网络映射。
 *  4. 进入【存储间】，与存储控制台交互 → 完成存储映射。
 *  5. 回到指挥台【切换控制台】，按 E 启动全量/增量同步、驱动注入、切换、验证。
 *  6. 结算面板显示分数。
 */
import * as THREE from 'three';
import { EventBus } from './core/EventBus';
import { CLOUDTOWER_THEME } from './theme/cloudtower.theme';
import { apiClient } from './net/apiClient';
import { socketClient } from './net/socketClient';
import { CollisionSystem } from './fps/CollisionSystem';
import { PlayerController, type InputState } from './fps/PlayerController';
import { HeadBobSystem } from './fps/HeadBobSystem';
import { ToolSystem } from './fps/ToolSystem';
import { InteractionSystem } from './fps/InteractionSystem';
import { MigrationStateMachine, type MigrationTask } from './simulation/MigrationStateMachine';
import { EnvScanPhase } from './simulation/phases/EnvScanPhase';
import { CompatibilityCheckPhase } from './simulation/phases/CompatibilityCheckPhase';
import {
  NetworkMappingPhase,
  type VSwitchNode,
  type BridgeNode,
} from './simulation/phases/NetworkMappingPhase';
import {
  StorageMappingPhase,
  type StoragePool,
  type VMWorkloadType,
} from './simulation/phases/StorageMappingPhase';
import { DataSyncPhase, SYNC_CHALLENGES } from './simulation/phases/DataSyncPhase';
import { DriverInjectionPhase } from './simulation/phases/DriverInjectionPhase';
import { FaultInjectionPhase } from './simulation/phases/FaultInjectionPhase';
import { CutoverDirector } from './simulation/phases/CutoverPhase';
import { PostCheckPhase } from './simulation/phases/PostCheckPhase';
import { CheckpointResumeSystem } from './simulation/CheckpointResumeSystem';
import { ScoringSystem } from './engine/ScoringSystem';
import { DataCenterAudio } from './audio/DataCenterAudio';
import { buildTutorialLevelAsync, ZoneManager } from './engine/TutorialLevel';
import { sharedAssetLoader } from './engine/AssetLoader';
import { configurePbrRenderer } from './engine/PbrRenderer';
import { installRoomEnvironment } from './engine/EnvironmentLighting';
import { PostFx } from './engine/PostFx';
import { ToolViewmodel } from './fps/ToolViewmodel';
import { UIManager } from './ui/UIManager';
import { mountReactUi } from './ui/ReactUi';
import { uiStore } from './ui/uiStore';
import type { ESXiScanResult, DiscoveredVM } from './simulation/phases/EnvScanPhase';

/** === Three.js 渲染基座 === */
function setupScene(container: HTMLElement): {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  postFx: PostFx | null;
  setSize: (w: number, h: number) => void;
} {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(CLOUDTOWER_THEME.colors.bg.primary);
  // PBR 基线：PCFSoft 阴影 + ACES tone mapping + sRGB 输出
  configurePbrRenderer(renderer);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(CLOUDTOWER_THEME.colors.bg.primary, 10, 50);
  // 程序化 IBL：让 MeshStandardMaterial 的金属/反射立刻生效
  installRoomEnvironment(renderer, scene);

  const camera = new THREE.PerspectiveCamera(
    75,
    container.clientWidth / container.clientHeight,
    0.05,
    100,
  );
  camera.position.set(0, 1.65, 3);

  // 后处理：Bloom + SMAA。无 WebGL 时优雅降级到 null。
  const postFx = PostFx.tryAttach(renderer, scene, camera);

  const setSize = (w: number, h: number): void => {
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    postFx?.setSize(w, h, renderer.getPixelRatio());
  };

  window.addEventListener('resize', () => {
    setSize(container.clientWidth, container.clientHeight);
  });

  return { renderer, scene, camera, postFx, setSize };
}

/** === 键盘/鼠标输入聚合 === */
function setupInput(domElement: HTMLElement): {
  getInput: () => InputState;
  isPointerLocked: () => boolean;
} {
  const keys = new Set<string>();
  let mouseDX = 0;
  let mouseDY = 0;

  domElement.addEventListener('click', () => {
    domElement.requestPointerLock?.();
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === domElement) {
      mouseDX += e.movementX ?? 0;
      mouseDY += e.movementY ?? 0;
    }
  });
  window.addEventListener('keydown', (e) => keys.add(e.code));
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  const getInput = (): InputState => {
    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const input: InputState = {
      forward,
      strafe,
      jump: keys.has('Space'),
      sprint: keys.has('ShiftLeft'),
      crouch: keys.has('ControlLeft'),
      mouseDX,
      mouseDY,
    };
    mouseDX = 0;
    mouseDY = 0;
    return input;
  };

  return { getInput, isPointerLocked: () => document.pointerLockElement === domElement };
}

/** === 事件驱动迁移控制器 === */
class MigrationFlowController {
  private task: MigrationTask | null = null;
  private envResult: ESXiScanResult | null = null;
  private primaryVm: (DiscoveredVM & { workloadType: VMWorkloadType }) | null = null;

  private envScan = new EnvScanPhase();
  private compat = new CompatibilityCheckPhase();
  private faultInjection = new FaultInjectionPhase();
  private networkPhase: NetworkMappingPhase | null = null;
  private storagePhase: StorageMappingPhase | null = null;

  private storagePools: StoragePool[] = [
    {
      id: 'pool-nvme',
      name: 'NVMe-Pool-01',
      tier: 'nvme',
      totalTB: 10,
      availableTB: 8,
      maxIOPS: 400000,
      avgLatencyMs: 0.3,
      ioLocalitySupport: true,
      rdmaSupport: true,
      color: '#FFD700',
    },
    {
      id: 'pool-ssd',
      name: 'SSD-Pool-01',
      tier: 'ssd',
      totalTB: 20,
      availableTB: 15,
      maxIOPS: 120000,
      avgLatencyMs: 1.0,
      ioLocalitySupport: true,
      rdmaSupport: false,
      color: '#C0C0C0',
    },
    {
      id: 'pool-hdd',
      name: 'HDD-Pool-01',
      tier: 'hdd',
      totalTB: 50,
      availableTB: 35,
      maxIOPS: 2500,
      avgLatencyMs: 12,
      ioLocalitySupport: false,
      rdmaSupport: false,
      color: '#CD7F32',
    },
  ];

  constructor(
    private readonly fsm: MigrationStateMachine,
    private readonly scoring: ScoringSystem,
    private readonly checkpoints: CheckpointResumeSystem,
  ) {}

  private setObjective(text: string): void {
    uiStore.patchHud({ objective: text });
  }

  get stage(): 'idle' | 'awaiting-scan' | 'awaiting-network' | 'awaiting-storage' | 'awaiting-cutover' | 'running' | 'done' {
    if (!this.task) return 'idle';
    const s = this.task.state;
    if (s === 'IDLE') return 'awaiting-scan';
    if (s === 'COMPATIBILITY_CHECK' || s === 'NETWORK_MAPPING') return 'awaiting-network';
    if (s === 'STORAGE_MAPPING') return 'awaiting-storage';
    if (s === 'PRE_SNAPSHOT') return 'awaiting-cutover';
    if (s === 'COMPLETED' || s === 'FAILED') return 'done';
    return 'running';
  }

  /** 阶段 1+2：登录 + 扫描 + 兼容性报告 */
  async onCommandConsole(): Promise<void> {
    if (this.stage !== 'idle' && this.stage !== 'awaiting-scan') {
      UIManager.toast('info', '当前阶段不需要回到指挥台 vCenter 控制台');
      return;
    }
    if (!this.task) {
      this.task = this.fsm.createTask('vm-1000', 'vm-db-01', 120);
      uiStore.patchHud({ state: this.task.state });
    }
    this.setObjective('在 UI 中输入 vCenter 凭据');
    const cred = await UIManager.showVCenterLoginPanel();
    this.fsm.transition(this.task.id, 'ENV_SCAN');
    uiStore.patchHud({ state: 'ENV_SCAN' });

    uiStore.openScanProgress();
    const env = await this.envScan.execute(cred);
    uiStore.closeScanProgress();
    this.envResult = env;
    await UIManager.showScanResultsPanel(env);

    // 故障注入：随机植入 1-2 个真实迁移场景中的故障，玩家用工具修复或忽略
    await this.runFaultInjection(env);

    // 兼容性检查
    this.fsm.transition(this.task.id, 'COMPATIBILITY_CHECK');
    uiStore.patchHud({ state: 'COMPATIBILITY_CHECK' });
    await this.compat.execute(env.vms);
    const issues = env.vms
      .filter((v) => v.snapshotExists)
      .map((v) => ({
        vmName: v.name,
        severity: 'warn' as const,
        message: '存在未合并的快照，建议合并后再迁移（不阻塞）。',
      }));
    await UIManager.showCompatibilityReport(env.vms, issues);

    this.fsm.transition(this.task.id, 'NETWORK_MAPPING');
    uiStore.patchHud({ state: 'NETWORK_MAPPING' });
    this.setObjective('前往 [网络间] 与网络控制台交互（左侧走廊尽头）');
    UIManager.toast('info', '前往网络间配置 vSwitch → Bridge 映射');
  }

  /** 阶段 3：网络映射 */
  async onNetworkConsole(): Promise<void> {
    if (!this.task || !this.envResult) {
      UIManager.toast('warn', '请先在指挥台与 vCenter 控制台交互');
      return;
    }
    if (this.task.state !== 'NETWORK_MAPPING') {
      UIManager.toast('info', '网络映射阶段已完成或尚未到达');
      return;
    }
    const sources: VSwitchNode[] = this.envResult.networks.map((n, i) => ({
      id: `vsw-${i}`,
      name: `vSwitch${i}`,
      portGroups: [n.name],
      vlanIds: n.vlanId ? [n.vlanId] : [],
      position3D: [-5, 1, i - 1],
      connected: false,
    }));
    const targets: BridgeNode[] = sources.map((_, i) => ({
      id: `br-${i}`,
      name: `brbond${i}`,
      type: 'distributed',
      availableBandwidthGbps: 10,
      position3D: [5, 1, i - 1],
    }));
    this.networkPhase = new NetworkMappingPhase(sources, targets);
    const { mappings } = await UIManager.showNetworkMappingPanel(sources, targets);
    // 复刻到阶段引擎内以触发校验/事件
    for (const m of mappings) {
      const src = sources.find((s) => s.name === m.sourceVSwitch);
      const tgt = targets.find((t) => t.name === m.targetBridgeName);
      if (src && tgt) this.networkPhase.attemptMapping(src.id, tgt.id);
    }
    this.task.networkMapping = mappings[0] ?? null;
    this.fsm.transition(this.task.id, 'STORAGE_MAPPING');
    uiStore.patchHud({ state: 'STORAGE_MAPPING' });
    this.setObjective('前往 [存储间] 与存储控制台交互（右侧走廊尽头）');
    UIManager.toast('info', '网络映射完成，前往存储间');
  }

  /** 阶段 4：存储映射 */
  async onStorageConsole(): Promise<void> {
    if (!this.task || !this.envResult) {
      UIManager.toast('warn', '请先完成前置步骤');
      return;
    }
    if (this.task.state !== 'STORAGE_MAPPING') {
      UIManager.toast('info', '存储映射阶段不在此时');
      return;
    }
    const primary = this.envResult.vms[0];
    this.primaryVm = { ...primary, workloadType: 'DATABASE' };
    this.storagePhase = new StorageMappingPhase(this.storagePools);
    const submission = await UIManager.showStorageMappingPanel(this.primaryVm, this.storagePools);
    const { mapping, warning } = this.storagePhase.assign(this.primaryVm, submission.poolId, {
      ioLocality: submission.ioLocality,
      rdma: submission.rdma,
    });
    this.task.storageMapping = mapping;
    this.task.storageWarning = warning;
    if (submission.ioLocality) this.scoring.apply('USED_IO_LOCALITY');
    if (submission.rdma) this.scoring.apply('USED_RDMA');
    if (!warning) this.scoring.apply('PERFECT_STORAGE_MAPPING');
    if (warning?.type === 'PERFORMANCE_DOWNGRADE') this.scoring.apply('WRONG_STORAGE_TIER');
    uiStore.patchHud({ score: this.currentScore() });

    this.fsm.transition(this.task.id, 'PRE_SNAPSHOT');
    uiStore.patchHud({ state: 'PRE_SNAPSHOT' });
    this.setObjective('返回 [指挥台] 启动切换控制台');
    UIManager.toast('info', '存储映射完成，回到指挥台启动切换');
  }

  /** 阶段 5+6+7+8：同步/驱动/切换/验证 */
  async onCutoverConsole(): Promise<void> {
    if (!this.task || !this.envResult) {
      UIManager.toast('warn', '尚未完成前置配置');
      return;
    }
    if (this.task.state !== 'PRE_SNAPSHOT') {
      UIManager.toast('info', '切换阶段不在此时');
      return;
    }
    const primary = this.envResult.vms[0];
    this.setObjective('全量同步进行中…');
    this.fsm.transition(this.task.id, 'FULL_SYNC');
    uiStore.patchHud({ state: 'FULL_SYNC' });

    const sync = new DataSyncPhase();
    sync.start(this.task, 1000, 200);
    // 挑战事件：同步进度到 30% 时触发
    let challengeFired = false;
    const progressSub = EventBus.on('migration:progress', ({ progress }: { progress: MigrationTask['progress'] }) => {
      uiStore.patchHud({
        fullSyncPercent: progress.fullSyncPercent,
        incrementalRounds: progress.incrementalRounds,
      });
      if (!challengeFired && progress.fullSyncPercent >= 30 && progress.fullSyncPercent < 80) {
        challengeFired = true;
        void this.runChallenge();
      }
    });
    await new Promise<void>((resolve) => {
      const sub = EventBus.on('migration:progress', ({ progress }: { progress: MigrationTask['progress'] }) => {
        if (progress.fullSyncPercent >= 90) {
          sub();
          resolve();
        }
      });
    });
    sync.stop();
    progressSub();
    this.checkpoints.saveCheckpoint(this.task);

    this.setObjective('增量同步中…');
    this.fsm.transition(this.task.id, 'INCREMENTAL_SYNC');
    uiStore.patchHud({ state: 'INCREMENTAL_SYNC' });
    await sync.runIncrementalRounds(this.task);

    this.setObjective('注入 VirtIO 驱动…');
    this.fsm.transition(this.task.id, 'DRIVER_INJECTION');
    uiStore.patchHud({ state: 'DRIVER_INJECTION' });
    const driver = new DriverInjectionPhase();
    const plan = driver.planFor(primary.guestOS, primary.moRef);
    await driver.execute(this.task, plan);

    this.setObjective('切换中…');
    this.fsm.transition(this.task.id, 'CUTOVER_READY');
    this.fsm.transition(this.task.id, 'CUTOVER_EXECUTING');
    uiStore.patchHud({ state: 'CUTOVER_EXECUTING' });
    const director = new CutoverDirector();
    await director.executeCutover(this.task);

    this.fsm.transition(this.task.id, 'POST_CHECK');
    uiStore.patchHud({ state: 'POST_CHECK' });
    const pc = new PostCheckPhase();
    await pc.runAuto();

    this.fsm.transition(this.task.id, 'COMPLETED');
    uiStore.patchHud({ state: 'COMPLETED' });
    this.scoring.apply('ZERO_DOWNTIME');
    this.scoring.apply('AGENTLESS_AWARENESS');
    const breakdown = this.scoring.finalize();
    uiStore.patchHud({ score: breakdown.total });
    this.setObjective('迁移完成！');
    UIManager.showScorePanel(breakdown);
    console.log('[SmartX] Migration completed. Score:', breakdown);
  }

  private async runChallenge(): Promise<void> {
    const ch = SYNC_CHALLENGES[0];
    EventBus.emit('ui:show_sync_challenge', ch);
    const resp = await UIManager.showSyncChallengeModal(ch);
    if (resp.isSmartXWay) {
      this.scoring.apply('USED_CHECKPOINT_RESUME');
    } else if (resp.id === 'restart_transfer') {
      this.scoring.apply('MANUAL_RESTART_TRANSFER');
    }
    uiStore.patchHud({ score: this.currentScore() });
    UIManager.toast(resp.isSmartXWay ? 'info' : 'warn', resp.effect);
  }

  /**
   * 扫描后弹出故障面板：玩家针对每条故障选择"用工具修复"或"忽略"。
   * UI 只回传选择，真正的判定走 `FaultInjectionPhase.resolve()` —— 业务规则在阶段引擎里集中维护。
   */
  private async runFaultInjection(env: ESXiScanResult): Promise<void> {
    const faults = this.faultInjection.inject(env);
    if (faults.length === 0) return;
    this.setObjective(`检测到 ${faults.length} 个故障，请在面板中处理`);
    const choices = await UIManager.showFaultInjectionPanel(faults);
    let fixed = 0;
    let ignored = 0;
    for (const choice of choices) {
      const fault = faults.find((f) => f.id === choice.faultId);
      if (!fault) continue;
      const tool = choice.action === 'use' ? fault.def.requiredTool : null;
      const resolution = this.faultInjection.resolve(fault, tool);
      if (resolution.rule) this.scoring.apply(resolution.rule);
      if (resolution.resolved) fixed++;
      else if (resolution.toolUsed === null) ignored++;
    }
    uiStore.patchHud({ score: this.currentScore() });
    if (fixed > 0) UIManager.toast('info', `已修复 ${fixed} 项故障，得分已加`);
    if (ignored > 0) UIManager.toast('warn', `${ignored} 项故障被忽略，已扣分`);
  }

  private currentScore(): number {
    return this.scoring.finalize().total;
  }
}

/** === 启动 === */
async function bootstrap(): Promise<void> {
  const container = document.getElementById('app')!;
  const uiRoot = document.getElementById('ui-root')!;
  mountReactUi(uiRoot);

  const { renderer, scene, camera, postFx } = setupScene(container);
  // 摄像机加入场景图，使其 child（如 ToolViewmodel）也参与渲染
  scene.add(camera);
  const collision = new CollisionSystem();

  // 系统
  new DataCenterAudio();
  const scoring = new ScoringSystem();
  const checkpoints = new CheckpointResumeSystem();
  const fsm = new MigrationStateMachine();
  const flow = new MigrationFlowController(fsm, scoring, checkpoints);

  const player = new PlayerController(camera, collision);
  player.state.position.set(0, 0, 3);
  const bob = new HeadBobSystem();
  const tools = new ToolSystem();
  const interaction = new InteractionSystem(player);
  interaction.attach();

  // 资产层 + 第一人称工具视图模型
  const assets = sharedAssetLoader();
  const toolViewmodel = new ToolViewmodel(camera, assets);
  toolViewmodel.attach();

  // 构建教程关（异步：尝试用 GLB 美化控制台/机柜，失败则保留占位）
  const level = await buildTutorialLevelAsync(
    scene,
    collision,
    {
      onCommandConsole: () => void flow.onCommandConsole(),
      onNetworkConsole: () => void flow.onNetworkConsole(),
      onStorageConsole: () => void flow.onStorageConsole(),
      onCutoverConsole: () => void flow.onCutoverConsole(),
    },
    { assets },
  );
  const zoneManager = new ZoneManager(level.zones);
  player.registerInteractable(level.consoles.command);
  player.registerInteractable(level.consoles.network);
  player.registerInteractable(level.consoles.storage);
  player.registerInteractable(level.consoles.cutover);

  // 工具切换：数字键 1-6
  window.addEventListener('keydown', (e) => {
    const n = parseInt(e.key, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 6) {
      tools.equipBySlot(n);
      player.setEquippedTool(tools.current?.type ?? null);
    }
    if (e.code === 'Escape') {
      document.exitPointerLock?.();
    }
  });

  // HUD 绑定
  EventBus.on('interaction:hover', ({ target }: { target: { label: string } | null }) => {
    uiStore.patchHud({ hoverHint: target?.label ?? null });
  });
  EventBus.on('migration:stateChange', ({ next }: { next: MigrationTask['state'] }) => {
    uiStore.patchHud({ state: next });
  });

  // 尝试与服务端建立会话
  if (apiClient.hasBackend()) {
    try {
      await apiClient.login('Player');
      socketClient.connect();
      EventBus.on('migration:created', ({ task }: { task: { id: string } }) => {
        socketClient.subscribe(task.id);
      });
      console.log('[SmartX] backend session established:', apiClient.getBaseUrl());
    } catch (err) {
      console.warn('[SmartX] backend unavailable, falling back to local sim:', err);
    }
  }

  const { getInput } = setupInput(renderer.domElement);

  // 渲染循环
  const clock = new THREE.Clock();
  const tick = (): void => {
    const dt = Math.min(0.1, clock.getDelta());
    player.update(dt, getInput());
    zoneManager.update(player);
    bob.apply(dt, player);
    tools.tick(dt);
    toolViewmodel.update(dt);
    interaction.update();
    uiStore.patchHud({
      zone: player.state.currentZone,
      stamina: player.state.staminaPercent,
      tool: tools.current?.name ?? '',
    });
    if (postFx) postFx.render();
    else renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  tick();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void bootstrap());
  } else {
    void bootstrap();
  }
}
