/**
 * 教程关：数据中心 3 个主要房间 —— NETWORK_ROOM / STORAGE_ROOM / COMMAND_POST。
 *
 * 场景布局（俯视，单位米）：
 *
 *   -20 ────────────── 0 ────────────── 20
 *   ┌──────────┐    ┌──────────┐    ┌──────────┐
 *   │ NETWORK  │────│ COMMAND  │────│ STORAGE  │
 *   │  ROOM    │    │  POST    │    │  ROOM    │
 *   └──────────┘    └──────────┘    └──────────┘
 *
 * 每个房间：
 *  - 四堵墙（带门洞）+ 天花板（省略，仅地面差异化）
 *  - 一个可交互的控制台 Mesh，userData.interactable 指向流水线 hook
 *  - 一个进入触发器 Box3，供 ZoneManager 检测并切换 `currentZone`
 */
import * as THREE from 'three';
import type { PlayerController, DataCenterZone, InteractableObject } from '../fps/PlayerController';
import type { CollisionSystem } from '../fps/CollisionSystem';

export interface RoomBounds {
  zone: DataCenterZone;
  box: THREE.Box3;
}

export interface BuiltLevel {
  zones: RoomBounds[];
  consoles: {
    command: THREE.Object3D;
    network: THREE.Object3D;
    storage: THREE.Object3D;
    cutover: THREE.Object3D;
  };
}

const ROOM = { width: 10, depth: 10, wallHeight: 3, wallThickness: 0.3 };

const roomPositions: Record<Exclude<DataCenterZone, 'COLD_AISLE' | 'HOT_AISLE'>, [number, number]> = {
  NETWORK_ROOM: [-14, 0],
  COMMAND_POST: [0, 0],
  STORAGE_ROOM: [14, 0],
};

const wallMat = new THREE.MeshStandardMaterial({
  color: 0x1a2035,
  emissive: 0x0a1220,
  emissiveIntensity: 0.2,
  roughness: 0.9,
});

const floorMat = (tint: number): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: tint, roughness: 0.85 });

function addWall(
  scene: THREE.Scene,
  collision: CollisionSystem,
  x: number,
  z: number,
  w: number,
  d: number,
): void {
  const geom = new THREE.BoxGeometry(w, ROOM.wallHeight, d);
  const mesh = new THREE.Mesh(geom, wallMat);
  mesh.position.set(x, ROOM.wallHeight / 2, z);
  scene.add(mesh);
  collision.add({ box: new THREE.Box3().setFromObject(mesh), solid: true });
}

function buildRoomWalls(
  scene: THREE.Scene,
  collision: CollisionSystem,
  cx: number,
  cz: number,
  doorwaysOn: ('N' | 'S' | 'E' | 'W')[],
): void {
  const { width: w, depth: d, wallThickness: t } = ROOM;
  const halfW = w / 2;
  const halfD = d / 2;
  const door = 2.0; // 门洞宽度

  // North wall (−Z)
  if (doorwaysOn.includes('N')) {
    const seg = (w - door) / 2;
    addWall(scene, collision, cx - (halfW - seg / 2), cz - halfD, seg, t);
    addWall(scene, collision, cx + (halfW - seg / 2), cz - halfD, seg, t);
  } else {
    addWall(scene, collision, cx, cz - halfD, w, t);
  }
  // South wall (+Z)
  if (doorwaysOn.includes('S')) {
    const seg = (w - door) / 2;
    addWall(scene, collision, cx - (halfW - seg / 2), cz + halfD, seg, t);
    addWall(scene, collision, cx + (halfW - seg / 2), cz + halfD, seg, t);
  } else {
    addWall(scene, collision, cx, cz + halfD, w, t);
  }
  // East wall (+X)
  if (doorwaysOn.includes('E')) {
    const seg = (d - door) / 2;
    addWall(scene, collision, cx + halfW, cz - (halfD - seg / 2), t, seg);
    addWall(scene, collision, cx + halfW, cz + (halfD - seg / 2), t, seg);
  } else {
    addWall(scene, collision, cx + halfW, cz, t, d);
  }
  // West wall (−X)
  if (doorwaysOn.includes('W')) {
    const seg = (d - door) / 2;
    addWall(scene, collision, cx - halfW, cz - (halfD - seg / 2), t, seg);
    addWall(scene, collision, cx - halfW, cz + (halfD - seg / 2), t, seg);
  } else {
    addWall(scene, collision, cx - halfW, cz, t, d);
  }
}

function addConsole(
  scene: THREE.Scene,
  collision: CollisionSystem,
  x: number,
  z: number,
  color: number,
  label: string,
  interactableId: string,
  interactableType: string,
  onInteract: () => void,
): THREE.Object3D {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.9, 0.6),
    new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.8 }),
  );
  base.position.y = 0.45;
  group.add(base);

  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 0.6),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.8,
      side: THREE.DoubleSide,
    }),
  );
  screen.position.set(0, 1.15, 0.31);
  screen.userData['interactable'] = {
    id: interactableId,
    type: interactableType,
    label,
    onInteract,
  } satisfies InteractableObject;
  group.add(screen);

  scene.add(group);
  collision.add({ box: new THREE.Box3().setFromObject(base), solid: true });
  return screen;
}

function addCorridor(
  scene: THREE.Scene,
  x1: number,
  x2: number,
  width = 3,
): void {
  const len = Math.abs(x2 - x1);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(len, width),
    floorMat(0x0b1020),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((x1 + x2) / 2, 0.001, 0);
  scene.add(floor);
}

export function buildTutorialLevel(
  scene: THREE.Scene,
  collision: CollisionSystem,
  callbacks: {
    onCommandConsole: () => void;
    onNetworkConsole: () => void;
    onStorageConsole: () => void;
    onCutoverConsole: () => void;
  },
): BuiltLevel {
  // 房间地板（不同色温暗示区域）
  const roomFloors: { zone: DataCenterZone; color: number; doors: ('N' | 'S' | 'E' | 'W')[] }[] = [
    { zone: 'NETWORK_ROOM', color: 0x0d1a30, doors: ['E'] },
    { zone: 'COMMAND_POST', color: 0x0f1726, doors: ['E', 'W'] },
    { zone: 'STORAGE_ROOM', color: 0x1a1028, doors: ['W'] },
  ];

  const zones: RoomBounds[] = [];
  for (const r of roomFloors) {
    const [cx, cz] = roomPositions[r.zone as Exclude<DataCenterZone, 'COLD_AISLE' | 'HOT_AISLE'>];
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM.width, ROOM.depth),
      floorMat(r.color),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0, cz);
    scene.add(floor);
    buildRoomWalls(scene, collision, cx, cz, r.doors);

    const box = new THREE.Box3(
      new THREE.Vector3(cx - ROOM.width / 2, 0, cz - ROOM.depth / 2),
      new THREE.Vector3(cx + ROOM.width / 2, ROOM.wallHeight, cz + ROOM.depth / 2),
    );
    zones.push({ zone: r.zone, box });
  }

  // 走廊
  addCorridor(scene, -(ROOM.width / 2) - 4, -(ROOM.width / 2));
  addCorridor(scene, ROOM.width / 2, ROOM.width / 2 + 4);

  // 环境光
  scene.add(new THREE.HemisphereLight(0x99cfff, 0x0a1a2a, 0.55));
  const key = new THREE.DirectionalLight(0x88ccff, 0.45);
  key.position.set(5, 12, 5);
  scene.add(key);

  // 每间房的点光，给出区域化氛围
  const roomLight = (x: number, color: number): void => {
    const light = new THREE.PointLight(color, 0.6, 12);
    light.position.set(x, 2.6, 0);
    scene.add(light);
  };
  roomLight(-14, 0x00b4ff);
  roomLight(0, 0x00e676);
  roomLight(14, 0xffb300);

  // 指挥台两个控制台：vCenter 登录 + Cutover
  const command = addConsole(
    scene,
    collision,
    -2.5,
    -3.5,
    0x00e676,
    '[E] 连接 vCenter 开始迁移',
    'command-console',
    'COMMAND_CONSOLE',
    callbacks.onCommandConsole,
  );
  const cutover = addConsole(
    scene,
    collision,
    2.5,
    -3.5,
    0xff1744,
    '[E] 启动数据同步与切换',
    'cutover-console',
    'CUTOVER_CONSOLE',
    callbacks.onCutoverConsole,
  );

  const network = addConsole(
    scene,
    collision,
    -14,
    -3.5,
    0x00b4ff,
    '[E] 配置 vSwitch → Bridge 映射',
    'network-console',
    'NETWORK_CONSOLE',
    callbacks.onNetworkConsole,
  );

  const storage = addConsole(
    scene,
    collision,
    14,
    -3.5,
    0xffb300,
    '[E] 配置 VM → 存储池 映射',
    'storage-console',
    'STORAGE_CONSOLE',
    callbacks.onStorageConsole,
  );

  // 房间里摆几台装饰机架，让画面不空洞
  const rackMat = new THREE.MeshStandardMaterial({
    color: 0x2a2f3a,
    emissive: 0x002a4a,
    emissiveIntensity: 0.2,
  });
  const addRack = (x: number, z: number): void => {
    const rack = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2, 1.2), rackMat);
    rack.position.set(x, 1, z);
    scene.add(rack);
    collision.add({ box: new THREE.Box3().setFromObject(rack), solid: true });
  };
  // 网络间：交换机架 2 列
  for (let i = 0; i < 3; i++) {
    addRack(-17, -2 + i * 2);
    addRack(-11, -2 + i * 2);
  }
  // 存储间：存储阵列
  for (let i = 0; i < 3; i++) {
    addRack(11, -2 + i * 2);
    addRack(17, -2 + i * 2);
  }

  return {
    zones,
    consoles: { command, cutover, network, storage },
  };
}

/** 在每帧调用：根据玩家当前位置决定应进入哪个区域 */
export class ZoneManager {
  constructor(private readonly zones: RoomBounds[]) {}

  update(player: PlayerController): void {
    const p = player.state.position;
    for (const z of this.zones) {
      if (
        p.x >= z.box.min.x &&
        p.x <= z.box.max.x &&
        p.z >= z.box.min.z &&
        p.z <= z.box.max.z
      ) {
        if (player.state.currentZone !== z.zone) player.onZoneEnter(z.zone);
        return;
      }
    }
    // 不在任一房间内 → 默认走廊视作 COMMAND_POST（不切换，避免频繁 toggle）
  }
}
