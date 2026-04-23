/**
 * 阶段三：NETWORK_MAPPING —— 校验 vSwitch → SmartX Bridge 连线。
 */
import type { BridgeNode, NetworkMapping, VSwitchNode } from '@shared/index';

export interface MappingValidation {
  valid: boolean;
  warning?: string;
  error?: string;
}

export const validateNetworkMapping = (
  source: VSwitchNode,
  target: BridgeNode,
  existing: NetworkMapping[],
): MappingValidation => {
  const alreadyMapped = existing.find((m) => m.targetBridgeName === target.name);
  if (alreadyMapped) {
    return { valid: false, error: `${target.name} 已被 ${alreadyMapped.sourceVSwitch} 占用` };
  }
  const vlanConflict = source.vlanIds.some((v) => existing.some((m) => m.vlanId === v));
  if (vlanConflict) {
    return { valid: true, warning: 'VLAN ID 冲突，请检查隔离配置' };
  }
  return { valid: true };
};

export interface NetworkMappingState {
  sources: VSwitchNode[];
  targets: BridgeNode[];
  completedMappings: NetworkMapping[];
  pendingSourceIds: string[];
}

export class NetworkMappingPhase {
  readonly state: NetworkMappingState;

  constructor(sources: VSwitchNode[], targets: BridgeNode[]) {
    this.state = {
      sources,
      targets,
      completedMappings: [],
      pendingSourceIds: sources.map((s) => s.id),
    };
  }

  attemptMapping(
    sourceId: string,
    targetId: string,
  ): { ok: boolean; mapping?: NetworkMapping; warning?: string; error?: string } {
    const source = this.state.sources.find((s) => s.id === sourceId);
    const target = this.state.targets.find((t) => t.id === targetId);
    if (!source || !target) return { ok: false, error: '源或目标节点不存在' };

    const result = validateNetworkMapping(source, target, this.state.completedMappings);
    if (!result.valid) return { ok: false, error: result.error };

    const mapping: NetworkMapping = {
      sourceVSwitch: source.name,
      sourcePortGroup: source.portGroups[0] ?? 'default',
      targetBridgeType: target.type,
      targetBridgeName: target.name,
      vlanId: source.vlanIds[0] ?? null,
      validated: true,
    };
    this.state.completedMappings.push(mapping);
    source.connected = true;
    this.state.pendingSourceIds = this.state.pendingSourceIds.filter((id) => id !== sourceId);
    return { ok: true, mapping, warning: result.warning };
  }

  isComplete(): boolean {
    return this.state.pendingSourceIds.length === 0;
  }
}
