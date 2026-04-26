# 3D Asset Credits

This directory holds runtime 3D assets (glTF/GLB) loaded by the client through
`client/src/engine/AssetLoader.ts`. Asset paths and licensing metadata are
declared in `client/src/engine/AssetManifest.ts`; this file is the human-readable
counterpart.

The repository's source code is **MIT-licensed** (see `LICENSE`). The 3D assets
listed below are distributed under their own licenses and are **not** covered by
the MIT license. Please honor the attribution requirements below when you
redistribute the built artifact (e.g. on a public dashboard or a release
package).

## Layout

```
client/public/models/
├── characters/
│   ├── engineer.glb            (player / NPC engineer; Soldier.glb mirror)
│   ├── enemy_bot.glb           (data-corruption robot)
│   └── enemy_corruption.glb    (alternate monster enemy)
├── environment/
│   ├── rack.glb
│   ├── console.glb
│   ├── floor_tile.glb
│   ├── door.glb
│   ├── cable_tray.glb
│   └── ceiling_truss.glb
└── tools/
    ├── snapshot_gun.glb
    ├── fiber_patcher.glb
    ├── tablet.glb
    ├── smart_probe.glb
    ├── recovery_kit.glb
    └── bandwidth.glb
```

> The repository ships **without** the binary GLB files. CI and unit tests do
> not need them — `AssetLoader` falls back to placeholder geometry when an asset
> is missing. To enable the full visual upgrade, drop the files into the
> directories above (or replace `AssetManifest.ts` with your own paths).

## Sources & Licenses

### Characters

| File | Source | License | Attribution |
|---|---|---|---|
| `characters/engineer.glb` | three.js examples — [`Soldier.glb`](https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/Soldier.glb) | **CC-BY 4.0** | "Soldier" model © three.js authors / Tomás Laulhé / quaternius. Used under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). |
| `characters/enemy_bot.glb` | [Quaternius — Robots Pack](https://quaternius.com/packs/robotspack.html) | **CC0** | No attribution required, but courtesy credit appreciated: Robots Pack by Quaternius. |
| `characters/enemy_corruption.glb` | [Quaternius — Monsters Pack](https://quaternius.com/packs/monsterspack.html) | **CC0** | Courtesy credit: Monsters Pack by Quaternius. |

### Environment

| File | Source | License |
|---|---|---|
| `environment/rack.glb` | [Quaternius — Sci-Fi Modular Pack](https://quaternius.com/packs/scifimodularpack.html) | **CC0** |
| `environment/console.glb` | [Kenney — Sci-fi Kit](https://kenney.nl/assets/sci-fi-kit) | **CC0** |
| `environment/floor_tile.glb` | [Quaternius — Sci-Fi Modular Pack](https://quaternius.com/packs/scifimodularpack.html) | **CC0** |
| `environment/door.glb` | [Kenney — Sci-fi Kit](https://kenney.nl/assets/sci-fi-kit) | **CC0** |
| `environment/cable_tray.glb` | [Quaternius — Sci-Fi Props Pack](https://quaternius.com/packs/scifipropspack.html) | **CC0** |
| `environment/ceiling_truss.glb` | [Quaternius — Sci-Fi Modular Pack](https://quaternius.com/packs/scifimodularpack.html) | **CC0** |

### Tools / Weapons

| File | Source | License |
|---|---|---|
| `tools/snapshot_gun.glb` | [Quaternius — Sci-Fi Guns Pack](https://quaternius.com/packs/scifigunspack.html) | **CC0** |
| `tools/fiber_patcher.glb` | [Quaternius — FPS Guns Pack](https://quaternius.com/packs/fpsgunspack.html) | **CC0** |
| `tools/tablet.glb` | [Kenney — Weapon Pack](https://kenney.nl/assets/weapon-pack) | **CC0** |
| `tools/smart_probe.glb` | [Quaternius — Sci-Fi Guns Pack](https://quaternius.com/packs/scifigunspack.html) | **CC0** |
| `tools/recovery_kit.glb` | [Quaternius — Sci-Fi Props Pack](https://quaternius.com/packs/scifipropspack.html) | **CC0** |
| `tools/bandwidth.glb` | [Quaternius — Sci-Fi Props Pack](https://quaternius.com/packs/scifipropspack.html) | **CC0** |

### Animations supplement

Mixamo (https://mixamo.com) is used as an *animation library* — when extra
clips (attack / reload / death) are needed, they are baked onto the CC0 skeleton
and re-exported as glTF. The repository **does not redistribute raw Mixamo FBX**;
only the baked GLB output is shipped.

## How to add or replace assets

1. Drop the GLB into the right subdirectory.
2. Update or add the matching entry in `client/src/engine/AssetManifest.ts`.
3. Re-run `npm run typecheck && npm test && npm run build`.
4. Append the new entry to this `CREDITS.md` and to `NOTICE.md` if the license
   requires attribution (e.g. CC-BY).
