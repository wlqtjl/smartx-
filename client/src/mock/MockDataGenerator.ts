/**
 * 离线 Mock 数据生成器：为扫描阶段提供演示数据。
 */
import type { VCenterCredential } from '../core/credential';
import type {
  Datastore,
  DiscoveredVM,
  ESXiHost,
  ESXiScanResult,
  VirtualNetwork,
} from '../simulation/phases/EnvScanPhase';
import type { GuestOSType } from '../simulation/MigrationStateMachine';

const GUEST_OS: GuestOSType[] = [
  'windows_server_2019',
  'windows_server_2022',
  'rhel_8',
  'ubuntu_22',
];

const randomMac = (): string =>
  '00:50:56:' +
  [0, 0, 0]
    .map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0'))
    .join(':');

export const MockDataGenerator = {
  async generateESXiEnvironment(_cred: VCenterCredential): Promise<ESXiScanResult> {
    const hosts: ESXiHost[] = [
      {
        name: 'esxi-01.dc.local',
        ip: '10.0.10.11',
        version: '7.0 U3',
        cpuModel: 'Intel Xeon Gold 6338',
        totalCPU: 64,
        totalMemoryGB: 512,
        vmCount: 18,
        status: 'connected',
        connectionState: 'ok',
      },
      {
        name: 'esxi-02.dc.local',
        ip: '10.0.10.12',
        version: '7.0 U3',
        cpuModel: 'Intel Xeon Gold 6338',
        totalCPU: 64,
        totalMemoryGB: 512,
        vmCount: 12,
        status: 'connected',
        connectionState: 'ok',
      },
    ];
    const datastores: Datastore[] = [
      { name: 'datastore1', type: 'VMFS', capacityGB: 4096, usedGB: 2800, iops: 12000, latencyMs: 2.1 },
      { name: 'nfs-share-01', type: 'NFS', capacityGB: 8192, usedGB: 5400, iops: 4800, latencyMs: 4.8 },
    ];
    const networks: VirtualNetwork[] = [
      { name: 'VM Network', vlanId: 10, type: 'standard' },
      { name: 'DB Network', vlanId: 20, type: 'distributed' },
      { name: 'Mgmt Network', vlanId: null, type: 'standard' },
    ];
    const vmNames = ['vm-db-01', 'vm-web-01', 'vm-web-02', 'vm-ad-01', 'vm-file-01'];
    const vms: DiscoveredVM[] = vmNames.map((name, i) => ({
      moRef: `vm-${1000 + i}`,
      name,
      powerState: 'poweredOn',
      guestOS: GUEST_OS[i % GUEST_OS.length],
      cpu: 2 + (i % 4) * 2,
      memoryGB: 4 << (i % 3),
      disks: [
        {
          label: 'Hard disk 1',
          capacityGB: 80 + (i % 3) * 40,
          provisionType: 'thin',
          datastoreName: 'datastore1',
          path: `[datastore1] ${name}/${name}.vmdk`,
        },
      ],
      nics: [
        {
          label: 'Network adapter 1',
          macAddress: randomMac(),
          networkName: i === 0 ? 'DB Network' : 'VM Network',
          adapterType: i % 2 === 0 ? 'vmxnet3' : 'e1000',
        },
      ],
      snapshotExists: i === 0,
      toolsVersion: '11.3.0',
      toolsRunning: i !== 3,
    }));

    return {
      vCenterVersion: 'vCenter 7.0 U3',
      esxiHosts: hosts,
      datastores,
      networks,
      vms,
      scanDurationMs: 0,
    };
  },
};
