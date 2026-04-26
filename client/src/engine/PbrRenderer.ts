/**
 * PbrRenderer —— 把 `WebGLRenderer` 一次性配置成"商业演示档"的视觉基线。
 *
 * 调整内容（与 three.js r160 一致）：
 *  - `shadowMap.enabled = true` + `PCFSoftShadowMap`（柔和阴影）
 *  - `toneMapping = ACESFilmicToneMapping`，`toneMappingExposure = 1.0`
 *  - `outputColorSpace = SRGBColorSpace`（sRGB 线性输出）
 *  - 物理材质所用的色彩空间已由 GLTFLoader 自行处理，这里仅设全局开关
 *
 * 可单测：所有写入都在传入的 renderer-like 对象上完成，不依赖真实 WebGL 上下文。
 * jsdom 测试可以传一个最小桩对象，验证字段被正确写入。
 */
import * as THREE from 'three';

/** 仅暴露我们要写入的字段，便于单测 stub */
export interface PbrConfigurableRenderer {
  shadowMap: { enabled: boolean; type: THREE.ShadowMapType };
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
  outputColorSpace: THREE.ColorSpace;
}

export interface PbrRendererOptions {
  /** 曝光，默认 1.0；夜景/暗黑机房可降到 0.7 */
  exposure?: number;
  /** 是否启用阴影；某些低端 GPU 可关闭。默认 true */
  shadows?: boolean;
}

/**
 * 应用 PBR 渲染设置。返回传入的 renderer 引用，便于链式调用与测试断言。
 */
export function configurePbrRenderer<T extends PbrConfigurableRenderer>(
  renderer: T,
  opts: PbrRendererOptions = {},
): T {
  renderer.shadowMap.enabled = opts.shadows ?? true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

/**
 * 给一个 `Object3D` 子树批量设置 cast/receive shadow。
 * 调用方在场景搭建完后调用一次即可。
 */
export function enableShadowsOnSubtree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
}
