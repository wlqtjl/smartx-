/**
 * PR #1：密码哈希 + JWT 单元测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/passwordHasher.js';
import { JwtService, JwtExpiredError, JwtInvalidError } from '../src/auth/jwtService.js';

test('passwordHasher: roundtrip matches', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');
  assert.ok(hash.startsWith('scrypt$'));
  assert.ok(await verifyPassword('correct-horse-battery-staple', hash));
});

test('passwordHasher: wrong password rejected', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');
  assert.equal(await verifyPassword('wrong-pass', hash), false);
});

test('passwordHasher: malformed stored hash rejected', async () => {
  assert.equal(await verifyPassword('anything', 'not-a-valid-hash'), false);
  assert.equal(await verifyPassword('anything', 'scrypt$bad'), false);
});

test('passwordHasher: hashes are salted (distinct ciphertext)', async () => {
  const h1 = await hashPassword('same');
  const h2 = await hashPassword('same');
  assert.notEqual(h1, h2);
});

test('passwordHasher: empty password rejected at hash time', async () => {
  await assert.rejects(hashPassword(''));
});

test('JwtService: rejects short secrets', () => {
  assert.throws(
    () =>
      new JwtService({
        secret: 'too-short',
        issuer: 'smartx',
        accessTtlSec: 60,
        refreshTtlSec: 3600,
      }),
    /at least 32/,
  );
});

test('JwtService: sign + verify roundtrip', async () => {
  const jwt = new JwtService({
    secret: 'a'.repeat(32),
    issuer: 'smartx-test',
    accessTtlSec: 60,
    refreshTtlSec: 3600,
  });
  const token = await jwt.sign('access', { sub: 'u1', login: 'alice', roles: ['operator'], sid: 's1' });
  const claims = await jwt.verify(token, 'access');
  assert.equal(claims.sub, 'u1');
  assert.equal(claims.login, 'alice');
  assert.deepEqual(claims.roles, ['operator']);
  assert.equal(claims.sid, 's1');
  assert.equal(claims.typ, 'access');
});

test('JwtService: rejects wrong typ', async () => {
  const jwt = new JwtService({
    secret: 'a'.repeat(32),
    issuer: 'smartx-test',
    accessTtlSec: 60,
    refreshTtlSec: 3600,
  });
  const access = await jwt.sign('access', { sub: 'u1', login: 'a', roles: [], sid: 's1' });
  await assert.rejects(jwt.verify(access, 'refresh'), JwtInvalidError);
});

test('JwtService: rejects tampered signature', async () => {
  const jwt = new JwtService({
    secret: 'a'.repeat(32),
    issuer: 'smartx-test',
    accessTtlSec: 60,
    refreshTtlSec: 3600,
  });
  const token = await jwt.sign('access', { sub: 'u1', login: 'a', roles: [], sid: 's1' });
  // Flip the last char of the signature segment.
  const parts = token.split('.');
  const sig = parts[2]!;
  const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  const tampered = `${parts[0]}.${parts[1]}.${flipped}`;
  await assert.rejects(jwt.verify(tampered, 'access'), JwtInvalidError);
});

test('JwtService: expired token rejected', async () => {
  // Build a service with a 1-second TTL, sign, then wait past expiry.
  const jwt = new JwtService({
    secret: 'a'.repeat(32),
    issuer: 'smartx-test',
    accessTtlSec: 1,
    refreshTtlSec: 1,
  });
  const token = await jwt.sign('access', { sub: 'u1', login: 'a', roles: [], sid: 's1' });
  await new Promise((r) => setTimeout(r, 1100));
  await assert.rejects(jwt.verify(token, 'access'), JwtExpiredError);
});

test('JwtService: rejects wrong issuer', async () => {
  const signer = new JwtService({
    secret: 'a'.repeat(32),
    issuer: 'smartx-a',
    accessTtlSec: 60,
    refreshTtlSec: 60,
  });
  const verifier = new JwtService({
    secret: 'a'.repeat(32),
    issuer: 'smartx-b',
    accessTtlSec: 60,
    refreshTtlSec: 60,
  });
  const token = await signer.sign('access', { sub: 'u1', login: 'a', roles: [], sid: 's1' });
  await assert.rejects(verifier.verify(token, 'access'), JwtInvalidError);
});
