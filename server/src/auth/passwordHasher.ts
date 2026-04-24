/**
 * PR #1：密码哈希工具。
 *
 * 设计取舍：
 *  - 选择 Node 内置 `crypto.scrypt`，不引入 `argon2` / `bcrypt` 原生依赖，
 *    降低构建复杂度；scrypt 亦为 OWASP 推荐的 memory-hard KDF 之一。
 *  - 存储格式：`scrypt$N=16384,r=8,p=1$<base64Salt>$<base64Hash>`。
 *    N/r/p 写入字符串，便于未来升级参数时保持向后兼容。
 *  - 校验使用 `timingSafeEqual`，避免旁路时序攻击。
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/** OWASP 推荐基线：N=16384, r=8, p=1 —— 与 Node 默认一致。 */
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;
// 提高 maxmem，避免 N=16384 时在某些版本 Node 下触发 ERR_CRYPTO_INVALID_SCRYPT_PARAMS。
const MAXMEM = 64 * 1024 * 1024;

type ScryptParams = { N: number; r: number; p: number };

const toB64 = (buf: Buffer): string => buf.toString('base64');
const fromB64 = (s: string): Buffer => Buffer.from(s, 'base64');

const parseParams = (segment: string): ScryptParams => {
  const parts = segment.split(',');
  const out: Partial<ScryptParams> = {};
  for (const p of parts) {
    const [k, v] = p.split('=');
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid scrypt param: ${p}`);
    if (k === 'N') out.N = n;
    else if (k === 'r') out.r = n;
    else if (k === 'p') out.p = n;
  }
  if (!out.N || !out.r || !out.p) throw new Error('incomplete scrypt params');
  return out as ScryptParams;
};

/** 对明文密码进行哈希，返回可直接存数据库的字符串。 */
export const hashPassword = async (plain: string): Promise<string> => {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  const salt = randomBytes(SALT_LEN);
  const params = DEFAULT_PARAMS;
  const derived = await scrypt(plain, salt, KEY_LEN, { ...params, maxmem: MAXMEM });
  return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${toB64(salt)}$${toB64(derived)}`;
};

/**
 * 验证明文密码与存储哈希是否匹配。
 * 未匹配 / 格式非法统一返回 false（不抛异常，调用侧不需要 try/catch）。
 */
export const verifyPassword = async (plain: string, stored: string): Promise<boolean> => {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  let params: ScryptParams;
  let salt: Buffer;
  let expected: Buffer;
  try {
    params = parseParams(parts[1]!);
    salt = fromB64(parts[2]!);
    expected = fromB64(parts[3]!);
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  let derived: Buffer;
  try {
    derived = await scrypt(plain, salt, expected.length, { ...params, maxmem: MAXMEM });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
};

/** 暴露给测试；业务代码不应直接使用。 */
export const __testing = { DEFAULT_PARAMS, KEY_LEN, SALT_LEN };
