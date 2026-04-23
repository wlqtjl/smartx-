# SmartX FPS × V2V Migration — 软件架构总览

本仓库实现了《数据中心攻坚战》FPS 玩法与 SmartX V2V 迁移仿真的完整客户端 + 服务端架构。

## 仓库结构

```
.
├── shared/              # 客户端/服务端共享的 TypeScript DTO 类型
├── client/              # Three.js + Vite 前端（FPS、场景、UI、迁移剧情）
├── server/              # Node.js + Express + ws 服务端（权威迁移仿真）
├── scripts/dev.sh       # 同时启动前后端的开发脚本
└── README.md            # 原游戏设计文档 v2.0（未修改）
```

三层解耦：

- **表现层 (client)** — Three.js 场景、FPS 控制器、HUD；不持有权威业务状态。
- **协议层 (shared)** — 迁移状态机、映射、评分、断点等 DTO 的唯一来源。
- **领域层 (server)** — 权威的 FSM、阶段引擎、持久化、评分、事件广播。

```
┌──────── Client (Browser, Three.js) ────────┐
│  Three.js scene / FPS / HUD / UIManager    │
│        ↑ REST (apiClient) + WS (socketClient)
└────────┬────────────────────────────────────┘
         │ http://host:8787  ws://host:8787/ws
┌────────▼──────────── Server ───────────────┐
│  Express + ws                              │
│  MigrationStateMachine (authoritative)     │
│  Phase engines: EnvScan / Compat /         │
│    NetworkMapping / StorageMapping /       │
│    DataSync (tick) / DriverInjection /     │
│    Cutover / PostCheck                     │
│  CheckpointSystem  ScoringRegistry         │
│  SessionStore      JsonStore (file persist)│
│  EventBus → WebSocket broadcast            │
└────────────────────────────────────────────┘
```

所有阶段合法性校验、评分计算、状态机转换都发生在服务端；服务端通过 WebSocket 向订阅了特定任务的客户端广播 `migration:*` / `ui:*` / `fx:*` 事件，客户端转发到本地 `EventBus`，渲染/音效层监听原有事件名即可。

## 快速运行

```bash
# 后端：依赖 + 测试 + 启动
cd server && npm install && npm test && npm run dev &

# 前端：依赖 + 启动（自动连接 http://localhost:8787）
cd client && npm install && npm run dev

# 或一键启动（需要先 npm install 两端）
./scripts/dev.sh
```

打开 Vite 输出的 URL 即可进入场景，服务端日志会显示 WebSocket 订阅与状态转换。

## 降级策略

- 若客户端未检测到后端（`VITE_SMARTX_API` 为空且 `fetch` 失败），前端会回落到纯本地模拟模式（保留原 demo 行为）。
- 若 WebSocket 断开，会按指数退避 + 抖动自动重连（上限 30 s），并在恢复后重新订阅之前的任务。
- 服务端以 JSON 文件（`SMARTX_DATA_PATH`）做最小持久化，重启后任务与断点会恢复。

## 测试

- **Server**: `cd server && npm test` — 21 个用例覆盖 FSM 合法性、存储错配、评分、网络映射、REST + WebSocket 端到端。
- **Client**: `cd client && npm run typecheck && npm run build` — 严格 TypeScript + Vite 构建。

详细 API 与协议见 `server/README.md`。
