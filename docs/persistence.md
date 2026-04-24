# 持久化适配层（PR #2）

SmartX V2V 迁移服务端把"任务/断点/用户/会话/审计日志"统一抽象为 `Store` 接口，下挂三种后端：

| 后端       | 适用场景                          | 并发模型                                     | 配置要求                              |
|------------|-----------------------------------|----------------------------------------------|---------------------------------------|
| `json`     | 本地开发 / 单实例演示             | 单进程独占文件；多实例**不安全**             | `SMARTX_DATA_PATH`（默认 `data/state.json`） |
| `sqlite`   | 单节点生产（小规模、低写入）       | WAL 模式；同进程并发安全；多进程文件锁        | `SMARTX_SQLITE_PATH`（默认同目录 `smartx.db`） |
| `postgres` | 多实例生产（推荐）                | 连接池 + `pg_advisory_lock` 守护迁移         | `DATABASE_URL`；可选 `SMARTX_DB_POOL_MAX` |

## 选择后端

优先级：显式 `SMARTX_STORE` > 存在 `DATABASE_URL` → `postgres` > 默认 `json`。

生产环境（`NODE_ENV=production`）下默认**拒绝** `json`，需显式设置 `SMARTX_ALLOW_JSON_IN_PROD=1` 才允许。

```bash
# 开发
SMARTX_STORE=sqlite SMARTX_SQLITE_PATH=./data/smartx.db npm --prefix server run dev

# 生产（单节点）
SMARTX_STORE=sqlite NODE_ENV=production SMARTX_ALLOWED_ORIGINS=https://... npm --prefix server start

# 生产（多节点）
DATABASE_URL=postgres://user:pw@pg:5432/smartx SMARTX_STORE=postgres \
  NODE_ENV=production SMARTX_ALLOWED_ORIGINS=https://... npm --prefix server start
```

## Schema 与迁移

Schema 定义在 `server/src/storage/migrations/`，形如 `NNNN_name.up.sql` / `NNNN_name.down.sql`。当前 schema：

- `schema_meta`：版本表，记录已应用迁移 id 与 `version` 行。
- `users`：用户凭据（PR #1 使用）。
- `sessions`：服务端会话（PR #1 使用）。
- `tasks` + `task_timeline`：迁移任务快照（PR #2 起持久化）。
- `checkpoints`：断点续传快照。
- `audit_log`：管理员审计（PR #6 使用）。

SQLite 用 `TEXT` 存 JSON，Postgres 用 `JSONB`；由迁移 runner 按方言替换 `${JSON}` 占位符。

### 并发锁

- **SQLite**：迁移 runner 在 `BEGIN EXCLUSIVE` 事务内串行化；多进程指向同一文件亦安全。
- **Postgres**：迁移 runner 先取 `pg_advisory_lock(913782401)`；多实例同时启动只有一个跑。

## CLI

所有子命令会读取 `.env` / 环境变量决定后端。只对 `sqlite` / `postgres` 生效，`json` 直接 no-op。

| 命令                   | 作用                                     |
|------------------------|------------------------------------------|
| `npm run db:migrate`   | 幂等应用所有未执行的 up 迁移             |
| `npm run db:migrate:down` | 回滚全部 down 迁移（慎用，会清空数据）   |
| `npm run db:status`    | 打印 `kind`、`schemaVersion`、已应用迁移 |
| `npm run db:seed`      | 插入 smoke-test 数据（demo 用户 + 审计）  |
| `npm run import:json`  | 从 `SMARTX_DATA_PATH` 的 JSON 快照导入   |

### 示例：从 JSON 迁移到 Postgres

```bash
# 1) 停服；备份现有 JSON
cp /data/state.json /data/state.json.bak

# 2) 连上 Postgres，建库建角色
psql -c 'CREATE DATABASE smartx; CREATE ROLE smartx LOGIN PASSWORD ...;'

# 3) 跑迁移
DATABASE_URL=postgres://smartx:...@pg/smartx \
SMARTX_STORE=postgres \
npm --prefix server run db:migrate

# 4) 导入历史任务 + 断点
DATABASE_URL=... SMARTX_STORE=postgres SMARTX_DATA_PATH=/data/state.json.bak \
npm --prefix server run import:json

# 5) 以 postgres 启动
DATABASE_URL=... SMARTX_STORE=postgres npm --prefix server start
```

## `/health`

升级后 `/health` 返回：

```json
{
  "ok": true,
  "tasks": 0,
  "sessions": 0,
  "wsClients": 0,
  "schemaVersion": 1,
  "storageError": null,
  "store": {
    "kind": "postgres",
    "latencyMs": 3,
    "migrationsApplied": ["0001_init"]
  }
}
```

监控接入建议：
- `schemaVersion < 预期` → 告警，提示漏跑迁移；
- `store.latencyMs > 阈值` → 告警，可能表明 DB 负载异常；
- `store.kind = json` 出现在生产日志 → 告警，违反部署约束。

## docker-compose

```yaml
# 默认（JSON）
docker compose up

# Postgres profile：会额外启动 `db` 容器
docker compose --profile postgres up
# 需同时设置
#   SMARTX_STORE=postgres
#   DATABASE_URL=postgres://smartx:smartx@db:5432/smartx
```

## 已知限制 / 后续工作

- `tasks` / `checkpoints` 在 SQL 后端目前仍按**整张表快照**刷写（`replaceAll`），原因是 FSM / CheckpointSystem 运行时仍在内存中持有任务对象；按行增删改要等 PR #1（用户模型）/PR #6（ACL）稳定再拆。
- `users` / `sessions` / `audit_log` 三张表接口就绪但**暂未被路由消费**；PR #1 会接上。
- 不提供跨后端的数据 diff / 对账工具——`import:json` 走完即认定一致，之后请以 SQL 后端为权威。
