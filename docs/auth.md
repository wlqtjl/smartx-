# Identity & Auth (PR #1)

SmartX 服务端支持三种身份方式，三者可以共存：

| 方式 | 端点 | 启用条件 | 用途 |
|---|---|---|---|
| **Password** | `POST /api/auth/password/login` | `SMARTX_JWT_SECRET` 已配置 | 内部账号、CI/CD、脚本 |
| **OIDC**     | `GET /api/auth/oidc/start` → `callback` | 上述 + `SMARTX_OIDC_*` | SSO（企业 IdP / Keycloak / Azure AD 等） |
| **Guest**    | `POST /api/auth/session` + `X-Session-Token` | `SMARTX_ALLOW_GUEST_LOGIN=1`（dev 默认开启） | 演示 / 教学 / 本地调试 |

鉴权层自动识别请求头：

- `Authorization: Bearer <JWT>` → 走密码 / OIDC 颁发的 JWT 路径
- `X-Session-Token: <t>`         → 走 guest 会话路径

两条路径的受保护 REST 端点（任务、映射、转换等）语义完全相同。

---

## 1. 最小启用（生产）

```bash
# 32 字节随机 HMAC key
export SMARTX_JWT_SECRET=$(openssl rand -hex 32)

# 关闭 guest / 自注册（生产默认如此）
export SMARTX_ALLOW_GUEST_LOGIN=0
export SMARTX_ALLOW_SELF_REGISTER=0
```

创建第一个管理员：

```bash
# 自注册临时打开 → 注册 → 再关掉
SMARTX_ALLOW_SELF_REGISTER=1 npm start &
curl -X POST http://127.0.0.1:8787/api/auth/password/register \
  -H 'content-type: application/json' \
  -d '{"login":"admin","password":"please-change-me","roles":["admin"]}'
```

（后续 CLI 会提供 `npm run user:create` 命令，当前请临时翻开开关。）

## 2. 密码登录流程

```bash
# 登录
curl -X POST https://api.example.com/api/auth/password/login \
  -H 'content-type: application/json' \
  -d '{"login":"alice","password":"..."}'

# → { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, user }
```

- `accessToken`：短 TTL（默认 15 min），无状态，放 `Authorization: Bearer`。
- `refreshToken`：长 TTL（默认 30 d），携带相同 `sid`；后端按 `sha256(refresh)` 持久化指纹。
- 调用 `POST /api/auth/refresh { refreshToken }` 拿**新的**一对；旧 refresh 立即失效（rotation on refresh）。
- `POST /api/auth/logout` 带 `Authorization: Bearer <access>` 撤销整个 sid。

检测到同一 sid 的两把 refresh token 都被用过时（典型的重放 / token 泄露），会**吊销整个会话**并写入
`audit.append { action: 'refresh.replay-detected' }`。

## 3. OIDC 授权码流程（带 PKCE）

```
# .env
SMARTX_OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant>/v2.0
SMARTX_OIDC_CLIENT_ID=...
SMARTX_OIDC_CLIENT_SECRET=...
SMARTX_OIDC_REDIRECT_URL=https://smartx.example.com/api/auth/oidc/callback
SMARTX_OIDC_SCOPES=openid profile email
SMARTX_OIDC_ROLE_CLAIM=roles
```

前端：

```
window.location = `${API_BASE}/api/auth/oidc/start`
```

IdP 将用户重定向回 `/oidc/callback`；服务器与 IdP 交换 token（PKCE S256），在 `users` 表内按
`oidc_subject` upsert，然后返回 `{ accessToken, refreshToken, user }`（本站颁发）。之后所有调用
都只用本站 JWT —— id_token 不再出现在请求里。

- **pending-flow LRU**：state→verifier 对映存在进程内 Map；多实例部署下用户在同一浏览器可能命中
  另一个节点，此时返回 400 `unknown_state`，刷新页面即可。后续会迁移到 `sessions` 表。
- 通过 `SMARTX_OIDC_ROLE_CLAIM` 指定角色 claim；读取到的数组会**每次登录时覆盖**本地 `users.roles`
  —— 便于 IdP 做统一的角色管理。

## 4. 配置项速查

| 变量 | 默认 | 说明 |
|---|---|---|
| `SMARTX_JWT_SECRET` | *(unset)* | HMAC 密钥；>= 32 字符。未设置则密码/OIDC 路由全部不挂载。 |
| `SMARTX_JWT_ISSUER` | `smartx` | JWT `iss` claim。 |
| `SMARTX_JWT_ACCESS_TTL_SEC` | `900` (15 min) | access token TTL。 |
| `SMARTX_JWT_REFRESH_TTL_SEC` | `2592000` (30 d) | refresh token + sessions 行的 TTL。 |
| `SMARTX_ALLOW_GUEST_LOGIN` | dev `1` / prod `0` | guest `/api/auth/session` 开关。 |
| `SMARTX_ALLOW_SELF_REGISTER` | dev `1` / prod `0` | `/api/auth/password/register` 开关。 |
| `SMARTX_OIDC_ISSUER_URL` | *(unset)* | 启用 OIDC 的唯一必选项。 |
| `SMARTX_OIDC_CLIENT_ID` / `_CLIENT_SECRET` / `_REDIRECT_URL` | — | OIDC 其余必选项，缺一启动报错。 |
| `SMARTX_OIDC_SCOPES` | `openid profile email` | 空格分隔。 |
| `SMARTX_OIDC_ROLE_CLAIM` | *(unset)* | 从 id_token/userinfo 抽 roles 的 claim 名。 |

## 5. 审计日志

所有鉴权相关动作都会走 `store.audit.append(...)`。目前记录的 action：

- `password.register`
- `password.login.ok` / `password.login.fail`
- `refresh.ok` / `refresh.replay-detected`
- `logout`
- `oidc.login.ok`

后续 PR #6（WS ACL）会基于同一份审计流进一步记录任务订阅/拒绝事件。

## 6. 迁移注意

- 现有客户端调用 `POST /api/auth/session` + `X-Session-Token` **继续工作**；服务端保留兼容行为，
  只是在生产默认关闭 guest，需要时以 `SMARTX_ALLOW_GUEST_LOGIN=1` 显式打开。
- JWT 与 guest 会话可以**同时**存在：WebSocket 仍走 guest token（将在 PR #6 中迁移）。
