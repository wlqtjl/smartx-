/**
 * 镜头晃动系统 —— 根据移动速度与所处区域修正幅度。
 * 在 render 循环中调用 apply(camera, state, dt) 实现头部正弦晃动。
 */
import * as THREE from 'three';
import type { PlayerController } from './PlayerController';

export class HeadBobSystem {
  private phase = 0;
  private lastOffsetY = 0;
  private lastOffsetX = 0;

  apply(dt: number, controller: PlayerController): void {
    const { state, config, camera } = controller;
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    const moving = speed > 0.15 && state.isGrounded;

    // 频率：步频 ×（2π）；跑步时更高
    const freq = state.isSprinting ? 2.8 : config.headBobFrequency;
    const amp = state.isSprinting
      ? config.headBobAmplitude.sprint
      : state.currentZone === 'COLD_AISLE'
        ? config.headBobAmplitude.coldAisle
        : config.headBobAmplitude.walk;

    // 只有在移动时推进相位
    if (moving) this.phase += dt * freq * Math.PI * 2;

    const targetY = moving ? Math.sin(this.phase) * amp : 0;
    const targetX = moving ? Math.cos(this.phase * 0.5) * amp * 0.5 : 0;

    // 平滑回零，避免停止时镜头抖动
    const smooth = Math.min(1, dt * 8);
    this.lastOffsetY += (targetY - this.lastOffsetY) * smooth;
    this.lastOffsetX += (targetX - this.lastOffsetX) * smooth;

    camera.position.y += this.lastOffsetY;
    camera.position.x += this.lastOffsetX;
  }

  reset(): void {
    this.phase = 0;
    this.lastOffsetX = 0;
    this.lastOffsetY = 0;
  }

  // 提供测试/调试时直接读取的偏移量
  get offset(): THREE.Vector2 {
    return new THREE.Vector2(this.lastOffsetX, this.lastOffsetY);
  }
}
