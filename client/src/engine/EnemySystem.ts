/**
 * EnemySystem —— "故障实体" 敌人 MVP。
 *
 * 设计原则（§四.6）：
 *  - **opt-in**：构造时禁用，由调用方 `enable()` 才生效；教程关默认关闭，
 *    避免破坏现有迁移剧情节奏。
 *  - 简单状态机：IDLE → CHASE（玩家靠近）→ ATTACK（接触）→ DEAD（被击中）。
 *  - 命中检测：raycast vs. 敌人 Bounding Box，由 `SNAPSHOT_GUN` 等工具触发。
 *  - 动画：通过 `AssetLoader.instantiateSkinned` 拿到 Quaternius Robots Pack 的
 *    Robot_Idle / Walk / Attack / Death clip，状态切换时 crossFade。
 *  - 失败优雅降级：若 GLB 缺失 → 用红色胶囊占位，状态机仍工作。
 */
import * as THREE from 'three';
import type { AssetLoader } from './AssetLoader';
import type { CharacterAssetKey } from './AssetManifest';

export type EnemyState = 'IDLE' | 'CHASE' | 'ATTACK' | 'DEAD';

export interface EnemyClipMap {
  idle: string;
  walk: string;
  attack: string;
  death: string;
}

const DEFAULT_CLIP_MAP: EnemyClipMap = {
  idle: 'Idle',
  walk: 'Walk',
  attack: 'Attack',
  death: 'Death',
};

export interface EnemyConfig {
  hp: number;
  /** 进入 CHASE 状态的距离（米） */
  detectRange: number;
  /** 进入 ATTACK 的距离（米） */
  attackRange: number;
  /** 移动速度 m/s */
  speed: number;
  /** 攻击间隔 ms（必须为常数，不允许来自外部输入 → CodeQL js/resource-exhaustion） */
  attackCooldownMs: number;
}

export const DEFAULT_ENEMY_CONFIG: EnemyConfig = {
  hp: 100,
  detectRange: 12,
  attackRange: 1.5,
  speed: 1.8,
  attackCooldownMs: 1200,
};

interface InternalEnemy {
  id: string;
  root: THREE.Object3D;
  position: THREE.Vector3;
  state: EnemyState;
  hp: number;
  config: EnemyConfig;
  mixer: THREE.AnimationMixer | null;
  clips: Map<string, THREE.AnimationClip>;
  currentAction: THREE.AnimationAction | null;
  clipMap: EnemyClipMap;
  attackTimer: number; // ms
  bbox: THREE.Box3;
}

export class EnemySystem {
  private readonly enemies = new Map<string, InternalEnemy>();
  private enabled = false;
  private idCounter = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly assets: AssetLoader,
  ) {}

  /** Feature flag —— 默认关闭，必须显式调用才会更新 */
  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 当前活着的敌人数量 */
  get count(): number {
    let n = 0;
    for (const e of this.enemies.values()) if (e.state !== 'DEAD') n++;
    return n;
  }

  /**
   * 在指定位置生成敌人。返回敌人 id（用于 hit 检测 / 移除）。
   */
  async spawn(
    position: THREE.Vector3,
    opts: {
      assetKey?: CharacterAssetKey;
      config?: Partial<EnemyConfig>;
      clipMap?: Partial<EnemyClipMap>;
    } = {},
  ): Promise<string> {
    const id = `enemy-${++this.idCounter}`;
    const inst = await this.assets.instantiateSkinned(opts.assetKey ?? 'enemy_bot');

    let root: THREE.Object3D;
    let mixer: THREE.AnimationMixer | null = null;
    const clips = new Map<string, THREE.AnimationClip>();
    if (inst) {
      root = inst.root;
      if (inst.animations.length > 0) {
        mixer = new THREE.AnimationMixer(inst.root);
        for (const c of inst.animations) clips.set(c.name, c);
      }
    } else {
      root = makeEnemyPlaceholder();
    }
    root.position.copy(position);
    this.scene.add(root);

    const enemy: InternalEnemy = {
      id,
      root,
      position: root.position,
      state: 'IDLE',
      hp: opts.config?.hp ?? DEFAULT_ENEMY_CONFIG.hp,
      config: { ...DEFAULT_ENEMY_CONFIG, ...(opts.config ?? {}) },
      mixer,
      clips,
      currentAction: null,
      clipMap: { ...DEFAULT_CLIP_MAP, ...(opts.clipMap ?? {}) },
      attackTimer: 0,
      bbox: new THREE.Box3().setFromObject(root),
    };
    this.playClip(enemy, 'idle');
    this.enemies.set(id, enemy);
    return id;
  }

  /** 每帧推进所有敌人；玩家位置传入，决定 chase 行为。 */
  update(dt: number, playerPosition: THREE.Vector3): void {
    if (!this.enabled) return;
    const dtMs = dt * 1000;
    for (const e of this.enemies.values()) {
      e.mixer?.update(dt);
      if (e.state === 'DEAD') continue;
      const dist = e.position.distanceTo(playerPosition);
      this.tickStateMachine(e, dist, dt, playerPosition);
      if (e.attackTimer > 0) e.attackTimer = Math.max(0, e.attackTimer - dtMs);
      e.bbox.setFromObject(e.root);
    }
  }

  private tickStateMachine(
    e: InternalEnemy,
    dist: number,
    dt: number,
    playerPosition: THREE.Vector3,
  ): void {
    switch (e.state) {
      case 'IDLE':
        if (dist <= e.config.detectRange) this.transition(e, 'CHASE');
        break;
      case 'CHASE': {
        if (dist > e.config.detectRange) {
          this.transition(e, 'IDLE');
          break;
        }
        if (dist <= e.config.attackRange) {
          this.transition(e, 'ATTACK');
          break;
        }
        // 朝玩家移动
        const dir = new THREE.Vector3().subVectors(playerPosition, e.position).setY(0).normalize();
        e.position.addScaledVector(dir, e.config.speed * dt);
        e.root.lookAt(playerPosition.x, e.position.y, playerPosition.z);
        break;
      }
      case 'ATTACK':
        if (dist > e.config.attackRange) {
          this.transition(e, 'CHASE');
          break;
        }
        if (e.attackTimer <= 0) {
          // 攻击触发：本 MVP 仅播动画，实际伤害由游戏逻辑订阅 EventBus 实现
          this.playClip(e, 'attack');
          // 注意：常数 cooldown，不来自客户端输入（CodeQL js/resource-exhaustion）
          e.attackTimer = e.config.attackCooldownMs;
        }
        break;
      case 'DEAD':
        break;
    }
  }

  private transition(e: InternalEnemy, next: EnemyState): void {
    if (e.state === next) return;
    e.state = next;
    switch (next) {
      case 'IDLE':
        this.playClip(e, 'idle');
        break;
      case 'CHASE':
        this.playClip(e, 'walk');
        break;
      case 'ATTACK':
        this.playClip(e, 'attack');
        break;
      case 'DEAD':
        this.playClip(e, 'death', { loopOnce: true });
        break;
    }
  }

  private playClip(
    e: InternalEnemy,
    key: keyof EnemyClipMap,
    opts: { loopOnce?: boolean } = {},
  ): void {
    if (!e.mixer) return;
    const target = e.clipMap[key];
    const clip =
      e.clips.get(target) ??
      [...e.clips.values()].find((c) => c.name.toLowerCase().includes(target.toLowerCase()));
    if (!clip) return;
    const next = e.mixer.clipAction(clip);
    if (e.currentAction && e.currentAction !== next) {
      next.reset();
      next.crossFadeFrom(e.currentAction, 0.2, false);
    } else {
      next.reset();
    }
    next.setLoop(opts.loopOnce ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = !!opts.loopOnce;
    next.play();
    e.currentAction = next;
  }

  /**
   * Raycast 命中检测：用 ray vs 每个敌人 BoundingBox，返回最近的 hit。
   * 这种粗粒度检测足以满足 MVP 与教学；后续可换 BVH。
   */
  raycastHit(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance = 30): {
    enemyId: string;
    point: THREE.Vector3;
    distance: number;
  } | null {
    const ray = new THREE.Ray(origin, direction.clone().normalize());
    let best: { enemyId: string; point: THREE.Vector3; distance: number } | null = null;
    const tmp = new THREE.Vector3();
    for (const e of this.enemies.values()) {
      if (e.state === 'DEAD') continue;
      if (!ray.intersectBox(e.bbox, tmp)) continue;
      const distance = origin.distanceTo(tmp);
      if (distance > maxDistance) continue;
      if (!best || distance < best.distance) {
        best = { enemyId: e.id, point: tmp.clone(), distance };
      }
    }
    return best;
  }

  /** 对敌人造成伤害；hp ≤ 0 → 进入 DEAD 状态 */
  applyDamage(enemyId: string, dmg: number): EnemyState | null {
    const e = this.enemies.get(enemyId);
    if (!e || e.state === 'DEAD') return null;
    e.hp -= dmg;
    if (e.hp <= 0) this.transition(e, 'DEAD');
    return e.state;
  }

  /** 测试：直接读状态 */
  getStateForTest(enemyId: string): EnemyState | null {
    return this.enemies.get(enemyId)?.state ?? null;
  }

  removeAll(): void {
    for (const e of this.enemies.values()) {
      this.scene.remove(e.root);
      e.mixer?.stopAllAction();
    }
    this.enemies.clear();
  }
}

function makeEnemyPlaceholder(): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'enemy_placeholder';
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.4, 1.2, 6, 12),
    new THREE.MeshStandardMaterial({
      color: 0xff3344,
      emissive: 0x441111,
      emissiveIntensity: 0.4,
      roughness: 0.7,
    }),
  );
  body.position.y = 1.0;
  group.add(body);
  return group;
}
