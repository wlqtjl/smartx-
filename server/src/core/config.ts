/**
 * 服务端配置层：统一 env 变量解析 + 启动期校验。
 * 失败直接抛错，由 index.ts 捕获并退出。
 */
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SMARTX_HOST: z.string().default('0.0.0.0'),
  SMARTX_PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  SMARTX_DATA_PATH: z.string().optional(),
  SMARTX_ALLOWED_ORIGINS: z.string().default(''),
  SMARTX_WS_ALLOWED_ORIGINS: z.string().default(''),
  SMARTX_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(100_000).default(60),
  SMARTX_WS_MAX_SUBSCRIPTIONS: z.coerce.number().int().min(1).max(1024).default(16),
  SMARTX_WS_IDLE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  SMARTX_STATIC_ROOT: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // ── PR #2: persistence adapter ─────────────────────────────────────────
  SMARTX_STORE: z.enum(['json', 'sqlite', 'postgres']).optional(),
  DATABASE_URL: z.string().optional(),
  SMARTX_SQLITE_PATH: z.string().optional(),
  SMARTX_DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  SMARTX_ALLOW_JSON_IN_PROD: z
    .union([z.literal('0'), z.literal('1'), z.literal('true'), z.literal('false')])
    .optional(),
  // ── PR #1: identity ────────────────────────────────────────────────────
  SMARTX_JWT_SECRET: z.string().min(32).optional(),
  SMARTX_JWT_ISSUER: z.string().default('smartx'),
  SMARTX_JWT_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(86_400).default(900),
  SMARTX_JWT_REFRESH_TTL_SEC: z.coerce.number().int().min(3600).max(90 * 86_400).default(30 * 86_400),
  SMARTX_ALLOW_GUEST_LOGIN: z
    .union([z.literal('0'), z.literal('1'), z.literal('true'), z.literal('false')])
    .optional(),
  SMARTX_ALLOW_SELF_REGISTER: z
    .union([z.literal('0'), z.literal('1'), z.literal('true'), z.literal('false')])
    .optional(),
  SMARTX_OIDC_ISSUER_URL: z.string().optional(),
  SMARTX_OIDC_CLIENT_ID: z.string().optional(),
  SMARTX_OIDC_CLIENT_SECRET: z.string().optional(),
  SMARTX_OIDC_REDIRECT_URL: z.string().optional(),
  SMARTX_OIDC_SCOPES: z.string().default('openid profile email'),
  SMARTX_OIDC_ROLE_CLAIM: z.string().optional(),
});

export type StoreKind = 'json' | 'sqlite' | 'postgres';

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  dataPath?: string;
  allowedOrigins: string[];
  wsAllowedOrigins: string[];
  rateLimitPerMin: number;
  wsMaxSubscriptions: number;
  wsIdleTimeoutMs: number;
  staticRoot?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  store: {
    kind: StoreKind;
    databaseUrl?: string;
    sqlitePath?: string;
    poolMax: number;
  };
  auth: {
    jwtSecret?: string;
    jwtIssuer: string;
    accessTtlSec: number;
    refreshTtlSec: number;
    allowGuestLogin: boolean;
    allowSelfRegister: boolean;
    oidc:
      | {
          issuerUrl: string;
          clientId: string;
          clientSecret: string;
          redirectUrl: string;
          scopes: string[];
          roleClaim?: string;
        }
      | null;
  };
};

const splitCsv = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * 解析环境变量。传入 overrides 主要用于测试。
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid environment configuration: ${msg}`);
  }
  const e = parsed.data;
  const allowedOrigins = splitCsv(e.SMARTX_ALLOWED_ORIGINS);
  const wsAllowedOrigins = splitCsv(e.SMARTX_WS_ALLOWED_ORIGINS);

  // 生产强制 CORS 白名单
  if (e.NODE_ENV === 'production' && allowedOrigins.length === 0) {
    throw new Error(
      'SMARTX_ALLOWED_ORIGINS must be set (comma-separated) when NODE_ENV=production',
    );
  }

  // ── 持久化适配器选择 ───────────────────────────────────────────────
  const allowJsonInProd = e.SMARTX_ALLOW_JSON_IN_PROD === '1' || e.SMARTX_ALLOW_JSON_IN_PROD === 'true';
  let storeKind: StoreKind;
  if (e.SMARTX_STORE) {
    storeKind = e.SMARTX_STORE;
  } else if (e.DATABASE_URL) {
    storeKind = 'postgres';
  } else {
    storeKind = 'json';
  }
  if (e.NODE_ENV === 'production' && storeKind === 'json' && !allowJsonInProd) {
    throw new Error(
      'SMARTX_STORE=json is not allowed in production. Set SMARTX_STORE=sqlite|postgres or SMARTX_ALLOW_JSON_IN_PROD=1.',
    );
  }
  if (storeKind === 'postgres' && !e.DATABASE_URL) {
    throw new Error('SMARTX_STORE=postgres requires DATABASE_URL');
  }

  // ── 身份配置（PR #1） ──────────────────────────────────────────────
  const boolEnv = (v: string | undefined, defaultValue: boolean): boolean => {
    if (v === undefined) return defaultValue;
    return v === '1' || v === 'true';
  };
  // 生产默认拒绝 guest 登录；dev / test 默认允许（保持既有行为）。
  const allowGuestLogin = boolEnv(
    e.SMARTX_ALLOW_GUEST_LOGIN,
    e.NODE_ENV !== 'production',
  );
  // 自注册默认仅在非生产开启。
  const allowSelfRegister = boolEnv(
    e.SMARTX_ALLOW_SELF_REGISTER,
    e.NODE_ENV !== 'production',
  );
  // 只有在任一真实身份方式被启用时，JWT secret 才是必需的；否则允许留空（演示模式）。
  const realAuthEnabled =
    Boolean(e.SMARTX_JWT_SECRET) ||
    Boolean(e.SMARTX_OIDC_ISSUER_URL);
  if (e.NODE_ENV === 'production' && !realAuthEnabled && !allowGuestLogin) {
    throw new Error(
      'production requires at least one auth method: set SMARTX_JWT_SECRET (+/- OIDC) or SMARTX_ALLOW_GUEST_LOGIN=1',
    );
  }
  if (realAuthEnabled && !e.SMARTX_JWT_SECRET) {
    throw new Error('SMARTX_JWT_SECRET is required when password login or OIDC is enabled');
  }
  let oidc: AppConfig['auth']['oidc'] = null;
  if (e.SMARTX_OIDC_ISSUER_URL) {
    if (!e.SMARTX_OIDC_CLIENT_ID || !e.SMARTX_OIDC_CLIENT_SECRET || !e.SMARTX_OIDC_REDIRECT_URL) {
      throw new Error(
        'SMARTX_OIDC_ISSUER_URL requires SMARTX_OIDC_CLIENT_ID, SMARTX_OIDC_CLIENT_SECRET, SMARTX_OIDC_REDIRECT_URL',
      );
    }
    oidc = {
      issuerUrl: e.SMARTX_OIDC_ISSUER_URL,
      clientId: e.SMARTX_OIDC_CLIENT_ID,
      clientSecret: e.SMARTX_OIDC_CLIENT_SECRET,
      redirectUrl: e.SMARTX_OIDC_REDIRECT_URL,
      scopes: e.SMARTX_OIDC_SCOPES.split(/\s+/).filter(Boolean),
      roleClaim: e.SMARTX_OIDC_ROLE_CLAIM,
    };
  }

  return {
    nodeEnv: e.NODE_ENV,
    host: e.SMARTX_HOST,
    port: e.SMARTX_PORT,
    dataPath: e.SMARTX_DATA_PATH,
    allowedOrigins,
    wsAllowedOrigins: wsAllowedOrigins.length > 0 ? wsAllowedOrigins : allowedOrigins,
    rateLimitPerMin: e.SMARTX_RATE_LIMIT_PER_MIN,
    wsMaxSubscriptions: e.SMARTX_WS_MAX_SUBSCRIPTIONS,
    wsIdleTimeoutMs: e.SMARTX_WS_IDLE_TIMEOUT_MS,
    staticRoot: e.SMARTX_STATIC_ROOT,
    logLevel: e.LOG_LEVEL,
    store: {
      kind: storeKind,
      databaseUrl: e.DATABASE_URL,
      sqlitePath: e.SMARTX_SQLITE_PATH,
      poolMax: e.SMARTX_DB_POOL_MAX,
    },
    auth: {
      jwtSecret: e.SMARTX_JWT_SECRET,
      jwtIssuer: e.SMARTX_JWT_ISSUER,
      accessTtlSec: e.SMARTX_JWT_ACCESS_TTL_SEC,
      refreshTtlSec: e.SMARTX_JWT_REFRESH_TTL_SEC,
      allowGuestLogin,
      allowSelfRegister,
      oidc,
    },
  };
};
