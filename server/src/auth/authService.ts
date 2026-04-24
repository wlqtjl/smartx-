/**
 * PR #1：身份服务。
 *
 * 职责：
 *   - 注册 / 密码登录 / 刷新 / 登出
 *   - access 与 refresh JWT 的签发与校验
 *   - refresh JWT 对应一条 StoredSession（sid）；revoke 时改写 revokedAt
 *   - 审计日志（成功 / 失败）写入 AuditRepo
 *
 * 令牌模型：
 *   - access：短期（默认 15min）JWT，无状态，携带 `sid`
 *   - refresh：长期（默认 30d）JWT，亦携带同一 `sid`；后端持久化 SHA-256(refresh) 的指纹
 *     以便检测令牌盗用（同一 sid 被两次换出 ⇒ 撤销会话）
 *   - logout / refresh 都会写 `sessions.revokedAt`
 *
 * 不直接操作 Express；REST 端点在 `transport/authRoutes.ts` 适配。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Store, StoredUser } from '../storage/Store.js';
import { hashPassword, verifyPassword } from './passwordHasher.js';
import { JwtExpiredError, JwtInvalidError, JwtService } from './jwtService.js';
import { log } from '../core/logger.js';

export interface AuthenticatedUser {
  id: string;
  login: string;
  roles: string[];
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  user: AuthenticatedUser;
}

export class AuthError extends Error {
  constructor(
    public readonly code: 'invalid_credentials' | 'user_disabled' | 'session_revoked' | 'token_expired' | 'token_invalid' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface RegisterInput {
  login: string;
  password: string;
  roles?: string[];
}

const fingerprint = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export class AuthService {
  constructor(
    private readonly store: Store,
    private readonly jwt: JwtService,
    private readonly clock: () => number = Date.now,
  ) {}

  /** 创建用户；重复登录名返回 conflict。 */
  async registerPassword(input: RegisterInput): Promise<AuthenticatedUser> {
    const login = input.login.trim();
    if (login.length < 1 || login.length > 128) throw new AuthError('conflict', 'invalid login');
    const existing = await this.store.users.findByLogin(login);
    if (existing) throw new AuthError('conflict', 'login already exists');
    const pwHash = await hashPassword(input.password);
    const user: StoredUser = {
      id: randomUUID(),
      login,
      passwordHash: pwHash,
      oidcSubject: null,
      roles: input.roles && input.roles.length > 0 ? input.roles : ['operator'],
      createdAt: this.clock(),
      disabledAt: null,
    };
    await this.store.users.upsert(user);
    await this.store.audit.append({
      userId: user.id,
      action: 'password.register',
      target: null,
      at: this.clock(),
      details: { login },
    });
    return { id: user.id, login: user.login, roles: user.roles };
  }

  /** 密码登录。返回访问令牌对；任何失败统一抛 `AuthError('invalid_credentials')`。 */
  async loginPassword(input: { login: string; password: string }): Promise<TokenPair> {
    const login = input.login.trim();
    const user = await this.store.users.findByLogin(login);
    // 即使用户不存在也执行 verify，避免通过响应时长暴露"用户存在与否"
    const ok = await verifyPassword(input.password, user?.passwordHash ?? 'scrypt$N=16384,r=8,p=1$AAAA$AAAA');
    if (!user || !ok) {
      await this.store.audit.append({
        userId: user?.id ?? null,
        action: 'password.login.fail',
        target: null,
        at: this.clock(),
        details: { login },
      });
      throw new AuthError('invalid_credentials', 'invalid login or password');
    }
    if (user.disabledAt) {
      await this.store.audit.append({
        userId: user.id,
        action: 'password.login.fail',
        target: null,
        at: this.clock(),
        details: { login, reason: 'disabled' },
      });
      throw new AuthError('user_disabled', 'user is disabled');
    }
    const pair = await this.issueTokenPair(user);
    await this.store.audit.append({
      userId: user.id,
      action: 'password.login.ok',
      target: null,
      at: this.clock(),
      details: { login, sid: pair.user.id /* placeholder; sid is private */ },
    });
    return pair;
  }

  /** 刷新：验证 refresh JWT + sid 未吊销 + 指纹匹配，然后旋转。 */
  async refresh(refreshToken: string): Promise<TokenPair> {
    let claims;
    try {
      claims = await this.jwt.verify(refreshToken, 'refresh');
    } catch (err) {
      if (err instanceof JwtExpiredError) throw new AuthError('token_expired', 'refresh token expired');
      if (err instanceof JwtInvalidError) throw new AuthError('token_invalid', err.message);
      throw err;
    }
    const sess = await this.store.sessions.get(claims.sid);
    if (!sess || sess.revokedAt) throw new AuthError('session_revoked', 'session revoked');
    const expectedFp = fingerprint(refreshToken);
    if (sess.refreshHash && sess.refreshHash !== expectedFp) {
      // 不匹配 ⇒ 疑似重放：吊销会话并告警
      await this.store.sessions.revoke(sess.sid, this.clock());
      await this.store.audit.append({
        userId: sess.userId,
        action: 'refresh.replay-detected',
        target: sess.sid,
        at: this.clock(),
        details: null,
      });
      log.warn('auth.refresh.replay', { sid: sess.sid, userId: sess.userId });
      throw new AuthError('session_revoked', 'session revoked');
    }
    const user = await this.store.users.get(sess.userId);
    if (!user || user.disabledAt) throw new AuthError('user_disabled', 'user no longer valid');

    // 旋转：吊销旧 sid，开新 sid
    await this.store.sessions.revoke(sess.sid, this.clock());
    const pair = await this.issueTokenPair(user);
    await this.store.audit.append({
      userId: user.id,
      action: 'refresh.ok',
      target: null,
      at: this.clock(),
      details: null,
    });
    return pair;
  }

  /** 登出：根据 sid 吊销会话；幂等。 */
  async logout(sid: string, userId?: string): Promise<void> {
    await this.store.sessions.revoke(sid, this.clock());
    await this.store.audit.append({
      userId: userId ?? null,
      action: 'logout',
      target: sid,
      at: this.clock(),
      details: null,
    });
  }

  /** 校验 access JWT，返回用户。调用侧通常是 requireAuth 中间件。 */
  async verifyAccessToken(accessToken: string): Promise<AuthenticatedUser & { sid: string }> {
    let claims;
    try {
      claims = await this.jwt.verify(accessToken, 'access');
    } catch (err) {
      if (err instanceof JwtExpiredError) throw new AuthError('token_expired', 'access token expired');
      if (err instanceof JwtInvalidError) throw new AuthError('token_invalid', err.message);
      throw err;
    }
    const sess = await this.store.sessions.get(claims.sid);
    if (!sess || sess.revokedAt) throw new AuthError('session_revoked', 'session revoked');
    return { id: claims.sub, login: claims.login, roles: claims.roles, sid: claims.sid };
  }

  /** OIDC 回调的"find-or-create"入口。PR #1 只用于本服务内部的 OIDC 路由。 */
  async upsertOidcUser(input: {
    subject: string;
    login: string;
    roles?: string[];
  }): Promise<TokenPair> {
    const existing = await this.store.users.findByOidcSubject(input.subject);
    const now = this.clock();
    const user: StoredUser =
      existing ?? {
        id: randomUUID(),
        login: input.login,
        passwordHash: null,
        oidcSubject: input.subject,
        roles: input.roles && input.roles.length > 0 ? input.roles : ['operator'],
        createdAt: now,
        disabledAt: null,
      };
    if (!existing) await this.store.users.upsert(user);
    else if (input.roles && input.roles.length > 0) {
      user.roles = input.roles; // refresh roles on each login
      await this.store.users.upsert(user);
    }
    const pair = await this.issueTokenPair(user);
    await this.store.audit.append({
      userId: user.id,
      action: 'oidc.login.ok',
      target: null,
      at: now,
      details: { subject: input.subject, login: input.login },
    });
    return pair;
  }

  // ── internals ─────────────────────────────────────────────────────────
  private async issueTokenPair(user: StoredUser): Promise<TokenPair> {
    const sid = randomUUID();
    const now = this.clock();
    const accessToken = await this.jwt.sign('access', {
      sub: user.id,
      login: user.login,
      roles: user.roles,
      sid,
    });
    const refreshToken = await this.jwt.sign('refresh', {
      sub: user.id,
      login: user.login,
      roles: user.roles,
      sid,
    });
    await this.store.sessions.upsert({
      sid,
      userId: user.id,
      createdAt: now,
      expiresAt: now + this.jwt.refreshTtlSec * 1000,
      refreshHash: fingerprint(refreshToken),
      revokedAt: null,
    });
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: now + this.jwt.accessTtlSec * 1000,
      refreshExpiresAt: now + this.jwt.refreshTtlSec * 1000,
      user: { id: user.id, login: user.login, roles: user.roles },
    };
  }
}
