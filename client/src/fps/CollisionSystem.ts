import * as THREE from 'three';

/**
 * 极简碰撞系统：仅使用包围盒。
 * 游戏中应替换为 AABB/胶囊体 + 物理引擎；此处用于玩家移动限制与类型完整性。
 */
export interface CollisionObject {
  box: THREE.Box3;
  solid: boolean;
}

export class CollisionSystem {
  private objects: CollisionObject[] = [];

  add(obj: CollisionObject): void {
    this.objects.push(obj);
  }

  /** 判断给定位置的玩家胶囊是否与实体障碍相交 */
  collides(position: THREE.Vector3, radius = 0.35, height = 1.75): boolean {
    const min = new THREE.Vector3(position.x - radius, position.y, position.z - radius);
    const max = new THREE.Vector3(position.x + radius, position.y + height, position.z + radius);
    const capsule = new THREE.Box3(min, max);
    return this.objects.some((o) => o.solid && o.box.intersectsBox(capsule));
  }

  /** 玩家是否站在地面（y=0 平面或任何实体顶部） */
  isGrounded(position: THREE.Vector3, radius = 0.35): boolean {
    if (position.y <= 0.001) return true;
    const probeMin = new THREE.Vector3(position.x - radius, position.y - 0.05, position.z - radius);
    const probeMax = new THREE.Vector3(position.x + radius, position.y + 0.01, position.z + radius);
    const probe = new THREE.Box3(probeMin, probeMax);
    return this.objects.some((o) => o.solid && o.box.intersectsBox(probe));
  }
}
