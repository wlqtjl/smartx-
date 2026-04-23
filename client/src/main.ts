/**
 * 应用入口：演示级别的 3D 场景 + FPS 输入 + 迁移剧情编排。
 * 并非最终游戏关卡，仅为架构验证和手动试玩使用。
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
import { MigrationStateMachine } from './simulation/MigrationStateMachine';
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
import { DataSyncPhase } from './simulation/phases/DataSyncPhase';
import { DriverInjectionPhase } from './simulation/phases/DriverInjectionPhase';
import { CutoverDirector } from './simulation/phases/CutoverPhase';
import { PostCheckPhase } from './simulation/phases/PostCheckPhase';
import { CheckpointResumeSystem } from './simulation/CheckpointResumeSystem';
import { ScoringSystem } from './engine/ScoringSystem';
import { DataCenterAudio } from './audio/DataCenterAudio';

/** === Three.js 渲染基座 === */
function setupScene(container: HTMLElement): {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
} {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(CLOUDTOWER_THEME.colors.bg.primary);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(CLOUDTOWER_THEME.colors.bg.primary, 8, 40);

  // 地面（指挥台）
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x0f1726 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // 环境光
  scene.add(new THREE.HemisphereLight(0x99cfff, 0x0a1a2a, 0.6));
  const dir = new THREE.DirectionalLight(0x88ccff, 0.5);
  dir.position.set(5, 10, 5);
  scene.add(dir);

  // 几个"机架"
  for (let i = 0; i < 6; i++) {
    const rack = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 2, 1.2),
      new THREE.MeshStandardMaterial({
        color: i < 3 ? 0x2a2f3a : 0x1a2035,
        emissive: i < 3 ? 0x111111 : 0x002a4a,
        emissiveIntensity: 0.2,
      }),
    );
    const side = i < 3 ? -1 : 1;
    rack.position.set(side * 3, 1, (i % 3) * 2 - 2);
    scene.add(rack);
  }

  const camera = new THREE.PerspectiveCamera(
    75,
    container.clientWidth / container.clientHeight,
    0.05,
    100,
  );
  camera.position.set(0, 1.65, 5);

  window.addEventListener('resize', () => {
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
  });

  return { renderer, scene, camera };
}

/** === 键盘/鼠标输入聚合 === */
function setupInput(domElement: HTMLElement): {
  getInput: () => InputState;
  reset: () => void;
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

  const reset = (): void => {
    keys.clear();
    mouseDX = 0;
    mouseDY = 0;
  };
  return { getInput, reset };
}

/** === HUD 简易渲染 === */
function updateHud(
  hud: HTMLPreElement,
  player: PlayerController,
  tool: ToolSystem,
): void {
  const p = player.state.position;
  const tip = tool.current ? `${tool.current.name}（冷却 ${tool.current.currentCooldown.toFixed(0)}ms）` : '空手';
  hud.textContent = [
    `SmartX FPS · ${player.state.currentZone}`,
    `pos ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}  stamina ${player.state.staminaPercent.toFixed(0)}%`,
    `tool: ${tip}`,
    `按 1-6 切工具 · E 交互 · Shift 冲刺 · Ctrl 蹲下`,
  ].join('\n');
}

/** === 迁移剧情 demo：串起全流程 === */
async function runMigrationScript(
  fsm: MigrationStateMachine,
  scoring: ScoringSystem,
  checkpoints: CheckpointResumeSystem,
): Promise<void> {
  const task = fsm.createTask('vm-1000', 'vm-db-01', 120);
  fsm.transition(task.id, 'ENV_SCAN');

  const envScan = new EnvScanPhase();
  const env = await envScan.execute({
    host: '10.0.0.1',
    port: 443,
    username: 'administrator@vsphere.local',
    password: '***',
  });

  fsm.transition(task.id, 'COMPATIBILITY_CHECK');
  const compat = new CompatibilityCheckPhase();
  await compat.execute(env.vms);

  fsm.transition(task.id, 'NETWORK_MAPPING');
  const sources: VSwitchNode[] = env.networks.map((n, i) => ({
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
  const netPhase = new NetworkMappingPhase(sources, targets);
  sources.forEach((s, i) => netPhase.attemptMapping(s.id, targets[i].id));
  task.networkMapping = netPhase.state.completedMappings[0];

  fsm.transition(task.id, 'STORAGE_MAPPING');
  const pools: StoragePool[] = [
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
  const storagePhase = new StorageMappingPhase(pools);
  const result = storagePhase.assign(
    { ...env.vms[0], workloadType: 'DATABASE' as VMWorkloadType },
    'pool-nvme',
    { ioLocality: true, rdma: true },
  );
  task.storageMapping = result.mapping;
  task.storageWarning = result.warning;
  scoring.apply('USED_IO_LOCALITY');
  scoring.apply('USED_RDMA');
  scoring.apply('PERFECT_STORAGE_MAPPING');

  fsm.transition(task.id, 'PRE_SNAPSHOT');

  fsm.transition(task.id, 'FULL_SYNC');
  const sync = new DataSyncPhase();
  sync.start(task, 1000, 200);
  // 每 CHECKPOINT_INTERVAL_MS 保存断点
  const CHECKPOINT_INTERVAL_MS = 60_000;
  const checkpointTimer = window.setInterval(
    () => checkpoints.saveCheckpoint(task),
    CHECKPOINT_INTERVAL_MS,
  );
  await new Promise<void>((resolve) => {
    const sub = EventBus.on('migration:progress', ({ progress }) => {
      if (progress.fullSyncPercent >= 90) {
        sub();
        resolve();
      }
    });
  });
  sync.stop();
  window.clearInterval(checkpointTimer);

  fsm.transition(task.id, 'INCREMENTAL_SYNC');
  await sync.runIncrementalRounds(task);

  fsm.transition(task.id, 'DRIVER_INJECTION');
  const driver = new DriverInjectionPhase();
  const plan = driver.planFor(env.vms[0].guestOS, env.vms[0].moRef);
  await driver.execute(task, plan);

  fsm.transition(task.id, 'CUTOVER_READY');
  fsm.transition(task.id, 'CUTOVER_EXECUTING');
  const director = new CutoverDirector();
  await director.executeCutover(task);

  fsm.transition(task.id, 'POST_CHECK');
  const pc = new PostCheckPhase();
  await pc.runAuto();

  fsm.transition(task.id, 'COMPLETED');
  scoring.apply('ZERO_DOWNTIME');
  scoring.apply('AGENTLESS_AWARENESS');
  console.log('[SmartX] Migration completed. Score:', scoring.finalize());
}

/** === 启动 === */
async function bootstrap(): Promise<void> {
  const container = document.getElementById('app')!;
  const hud = document.getElementById('hud') as HTMLPreElement;
  const { renderer, scene, camera } = setupScene(container);

  const collision = new CollisionSystem();
  // 把机架加入碰撞
  scene.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && obj.position.y > 0.1) {
      const box = new THREE.Box3().setFromObject(obj);
      collision.add({ box, solid: true });
    }
  });

  const player = new PlayerController(camera, collision);
  const bob = new HeadBobSystem();
  const tools = new ToolSystem();
  const interaction = new InteractionSystem(player);
  interaction.attach();

  // 工具切换：数字键 1-6
  window.addEventListener('keydown', (e) => {
    const n = parseInt(e.key, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 6) {
      tools.equipBySlot(n);
      player.setEquippedTool(tools.current?.type ?? null);
    }
  });

  // 音效/评分/断点/状态机实例化
  new DataCenterAudio();
  const scoring = new ScoringSystem();
  const checkpoints = new CheckpointResumeSystem();
  const fsm = new MigrationStateMachine();

  // 监听状态变化 → HUD 日志
  EventBus.on('migration:stateChange', ({ prev, next }) => {
    console.log(`[FSM] ${prev} → ${next}`);
  });

  // 尝试与服务端会话建立（可选：未配置 VITE_SMARTX_API 时会静默失败）
  if (apiClient.hasBackend()) {
    try {
      await apiClient.login('Player');
      socketClient.connect();
      // 订阅所有任务事件（演示场景下广播即可）
      EventBus.on('migration:created', ({ task }: { task: { id: string } }) => {
        socketClient.subscribe(task.id);
      });
      console.log('[SmartX] backend session established:', apiClient.getBaseUrl());
    } catch (err) {
      console.warn('[SmartX] backend unavailable, falling back to local sim:', err);
    }
  }

  const { getInput } = setupInput(renderer.domElement);

  // 自动跑一次迁移演示脚本（无需真实 UI）
  runMigrationScript(fsm, scoring, checkpoints).catch((err) =>
    console.error('[migration demo] failed:', err),
  );

  // 渲染循环
  const clock = new THREE.Clock();
  const tick = (): void => {
    const dt = Math.min(0.1, clock.getDelta());
    player.update(dt, getInput());
    bob.apply(dt, player);
    tools.tick(dt);
    interaction.update();
    updateHud(hud, player, tools);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  tick();
}

if (typeof document !== 'undefined') {
  // 浏览器环境才引导；测试/类型校验时 import 不执行 DOM 逻辑
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void bootstrap());
  } else {
    void bootstrap();
  }
}
