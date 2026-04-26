/**
 * AssetLoader —— GLB 资产加载与缓存层。
 *
 * 设计目标（与本仓 §四.2 计划一致）：
 *  - 封装 `GLTFLoader` + 可选 `DRACOLoader`，集中管理 `THREE.LoadingManager` 进度。
 *  - 通过 `AssetManifest` 白名单解析 URL，**不接受用户输入**，避免 CodeQL js/path-injection
 *    与资源耗尽（参考 repo memory: setInterval/setTimeout 等不应来自客户端输入）。
 *  - 对每个 key 仅发起一次实际加载，重复 `loadGLTF(key)` 复用同一 Promise/缓存。
 *  - 对带骨骼的角色模型，提供 `instantiateSkinned()`，内部用 `SkeletonUtils.clone`
 *    保证多实例不会共享骨骼姿态（这是 three.js skinning 的标准做法）。
 *  - 单元测试可注入 `LoaderImpl` 替身 → vitest jsdom 环境无需真正 WebGL。
 *
 * 失败优雅降级：当目标 GLB 缺失（404 / 无网络）时不会抛到游戏主循环，
 * 调用方拿到 `null`，自行回退到占位几何体。
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ASSET_MANIFEST, resolveAssetUrl, type AssetKey } from './AssetManifest';

/**
 * 注入式 Loader 抽象，方便单元测试 stub 掉真实 GLTFLoader。
 * 真实实现见 `defaultLoaderImpl`。
 */
export interface LoaderImpl {
  load(url: string, manager: THREE.LoadingManager): Promise<GLTF>;
  dispose(): void;
}

export interface AssetLoaderOptions {
  /** Draco 解码器静态目录，默认 `${BASE_URL}draco/`；不存在时 GLTFLoader 会忽略 */
  dracoDecoderPath?: string;
  /** 注入自定义 loader（测试用） */
  loaderImpl?: LoaderImpl;
  /** 进度回调 (0..1) */
  onProgress?: (loaded: number, total: number) => void;
}

interface CacheEntry {
  promise: Promise<GLTF | null>;
  /** 已 resolve 后存放，便于同步获取 */
  resolved: GLTF | null;
}

function defaultLoaderImpl(dracoDecoderPath: string): LoaderImpl {
  let gltfLoader: GLTFLoader | null = null;
  let dracoLoader: DRACOLoader | null = null;

  const ensure = (manager: THREE.LoadingManager): GLTFLoader => {
    if (gltfLoader) return gltfLoader;
    gltfLoader = new GLTFLoader(manager);
    try {
      dracoLoader = new DRACOLoader(manager);
      dracoLoader.setDecoderPath(dracoDecoderPath);
      gltfLoader.setDRACOLoader(dracoLoader);
    } catch {
      // Draco 不是必需，缺失时直接 fallback 到 uncompressed glTF
    }
    return gltfLoader;
  };

  return {
    load(url, manager) {
      const loader = ensure(manager);
      return new Promise<GLTF>((resolve, reject) => {
        loader.load(url, resolve, undefined, (err) => reject(err));
      });
    },
    dispose() {
      dracoLoader?.dispose();
      dracoLoader = null;
      gltfLoader = null;
    },
  };
}

export class AssetLoader {
  private readonly cache = new Map<AssetKey, CacheEntry>();
  private readonly manager: THREE.LoadingManager;
  private readonly impl: LoaderImpl;
  private totalRequested = 0;
  private totalCompleted = 0;
  private readonly onProgress?: (loaded: number, total: number) => void;

  constructor(opts: AssetLoaderOptions = {}) {
    const baseUrl =
      (typeof import.meta !== 'undefined' && import.meta?.env?.BASE_URL) || '/';
    const decoder = opts.dracoDecoderPath ?? `${baseUrl}draco/`;
    this.manager = new THREE.LoadingManager();
    this.onProgress = opts.onProgress;
    // LoadingManager 自身的进度可视化（仅 GLTF 内嵌资源），单元里我们再单独累计 key 数。
    this.manager.onProgress = (): void => {
      this.onProgress?.(this.totalCompleted, this.totalRequested);
    };
    this.impl = opts.loaderImpl ?? defaultLoaderImpl(decoder);
  }

  /**
   * 加载（带缓存）。
   * 同一 `key` 多次调用会复用第一次的 Promise，并且从 manifest 解析出唯一 URL。
   * 加载失败 → resolve 为 `null`（调用方负责 fallback），不会抛异常给主循环。
   */
  loadGLTF(key: AssetKey): Promise<GLTF | null> {
    const cached = this.cache.get(key);
    if (cached) return cached.promise;

    if (!ASSET_MANIFEST[key]) {
      // 不应发生（types 已限定），但运行时也守一下
      const p = Promise.resolve(null);
      this.cache.set(key, { promise: p, resolved: null });
      return p;
    }

    const url = resolveAssetUrl(key);
    this.totalRequested++;
    this.onProgress?.(this.totalCompleted, this.totalRequested);

    const promise = this.impl
      .load(url, this.manager)
      .then((gltf) => {
        // 设置阴影（占位 box 也是这个套路）
        gltf.scene.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh) {
            const m = obj as THREE.Mesh;
            m.castShadow = true;
            m.receiveShadow = true;
          }
        });
        const entry = this.cache.get(key);
        if (entry) entry.resolved = gltf;
        this.totalCompleted++;
        this.onProgress?.(this.totalCompleted, this.totalRequested);
        return gltf;
      })
      .catch((err) => {
        console.warn(`[AssetLoader] failed to load "${key}" (${url}):`, err);
        this.totalCompleted++;
        this.onProgress?.(this.totalCompleted, this.totalRequested);
        return null;
      });

    this.cache.set(key, { promise, resolved: null });
    return promise;
  }

  /**
   * 并发预热多个 key，返回成功加载的 key 列表。
   */
  async preload(keys: AssetKey[]): Promise<AssetKey[]> {
    const t0 =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const results = await Promise.all(
      keys.map(async (k) => ({ k, gltf: await this.loadGLTF(k) })),
    );
    const ok = results.filter((r) => r.gltf !== null).map((r) => r.k);
    const t1 =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    console.info(
      `[assets] loaded ${ok.length}/${keys.length} models in ${Math.round(t1 - t0)} ms`,
    );
    return ok;
  }

  /**
   * 实例化静态 GLB（环境/工具）：直接 `clone(true)`。
   * 注意：对带骨骼的角色请用 `instantiateSkinned`。
   */
  async instantiate(key: AssetKey): Promise<THREE.Object3D | null> {
    const gltf = await this.loadGLTF(key);
    if (!gltf) return null;
    return gltf.scene.clone(true);
  }

  /**
   * 实例化带骨骼的 GLB（角色 / 敌人）：使用 SkeletonUtils.clone，
   * 这样多实例可以共享几何体/材质/动画 clip，但骨骼姿态独立。
   * 返回 root + animations，调用方自建 AnimationMixer。
   */
  async instantiateSkinned(
    key: AssetKey,
  ): Promise<{ root: THREE.Object3D; animations: THREE.AnimationClip[] } | null> {
    const gltf = await this.loadGLTF(key);
    if (!gltf) return null;
    const root = cloneSkinned(gltf.scene);
    return { root, animations: gltf.animations ?? [] };
  }

  /** 已成功解析的 GLTF 同步取（仅用于已 preload 的资源） */
  getCached(key: AssetKey): GLTF | null {
    return this.cache.get(key)?.resolved ?? null;
  }

  dispose(): void {
    this.cache.clear();
    this.impl.dispose();
  }
}

/**
 * 全局单例。多数游戏场景共用一个 loader 即可；测试可不通过此单例。
 */
let _shared: AssetLoader | null = null;
export function sharedAssetLoader(opts?: AssetLoaderOptions): AssetLoader {
  if (!_shared) _shared = new AssetLoader(opts);
  return _shared;
}

/** 仅供测试：重置单例 */
export function _resetSharedAssetLoaderForTest(): void {
  _shared?.dispose();
  _shared = null;
}
