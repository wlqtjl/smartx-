/**
 * 玩家控制器核心 —— 对应主架构文档 §1.1。
 * 职责：WSAD 移动、鼠标视角、区域进入/离开、准星射线交互。
 */
import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import { clamp } from '../core/utils';
import { CollisionSystem } from './CollisionSystem';
import type { ToolType } from './ToolSystem';

export type DataCenterZone =
  | 'COLD_AISLE'
  | 'HOT_AISLE'
  | 'NETWORK_ROOM'
  | 'STORAGE_ROOM'
  | 'COMMAND_POST';

export interface PlayerState {
  position: THREE.Vector3;
  rotation: THREE.Euler; // yaw(Y) + pitch(X)，无 roll
  velocity: THREE.Vector3;
  isGrounded: boolean;
  isCrouching: boolean;
  isSprinting: boolean;
  currentZone: DataCenterZone;
  equippedTool: ToolType | null;
  staminaPercent: number; // 0~100
}

export interface MovementConfig {
  walkSpeed: number; // m/s
  sprintSpeed: number;
  crouchSpeed: number;
  headBobFrequency: number; // Hz
  headBobAmplitude: {
    walk: number;
    sprint: number;
    coldAisle: number;
  };
  mouseSensitivity: number;
  fovDefault: number;
  fovSprint: number;
}

export const DEFAULT_MOVEMENT_CONFIG: MovementConfig = {
  walkSpeed: 3.5,
  sprintSpeed: 6.0,
  crouchSpeed: 1.8,
  headBobFrequency: 1.8,
  headBobAmplitude: { walk: 0.005, sprint: 0.012, coldAisle: 0.018 },
  mouseSensitivity: 0.0022,
  fovDefault: 75,
  fovSprint: 82,
};

export interface InteractableObject {
  id: string;
  type: string;
  label: string;
  onInteract?: () => void;
}

export interface InputState {
  forward: number; // -1..1
  strafe: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  mouseDX: number;
  mouseDY: number;
}

export class PlayerController {
  readonly state: PlayerState;
  readonly config: MovementConfig;
  readonly camera: THREE.PerspectiveCamera;
  private readonly collisionSystem: CollisionSystem;
  private readonly interactionRaycaster: THREE.Raycaster;
  private readonly interactionTargets: THREE.Object3D[] = [];

  // 重力加速度（m/s²），负值向下
  private static readonly GRAVITY = -18;

  // 冲刺消耗：体力 / 秒；冲刺冷却恢复：体力 / 秒
  private readonly staminaDrainPerSec = 25;
  private readonly staminaRegenPerSec = 15;

  constructor(
    camera: THREE.PerspectiveCamera,
    collision: CollisionSystem,
    config: MovementConfig = DEFAULT_MOVEMENT_CONFIG,
  ) {
    this.camera = camera;
    this.collisionSystem = collision;
    this.config = { ...config, headBobAmplitude: { ...config.headBobAmplitude } };
    this.interactionRaycaster = new THREE.Raycaster();
    this.interactionRaycaster.near = 0;
    this.interactionRaycaster.far = 2.5;

    this.state = {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0, 'YXZ'),
      velocity: new THREE.Vector3(),
      isGrounded: true,
      isCrouching: false,
      isSprinting: false,
      currentZone: 'COMMAND_POST',
      equippedTool: null,
      staminaPercent: 100,
    };
  }

  /** 注册一个可交互物体（网格 userData.interactable 需要是 InteractableObject） */
  registerInteractable(obj: THREE.Object3D): void {
    this.interactionTargets.push(obj);
  }

  /** 按帧推进：dt 以秒为单位 */
  update(dt: number, input: InputState): void {
    this.applyMouseLook(input.mouseDX, input.mouseDY);
    this.applyMovement(dt, input);
    this.applyStamina(dt, input.sprint);
  }

  private applyMouseLook(dx: number, dy: number): void {
    const s = this.config.mouseSensitivity;
    this.state.rotation.y -= dx * s;
    this.state.rotation.x -= dy * s;
    // 俯仰限制
    this.state.rotation.x = clamp(this.state.rotation.x, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    this.camera.rotation.copy(this.state.rotation);
  }

  private applyMovement(dt: number, input: InputState): void {
    const { state, config } = this;
    state.isCrouching = input.crouch;
    state.isSprinting = input.sprint && !input.crouch && state.staminaPercent > 0 && input.forward > 0;

    let speed = config.walkSpeed;
    if (state.isCrouching) speed = config.crouchSpeed;
    else if (state.isSprinting) speed = config.sprintSpeed;

    // 冷风道额外限速 4.0 m/s（详见 §1.1 的注释）
    if (state.currentZone === 'COLD_AISLE') speed = Math.min(speed, 4.0);

    // 计算水平方向向量（忽略俯仰）
    const yaw = state.rotation.y;
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

    const dir = new THREE.Vector3()
      .addScaledVector(forward, input.forward)
      .addScaledVector(right, input.strafe);
    if (dir.lengthSq() > 0) dir.normalize();

    // 水平速度
    state.velocity.x = dir.x * speed;
    state.velocity.z = dir.z * speed;

    // 重力 / 跳跃
    if (!state.isGrounded) state.velocity.y += PlayerController.GRAVITY * dt;
    if (input.jump && state.isGrounded) {
      state.velocity.y = 5.5;
      state.isGrounded = false;
    }

    // 积分位置（带碰撞回退）
    const next = state.position.clone().addScaledVector(state.velocity, dt);

    // 逐轴碰撞解算，避免沿墙滑动时被卡住
    const trial = state.position.clone();
    trial.x = next.x;
    if (!this.collisionSystem.collides(trial)) state.position.x = trial.x;
    trial.copy(state.position);
    trial.z = next.z;
    if (!this.collisionSystem.collides(trial)) state.position.z = trial.z;
    state.position.y = Math.max(0, next.y);

    state.isGrounded = state.position.y <= 0.001 || this.collisionSystem.isGrounded(state.position);
    if (state.isGrounded && state.velocity.y < 0) state.velocity.y = 0;

    // 同步到相机（眼睛位置 = 地面 + 身高）
    const eyeHeight = state.isCrouching ? 1.1 : 1.65;
    this.camera.position.set(state.position.x, state.position.y + eyeHeight, state.position.z);

    // FOV 插值（冲刺拉伸）
    const targetFov = state.isSprinting ? config.fovSprint : config.fovDefault;
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 6);
    this.camera.updateProjectionMatrix();
  }

  private applyStamina(dt: number, sprintPressed: boolean): void {
    if (this.state.isSprinting) {
      this.state.staminaPercent = clamp(
        this.state.staminaPercent - this.staminaDrainPerSec * dt,
        0,
        100,
      );
    } else if (!sprintPressed) {
      this.state.staminaPercent = clamp(
        this.state.staminaPercent + this.staminaRegenPerSec * dt,
        0,
        100,
      );
    }
  }

  /** 交互检测：准星投射射线，检测可交互对象 */
  checkInteractable(): InteractableObject | null {
    this.interactionRaycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hits = this.interactionRaycaster.intersectObjects(this.interactionTargets, true);
    if (hits.length > 0 && hits[0].distance < 2.5) {
      const data = hits[0].object.userData['interactable'];
      return (data as InteractableObject) ?? null;
    }
    return null;
  }

  /** 区域进入：触发特效与限速 */
  onZoneEnter(zone: DataCenterZone): void {
    if (this.state.currentZone === zone) return;
    this.state.currentZone = zone;
    switch (zone) {
      case 'HOT_AISLE':
        EventBus.emit('fx:heat_distortion', { intensity: 0.3 });
        this.config.walkSpeed *= 0.9;
        break;
      case 'COLD_AISLE':
        EventBus.emit('fx:cold_breath', {});
        this.config.headBobAmplitude.walk = this.config.headBobAmplitude.coldAisle;
        break;
      case 'NETWORK_ROOM':
      case 'STORAGE_ROOM':
      case 'COMMAND_POST':
        EventBus.emit('fx:zone_ambient', { zone });
        break;
    }
    EventBus.emit('player:zoneChange', { zone });
  }

  setEquippedTool(tool: ToolType | null): void {
    this.state.equippedTool = tool;
    EventBus.emit('player:toolChange', { tool });
  }
}
