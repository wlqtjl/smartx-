/**
 * ToolViewmodel 单元测试 —— 验证占位 fallback、事件订阅、切换语义。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EventBus } from '../core/EventBus';
import { AssetLoader, type LoaderImpl } from '../engine/AssetLoader';
import { ToolViewmodel } from './ToolViewmodel';

function fakeLoader(opts: { fail?: boolean } = {}): LoaderImpl {
  return {
    async load(): Promise<GLTF> {
      if (opts.fail) throw new Error('stub fail');
      const root = new THREE.Group();
      root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
      return {
        scene: root,
        scenes: [root],
        animations: [] as THREE.AnimationClip[],
        cameras: [],
        asset: { version: '2.0' },
        parser: {} as GLTF['parser'],
        userData: {},
      } as GLTF;
    },
    dispose() {},
  };
}

describe('ToolViewmodel', () => {
  let camera: THREE.PerspectiveCamera;

  beforeEach(() => {
    EventBus.clear();
    camera = new THREE.PerspectiveCamera();
  });

  it('mounts a placeholder synchronously on tool:switch and reacts to tool changes', async () => {
    const vm = new ToolViewmodel(camera, new AssetLoader({ loaderImpl: fakeLoader({ fail: true }) }));
    vm.attach();
    EventBus.emit('tool:switch', { prev: null, next: 'SNAPSHOT_GUN' });
    // placeholder is mounted synchronously
    expect(vm.equippedToolForTest).toBe('SNAPSHOT_GUN');
    expect(vm.rootForTest?.name).toContain('viewmodel_fallback_SNAPSHOT_GUN');
    // wait one microtask for the failed load to settle; placeholder remains
    await Promise.resolve();
    await Promise.resolve();
    expect(vm.rootForTest?.name).toContain('viewmodel_fallback_SNAPSHOT_GUN');
  });

  it('replaces placeholder with real model once loaded', async () => {
    const vm = new ToolViewmodel(camera, new AssetLoader({ loaderImpl: fakeLoader() }));
    vm.attach();
    EventBus.emit('tool:switch', { prev: null, next: 'FIBER_PATCHER' });
    // give the async load chain a chance to resolve
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(vm.rootForTest).not.toBeNull();
    expect(vm.rootForTest!.name).not.toContain('viewmodel_fallback');
  });

  it('unmounts when next tool is null', async () => {
    const vm = new ToolViewmodel(camera, new AssetLoader({ loaderImpl: fakeLoader() }));
    vm.attach();
    EventBus.emit('tool:switch', { prev: null, next: 'SNAPSHOT_GUN' });
    EventBus.emit('tool:switch', { prev: 'SNAPSHOT_GUN', next: null });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(vm.equippedToolForTest).toBeNull();
    expect(vm.rootForTest).toBeNull();
  });

  it('detach() removes EventBus subscriptions', () => {
    const vm = new ToolViewmodel(camera, new AssetLoader({ loaderImpl: fakeLoader() }));
    vm.attach();
    vm.detach();
    EventBus.emit('tool:switch', { prev: null, next: 'SNAPSHOT_GUN' });
    expect(vm.equippedToolForTest).toBeNull();
  });
});
