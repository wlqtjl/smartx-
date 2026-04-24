# 部署指南

本文档描述生产部署的推荐方式与可选托管策略。

## 1. Docker Compose（推荐）

最小生产部署：

```bash
cp .env.example .env
# 必填：至少把 SMARTX_ALLOWED_ORIGINS 设置为你的前端实际来源
# 例如：SMARTX_ALLOWED_ORIGINS=https://smartx.example.com
docker compose up -d --build
```

端口：

- `server` 监听 `:8787`（REST + WebSocket）。
- `client` 监听 `:8080`（Nginx 伺服 Vite 构建产物）。

持久化：

- `server` 将 JSON 快照写入容器内 `/data/state.json`，映射到命名卷 `smartx-data`。
- 备份：`docker run --rm -v smartx-data:/data -v $PWD:/backup alpine tar czf /backup/smartx-data.tgz -C /data .`。

## 2. 同源部署（单一 Nginx 反代）

更安全的做法：把 `/api/`、`/ws` 反代到 server，前端与 API 同源，可以关闭 CORS 与 WS Origin 白名单的公网放行。

1. 在 `deploy/nginx.conf` 中解开 `/api/` 与 `/ws` 的 `proxy_pass` 段。
2. `docker-compose.yml` 里把 `VITE_SMARTX_API` 设为空字符串：

```bash
VITE_SMARTX_API= docker compose up -d --build
```

3. 把 `SMARTX_ALLOWED_ORIGINS` 设为同一个源（如 `https://smartx.example.com`）。

## 3. 分离托管（CDN + 独立后端）

- 前端：`cd client && npm ci && VITE_SMARTX_API=https://api.example.com npm run build`，将 `client/dist/` 上传到 CDN（CloudFront / OSS 等）。
- 后端：使用 `Dockerfile.server` 构建并推送到 GHCR / ECR，部署到任意容器平台（k8s / ECS / Nomad）。
- CORS：`SMARTX_ALLOWED_ORIGINS` 必须显式列出前端域名。

## 4. 环境变量

完整清单见 [`.env.example`](../.env.example)。生产环境**必填**：

| 变量 | 说明 |
|---|---|
| `SMARTX_ALLOWED_ORIGINS` | REST CORS 白名单；`NODE_ENV=production` 下为空会拒绝启动 |
| `SMARTX_WS_ALLOWED_ORIGINS` | WebSocket Origin 白名单（留空则复用上面的值） |
| `SMARTX_DATA_PATH` | 持久化文件绝对路径；多实例部署请分别映射独立路径 |
| `NODE_ENV` | 设为 `production` 启用严格 CORS / WS 校验 |

## 5. 可观测性

- **健康检查**：`GET /health` → `{ ok, storageOk, tasks, schemaVersion, uptime }`。容器编排器可直接消费。
- **指标**：`GET /metrics` → 文本格式（Prometheus 兼容），暴露 `smartx_tasks_total`、`smartx_ws_clients`、`smartx_sessions`、`smartx_uptime_seconds` 等。
- **日志**：stdout 输出 JSON 结构化日志（含 `requestId`），可直接送 Loki / Elasticsearch / Cloud Logging。

## 6. 升级策略

- 使用语义化版本的镜像 tag（`ghcr.io/<owner>/smartx-/server:0.2.0`）。
- 滚动升级前确认 `CHANGELOG.md` 中的 Breaking Changes。
- JSON 持久化快照包含 `schemaVersion` 字段；若服务端检测到更新的 schema，将尝试兼容读取；向前不兼容时会在启动日志中警告并跳过对应字段。

## 7. 已知限制（生产前需评估）

- **身份认证**为 demo 级（`playerName` 即凭证）。生产场景请在反代层叠加 OAuth2 / OIDC / 内网鉴权。
- **持久化**为单实例 JSON；多副本部署会互相覆盖。高可用场景需等待 SQLite/Postgres 适配器（见 `CHANGELOG.md` Deferred 列表）。
- **前端错误上报**尚未接入（Sentry 等）。建议通过 CDN 注入 `window.onerror` 汇报。
