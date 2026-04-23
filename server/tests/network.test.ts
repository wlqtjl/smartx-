import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NetworkMappingPhase,
  validateNetworkMapping,
} from '../src/simulation/phases/NetworkMappingPhase.js';
import type { BridgeNode, VSwitchNode } from '@shared/index';

const src: VSwitchNode = {
  id: 'v1',
  name: 'vSwitch0',
  portGroups: ['VM Network'],
  vlanIds: [10],
  position3D: [0, 0, 0],
  connected: false,
};
const tgt: BridgeNode = {
  id: 't1',
  name: 'br0',
  type: 'distributed',
  availableBandwidthGbps: 10,
  position3D: [5, 0, 0],
};

test('network: clean mapping validates', () => {
  const r = validateNetworkMapping(src, tgt, []);
  assert.equal(r.valid, true);
});

test('network: duplicate target bridge rejected', () => {
  const phase = new NetworkMappingPhase([src], [tgt]);
  const first = phase.attemptMapping('v1', 't1');
  assert.equal(first.ok, true);
  const secondSrc: VSwitchNode = { ...src, id: 'v2', name: 'vSwitch1', vlanIds: [30] };
  const phase2 = new NetworkMappingPhase([src, secondSrc], [tgt]);
  phase2.attemptMapping('v1', 't1');
  const second = phase2.attemptMapping('v2', 't1');
  assert.equal(second.ok, false);
  assert.match(second.error ?? '', /已被/);
});

test('network: VLAN conflict yields warning but still maps', () => {
  const s2: VSwitchNode = { ...src, id: 'v2', name: 'vSwitch1' }; // same VLAN 10
  const t2: BridgeNode = { ...tgt, id: 't2', name: 'br1' };
  const phase = new NetworkMappingPhase([src, s2], [tgt, t2]);
  phase.attemptMapping('v1', 't1');
  const r = phase.attemptMapping('v2', 't2');
  assert.equal(r.ok, true);
  assert.match(r.warning ?? '', /VLAN/);
});

test('network: isComplete reflects pending list', () => {
  const phase = new NetworkMappingPhase([src], [tgt]);
  assert.equal(phase.isComplete(), false);
  phase.attemptMapping('v1', 't1');
  assert.equal(phase.isComplete(), true);
});
