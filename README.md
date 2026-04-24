# 数据中心攻坚战 · SmartX FPS × V2V Migration

[![CI](https://github.com/wlqtjl/smartx-/actions/workflows/ci.yml/badge.svg)](https://github.com/wlqtjl/smartx-/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一款以 SmartX 虚拟化迁移为主题的 FPS × 模拟经营混合体验：玩家在 3D 机房中操作控制台，驱动真实的 V2V 迁移状态机（环境扫描 → 兼容性 → 网络/存储映射 → 数据同步 → 驱动注入 → 切换 → 验证），并依据执行质量计分。

<p align="center">
  <em>Three.js + React (Vite, TypeScript)  ·  Node.js + Express + ws 权威仿真</em>
</p>

---

## 特性概览

- **端到端迁移状态机** — 8 个阶段在服务端权威执行，客户端事件驱动呈现。
- **实时双向通道** — REST 下发指令，WebSocket 广播进度与评分事件。
- **断点续传** — 任何阶段可中断、序列化与恢复（`CheckpointSystem`）。
- **降级模式** — 无服务端时客户端自动回落到本地模拟，保留完整演示能力。
- **强类型协议** — `shared/` 包为两端提供唯一 DTO / 消息定义源。

## 仓库结构

```
.
├── shared/              # 跨端 DTO 类型 + 协议常量
├── client/              # Vite + React + Three.js 前端
├── server/              # Node + Express + ws 服务端（权威 FSM）
├── docs/
│   ├── design.md        # 原游戏设计稿（玩法、美术规范、音效清单）
│   └── deployment.md    # 部署指南
├── scripts/dev.sh       # 本地一键启动前后端
├── Dockerfile.server    # 服务端容器镜像（多阶段）
├── Dockerfile.client    # 前端静态资源镜像（Nginx）
└── docker-compose.yml   # 本地与小规模部署编排
```

详细架构与数据流见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 快速开始（本地开发）

前置条件：**Node.js ≥ 20**、npm ≥ 10（两端各自有独立锁文件）。

```bash
# 一键前后端开发启动（默认 server :8787, client :5173）
./scripts/dev.sh
```

或分开启动：

```bash
# 服务端
cd server && npm install && npm run dev

# 客户端（另一个终端）
cd client && npm install && npm run dev
```

打开终端中 Vite 输出的 URL 即可进入场景。

## 部署

最小生产部署使用 Docker Compose：

```bash
cp .env.example .env            # 按需编辑端口、CORS 白名单等
docker compose up -d --build
# 服务端监听 :8787，前端由 Nginx 伺服 :8080
```

生产部署必读：[`docs/deployment.md`](docs/deployment.md)。

## 测试

| 包 | 命令 | 说明 |
|---|---|---|
| server | `cd server && npm test` | 21 个 `node:test` 用例：FSM 合法性、评分、REST + WS 端到端 |
| server | `cd server && npm run typecheck && npm run build` | 严格 TS + `tsc` 产物构建 |
| client | `cd client && npm test` | 25 个 vitest 用例 |
| client | `cd client && npm run typecheck && npm run build` | Vite 生产构建 |

## 配置

所有环境变量均在 [`.env.example`](.env.example) 中列出并注释。生产环境必须设置：

- `SMARTX_ALLOWED_ORIGINS` — 逗号分隔的 CORS 白名单（不设置将拒绝启动）。
- `SMARTX_WS_ALLOWED_ORIGINS` — WebSocket Origin 白名单（默认复用 `SMARTX_ALLOWED_ORIGINS`）。
- `SMARTX_DATA_PATH` — JSON 持久化路径（单实例；多实例请参考部署文档）。

## 贡献

欢迎提交 Issue / PR！在开始前请阅读：
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — 本地环境、代码风格、测试与提交约定。
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — 行为准则。
- [`SECURITY.md`](SECURITY.md) — 漏洞报告流程（请勿直接公开 issue）。

## 许可协议

本项目基于 [MIT License](LICENSE) 开源。三方依赖（three.js / React / howler 等）的许可证与致谢详见 [`NOTICE.md`](NOTICE.md)。

---

## 路线图（摘录）

- [x] V0.1 — 教程关全流程（当前版本）
- [ ] V0.2 — 真实身份认证（SSO/JWT），速率限制持久化到 Redis
- [ ] V0.3 — SQLite / Postgres 持久化适配器
- [ ] V0.4 — 章节关卡、成就系统、排行榜
- [ ] V1.0 — 公测

完整变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。
