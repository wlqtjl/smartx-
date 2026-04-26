/**
 * EnemySystem 单元测试 —— 验证状态机、伤害与命中检测在不依赖真实 GLB 的占位路径下能跑通。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AssetLoader, type LoaderImpl } from './AssetLoader';
import { EnemySystem } from './EnemySystem';

function failingLoader(): LoaderImpl {
  return {
    async load(): Promise<GLTF> {
      throw new Error('stub: forces enemy to use placeholder path');
    },
    dispose() {},
  };
}

describe('EnemySystem', () => {
  let scene: THREE.Scene;
  let assets: AssetLoader;
  let sys: EnemySystem;

  beforeEach(() => {
    scene = new THREE.Scene();
    assets = new AssetLoader({ loaderImpl: failingLoader() });
    sys = new EnemySystem(scene, assets);
  });

  it('is opt-in: update() is a no-op until enable()', async () => {
    const id = await sys.spawn(new THREE.Vector3(0, 0, 0));
    sys.update(0.1, new THREE.Vector3(0, 0, 0));
    expect(sys.getStateForTest(id)).toBe('IDLE');
    sys.enable();
    sys.update(0.1, new THREE.Vector3(0, 0, 0));
    // adjacent player + enable → CHASE then ATTACK
    expect(['CHASE', 'ATTACK']).toContain(sys.getStateForTest(id));
  });

  it('transitions IDLE → CHASE when player enters detect range', async () => {
    sys.enable();
    const id = await sys.spawn(new THREE.Vector3(0, 0, 0), {
      config: { detectRange: 5, attackRange: 0.5, hp: 100, speed: 1, attackCooldownMs: 1000 },
    });
    sys.update(0.05, new THREE.Vector3(3, 0, 0));
    expect(sys.getStateForTest(id)).toBe('CHASE');
  });

  it('applyDamage transitions to DEAD on lethal hit', async () => {
    sys.enable();
    const id = await sys.spawn(new THREE.Vector3(0, 0, 0));
    sys.applyDamage(id, 1000);
    expect(sys.getStateForTest(id)).toBe('DEAD');
    expect(sys.count).toBe(0);
  });

  it('raycastHit returns the closest live enemy in front of the ray', async () => {
    sys.enable();
    const close = await sys.spawn(new THREE.Vector3(0, 1, -2));
    const far = await sys.spawn(new THREE.Vector3(0, 1, -8));
    // Need an update tick to refresh bbox after spawn position
    sys.update(0.016, new THREE.Vector3(0, 1, 0));
    const hit = sys.raycastHit(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
    expect(hit).not.toBeNull();
    expect(hit!.enemyId).toBe(close);
    // ensure other enemy variable referenced (no unused-var lint)
    expect(far).not.toBe(close);
  });

  it('raycastHit ignores DEAD enemies', async () => {
    sys.enable();
    const id = await sys.spawn(new THREE.Vector3(0, 1, -2));
    sys.update(0.016, new THREE.Vector3(0, 1, 0));
    sys.applyDamage(id, 9999);
    const hit = sys.raycastHit(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
    expect(hit).toBeNull();
  });
});
