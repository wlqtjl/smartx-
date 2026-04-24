# 贡献指南

感谢你希望为本项目做出贡献！

## 本地开发

```bash
# 前置：Node.js >= 20
cd server && npm install
cd ../client && npm install
./scripts/dev.sh
```

## 代码规范

- **TypeScript 严格模式**，禁用 `any`（使用 `unknown` + 类型守卫）。
- **文件头注释**：每个模块顶部用简短注释说明职责（参考现有代码风格）。
- **日志**：统一通过 `server/src/core/logger.ts` 的 `log.*`，避免直接 `console.*`。
- **事件名**：保持 `migration:*` / `ui:*` / `fx:*` / `audio:*` / `checkpoint:*` / `achievement:*` 前缀约定。
- **共享 DTO**：跨端类型**必须**放在 `shared/src/index.ts`。

## 提交与分支

- 分支命名：`feat/xxx`、`fix/xxx`、`chore/xxx`、`docs/xxx`。
- 提交信息推荐遵循 [Conventional Commits](https://www.conventionalcommits.org/)，例如 `feat(server): add rate limiter to auth`。
- 每个 PR 须：
  - 通过 `npm test`、`npm run typecheck`、`npm run build`（两端）。
  - 附带变更说明、相关 Issue 链接（如有）。
  - 不引入新的高/严重严重级别 `npm audit` 告警。

## 测试

- **Server**：`cd server && npm test` — `node --test` 通过 `tsx` 运行。
- **Client**：`cd client && npm test` — `vitest`（jsdom 环境）。
- 新增公共接口、状态机分支、评分规则**必须**伴随测试。

## 安全

- 请勿提交密钥、真实凭据、生产数据。
- 发现安全问题请按 [`SECURITY.md`](SECURITY.md) 私下报告。

## 发布

版本通过 git tag 触发（`.github/workflows/release.yml`）。只有维护者可打 tag。
