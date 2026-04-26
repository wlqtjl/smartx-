/**
 * ToolViewmodel —— 工具/枪支的"第一人称手中模型"。
 *
 * 设计原则（§四.4）：
 *  - 纯订阅者：监听 `EventBus` 的 `tool:switch` / `tool:anim`，**不修改 `ToolSystem` 公共 API**。
 *  - 非阻塞：所有 GLB 加载异步进行；切换瞬间先卸载旧模型，新模型 ready 时再挂载，避免渲染卡顿。
 *  - 优雅降级：若 GLB 缺失，挂一个小的彩色占位 box，让玩家能看到"装备已切换"。
 *  - 第一人称：viewmodel 挂在相机上（child of camera），绕过常规渲染矩阵，避免被场景透视裁剪。
 *
 * 用法：
 *   const vm = new ToolViewmodel(camera, sharedAssetLoader());
 *   vm.attach(); // 订阅事件
 *   // ToolSystem.equip() 会触发 tool:switch，此处自动加载/挂载模型
 *   // ToolSystem.activateSmartProbe() 会触发 tool:anim，此处自动播放对应 clip
 */
import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import type { ToolType, ToolAnimationSet } from './ToolSystem';
import { TOOL_CATALOG } from './ToolSystem';
import type { AssetLoader } from '../engine/AssetLoader';

export interface ToolViewmodelOptions {
  /** 相对相机的位置偏移；默认 "右下握持" */
  offset?: THREE.Vector3;
  /** 占位 box 的颜色（按工具 type 查询） */
  fallbackColor?: Partial<Record<ToolType, number>>;
  /**
   * 工具 GLB 中实际 clip 名 → 我们标准化的动画键的映射表。
   * 多数 Quaternius / Mixamo 的 clip 名不是 `${prefix}_idle` 这种格式，
   * 故支持每个工具自定义一份映射；缺省值见 DEFAULT_ANIMATION_MAP。
   */
  animationMap?: Partial<Record<ToolType, Partial<Record<keyof ToolAnimationSet, string>>>>;
}

const DEFAULT_OFFSET = new THREE.Vector3(0.28, -0.32, -0.55);

const FALLBACK_COLORS: Record<ToolType, number> = {
  SMART_PROBE: 0x00b4ff,
  FIBER_PATCHER: 0x00e1ff,
  DIAGNOSTIC_TABLET: 0x80ff80,
  RECOVERY_KIT: 0xffae00,
  BANDWIDTH_LIMITER: 0xc080ff,
  SNAPSHOT_GUN: 0xff5577,
};

export class ToolViewmodel {
  private readonly group: THREE.Group;
  private currentTool: ToolType | null = null;
  private currentRoot: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private clipsByName: Map<string, THREE.AnimationClip> = new Map();
  /** 防止竞态：切换工具时旧的 load 完成后不能再挂上 */
  private loadGeneration = 0;
  private subscriptions: (() => void)[] = [];
  private readonly fallbackColors: Record<ToolType, number>;
  private readonly animationMap: Required<ToolViewmodelOptions>['animationMap'];

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly assets: AssetLoader,
    opts: ToolViewmodelOptions = {},
  ) {
    this.group = new THREE.Group();
    this.group.name = 'ToolViewmodel';
    this.group.position.copy(opts.offset ?? DEFAULT_OFFSET);
    // viewmodel 不参与场景遮挡 / 相机近裁剪应放进相机自身
    this.camera.add(this.group);
    this.fallbackColors = { ...FALLBACK_COLORS, ...(opts.fallbackColor ?? {}) };
    this.animationMap = opts.animationMap ?? {};
  }

  /** 订阅 EventBus；返回反订阅句柄 */
  attach(): () => void {
    const offSwitch = EventBus.on('tool:switch', (p: { next: ToolType | null }) => {
      void this.equip(p.next);
    });
    const offAnim = EventBus.on(
      'tool:anim',
      (p: { tool: ToolType; anim: string }) => {
        this.playAnimationByEvent(p.tool, p.anim);
      },
    );
    this.subscriptions.push(offSwitch, offAnim);
    return () => this.detach();
  }

  detach(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
  }

  /** 渲染循环每帧调用，推进动画 mixer */
  update(dt: number): void {
    this.mixer?.update(dt);
  }

  private async equip(next: ToolType | null): Promise<void> {
    if (this.currentTool === next) return;
    this.currentTool = next;
    const gen = ++this.loadGeneration;
    this.unmount();
    if (!next) return;

    // 先放占位，加载完后无缝替换
    const placeholder = this.makeFallback(next);
    this.mount(placeholder);

    const inst = await this.assets.instantiateSkinned(next);
    if (gen !== this.loadGeneration) return; // 切换被打断
    if (!inst) return; // 占位继续生效

    this.unmount();
    this.mount(inst.root);
    if (inst.animations.length > 0) {
      this.mixer = new THREE.AnimationMixer(inst.root);
      this.clipsByName = new Map(inst.animations.map((c) => [c.name, c]));
      // 自动播放 idle
      this.playAnimationByKey(next, 'idle');
    }
  }

  private unmount(): void {
    if (this.currentRoot) {
      this.group.remove(this.currentRoot);
      this.currentRoot.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose?.();
          const mat = m.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose?.());
          else mat?.dispose?.();
        }
      });
      this.currentRoot = null;
    }
    this.mixer = null;
    this.clipsByName.clear();
  }

  private mount(root: THREE.Object3D): void {
    this.group.add(root);
    this.currentRoot = root;
  }

  private makeFallback(type: ToolType): THREE.Object3D {
    const color = this.fallbackColors[type] ?? 0xffffff;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.08, 0.3),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.4,
        roughness: 0.6,
      }),
    );
    mesh.name = `viewmodel_fallback_${type}`;
    return mesh;
  }

  /**
   * 由 `tool:anim` 事件触发 —— 事件载荷里 `anim` 已经是 `ToolSystem` 标准前缀格式
   * （例如 `snapshot_gun_fire`）。我们通过反查 TOOL_CATALOG.animationSet 取出对应的
   * 抽象键（`primaryFire`），再去 animationMap 里找真实 clip 名。
   */
  private playAnimationByEvent(tool: ToolType, eventAnimName: string): void {
    if (tool !== this.currentTool) return; // 落后事件
    const set = TOOL_CATALOG[tool]?.animationSet;
    if (!set) return;
    const key = (Object.keys(set) as (keyof ToolAnimationSet)[]).find(
      (k) => set[k] === eventAnimName,
    );
    if (!key) return;
    this.playAnimationByKey(tool, key);
  }

  private playAnimationByKey(tool: ToolType, key: keyof ToolAnimationSet): void {
    if (!this.mixer || this.clipsByName.size === 0) return;
    const mapped = this.animationMap[tool]?.[key];
    const candidates = [
      mapped,
      TOOL_CATALOG[tool].animationSet[key],
      key, // 'idle' 等通用名
    ].filter((s): s is string => typeof s === 'string' && s.length > 0);
    let clip: THREE.AnimationClip | undefined;
    for (const name of candidates) {
      clip = this.clipsByName.get(name);
      if (clip) break;
    }
    if (!clip) return;
    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(key === 'idle' ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = key !== 'idle';
    action.play();
  }

  /** 测试用：直接读当前装备 */
  get equippedToolForTest(): ToolType | null {
    return this.currentTool;
  }

  /** 测试用：当前在 group 下挂的 root（占位 or 真实模型） */
  get rootForTest(): THREE.Object3D | null {
    return this.currentRoot;
  }
}
