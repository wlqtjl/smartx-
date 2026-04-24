# SECURITY

## 支持的版本

| 版本 | 状态 |
|---|---|
| `0.x` | 🟡 公开预览，安全问题会在最新 minor 修复 |

## 报告漏洞

**请勿在公开 Issue 中描述可被利用的安全问题。**

请通过以下任一方式私下联系维护者：

1. GitHub 私密安全公告（推荐）：仓库 → Security → "Report a vulnerability"。
2. Email：`security@example.invalid`（请在此替换为实际联系邮箱）。

报告请尽量包含：

- 受影响版本 / commit。
- 复现步骤或最小 PoC。
- 已知的业务/数据影响。
- 建议的缓解方案（可选）。

我们将在 **3 个工作日内** 确认收到报告，并在 **14 日内** 给出初步处置计划。

## 披露策略

- 我们采用 **协同披露**：修复发布后，将在 `CHANGELOG.md` 中致谢报告者（除非报告者要求匿名）。
- 严重漏洞修复会同时发布 GitHub Security Advisory（含 CVE 若适用）。

## 当前已知局限

本项目目前为 **预览阶段**，存在以下**已声明**的演示级实现（非安全漏洞，但生产部署前须替换）：

1. `server/src/core/sessions.ts` — 基于内存的会话 Map，`playerName` 即登录凭据；**不是**安全身份验证。生产部署前须接入 SSO / OIDC / JWT 或等效方案。
2. 无持久化的多实例支持 — `JsonStore` 仅适合单实例；多副本部署会出现写覆盖。
3. WebSocket 广播目前按 `taskId` 订阅放行，未与会话身份绑定 ACL。

上述项目均在 [`docs/design.md`](docs/design.md) 与 README 的路线图中作为优先路线追踪。
