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
  };
};
