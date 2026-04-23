import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkStorageMismatch,
  StorageMappingPhase,
} from '../src/simulation/phases/StorageMappingPhase.js';
import type { DiscoveredVM, StoragePool, VMWorkloadType } from '@shared/index';

const makeVM = (
  overrides: Partial<DiscoveredVM> & { workloadType: VMWorkloadType },
): DiscoveredVM & { workloadType: VMWorkloadType } => ({
  moRef: 'vm-1',
  name: 'vm-db-01',
  powerState: 'poweredOn',
  guestOS: 'windows_server_2019',
  cpu: 4,
  memoryGB: 16,
  disks: [
    {
      label: 'Hard disk 1',
      capacityGB: 100,
      provisionType: 'thin',
      datastoreName: 'datastore1',
      path: '[datastore1] vm/vm.vmdk',
    },
  ],
  nics: [],
  snapshotExists: false,
  toolsVersion: '11.3',
  toolsRunning: true,
  ...overrides,
});

const nvmePool: StoragePool = {
  id: 'pool-nvme',
  name: 'NVMe',
  tier: 'nvme',
  totalTB: 10,
  availableTB: 8,
  maxIOPS: 400000,
  avgLatencyMs: 0.3,
  ioLocalitySupport: true,
  rdmaSupport: true,
  color: '#FFD700',
};
const hddPool: StoragePool = {
  id: 'pool-hdd',
  name: 'HDD',
  tier: 'hdd',
  totalTB: 0.05,
  availableTB: 0.05,
  maxIOPS: 2500,
  avgLatencyMs: 12,
  ioLocalitySupport: false,
  rdmaSupport: false,
  color: '#CD7F32',
};

test('storage: database VM onto HDD triggers PERFORMANCE_DOWNGRADE', () => {
  const vm = makeVM({ workloadType: 'DATABASE' });
  const warning = checkStorageMismatch(vm, hddPool);
  assert.ok(warning);
  assert.equal(warning?.type, 'PERFORMANCE_DOWNGRADE');
});

test('storage: capacity insufficient detected', () => {
  const vm = makeVM({
    workloadType: 'BATCH_JOB',
    disks: [
      {
        label: 'd1',
        capacityGB: 500,
        provisionType: 'thin',
        datastoreName: 'ds1',
        path: '[ds1]',
      },
    ],
  });
  const warning = checkStorageMismatch(vm, hddPool);
  assert.ok(warning);
  assert.equal(warning?.type, 'CAPACITY_INSUFFICIENT');
});

test('storage: database on NVMe is validated and warning-free', () => {
  const vm = makeVM({ workloadType: 'DATABASE' });
  const phase = new StorageMappingPhase([nvmePool]);
  const { mapping, warning } = phase.assign(vm, 'pool-nvme', { ioLocality: true, rdma: true });
  assert.equal(warning, null);
  assert.equal(mapping.validated, true);
  assert.equal(mapping.ioLocalityEnabled, true);
  assert.equal(mapping.rdmaEnabled, true);
});

test('storage: unknown pool throws', () => {
  const vm = makeVM({ workloadType: 'DATABASE' });
  const phase = new StorageMappingPhase([nvmePool]);
  assert.throws(() => phase.assign(vm, 'nonexistent'), /未知存储池/);
});
