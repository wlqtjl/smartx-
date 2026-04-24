/**
 * PR #2：Store 适配器跨后端一致性测试。
 *
 * 为每一个后端运行同一套 round-trip 用例，覆盖 users/sessions/tasks/checkpoints/audit。
 * Postgres 只在 `DATABASE_URL` 存在时执行（CI 中由服务容器提供；本地默认跳过）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  MigrationCheckpoint,
  MigrationTask,
  MigrationState,
} from '@shared/index';
import { MigrationStateMachine } from '../src/simulation/MigrationStateMachine.js';
import { CheckpointSystem } from '../src/simulation/CheckpointSystem.js';
import { JsonStore } from '../src/storage/JsonStore.js';
import { SqliteStore } from '../src/storage/SqliteStore.js';
import type { Store, StoredUser, StoredSession } from '../src/storage/Store.js';

type AdapterFactory = () => Promise<{ store: Store; cleanup: () => Promise<void> }>;

const sampleTask = (id: string, state: MigrationState = 'IDLE'): MigrationTask => ({
  id,
  vmId: `vm-${id}`,
  vmName: `vm-name-${id}`,
  state,
  progress: {
    fullSyncPercent: 0,
    incrementalRounds: 0,
    dataTotalGB: 100,
    dataTransferredGB: 0,
    transferSpeedMbps: 0,
    etaSeconds: 0,
  },
  networkMapping: null,
  storageMapping: null,
  driverStatus: {
    phase: 'PENDING',
    guestOS: 'windows_server_2019',
    detectedDrivers: [],
    injectedDrivers: [],
    autoInjected: false,
  },
  checkpointOffset: 0,
  errors: [],
  timeline: [],
  agentless: true,
  ownerSession: 'user-a',
});

const sampleCheckpoint = (taskId: string, offset: number): MigrationCheckpoint => ({
  taskId,
  vmId: `vm-${taskId}`,
  timestamp: Date.now(),
  lastCompletedBlockOffset: offset,
  transferredBlocks: [offset - 1, offset],
  totalBlocks: 1000,
  networkMetricsAtFailure: { packetLoss: 0, jitterMs: 0, failureReason: '' },
  cachedVMMetadata: null,
  networkMappingSnapshot: null,
  storageMappingSnapshot: null,
});

const sampleUser = (id: string): StoredUser => ({
  id,
  login: `user-${id}`,
  passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$abcd$efgh',
  oidcSubject: null,
  roles: ['operator'],
  createdAt: Date.now(),
  disabledAt: null,
});

const sampleSession = (sid: string, userId: string): StoredSession => ({
  sid,
  userId,
  createdAt: Date.now(),
  expiresAt: Date.now() + 15 * 60_000,
  refreshHash: 'hash-abc',
  revokedAt: null,
});

const adapters: Array<[string, AdapterFactory]> = [
  [
    'json',
    async () => {
      const fsm = new MigrationStateMachine();
      const cp = new CheckpointSystem();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartx-jsonstore-'));
      const file = path.join(dir, 'state.json');
      const store = new JsonStore(fsm, cp, file);
      await store.migrate();
      return {
        store,
        cleanup: async () => {
          await store.shutdown();
          await fs.rm(dir, { recursive: true, force: true });
        },
      };
    },
  ],
  [
    'sqlite',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartx-sqlite-'));
      const file = path.join(dir, 'smartx.db');
      const store = new SqliteStore(file);
      await store.migrate();
      return {
        store,
        cleanup: async () => {
          await store.close();
          await fs.rm(dir, { recursive: true, force: true });
        },
      };
    },
  ],
];

// Postgres is parametrized in too, gated on DATABASE_URL. We import lazily so
// a missing `pg` module wouldn't take the whole suite down in edge cases.
if (process.env.DATABASE_URL) {
  adapters.push([
    'postgres',
    async () => {
      const { PostgresStore } = await import('../src/storage/PostgresStore.js');
      const store = new PostgresStore({
        connectionString: process.env.DATABASE_URL!,
        max: 4,
      });
      // Reset: rollback then re-migrate so each adapter test starts empty.
      await store.migrate();
      await store.rollbackLatest();
      await store.migrate();
      return {
        store,
        cleanup: async () => {
          await store.rollbackLatest();
          await store.close();
        },
      };
    },
  ]);
}

for (const [name, factory] of adapters) {
  test(`adapter[${name}]: users round-trip`, async () => {
    const { store, cleanup } = await factory();
    try {
      const u = sampleUser('u1');
      await store.users.upsert(u);
      const back = await store.users.get('u1');
      assert.ok(back);
      assert.equal(back?.login, 'user-u1');
      assert.deepEqual(back?.roles, ['operator']);
      const byLogin = await store.users.findByLogin('user-u1');
      assert.equal(byLogin?.id, 'u1');
      await store.users.delete('u1');
      assert.equal(await store.users.get('u1'), null);
    } finally {
      await cleanup();
    }
  });

  test(`adapter[${name}]: sessions round-trip + revoke`, async () => {
    const { store, cleanup } = await factory();
    try {
      await store.users.upsert(sampleUser('u1'));
      const s = sampleSession('sid-1', 'u1');
      await store.sessions.upsert(s);
      const got = await store.sessions.get('sid-1');
      assert.equal(got?.userId, 'u1');
      assert.equal(got?.revokedAt, null);
      const revokeAt = Date.now();
      await store.sessions.revoke('sid-1', revokeAt);
      const after = await store.sessions.get('sid-1');
      assert.equal(after?.revokedAt, revokeAt);
    } finally {
      await cleanup();
    }
  });

  test(`adapter[${name}]: tasks replaceAll + list`, async () => {
    const { store, cleanup } = await factory();
    try {
      const tasks = [sampleTask('t1'), sampleTask('t2', 'FULL_SYNC')];
      await store.tasks.replaceAll(tasks);
      const all = await store.tasks.list();
      assert.equal(all.length, 2);
      const ids = all.map((t) => t.id).sort();
      assert.deepEqual(ids, ['t1', 't2']);
      const t2 = all.find((t) => t.id === 't2');
      assert.equal(t2?.state, 'FULL_SYNC');
    } finally {
      await cleanup();
    }
  });

  test(`adapter[${name}]: checkpoints replaceAll + dumpAll`, async () => {
    const { store, cleanup } = await factory();
    try {
      const cps: Array<[string, MigrationCheckpoint[]]> = [
        ['t1', [sampleCheckpoint('t1', 10), sampleCheckpoint('t1', 20)]],
        ['t2', [sampleCheckpoint('t2', 5)]],
      ];
      await store.checkpoints.replaceAll(cps);
      const dumped = await store.checkpoints.dumpAll();
      // Normalize: check counts + offsets match (order within task_id guaranteed by seq)
      const mapIn = new Map(cps);
      const mapOut = new Map(dumped);
      assert.equal(mapOut.size, mapIn.size);
      for (const [taskId, arr] of mapIn) {
        const out = mapOut.get(taskId);
        assert.equal(out?.length, arr.length, `checkpoints len for ${taskId}`);
        assert.deepEqual(
          out?.map((c) => c.lastCompletedBlockOffset),
          arr.map((c) => c.lastCompletedBlockOffset),
        );
      }
    } finally {
      await cleanup();
    }
  });

  test(`adapter[${name}]: audit append + filter`, async () => {
    const { store, cleanup } = await factory();
    try {
      const t0 = Date.now();
      await store.audit.append({ userId: 'u1', action: 'login', target: null, at: t0, details: null });
      await store.audit.append({ userId: 'u2', action: 'logout', target: null, at: t0 + 1, details: { ip: '1.2.3.4' } });
      const all = await store.audit.list();
      assert.equal(all.length, 2);
      const u1Only = await store.audit.list({ userId: 'u1' });
      assert.equal(u1Only.length, 1);
      assert.equal(u1Only[0]!.action, 'login');
    } finally {
      await cleanup();
    }
  });

  test(`adapter[${name}]: health reports schemaVersion`, async () => {
    const { store, cleanup } = await factory();
    try {
      const h = await store.health();
      assert.equal(h.ok, true);
      assert.ok(h.schemaVersion >= 1, `schemaVersion should be >= 1 but is ${h.schemaVersion}`);
      assert.ok(Array.isArray(h.migrationsApplied));
    } finally {
      await cleanup();
    }
  });
}
