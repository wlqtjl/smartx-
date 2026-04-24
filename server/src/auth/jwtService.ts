/**
 * PR #1：JWT 签发与校验服务。
 *
 * 用 `jose` 实现 HS256；与 OIDC id_token 的 RS256 解耦——本地签发的是本站的
 * access / refresh 令牌，OIDC 提供方签发的 id_token 仅在 `/oidc/callback` 做一次
 * 校验，随后由我们换成本站 JWT。
 *
 * Claims 契约（短小稳定）：
 *   sub    用户 id
 *   login  登录名
 *   roles  string[]
 *   sid    关联的持久化 session id（用于 refresh 时查吊销状态）
 *   typ    'access' | 'refresh'
 *   iss    `SMARTX_JWT_ISSUER`
 */
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

export type JwtTokenType = 'access' | 'refresh';

export interface JwtClaims {
  sub: string;
  login: string;
  roles: string[];
  sid: string;
  typ: JwtTokenType;
  iat: number;
  exp: number;
  iss?: string;
}

export interface JwtServiceOptions {
  secret: string;
  issuer: string;
  accessTtlSec: number;
  refreshTtlSec: number;
}

export class JwtService {
  private readonly key: Uint8Array;
  private readonly issuer: string;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(opts: JwtServiceOptions) {
    if (!opts.secret || opts.secret.length < 32) {
      throw new Error('JWT secret must be at least 32 characters');
    }
    this.key = new TextEncoder().encode(opts.secret);
    this.issuer = opts.issuer;
    this.accessTtl = opts.accessTtlSec;
    this.refreshTtl = opts.refreshTtlSec;
  }

  get accessTtlSec(): number {
    return this.accessTtl;
  }

  get refreshTtlSec(): number {
    return this.refreshTtl;
  }

  async sign(
    typ: JwtTokenType,
    claims: { sub: string; login: string; roles: string[]; sid: string },
  ): Promise<string> {
    const ttl = typ === 'access' ? this.accessTtl : this.refreshTtl;
    return new SignJWT({ login: claims.login, roles: claims.roles, sid: claims.sid, typ })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.issuer)
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(this.key);
  }

  async verify(token: string, expectedType: JwtTokenType): Promise<JwtClaims> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.key, { issuer: this.issuer }));
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw new JwtExpiredError();
      throw new JwtInvalidError((err as Error).message);
    }
    const raw = payload as Partial<JwtClaims>;
    if (raw.typ !== expectedType) throw new JwtInvalidError(`expected typ=${expectedType}`);
    if (typeof raw.sub !== 'string' || typeof raw.login !== 'string' || typeof raw.sid !== 'string') {
      throw new JwtInvalidError('missing required claims');
    }
    const roles = Array.isArray(raw.roles) ? raw.roles.filter((r): r is string => typeof r === 'string') : [];
    return {
      sub: raw.sub,
      login: raw.login,
      roles,
      sid: raw.sid,
      typ: raw.typ,
      iat: typeof raw.iat === 'number' ? raw.iat : 0,
      exp: typeof raw.exp === 'number' ? raw.exp : 0,
      iss: typeof raw.iss === 'string' ? raw.iss : undefined,
    };
  }
}

export class JwtExpiredError extends Error {
  constructor() {
    super('token expired');
    this.name = 'JwtExpiredError';
  }
}

export class JwtInvalidError extends Error {
  constructor(msg: string) {
    super(`invalid token: ${msg}`);
    this.name = 'JwtInvalidError';
  }
}
