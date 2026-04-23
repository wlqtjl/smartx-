/**
 * 阶段三：网络映射（NETWORK_MAPPING）—— §3.3
 * 玩家用光纤工具在 3D 空间从 vSwitch 拖拽到 SmartX Bridge。
 */
export interface NetworkMapping {
  sourceVSwitch: string;
  sourcePortGroup: string;
  targetBridgeType: 'standard' | 'distributed';
  targetBridgeName: string;
  vlanId: number | null;
  validated: boolean;
}

export interface VSwitchNode {
  id: string;
  name: string;
  portGroups: string[];
  vlanIds: number[];
  position3D: [number, number, number];
  connected: boolean;
}

export interface BridgeNode {
  id: string;
  name: string;
  type: 'standard' | 'distributed';
  availableBandwidthGbps: number;
  position3D: [number, number, number];
}

export interface NetworkMappingUI {
  sourceVSwitches: VSwitchNode[];
  targetSmartXBridges: BridgeNode[];
  completedMappings: NetworkMapping[];
  pendingMappings: string[];
}

export const validateNetworkMapping = (
  source: VSwitchNode,
  target: BridgeNode,
  existingMappings: NetworkMapping[],
): { valid: boolean; warning?: string; error?: string } => {
  const alreadyMapped = existingMappings.find((m) => m.targetBridgeName === target.name);
  if (alreadyMapped) {
    return { valid: false, error: `${target.name} 已被 ${alreadyMapped.sourceVSwitch} 占用` };
  }
  const vlanConflict = source.vlanIds.some((v) =>
    existingMappings.some((m) => m.vlanId === v),
  );
  if (vlanConflict) {
    return { valid: true, warning: 'VLAN ID 冲突，请检查隔离配置' };
  }
  return { valid: true };
};

export class NetworkMappingPhase {
  readonly state: NetworkMappingUI;

  constructor(sources: VSwitchNode[], targets: BridgeNode[]) {
    this.state = {
      sourceVSwitches: sources,
      targetSmartXBridges: targets,
      completedMappings: [],
      pendingMappings: sources.map((s) => s.id),
    };
  }

  /** 玩家完成一次连线；如果通过校验则落库 */
  attemptMapping(
    sourceId: string,
    targetId: string,
  ): { ok: boolean; mapping?: NetworkMapping; warning?: string; error?: string } {
    const source = this.state.sourceVSwitches.find((s) => s.id === sourceId);
    const target = this.state.targetSmartXBridges.find((b) => b.id === targetId);
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
    this.state.pendingMappings = this.state.pendingMappings.filter((id) => id !== sourceId);
    return { ok: true, mapping, warning: result.warning };
  }

  isComplete(): boolean {
    return this.state.pendingMappings.length === 0;
  }
}
