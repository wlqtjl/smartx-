/**
 * EnvironmentLighting —— 用 three.js 内置 `RoomEnvironment` 程序化生成
 * 一张 PMREM 环境贴图，赋给 `scene.environment`。这样 `MeshStandardMaterial`
 * 的金属/反射效果会立刻"亮起来"，不再需要外部 HDR 文件，也不会触网。
 *
 * 失败优雅降级：在 jsdom（无 WebGL）下 `PMREMGenerator` 会抛异常，
 * 我们捕获并直接返回 null —— 调用方仍然能看到关卡（只是没有 IBL 反射）。
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * 给场景挂载程序化环境贴图。
 *
 * 实现：用 `RoomEnvironment`（一个手工搭建的 box 房间 Scene）+ `PMREMGenerator`
 * 烘焙出 prefiltered 立方贴图。三步：
 *   1. new PMREMGenerator(renderer)       —— 需要真实 WebGL 上下文
 *   2. pmrem.fromScene(roomScene, sigma)  —— 实际着色器烘焙
 *   3. scene.environment = target.texture
 *
 * 注意：返回的 Texture 由 PMREMGenerator 持有，调用方通常不需要 dispose；
 * 如果游戏长生命周期切场景，可保留引用并在切场景前调用 `texture.dispose()`。
 *
 * 失败优雅降级：jsdom / 无 WebGL 环境下 `PMREMGenerator` 会抛异常，
 * 我们 catch 后返回 null —— 调用方仍然能看到关卡（只是没有 IBL 反射）。
 */
export function installRoomEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
): THREE.Texture | null {
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new RoomEnvironment();
    const target = pmrem.fromScene(envScene, 0.04);
    scene.environment = target.texture;
    pmrem.dispose();
    return target.texture;
  } catch (err) {
    console.warn('[EnvironmentLighting] RoomEnvironment unavailable, falling back:', err);
    return null;
  }
}
