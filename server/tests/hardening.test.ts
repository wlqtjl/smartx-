import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type SmartXServer } from '../src/server.js';

let srv: SmartXServer;

test.before(async () => {
  srv = await createServer({ port: 0, host: '127.0.0.1', dataPath: '/tmp/smartx-hardening.json' });
});
test.after(async () => {
  if (srv) await srv.close();
});

test('health: returns storage + schema info', async () => {
  const r = await fetch(`${srv.url}/health`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ok: boolean; schemaVersion: number; wsClients: number };
  assert.equal(body.ok, true);
  assert.equal(typeof body.schemaVersion, 'number');
  assert.equal(body.wsClients, 0);
});

test('metrics: emits prometheus text lines', async () => {
  const r = await fetch(`${srv.url}/metrics`);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /smartx_tasks_total /);
  assert.match(text, /smartx_sessions /);
  assert.match(text, /smartx_ws_clients /);
  assert.match(text, /smartx_uptime_seconds /);
});

test('validation: invalid body returns 400 with issues array', async () => {
  const sess = (await (
    await fetch(`${srv.url}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerName: 'V' }),
    })
  ).json()) as { token: string };

  const r = await fetch(`${srv.url}/api/migration/tasks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-session-token': sess.token,
    },
    body: JSON.stringify({ vmId: '', vmName: '', dataTotalGB: -5 }),
  });
  assert.equal(r.status, 400);
  const body = (await r.json()) as { error: { message: string; issues: unknown[] } };
  assert.equal(body.error.message, 'validation failed');
  assert.ok(Array.isArray(body.error.issues));
  assert.ok(body.error.issues.length > 0);
});

test('request-id: echoed back in X-Request-Id header', async () => {
  const r = await fetch(`${srv.url}/health`, {
    headers: { 'x-request-id': 'abc-123' },
  });
  assert.equal(r.headers.get('x-request-id'), 'abc-123');
});

test('request-id: generated when absent', async () => {
  const r = await fetch(`${srv.url}/health`);
  const rid = r.headers.get('x-request-id');
  assert.ok(rid && rid.length > 0);
});
