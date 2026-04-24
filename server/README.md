# SmartX Migration Server

服务端（Node.js + TypeScript + Express + ws），为《数据中心攻坚战》客户端提供权威的 V2V 迁移仿真服务。

## 快速开始

```bash
# 安装依赖
npm install

# 启动（默认 8787 端口，0.0.0.0）
npm run start

# 或者开发模式（自动热重启）
npm run dev

# 运行测试
npm test

# 类型检查 / 生产构建
npm run typecheck
npm run build
```

## 环境变量

完整列表见仓库根目录 [`.env.example`](../.env.example)。最常用：

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `SMARTX_PORT` | `8787` | HTTP/WS 监听端口 |
| `SMARTX_HOST` | `0.0.0.0` | 绑定地址 |
| `SMARTX_DATA_PATH` | `data/state.json` | 持久化文件（JSON） |
| `SMARTX_ALLOWED_ORIGINS` | *（dev 全放行 / prod 必填）* | CORS 白名单，逗号分隔。`NODE_ENV=production` 时为空会拒绝启动。 |
| `SMARTX_WS_ALLOWED_ORIGINS` | *（同上 CORS 列表）* | WebSocket Origin 白名单 |
| `SMARTX_RATE_LIMIT_PER_MIN` | `60` | 每 token/IP 每分钟请求上限 |
| `SMARTX_WS_MAX_SUBSCRIPTIONS` | `16` | 每 WS 连接订阅任务数上限 |
| `SMARTX_STATIC_ROOT` | *(空)* | 若设置，在 `/` 伺服该目录的 SPA 构建产物 |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |

## 架构总览

```
┌───────── Client (Three.js + Vite) ─────────┐
│  apiClient ──REST──┐                       │
│  socketClient ─WS──┤                       │
└────────────────────┼───────────────────────┘
                     │
              ┌──────▼──────┐
              │ HTTP Server │  /api   /ws   /health
              └──────┬──────┘
                     │
      ┌──────────────┼────────────────┐
      ▼              ▼                ▼
  FSM (权威)   Phase 引擎         ScoringRegistry
   │             ├─ EnvScan       + CheckpointSystem
   │             ├─ Compat        + SessionStore
   │             ├─ NetworkMap
   │             ├─ StorageMap
   │             ├─ DataSync (tick)
   │             ├─ DriverInjection
   │             ├─ Cutover
   │             └─ PostCheck
   │
   └── EventBus ─── WebSocketServer 桥接 ──→ 订阅客户端
```

所有状态转换、评分、断点都在服务端完成；客户端只负责渲染与输入。

## REST 端点

所有非 `/auth/session` 和 `/health` 的路由都需要 `X-Session-Token` 头。

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/auth/session` | 创建会话（返回 token） |
| `DELETE` | `/api/auth/session` | 销毁会话 |
| `POST` | `/api/environment/scan` | 扫描源端 vCenter（mock） |
| `POST` | `/api/compatibility/check` | 兼容性检查 |
| `GET`/`POST` | `/api/migration/tasks` | 列出/创建任务 |
| `GET` | `/api/migration/tasks/:id` | 任务详情 |
| `POST` | `/api/migration/tasks/:id/transition` | 状态迁移（非法转换返 409） |
| `POST` | `/api/migration/tasks/:id/network-mapping` | 提交网络映射 |
| `POST` | `/api/migration/tasks/:id/storage-mapping` | 提交存储映射 |
| `POST` | `/api/migration/tasks/:id/sync/start` | 启动同步 tick |
| `POST` | `/api/migration/tasks/:id/sync/stop` | 停止同步 |
| `POST` | `/api/migration/tasks/:id/sync/incremental` | 增量同步轮次 |
| `POST` | `/api/migration/tasks/:id/driver-injection` | 驱动注入 |
| `POST` | `/api/migration/tasks/:id/cutover` | 切换执行 |
| `POST` | `/api/migration/tasks/:id/post-check` | 事后验证 |
| `GET`/`POST` | `/api/migration/tasks/:id/checkpoints` | 列出/保存断点 |
| `POST` | `/api/migration/tasks/:id/resume` | 从最新断点恢复 |
| `GET` | `/api/migration/tasks/:id/score` | 评分汇总 |
| `POST` | `/api/migration/tasks/:id/score/apply` | 应用评分规则 |
| `GET` | `/health` | 健康检查（公开） |

## WebSocket 协议

握手：`ws://host:port/ws?token=<session token>`

服务端消息：

```ts
{ type: 'hello', protocolVersion: 1 }
{ type: 'event', taskId: string | null, event: string, payload: unknown }
{ type: 'pong', at: number }
{ type: 'error', message: string }
```

客户端消息：

```ts
{ type: 'subscribe', taskId: string }
{ type: 'unsubscribe', taskId: string }
{ type: 'ping', at: number }
```

被广播的事件前缀：`migration:`, `ui:`, `fx:`, `audio:`, `checkpoint:`, `achievement:`。
