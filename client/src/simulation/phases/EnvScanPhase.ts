/**
 * 阶段一：源端环境扫描（ENV_SCAN）—— §3.1
 */
import { EventBus } from '../../core/EventBus';
import { delay } from '../../core/utils';
import type { VCenterCredential } from '../../core/credential';
import { MockDataGenerator } from '../../mock/MockDataGenerator';
import type { GuestOSType } from '../MigrationStateMachine';

export interface ESXiHost {
  name: string;
  ip: string;
  version: string;
  cpuModel: string;
  totalCPU: number;
  totalMemoryGB: number;
  vmCount: number;
  status: 'connected' | 'disconnected' | 'maintenance';
  connectionState: 'ok' | 'notResponding' | 'unknown';
}

export interface Datastore {
  name: string;
  type: 'VMFS' | 'NFS' | 'vSAN';
  capacityGB: number;
  usedGB: number;
  iops: number;
  latencyMs: number;
}

export interface VirtualNetwork {
  name: string;
  vlanId: number | null;
  type: 'standard' | 'distributed';
}

export interface VMDisk {
  label: string;
  capacityGB: number;
  provisionType: 'thin' | 'thick_eager' | 'thick_lazy';
  datastoreName: string;
  path: string;
}

export interface VMNIC {
  label: string;
  macAddress: string;
  networkName: string;
  adapterType: 'vmxnet3' | 'e1000' | 'e1000e';
}

export interface DiscoveredVM {
  moRef: string;
  name: string;
  powerState: 'poweredOn' | 'poweredOff' | 'suspended';
  guestOS: GuestOSType;
  cpu: number;
  memoryGB: number;
  disks: VMDisk[];
  nics: VMNIC[];
  snapshotExists: boolean;
  toolsVersion: string;
  toolsRunning: boolean;
}

export interface ESXiScanResult {
  vCenterVersion: string;
  esxiHosts: ESXiHost[];
  datastores: Datastore[];
  networks: VirtualNetwork[];
  vms: DiscoveredVM[];
  scanDurationMs: number;
}

export class EnvScanPhase {
  async execute(credential: VCenterCredential): Promise<ESXiScanResult> {
    EventBus.emit('fx:rack_lights_scanning', { color: '#00AAFF', pattern: 'blink' });
    const result = await this.simulateScan(credential);
    EventBus.emit('ui:show_scan_results', result);
    return result;
  }

  private async simulateScan(cred: VCenterCredential): Promise<ESXiScanResult> {
    const start = Date.now();
    await delay(1500 + Math.random() * 1500);
    const env = await MockDataGenerator.generateESXiEnvironment(cred);
    return { ...env, scanDurationMs: Date.now() - start };
  }
}
