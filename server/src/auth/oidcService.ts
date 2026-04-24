/**
 * PR #1：OIDC 授权码流程的最薄封装。
 *
 * 基于 `openid-client@5`。只要 `SMARTX_OIDC_ISSUER_URL` 配了，就会在启动时
 * `Issuer.discover(...)` 一次，缓存 Client；否则 service 自身为 `null`，相关路由返回 501。
 *
 * 流程：
 *  1. `GET /api/auth/oidc/start`：生成 state + nonce + PKCE verifier，存入短期 Map，
 *     返回 302 到 provider 的 `authorization_endpoint`。
 *  2. `GET /api/auth/oidc/callback?code=...&state=...`：校验 state，取出 verifier，
 *     调用 `client.callback(...)` 换 id_token + access_token；提取 `sub` + `preferred_username`
 *     + roles claim，交给 `AuthService.upsertOidcUser(...)` 拿本站 JWT 对。
 *
 * 为避免 session 黏性问题，state→verifier 映射存在进程内 LRU；多实例下同一浏览器
 * 刷新可能回到另一个节点，此时会触发 "unknown state"。完整跨节点支持可以在后续
 * 用 `sessions.audit.append` 或独立表记录——暂列为 known limitation。
 */
import { Issuer, generators, type Client } from 'openid-client';
import { log } from '../core/logger.js';
import type { AuthService, TokenPair } from './authService.js';

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  scopes: string[];
  /** id_token / userinfo 里解析角色的 claim 名；留空则不读取。 */
  roleClaim?: string;
}

interface PendingFlow {
  nonce: string;
  codeVerifier: string;
  createdAt: number;
}

const FLOW_TTL_MS = 10 * 60_000;
const FLOW_MAX = 2048;

export class OidcService {
  private readonly client: Client;
  private readonly config: OidcConfig;
  private readonly pending = new Map<string, PendingFlow>();

  private constructor(client: Client, config: OidcConfig) {
    this.client = client;
    this.config = config;
  }

  static async create(config: OidcConfig): Promise<OidcService> {
    const issuer = await Issuer.discover(config.issuerUrl);
    const client = new issuer.Client({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uris: [config.redirectUrl],
      response_types: ['code'],
    });
    log.info('auth.oidc.ready', { issuer: issuer.metadata.issuer });
    return new OidcService(client, config);
  }

  /** 返回授权端点 URL（302 location）。 */
  startAuthorizationUrl(): string {
    this.gc();
    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    this.pending.set(state, { nonce, codeVerifier, createdAt: Date.now() });
    return this.client.authorizationUrl({
      scope: this.config.scopes.join(' '),
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  /** 用授权码换 token，解析 claim，调用 AuthService 发本站 JWT。 */
  async handleCallback(
    auth: AuthService,
    params: Record<string, string | string[] | undefined>,
    state: string,
  ): Promise<TokenPair> {
    const flow = this.pending.get(state);
    if (!flow) throw new OidcError('unknown_state', 'unknown or expired state');
    this.pending.delete(state);
    const tokenSet = await this.client.callback(
      this.config.redirectUrl,
      params,
      { state, nonce: flow.nonce, code_verifier: flow.codeVerifier },
    );
    const claims = tokenSet.claims();
    const subject = typeof claims.sub === 'string' ? claims.sub : '';
    if (!subject) throw new OidcError('invalid_claims', 'id_token missing sub');
    const login =
      (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
      (typeof claims.email === 'string' && claims.email) ||
      subject;
    const roles = this.extractRoles(claims);
    return auth.upsertOidcUser({ subject, login, roles });
  }

  private extractRoles(claims: Record<string, unknown>): string[] {
    if (!this.config.roleClaim) return [];
    const raw = claims[this.config.roleClaim];
    if (Array.isArray(raw)) return raw.filter((r): r is string => typeof r === 'string');
    if (typeof raw === 'string') return raw.split(/[\s,]+/).filter(Boolean);
    return [];
  }

  /** 清理超时的 state → 防内存泄漏。 */
  private gc(): void {
    const now = Date.now();
    if (this.pending.size > FLOW_MAX) {
      // 先按 size 截断，再按 TTL 清
      const entries = [...this.pending.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt,
      );
      for (const [k] of entries.slice(0, this.pending.size - FLOW_MAX)) {
        this.pending.delete(k);
      }
    }
    for (const [k, v] of this.pending) {
      if (now - v.createdAt > FLOW_TTL_MS) this.pending.delete(k);
    }
  }
}

export class OidcError extends Error {
  constructor(
    public readonly code: 'unknown_state' | 'invalid_claims' | 'provider_error',
    message: string,
  ) {
    super(message);
    this.name = 'OidcError';
  }
}
