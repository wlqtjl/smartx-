/**
 * PR #1：Auth REST 端点 + middleware 集成测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { loadConfig } from '../src/core/config.js';
import { createServer, type SmartXServer } from '../src/server.js';

const startServer = async (
  env: Partial<NodeJS.ProcessEnv> = {},
): Promise<SmartXServer> => {
  const dir = mkdtempSync(join(tmpdir(), 'smartx-auth-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    SMARTX_PORT: '0',
    SMARTX_HOST: '127.0.0.1',
    SMARTX_STORE: 'sqlite',
    SMARTX_SQLITE_PATH: join(dir, 'auth.db'),
    SMARTX_DATA_PATH: join(dir, 'state.json'),
    SMARTX_ALLOWED_ORIGINS: 'http://localhost:5173',
    SMARTX_JWT_SECRET: 'a'.repeat(48),
    SMARTX_JWT_ISSUER: 'smartx-test',
    SMARTX_ALLOW_SELF_REGISTER: '1',
    SMARTX_ALLOW_GUEST_LOGIN: '1',
    ...env,
  } as NodeJS.ProcessEnv);
  return createServer({ config });
};

const json = async <T>(resp: Response): Promise<T> => (await resp.json()) as T;

test('auth: register + login + me + refresh + logout + access revocation', async () => {
  const srv = await startServer();
  try {
    // Register
    const reg = await fetch(`${srv.url}/api/auth/password/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password: 'hunter2hunter2' }),
    });
    assert.equal(reg.status, 201);

    // Login
    const login = await fetch(`${srv.url}/api/auth/password/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password: 'hunter2hunter2' }),
    });
    assert.equal(login.status, 200);
    const pair = await json<{ accessToken: string; refreshToken: string; user: { login: string; roles: string[] } }>(login);
    assert.ok(pair.accessToken && pair.refreshToken);
    assert.equal(pair.user.login, 'alice');
    assert.deepEqual(pair.user.roles, ['operator']);

    // Me with bearer
    const me = await fetch(`${srv.url}/api/auth/me`, {
      headers: { authorization: `Bearer ${pair.accessToken}` },
    });
    assert.equal(me.status, 200);
    const meBody = await json<{ user: { login: string } }>(me);
    assert.equal(meBody.user.login, 'alice');

    // Refresh
    const ref = await fetch(`${srv.url}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: pair.refreshToken }),
    });
    assert.equal(ref.status, 200);
    const pair2 = await json<{ accessToken: string; refreshToken: string }>(ref);
    assert.notEqual(pair2.accessToken, pair.accessToken);
    assert.notEqual(pair2.refreshToken, pair.refreshToken);

    // Old refresh token should be revoked (session rotated)
    const refAgain = await fetch(`${srv.url}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: pair.refreshToken }),
    });
    assert.equal(refAgain.status, 401);

    // New access token is still valid for /me
    const me2 = await fetch(`${srv.url}/api/auth/me`, {
      headers: { authorization: `Bearer ${pair2.accessToken}` },
    });
    assert.equal(me2.status, 200);

    // Logout
    const logout = await fetch(`${srv.url}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pair2.accessToken}` },
    });
    assert.equal(logout.status, 204);

    // After logout, the access token's sid is revoked → /me 401
    const meGone = await fetch(`${srv.url}/api/auth/me`, {
      headers: { authorization: `Bearer ${pair2.accessToken}` },
    });
    assert.equal(meGone.status, 401);
  } finally {
    await srv.close();
  }
});

test('auth: duplicate register returns 409', async () => {
  const srv = await startServer();
  try {
    const body = { login: 'bob', password: 'password1234' };
    const r1 = await fetch(`${srv.url}/api/auth/password/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(r1.status, 201);
    const r2 = await fetch(`${srv.url}/api/auth/password/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(r2.status, 409);
  } finally {
    await srv.close();
  }
});

test('auth: wrong password returns 401 with invalid_credentials', async () => {
  const srv = await startServer();
  try {
    await fetch(`${srv.url}/api/auth/password/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'carol', password: 'correctbattery' }),
    });
    const bad = await fetch(`${srv.url}/api/auth/password/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'carol', password: 'wrong-password' }),
    });
    assert.equal(bad.status, 401);
    const body = await json<{ error: { reason: string } }>(bad);
    assert.equal(body.error.reason, 'invalid_credentials');
  } finally {
    await srv.close();
  }
});

test('auth: self-register disabled returns 403', async () => {
  const srv = await startServer({ SMARTX_ALLOW_SELF_REGISTER: '0' });
  try {
    const r = await fetch(`${srv.url}/api/auth/password/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'dan', password: 'password1234' }),
    });
    assert.equal(r.status, 403);
  } finally {
    await srv.close();
  }
});

test('auth: guest login blocked when SMARTX_ALLOW_GUEST_LOGIN=0', async () => {
  const srv = await startServer({ SMARTX_ALLOW_GUEST_LOGIN: '0' });
  try {
    const r = await fetch(`${srv.url}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerName: 'guest' }),
    });
    assert.equal(r.status, 403);
  } finally {
    await srv.close();
  }
});

test('auth: Bearer JWT is accepted by protected routes (back-compat with x-session-token)', async () => {
  const srv = await startServer();
  try {
    // Register + login
    await fetch(`${srv.url}/api/auth/password/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'eve', password: 'password1234' }),
    });
    const login = await fetch(`${srv.url}/api/auth/password/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'eve', password: 'password1234' }),
    });
    const { accessToken } = await json<{ accessToken: string }>(login);

    // Create a task using the Bearer JWT instead of x-session-token.
    const create = await fetch(`${srv.url}/api/migration/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ vmId: 'vm-auth', vmName: 'vm-jwt', dataTotalGB: 5 }),
    });
    assert.equal(create.status, 201);

    // Legacy guest token also still works on the same server (both paths coexist).
    const sess = await fetch(`${srv.url}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerName: 'Legacy' }),
    });
    assert.equal(sess.status, 201);
    const { token } = await json<{ token: string }>(sess);
    const legacyCreate = await fetch(`${srv.url}/api/migration/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({ vmId: 'vm-legacy', vmName: 'vm-guest', dataTotalGB: 5 }),
    });
    assert.equal(legacyCreate.status, 201);

    // Invalid bearer → 401 (must NOT fall through to guest header path if header is set)
    const bad = await fetch(`${srv.url}/api/migration/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer not-a-real-token',
      },
      body: JSON.stringify({ vmId: 'vm-bad', vmName: 'vm', dataTotalGB: 5 }),
    });
    assert.equal(bad.status, 401);
  } finally {
    await srv.close();
  }
});

test('auth: OIDC endpoints return 501 when not configured', async () => {
  const srv = await startServer();
  try {
    const start = await fetch(`${srv.url}/api/auth/oidc/start`, { redirect: 'manual' });
    assert.equal(start.status, 501);
    const cb = await fetch(`${srv.url}/api/auth/oidc/callback?state=x&code=y`);
    assert.equal(cb.status, 501);
  } finally {
    await srv.close();
  }
});
