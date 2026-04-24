import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/core/config.js';

test('config: defaults in development', () => {
  const c = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
  assert.equal(c.nodeEnv, 'development');
  assert.equal(c.port, 8787);
  assert.equal(c.host, '0.0.0.0');
  assert.deepEqual(c.allowedOrigins, []);
  assert.equal(c.rateLimitPerMin, 60);
  assert.equal(c.wsMaxSubscriptions, 16);
});

test('config: parses CSV origins and falls back ws to http', () => {
  const c = loadConfig({
    NODE_ENV: 'development',
    SMARTX_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(c.allowedOrigins, ['https://a.example', 'https://b.example']);
  assert.deepEqual(c.wsAllowedOrigins, c.allowedOrigins);
});

test('config: independent ws origin list', () => {
  const c = loadConfig({
    NODE_ENV: 'development',
    SMARTX_ALLOWED_ORIGINS: 'https://a.example',
    SMARTX_WS_ALLOWED_ORIGINS: 'https://ws.example',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(c.wsAllowedOrigins, ['https://ws.example']);
});

test('config: production requires allowed origins', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), /SMARTX_ALLOWED_ORIGINS/);
});

test('config: production with allowed origins succeeds', () => {
  const c = loadConfig({
    NODE_ENV: 'production',
    SMARTX_ALLOWED_ORIGINS: 'https://a.example',
  } as NodeJS.ProcessEnv);
  assert.equal(c.nodeEnv, 'production');
});

test('config: invalid port rejected', () => {
  assert.throws(
    () => loadConfig({ SMARTX_PORT: 'not-a-number' } as NodeJS.ProcessEnv),
    /invalid environment/,
  );
});

test('config: invalid rate limit rejected', () => {
  assert.throws(
    () => loadConfig({ SMARTX_RATE_LIMIT_PER_MIN: '0' } as NodeJS.ProcessEnv),
    /invalid environment/,
  );
});
