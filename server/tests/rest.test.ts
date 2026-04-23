import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer, type SmartXServer } from '../src/server.js';

let srv: SmartXServer;

const startOnce = async (): Promise<SmartXServer> => {
  if (!srv) {
    srv = await createServer({ port: 0, host: '127.0.0.1', dataPath: '/tmp/smartx-test-state.json' });
  }
  return srv;
};

test.after(async () => {
  if (srv) await srv.close();
});

const post = async (url: string, body?: unknown, token?: string): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-session-token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const get = async (url: string, token?: string): Promise<Response> =>
  fetch(url, { headers: token ? { 'x-session-token': token } : {} });

test('REST: health endpoint is open', async () => {
  const s = await startOnce();
  const r = await get(`${s.url}/health`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test('REST: unauthenticated task creation fails with 401', async () => {
  const s = await startOnce();
  const r = await post(`${s.url}/api/migration/tasks`, { vmId: 'x', vmName: 'y', dataTotalGB: 10 });
  assert.equal(r.status, 401);
});

test('REST: full task lifecycle with session', async () => {
  const s = await startOnce();

  const sessResp = await post(`${s.url}/api/auth/session`, { playerName: 'Tester' });
  assert.equal(sessResp.status, 201);
  const session = (await sessResp.json()) as { token: string };
  const token = session.token;

  const createResp = await post(
    `${s.url}/api/migration/tasks`,
    { vmId: 'vm-1000', vmName: 'vm-db-01', dataTotalGB: 10 },
    token,
  );
  assert.equal(createResp.status, 201);
  const task = (await createResp.json()) as { id: string; state: string };
  assert.equal(task.state, 'IDLE');

  // Happy-path transitions
  const path = [
    'ENV_SCAN',
    'COMPATIBILITY_CHECK',
    'NETWORK_MAPPING',
    'STORAGE_MAPPING',
    'PRE_SNAPSHOT',
    'FULL_SYNC',
    'INCREMENTAL_SYNC',
    'DRIVER_INJECTION',
    'CUTOVER_READY',
    'CUTOVER_EXECUTING',
    'POST_CHECK',
    'COMPLETED',
  ];
  for (const state of path) {
    const r = await post(`${s.url}/api/migration/tasks/${task.id}/transition`, { state }, token);
    assert.equal(r.status, 200, `transition to ${state} should succeed`);
  }

  // Apply a scoring rule
  const scoreResp = await post(
    `${s.url}/api/migration/tasks/${task.id}/score/apply`,
    { rule: 'USED_RDMA' },
    token,
  );
  assert.equal(scoreResp.status, 200);
  const score = (await scoreResp.json()) as { total: number };
  assert.equal(score.total, 200);

  // Unknown rule rejected
  const badScore = await post(
    `${s.url}/api/migration/tasks/${task.id}/score/apply`,
    { rule: 'NOPE' },
    token,
  );
  assert.equal(badScore.status, 400);
});

test('REST: illegal transition returns 409', async () => {
  const s = await startOnce();
  const sess = (await (await post(`${s.url}/api/auth/session`, { playerName: 'T' })).json()) as { token: string };
  const task = (await (
    await post(
      `${s.url}/api/migration/tasks`,
      { vmId: 'v', vmName: 'v', dataTotalGB: 5 },
      sess.token,
    )
  ).json()) as { id: string };
  const bad = await post(
    `${s.url}/api/migration/tasks/${task.id}/transition`,
    { state: 'FULL_SYNC' },
    sess.token,
  );
  assert.equal(bad.status, 409);
});

test('REST: invalid dataTotalGB rejected', async () => {
  const s = await startOnce();
  const sess = (await (await post(`${s.url}/api/auth/session`, { playerName: 'T' })).json()) as { token: string };
  const r = await post(
    `${s.url}/api/migration/tasks`,
    { vmId: 'v', vmName: 'v', dataTotalGB: -1 },
    sess.token,
  );
  assert.equal(r.status, 400);
});

test('WS: connection requires token and broadcasts subscribed task events', async () => {
  const s = await startOnce();

  // Without token → 401
  const noTokenFail = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(s.url).port}/ws`);
    ws.on('error', () => resolve(true));
    ws.on('open', () => {
      ws.close();
      resolve(false);
    });
  });
  assert.equal(noTokenFail, true, 'connection without token should fail');

  const sess = (await (await post(`${s.url}/api/auth/session`, { playerName: 'WsT' })).json()) as { token: string };
  const task = (await (
    await post(
      `${s.url}/api/migration/tasks`,
      { vmId: 'vm-ws', vmName: 'vm-ws', dataTotalGB: 3 },
      sess.token,
    )
  ).json()) as { id: string };

  const port = new URL(s.url).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${sess.token}`);
  const messages: unknown[] = [];

  const helloReceived = new Promise<void>((resolve) => {
    ws.once('message', (raw) => {
      const msg = JSON.parse(String(raw));
      messages.push(msg);
      assert.equal(msg.type, 'hello');
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  await helloReceived;

  const stateChangeReceived = new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'event' && msg.event === 'migration:stateChange') {
        messages.push(msg);
        resolve();
      }
    });
  });

  ws.send(JSON.stringify({ type: 'subscribe', taskId: task.id }));
  await new Promise((r) => setTimeout(r, 50));

  await post(
    `${s.url}/api/migration/tasks/${task.id}/transition`,
    { state: 'ENV_SCAN' },
    sess.token,
  );

  await stateChangeReceived;
  ws.close();
  assert.ok(messages.length >= 2);
});
