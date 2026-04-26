# 第三方声明 / Third-Party Notices

本项目发布包中使用了以下第三方依赖及其许可证。完整的依赖树与许可证请以 `npm ls` 与各包的 `LICENSE` 文件为准。

## 运行时（Client）

| 依赖 | 许可证 | 链接 |
|---|---|---|
| three.js | MIT | https://github.com/mrdoob/three.js |
| React / React DOM | MIT | https://github.com/facebook/react |
| howler.js | MIT | https://github.com/goldfire/howler.js |

## 运行时（Server）

| 依赖 | 许可证 | 链接 |
|---|---|---|
| Express | MIT | https://github.com/expressjs/express |
| ws | MIT | https://github.com/websockets/ws |
| cors | MIT | https://github.com/expressjs/cors |
| zod | MIT | https://github.com/colinhacks/zod |
| express-rate-limit | MIT | https://github.com/express-rate-limit/express-rate-limit |

## 开发依赖

TypeScript、Vite、vitest、tsx 等开发依赖均采用 MIT 许可证。详细列表见各包的 `package.json` 与 `node_modules/*/LICENSE`。

---

本项目自身遵循 [MIT 许可证](LICENSE)。若你将本项目作为静态资源分发，请在 About 页或发行包内包含本文件。

---

## 第三方 3D 资产 / Third-Party 3D Assets

本项目支持加载位于 `client/public/models/` 下的 glTF/GLB 资产以增强机房、人物、工具/枪支、敌人的视觉效果。仓库默认 **不打包** 这些二进制文件——`AssetLoader` 在缺失时会优雅降级为占位几何体，以保证 CI 和单元测试无需依赖大文件即可通过。

资产清单及其来源/许可证均在 `client/src/engine/AssetManifest.ts` 中以代码形式登记，详细的人类可读版本见 [`client/public/models/CREDITS.md`](client/public/models/CREDITS.md)。

| 类别 | 推荐来源 | 许可证 | 署名要求 |
|---|---|---|---|
| 角色（主角/工程师 NPC） | three.js 官方 [`Soldier.glb`](https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/Soldier.glb) | CC-BY 4.0 | **必须**：在分发包/About 页注明 "Soldier" model © three.js authors，使用 [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| 敌人（机器人/怪物） | [Quaternius Robots/Monsters Pack](https://quaternius.com/) | CC0 | 不强制；建议以 courtesy credit 形式致谢 Quaternius |
| 机房环境（机柜、控制台、地板等） | [Quaternius Sci-Fi Modular/Props](https://quaternius.com/) + [Kenney Sci-fi Kit](https://kenney.nl/assets/sci-fi-kit) | CC0 | 同上，courtesy credit |
| 工具/枪支 | [Quaternius FPS/Sci-Fi Guns Pack](https://quaternius.com/) + [Kenney Weapon Pack](https://kenney.nl/assets/weapon-pack) | CC0 | 同上，courtesy credit |
| 动画补充（attack/reload/death） | [Mixamo](https://mixamo.com) | Adobe Mixamo EULA（项目内嵌入免费） | 不在仓库分发原始 FBX；仅嵌入 retarget 后的 GLB 输出 |

> **注意**：当你新增或替换资产时，必须同时更新 `AssetManifest.ts`、`client/public/models/CREDITS.md`，并视许可证情况更新本 `NOTICE.md` 表格。
