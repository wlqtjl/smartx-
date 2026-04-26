import { describe, it, expect } from 'vitest';
import { FaultInjectionPhase, FAULT_CATALOG } from './FaultInjectionPhase';
import type { ESXiScanResult } from './EnvScanPhase';

function fakeEnv(): ESXiScanResult {
  return {
    vCenterVersion: 'vCenter 7.0',
    esxiHosts: [],
    datastores: [],
    networks: [{ name: 'VM Network', vlanId: 10, type: 'standard' }],
    vms: [
      {
        moRef: 'vm-1',
        name: 'vm-db-01',
        powerState: 'poweredOn',
        guestOS: 'rhel_8',
        cpu: 4,
        memoryGB: 8,
        disks: [],
        nics: [],
        snapshotExists: true,
        toolsVersion: '11.3.0',
        toolsRunning: true,
      },
      {
        moRef: 'vm-2',
        name: 'vm-web-01',
        powerState: 'poweredOn',
        guestOS: 'ubuntu_22',
        cpu: 2,
        memoryGB: 4,
        disks: [],
        nics: [],
        snapshotExists: false,
        toolsVersion: '11.3.0',
        toolsRunning: true,
      },
    ],
    scanDurationMs: 0,
  };
}

describe('FaultInjectionPhase.inject', () => {
  it('produces between minFaults and maxFaults entries', () => {
    const phase = new FaultInjectionPhase();
    // Deterministic rng: always returns 0 → picks minFaults end
    const faults = phase.inject(fakeEnv(), { rng: () => 0, minFaults: 1, maxFaults: 3 });
    expect(faults.length).toBeGreaterThanOrEqual(1);
    expect(faults.length).toBeLessThanOrEqual(3);
  });

  it('substitutes vm/network into the description', () => {
    const phase = new FaultInjectionPhase();
    // Force inclusion of all 3 candidates by maxing out
    const faults = phase.inject(fakeEnv(), { rng: () => 0.99, minFaults: 3, maxFaults: 3 });
    const types = faults.map((f) => f.def.type).sort();
    expect(types).toEqual(['MTU_MISMATCH', 'RDMA_UNSUPPORTED', 'UNMERGED_SNAPSHOT']);
    const snap = faults.find((f) => f.def.type === 'UNMERGED_SNAPSHOT')!;
    expect(snap.contextDescription).toContain('vm-db-01');
    const mtu = faults.find((f) => f.def.type === 'MTU_MISMATCH')!;
    expect(mtu.contextDescription).toContain('VM Network');
  });

  it('skips snapshot fault when no VM has snapshots', () => {
    const phase = new FaultInjectionPhase();
    const env = fakeEnv();
    env.vms.forEach((v) => (v.snapshotExists = false));
    const faults = phase.inject(env, { rng: () => 0.5, minFaults: 3, maxFaults: 3 });
    expect(faults.find((f) => f.def.type === 'UNMERGED_SNAPSHOT')).toBeUndefined();
  });
});

describe('FaultInjectionPhase.resolve', () => {
  const phase = new FaultInjectionPhase();
  const fault = phase.inject(fakeEnv(), { rng: () => 0.99, minFaults: 3, maxFaults: 3 })
    .find((f) => f.def.type === 'UNMERGED_SNAPSHOT')!;

  it('rewards the correct tool', () => {
    const r = phase.resolve(fault, FAULT_CATALOG.UNMERGED_SNAPSHOT.requiredTool);
    expect(r.resolved).toBe(true);
    expect(r.rule).toBe('FIXED_FAULT_SNAPSHOT');
  });

  it('treats wrong tool as a no-op (no reward, no penalty)', () => {
    const r = phase.resolve(fault, 'BANDWIDTH_LIMITER');
    expect(r.resolved).toBe(false);
    expect(r.rule).toBeNull();
  });

  it('penalizes ignore via the configured ignoreRule', () => {
    const r = phase.resolve(fault, null);
    expect(r.resolved).toBe(false);
    expect(r.rule).toBe(FAULT_CATALOG.UNMERGED_SNAPSHOT.ignoreRule);
  });
});
