/**
 * PostFx —— 后处理管线封装。
 *
 * 组合三件套：
 *   - `RenderPass`         —— 把 scene/camera 渲染到 framebuffer
 *   - `UnrealBloomPass`    —— 高光辉光，让 emissive 屏幕 / 灯条"亮起来"
 *   - `SMAAPass`           —— 形态学抗锯齿，比 MSAA 更便宜，比 FXAA 更清
 *
 * 设计要点：
 *  - **可降级**：构造函数若拿不到 WebGL 上下文（jsdom / 无显卡）会失败；
 *    我们用 `PostFx.tryAttach()` 工厂返回 null，调用方退化为 `renderer.render`。
 *  - **不持有外部状态**：`render()` 只读 `scene/camera`，window resize 由 `setSize` 显式驱动。
 *  - **泛参可单测**：`computeBloomParams()` / `computeSmaaSize()` 是纯函数，jsdom 下可跑。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export interface PostFxQuality {
  /** Bloom 强度 0..3，默认 0.45 */
  bloomStrength?: number;
  /** Bloom 半径 0..1，默认 0.6 */
  bloomRadius?: number;
  /** 进入 bloom 的亮度阈值 0..1，默认 0.85（避免整屏发光） */
  bloomThreshold?: number;
}

export interface BloomParams {
  strength: number;
  radius: number;
  threshold: number;
}

/** 把可选的 quality preset 解析成稳定的 BloomParams，纯函数便于单测 */
export function computeBloomParams(q: PostFxQuality = {}): BloomParams {
  return {
    strength: clamp(q.bloomStrength ?? 0.45, 0, 3),
    radius: clamp(q.bloomRadius ?? 0.6, 0, 1),
    threshold: clamp(q.bloomThreshold ?? 0.85, 0, 1),
  };
}

/** SMAA 内部纹理尺寸用整数像素，纯函数便于单测 */
export function computeSmaaSize(width: number, height: number, pixelRatio: number): {
  w: number;
  h: number;
} {
  const w = Math.max(1, Math.floor(width * pixelRatio));
  const h = Math.max(1, Math.floor(height * pixelRatio));
  return { w, h };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class PostFx {
  private constructor(
    public readonly composer: EffectComposer,
    public readonly bloom: UnrealBloomPass,
    public readonly smaa: SMAAPass,
  ) {}

  /**
   * 工厂：尝试附加后处理；失败（jsdom/headless）→ 返回 null。
   * 不抛异常，由调用方决定是否回退到 `renderer.render`。
   */
  static tryAttach(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    quality: PostFxQuality = {},
  ): PostFx | null {
    try {
      const size = renderer.getSize(new THREE.Vector2());
      const pixelRatio = renderer.getPixelRatio();
      const composer = new EffectComposer(renderer);
      composer.setPixelRatio(pixelRatio);
      composer.setSize(size.x, size.y);

      composer.addPass(new RenderPass(scene, camera));

      const bp = computeBloomParams(quality);
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y),
        bp.strength,
        bp.radius,
        bp.threshold,
      );
      composer.addPass(bloom);

      const sm = computeSmaaSize(size.x, size.y, pixelRatio);
      const smaa = new SMAAPass(sm.w, sm.h);
      composer.addPass(smaa);

      // OutputPass 负责把线性空间转回 sRGB（与 renderer.outputColorSpace 配合）
      composer.addPass(new OutputPass());

      return new PostFx(composer, bloom, smaa);
    } catch (err) {
      console.warn('[PostFx] post-processing unavailable, falling back to direct render:', err);
      return null;
    }
  }

  /** 渲染一帧 */
  render(): void {
    this.composer.render();
  }

  /** 窗口大小变化时调用 */
  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.bloom.setSize(width, height);
    const sm = computeSmaaSize(width, height, pixelRatio);
    this.smaa.setSize(sm.w, sm.h);
  }
}
