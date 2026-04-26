/**
 * CharacterController —— 复刻 three.js `webgl_animation_skinning_blending` 的核心：
 * 一个骨骼角色 + AnimationMixer + 三个 AnimationAction（idle/walk/run），
 * 根据当前速度做 **权重交叉淡化**（而不是简单 crossFadeTo），从而在站立↔走↔跑
 * 之间产生平滑的混合动画。
 *
 * 用途：
 *  - 关卡内的"工程师 NPC"（剧情指引者，按路径点 / waypoint 漫步）。
 *  - 第三人称化 / 多人占位时复用同一份资产。
 *
 * 实现要点：
 *  1. 通过 `AssetLoader.instantiateSkinned` 拿到独立骨骼实例；
 *  2. 三个 action 同时 `.play()`，但用 `setEffectiveWeight` 控制权重，权重和始终为 1；
 *  3. clip 名映射可配置，便于换 Quaternius / Mixamo 角色（默认匹配 Soldier.glb）。
 */
import * as THREE from 'three';
import type { AssetLoader } from './AssetLoader';
import type { CharacterAssetKey } from './AssetManifest';

/** 标准动画键 */
export type CharacterAnimKey = 'idle' | 'walk' | 'run';

/** 默认 clip 名（与 three.js Soldier.glb 一致） */
export const DEFAULT_CHARACTER_ANIM_MAP: Record<CharacterAnimKey, string> = {
  idle: 'Idle',
  walk: 'Walk',
  run: 'Run',
};

export interface CharacterControllerOptions {
  /** 走路速度阈值（m/s），低于则视为站立 */
  walkThreshold?: number;
  /** 跑步速度阈值（m/s），高于则全权重 run */
  runThreshold?: number;
  /** 自定义 clip 名映射（换 Quaternius/Mixamo 时用） */
  animationMap?: Partial<Record<CharacterAnimKey, string>>;
}

interface CharacterActions {
  idle: THREE.AnimationAction;
  walk: THREE.AnimationAction;
  run: THREE.AnimationAction;
}

export class CharacterController {
  private mixer: THREE.AnimationMixer | null = null;
  private actions: CharacterActions | null = null;
  private root: THREE.Object3D | null = null;
  private readonly walkThreshold: number;
  private readonly runThreshold: number;
  private readonly animationMap: Record<CharacterAnimKey, string>;

  constructor(opts: CharacterControllerOptions = {}) {
    this.walkThreshold = opts.walkThreshold ?? 0.1;
    this.runThreshold = opts.runThreshold ?? 4.5;
    this.animationMap = { ...DEFAULT_CHARACTER_ANIM_MAP, ...(opts.animationMap ?? {}) };
  }

  /**
   * 异步加载并实例化角色。返回根对象，由调用方 add 到 scene 并管理位置。
   * 失败 → 返回简化的胶囊 mesh 占位。
   */
  async load(assets: AssetLoader, key: CharacterAssetKey): Promise<THREE.Object3D> {
    const inst = await assets.instantiateSkinned(key);
    if (!inst) {
      this.root = makeCapsulePlaceholder();
      return this.root;
    }
    this.root = inst.root;
    if (inst.animations.length > 0) {
      this.mixer = new THREE.AnimationMixer(inst.root);
      const actions = this.bindActions(inst.animations);
      if (actions) {
        this.actions = actions;
        // 三段同时 play，仅 weight 不同——这是 skinning_blending 示例的核心做法
        actions.idle.play();
        actions.walk.play();
        actions.run.play();
        this.setWeights(1, 0, 0);
      }
    }
    return this.root;
  }

  private bindActions(clips: THREE.AnimationClip[]): CharacterActions | null {
    if (!this.mixer) return null;
    const find = (key: CharacterAnimKey): THREE.AnimationClip | undefined => {
      const target = this.animationMap[key];
      // 精确匹配 → 大小写不敏感包含匹配（兼容 "Armature|Idle" 等命名）
      return (
        clips.find((c) => c.name === target) ??
        clips.find((c) => c.name.toLowerCase().includes(target.toLowerCase()))
      );
    };
    const idleClip = find('idle');
    const walkClip = find('walk');
    const runClip = find('run');
    if (!idleClip || !walkClip || !runClip) {
      console.warn('[CharacterController] missing one or more clips:', {
        clips: clips.map((c) => c.name),
        wanted: this.animationMap,
      });
      return null;
    }
    return {
      idle: this.mixer.clipAction(idleClip),
      walk: this.mixer.clipAction(walkClip),
      run: this.mixer.clipAction(runClip),
    };
  }

  /**
   * 每帧调用：dt 秒 + 当前移动速度（m/s）。
   * 在 idle/walk/run 三段间根据速度做线性权重混合。
   *
   * 速度区间：
   *   speed <= walkThreshold              →   idle = 1
   *   walkThreshold < speed < runThreshold →  idle 与 walk / walk 与 run 之间线性混合
   *   speed >= runThreshold                →   run = 1
   */
  update(dt: number, speed: number): void {
    this.mixer?.update(dt);
    if (!this.actions) return;
    const w = computeBlendWeights(speed, this.walkThreshold, this.runThreshold);
    this.setWeights(w.idle, w.walk, w.run);
  }

  private setWeights(idle: number, walk: number, run: number): void {
    if (!this.actions) return;
    this.actions.idle.setEffectiveWeight(idle);
    this.actions.walk.setEffectiveWeight(walk);
    this.actions.run.setEffectiveWeight(run);
  }

  /** 测试 / 调试：当前权重快照 */
  getWeightsForTest(): { idle: number; walk: number; run: number } | null {
    if (!this.actions) return null;
    return {
      idle: this.actions.idle.getEffectiveWeight(),
      walk: this.actions.walk.getEffectiveWeight(),
      run: this.actions.run.getEffectiveWeight(),
    };
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.actions = null;
    this.root = null;
  }
}

/**
 * 速度→权重的纯函数，便于单测。三段在阈值两侧的权重分布满足 sum=1。
 *
 * 段 1: [0, walkT)            → idle=1
 * 段 2: [walkT, midT]         → idle/walk 之间线性插值，midT = (walkT + runT) / 2
 * 段 3: (midT, runT]          → walk/run 之间线性插值
 * 段 4: (runT, +∞)            → run=1
 */
export function computeBlendWeights(
  speed: number,
  walkT: number,
  runT: number,
): { idle: number; walk: number; run: number } {
  const s = Math.max(0, speed);
  if (s <= walkT) return { idle: 1, walk: 0, run: 0 };
  if (s >= runT) return { idle: 0, walk: 0, run: 1 };
  const midT = (walkT + runT) / 2;
  if (s <= midT) {
    const t = (s - walkT) / (midT - walkT); // 0..1
    return { idle: 1 - t, walk: t, run: 0 };
  }
  const t = (s - midT) / (runT - midT);
  return { idle: 0, walk: 1 - t, run: t };
}

function makeCapsulePlaceholder(): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'character_placeholder';
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.0, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0x88aacc, roughness: 0.6 }),
  );
  body.position.y = 0.85;
  group.add(body);
  return group;
}
