/**
 * AssetLoader 单元测试 —— 验证缓存、并发去重、失败 fallback、白名单 URL。
 *
 * 这里完全不接触 WebGL / 真实 GLTFLoader：通过注入 `LoaderImpl` 替身，
 * 把 GLTF 模拟成 `{ scene, animations }`，从而能在 vitest + jsdom 跑通。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AssetLoader, type LoaderImpl } from './AssetLoader';
import { resolveAssetUrl } from './AssetManifest';

interface FakeLoaderState {
  calls: { url: string }[];
  fail?: Set<string>;
}

function fakeLoader(state: FakeLoaderState): LoaderImpl {
  return {
    async load(url): Promise<GLTF> {
      state.calls.push({ url });
      if (state.fail?.has(url)) throw new Error(`stub failure: ${url}`);
      const root = new THREE.Group();
      root.name = `stub:${url}`;
      // 加一个骨骼 SkinnedMesh 占位，便于 SkeletonUtils.clone 路径不爆炸
      const geom = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshStandardMaterial();
      const mesh = new THREE.Mesh(geom, mat);
      root.add(mesh);
      return {
        scene: root,
        scenes: [root],
        animations: [],
        cameras: [],
        asset: { version: '2.0' },
        parser: {} as GLTF['parser'],
        userData: {},
      } as GLTF;
    },
    dispose() {
      /* no-op */
    },
  };
}

describe('AssetLoader', () => {
  let state: FakeLoaderState;
  let loader: AssetLoader;

  beforeEach(() => {
    state = { calls: [] };
    loader = new AssetLoader({ loaderImpl: fakeLoader(state) });
  });

  it('resolves GLB through manifest whitelist', async () => {
    const gltf = await loader.loadGLTF('engineer');
    expect(gltf).not.toBeNull();
    // URL must come from manifest, not user input
    expect(state.calls[0].url).toBe(resolveAssetUrl('engineer'));
  });

  it('caches subsequent loads of the same key (single network call)', async () => {
    await Promise.all([
      loader.loadGLTF('rack'),
      loader.loadGLTF('rack'),
      loader.loadGLTF('rack'),
    ]);
    expect(state.calls.filter((c) => c.url.endsWith('rack.glb'))).toHaveLength(1);
  });

  it('returns null on load failure and does not throw', async () => {
    state.fail = new Set([resolveAssetUrl('SNAPSHOT_GUN')]);
    const result = await loader.loadGLTF('SNAPSHOT_GUN');
    expect(result).toBeNull();
  });

  it('preload reports successful keys only', async () => {
    state.fail = new Set([resolveAssetUrl('door')]);
    const ok = await loader.preload(['rack', 'door', 'console_terminal']);
    expect(ok).toEqual(expect.arrayContaining(['rack', 'console_terminal']));
    expect(ok).not.toContain('door');
  });

  it('instantiate clones the scene (non-shared)', async () => {
    const a = await loader.instantiate('rack');
    const b = await loader.instantiate('rack');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('emits progress callbacks summing to 1.0 at end', async () => {
    const progress: number[] = [];
    const l2 = new AssetLoader({
      loaderImpl: fakeLoader(state),
      onProgress: (loaded, total) => {
        if (total > 0) progress.push(loaded / total);
      },
    });
    await l2.preload(['rack', 'console_terminal', 'floor_tile']);
    expect(progress[progress.length - 1]).toBe(1);
  });
});
