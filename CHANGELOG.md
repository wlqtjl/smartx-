# Changelog

本文件记录项目的显著变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- **PR #1 — 真实身份（OIDC / JWT / 密码）**：新增 `AuthService` + `JwtService` + `PasswordHasher`（基于 Node 内置 `crypto.scrypt`，无原生依赖）。
  - 新增 REST 端点：`POST /api/auth/password/register` / `/password/login` / `/refresh` / `/logout`、`GET /api/auth/me`、`GET /api/auth/oidc/start` + `/callback`。
  - 请求鉴权层同时接受 `Authorization: Bearer <JWT>` 与 legacy `X-Session-Token`，现有客户端无需改动。
  - refresh token 带旋转；`sid` 被吊销或同一 refresh 被复用时立即作废会话并审计 `refresh.replay-detected`。
  - OIDC 走授权码 + PKCE（`openid-client@5`），未配置 `SMARTX_OIDC_ISSUER_URL` 时相关路由返回 501。
  - 环境变量：`SMARTX_JWT_SECRET`、`SMARTX_JWT_ISSUER`、`SMARTX_JWT_ACCESS_TTL_SEC`、`SMARTX_JWT_REFRESH_TTL_SEC`、`SMARTX_ALLOW_GUEST_LOGIN`、`SMARTX_ALLOW_SELF_REGISTER`、`SMARTX_OIDC_*`。
  - 生产默认**关闭** guest 登录和自注册；`/api/auth/session` 在生产返回 403。
  - 审计日志：`password.login.ok/fail`、`refresh.ok/replay-detected`、`logout`、`oidc.login.ok` 等写入 PR #2 的 `audit` 表。
  - 文档：`docs/auth.md`。
- **PR #2 — 持久化适配层**：新增 `Store` 接口 + SQLite（`better-sqlite3`，WAL）+ Postgres（`pg`，连接池 + `pg_advisory_lock`）两套后端；默认仍为 JSON 以保证开发体验。
  - 环境变量：`SMARTX_STORE=json|sqlite|postgres`、`DATABASE_URL`、`SMARTX_SQLITE_PATH`、`SMARTX_DB_POOL_MAX`、`SMARTX_ALLOW_JSON_IN_PROD`。
  - SQL 迁移：`server/src/storage/migrations/0001_init.{up,down}.sql`，版本化记录在 `schema_meta` 表。
  - npm 脚本：`db:migrate` / `db:migrate:down` / `db:status` / `db:seed` / `import:json`。
  - `docker-compose.yml` 新增 `postgres` profile（启用：`docker compose --profile postgres up`）。
  - `/health` 扩展 `store.{kind,latencyMs,migrationsApplied}`；`schemaVersion` 现从 DB 读取。
  - 文档：`docs/persistence.md`。
  - 生产环境默认**拒绝** `SMARTX_STORE=json`，需显式 `SMARTX_ALLOW_JSON_IN_PROD=1` 才能降级（`docker-compose.yml` 为默认兼容保留此开关）。
- 生产化基线：Docker 镜像、`docker-compose.yml`、`.env.example`。
- 服务端速率限制（`express-rate-limit`）覆盖登录与昂贵写入端点。
- 服务端请求级结构化日志（request-id）+ HTTP 访问日志。
- `/metrics` 端点（文本格式）暴露任务 / 会话 / WS 连接等指标。
- `/health` 扩展：持久化可写性检查 + `schemaVersion`。
- WebSocket：Origin 白名单校验、心跳超时踢人、每连接订阅数上限。
- 会话定期清理任务（`SessionStore.purgeExpired()` 定时执行）。
- `zod` 驱动的 REST 入参与 WS 消息校验框架（增量接入）。
- 持久化快照引入 `schemaVersion` 字段与向下兼容回退。
- 文档：`SECURITY.md`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`docs/deployment.md`、`NOTICE.md`。
- GitHub：PR / Issue 模板、Dependabot、CodeQL、发布工作流（tag → GHCR）。
- 客户端：`public/` 下 favicon / robots.txt / 可安装 manifest，`index.html` 加 meta / OG / WebGL 不支持降级提示。
- `engines.node >=20` 在 root / client / server。

### Changed
- CORS：生产模式（`NODE_ENV=production`）下未配置 `SMARTX_ALLOWED_ORIGINS` 将拒绝启动，避免误放行。
- 根 `README.md` 重写为面向使用者/运维者的精简指南；原设计稿移至 `docs/design.md`。
- `server` 的 `npm start` 使用 `tsc` 构建产物（`node dist/index.js`），不再直接跑 `tsx`。

### Deferred（列入下一个 milestone）
- Sentry 前端错误上报。
- Playwright E2E。
- 前端 i18n 框架、a11y 完整化。
- WS 订阅 ACL（与任务 owner 绑定）。

## [0.1.0] - 2025-11-xx

### Added
- 初始教程关：8 阶段迁移状态机、FPS 控制器、React UI、断点续传、评分。
- REST + WebSocket 协议 + 客户端降级模式。
- CI：前后端 typecheck / test / build。
