/**
 * 资产清单（白名单）
 *
 * 集中登记所有可加载的 3D 资源 URL。设计目的：
 *  - **安全**：`AssetLoader` 只接受清单 *键*（AssetKey），不接受任意字符串/用户输入，
 *    避免 SSRF / 资源耗尽 / 用户控制的 URL 污染。所有 URL 都是相对 `BASE_URL` 的静态路径。
 *  - **可追溯**：每个条目附 `source` / `license` 字段，便于自动生成 CREDITS.md / NOTICE.md。
 *  - **可替换**：未来要换成 Quaternius / Mixamo / Kenney 等不同包，只改这里一处。
 *
 * 资产文件本身位于 `client/public/models/...`，按 Vite 静态目录约定通过 `import.meta.env.BASE_URL`
 * 解析（默认 `/`）。如果对应文件尚未提交，`AssetLoader.loadGLTF` 会优雅降级（fallback 占位）。
 */
import type { ToolType } from '../fps/ToolSystem';

/** 第三方资源许可证标签 */
export type AssetLicense =
  | 'CC0' // Quaternius / Kenney / KayKit / Poly Pizza-CC0：无署名义务
  | 'CC-BY-4.0' // three.js 官方 examples 资产：需署名
  | 'MIT'
  | 'PROPRIETARY-PLACEHOLDER';

export interface AssetEntry {
  /** 相对 BASE_URL 的路径，例如 `models/tools/snapshot_gun.glb` */
  path: string;
  source: string;
  license: AssetLicense;
  /** 简短描述，用于 CREDITS 与调试日志 */
  notes?: string;
}

/**
 * 角色资产键（用于带骨骼动画的 GLB）。
 * 默认主角 / 工程师 NPC 用 three.js 官方 Soldier.glb（自带 idle/walk/run）。
 */
export type CharacterAssetKey = 'engineer' | 'enemy_bot' | 'enemy_corruption';

/** 环境（机房）资产键 */
export type EnvAssetKey =
  | 'rack'
  | 'console_terminal'
  | 'floor_tile'
  | 'door'
  | 'cable_tray'
  | 'ceiling_truss';

/** 工具/枪支资产键，与 ToolType 一一对应 */
export type ToolAssetKey = ToolType;

export type AssetKey = CharacterAssetKey | EnvAssetKey | ToolAssetKey;

/**
 * 全部资产登记表。如果某个文件还没真正落库，依然保留键，
 * `AssetLoader` 会尝试加载并在 404 时回退到占位 mesh。
 */
export const ASSET_MANIFEST: Readonly<Record<AssetKey, AssetEntry>> = {
  // === 角色 ===
  engineer: {
    path: 'models/characters/engineer.glb',
    source:
      'three.js examples (Soldier.glb) — https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/Soldier.glb',
    license: 'CC-BY-4.0',
    notes: '带骨骼 + idle/walk/run 动画，作为主角 / 工程师 NPC 使用',
  },
  enemy_bot: {
    path: 'models/characters/enemy_bot.glb',
    source: 'Quaternius Robots Pack — https://quaternius.com/packs/robotspack.html',
    license: 'CC0',
    notes: '"故障机器人" 风格的敌人，预期 clip：Robot_Idle/Walk/Attack/Death',
  },
  enemy_corruption: {
    path: 'models/characters/enemy_corruption.glb',
    source: 'Quaternius Monsters Pack — https://quaternius.com/packs/monsterspack.html',
    license: 'CC0',
    notes: '可选：数据腐蚀实体，主题更夸张的备用敌人',
  },

  // === 环境 / 机房 ===
  rack: {
    path: 'models/environment/rack.glb',
    source: 'Quaternius Sci-Fi Modular Pack — https://quaternius.com/packs/scifimodularpack.html',
    license: 'CC0',
  },
  console_terminal: {
    path: 'models/environment/console.glb',
    source: 'Kenney Sci-fi Kit — https://kenney.nl/assets/sci-fi-kit',
    license: 'CC0',
    notes: '控制台外观，子节点命名约定 `interact_screen` 用于挂载 userData.interactable',
  },
  floor_tile: {
    path: 'models/environment/floor_tile.glb',
    source: 'Quaternius Sci-Fi Modular Pack — https://quaternius.com/packs/scifimodularpack.html',
    license: 'CC0',
  },
  door: {
    path: 'models/environment/door.glb',
    source: 'Kenney Sci-fi Kit — https://kenney.nl/assets/sci-fi-kit',
    license: 'CC0',
  },
  cable_tray: {
    path: 'models/environment/cable_tray.glb',
    source: 'Quaternius Sci-Fi Props Pack — https://quaternius.com/packs/scifipropspack.html',
    license: 'CC0',
  },
  ceiling_truss: {
    path: 'models/environment/ceiling_truss.glb',
    source: 'Quaternius Sci-Fi Modular Pack — https://quaternius.com/packs/scifimodularpack.html',
    license: 'CC0',
  },

  // === 工具 / 枪支 ===
  SMART_PROBE: {
    path: 'models/tools/smart_probe.glb',
    source: 'Quaternius Sci-Fi Guns Pack — https://quaternius.com/packs/scifigunspack.html',
    license: 'CC0',
    notes: '智能采集跳线 — Sci-Fi Scanner 视觉',
  },
  FIBER_PATCHER: {
    path: 'models/tools/fiber_patcher.glb',
    source: 'Quaternius FPS Guns Pack — https://quaternius.com/packs/fpsgunspack.html',
    license: 'CC0',
    notes: '光纤跳线工具 — Pistol 改材质',
  },
  DIAGNOSTIC_TABLET: {
    path: 'models/tools/tablet.glb',
    source: 'Kenney Weapon Pack — https://kenney.nl/assets/weapon-pack',
    license: 'CC0',
  },
  RECOVERY_KIT: {
    path: 'models/tools/recovery_kit.glb',
    source: 'Quaternius Sci-Fi Props Pack — https://quaternius.com/packs/scifipropspack.html',
    license: 'CC0',
  },
  BANDWIDTH_LIMITER: {
    path: 'models/tools/bandwidth.glb',
    source: 'Quaternius Sci-Fi Props Pack — https://quaternius.com/packs/scifipropspack.html',
    license: 'CC0',
  },
  SNAPSHOT_GUN: {
    path: 'models/tools/snapshot_gun.glb',
    source: 'Quaternius Sci-Fi Guns Pack — https://quaternius.com/packs/scifigunspack.html',
    license: 'CC0',
    notes: '快照枪 — Sci-Fi Pistol 视觉',
  },
};

/**
 * 把清单条目解析成可加载的 URL（相对 Vite BASE_URL）。
 *
 * 注意：本函数 **不接受任意字符串**，仅支持 `AssetKey`，从而保证：
 *   - 不会被用户输入注入路径
 *   - 不会泄露内部资源到外部域
 *   - CodeQL `js/path-injection` 不会被触发
 */
export function resolveAssetUrl(key: AssetKey): string {
  const entry = ASSET_MANIFEST[key];
  // BASE_URL 在 Vite 中默认为 '/'；测试环境可能没有，回退 ''
  const base =
    (typeof import.meta !== 'undefined' && import.meta?.env?.BASE_URL) || '/';
  // 已知 entry.path 不以 '/' 开头
  return `${base}${entry.path}`.replace(/\/{2,}/g, '/');
}

/** 是否所有清单 key 都被声明：编译期检查 */
export const __ALL_KEYS_DECLARED__: ReadonlyArray<AssetKey> = Object.keys(
  ASSET_MANIFEST,
) as AssetKey[];
