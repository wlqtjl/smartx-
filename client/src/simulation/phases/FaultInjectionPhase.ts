/**
 * 故障注入阶段（FAULT_INJECTION）—— 在扫描结果之上随机植入 1–2 个真实迁移场景中常见的故障，
 * 玩家用对应工具修复，每次结果记入 `ScoringSystem`。
 *
 * 设计要点：
 *  - **不引入 `Math.random` 到判定路径**：内置 mulberry32 PRNG，调用方可注入自定义 `rng`
 *    便于测试 / 服务端确定性回放（与本仓 MockDataGenerator 的 deterministic 风格一致）。
 *  - **不接受用户输入直接构造 setTimeout 周期** —— 整个阶段没有任何动态定时器，
 *    与 repo memory（DataSyncPhase ResourceExhaustion 防护）一致。
 *  - **纯函数式**：`inject` 和 `resolve` 都返回新对象，不修改入参；状态由外部 React 层持有。
 *  - **每个故障关联一个修复工具**：`SNAPSHOT_GUN` / `FIBER_PATCHER` / `DIAGNOSTIC_TABLET`。
 *    用错工具 = 没修复（不扣"忽略"分，但也不加分），玩家可以再选另一个；
 *    主动选择"忽略" = 触发 IGNORED_FAULT 惩罚。
 */
import type { ESXiScanResult, DiscoveredVM } from './EnvScanPhase';
import type { ToolType } from '../../fps/ToolSystem';
import type { ScoringRuleKey } from '../../engine/ScoringSystem';

export type FaultType = 'UNMERGED_SNAPSHOT' | 'MTU_MISMATCH' | 'RDMA_UNSUPPORTED';

export interface FaultDef {
  type: FaultType;
  /** 玩家可见标题 */
  title: string;
  /** 玩家可见的故障描述（带具体 VM/网络名） */
  description: string;
  /** 推荐的修复工具（其它工具会"无效" - 不计分也不惩罚） */
  requiredTool: ToolType;
  /** 玩家在游戏内看到的"用什么修"提示 */
  toolHint: string;
  /** SmartX 视角的解释——为什么这是 SmartX 的卖点 */
  smartxNarrative: string;
  /** 修复成功时累加的 ScoringRule */
  fixRule: ScoringRuleKey;
  /** 玩家选择忽略时累加的 ScoringRule（负分） */
  ignoreRule: ScoringRuleKey;
}

export interface InjectedFault {
  /** 稳定 id（注入次序），便于 React key */
  id: string;
  def: FaultDef;
  /** 触发故障的 VM 名（若有），用于在描述里替换占位符 */
  vmName?: string;
  /** 已经渲染好的、带具体上下文的描述串 */
  contextDescription: string;
}

export interface FaultResolution {
  faultId: string;
  /** 玩家选用的工具；null 表示选择了"忽略" */
  toolUsed: ToolType | null;
  /** 是否真正修复（toolUsed === requiredTool） */
  resolved: boolean;
  /** 触发的 ScoringRule（fix / ignore / 无效尝试时为 null） */
  rule: ScoringRuleKey | null;
  /** 玩家可见的反馈 */
  message: string;
}

/** 故障定义表（调用方仅消费，不应修改） */
export const FAULT_CATALOG: Readonly<Record<FaultType, FaultDef>> = {
  UNMERGED_SNAPSHOT: {
    type: 'UNMERGED_SNAPSHOT',
    title: '未合并快照',
    description: '{vm} 存在多层未合并快照链，迁移速度将下降约 40%',
    requiredTool: 'SNAPSHOT_GUN',
    toolHint: '使用 [快照枪] 在迁移前合并快照',
    smartxNarrative:
      'SmartX 的快照感知迁移：合并快照后只传"基线 + 差异"，比 vMotion 直接传整链快 40%。',
    fixRule: 'FIXED_FAULT_SNAPSHOT',
    // 复用既有 ScoringRule（与兼容性检查里的"忽略快照警告"语义完全一致）
    ignoreRule: 'IGNORED_SNAPSHOT_WARNING',
  },
  MTU_MISMATCH: {
    type: 'MTU_MISMATCH',
    title: 'MTU 不匹配',
    description: '源端 vSwitch ({network}) MTU=1500，SmartX Bridge 期望 9000，将出现大包丢失',
    requiredTool: 'FIBER_PATCHER',
    toolHint: '使用 [光纤跳线工具] 重设链路 MTU 到 9000',
    smartxNarrative:
      'SmartX Bridge 默认启用 Jumbo Frames：单包 9KB 减少协议栈开销，吞吐提升 ~2x。',
    fixRule: 'FIXED_FAULT_MTU',
    ignoreRule: 'IGNORED_FAULT_MTU',
  },
  RDMA_UNSUPPORTED: {
    type: 'RDMA_UNSUPPORTED',
    title: 'RDMA 驱动缺失',
    description: '{vm} GuestOS 未识别 RDMA 网卡，存储 I/O 将退回到 TCP',
    requiredTool: 'DIAGNOSTIC_TABLET',
    toolHint: '使用 [诊断平板] 触发 SmartX 驱动注入流程',
    smartxNarrative:
      'SmartX Boost：自动注入 RDMA/VirtIO 驱动到 GuestOS，绕过 TCP 栈，延迟降到亚毫秒。',
    fixRule: 'FIXED_FAULT_RDMA',
    ignoreRule: 'IGNORED_FAULT_RDMA',
  },
};

const ALL_TYPES: FaultType[] = Object.keys(FAULT_CATALOG) as FaultType[];

export interface InjectOptions {
  /** [0..1) 伪随机源；默认走内部 mulberry32（非密码学用途） */
  rng?: () => number;
  /** 注入数量上限，默认 2 */
  maxFaults?: number;
  /** 注入数量下限，默认 1 */
  minFaults?: number;
}

export class FaultInjectionPhase {
  /**
   * 在扫描结果上随机植入故障。
   * 选择条件：
   *   - UNMERGED_SNAPSHOT：必须存在 `snapshotExists` 的 VM
   *   - MTU_MISMATCH：必须存在网络
   *   - RDMA_UNSUPPORTED：必须存在 VM
   * 不满足条件的故障类型自动跳过。
   */
  inject(env: ESXiScanResult, opts: InjectOptions = {}): InjectedFault[] {
    const rng = opts.rng ?? defaultRng();
    const minN = Math.max(0, opts.minFaults ?? 1);
    const maxN = Math.max(minN, opts.maxFaults ?? 2);
    const targetN = minN + Math.floor(rng() * (maxN - minN + 1));

    // 候选池：每种故障类型 → 可用上下文（vm/network）
    const candidates: { def: FaultDef; vm?: DiscoveredVM; network?: string }[] = [];
    const snapshotVm = env.vms.find((v) => v.snapshotExists);
    if (snapshotVm) {
      candidates.push({ def: FAULT_CATALOG.UNMERGED_SNAPSHOT, vm: snapshotVm });
    }
    if (env.networks.length > 0) {
      candidates.push({
        def: FAULT_CATALOG.MTU_MISMATCH,
        network: env.networks[0].name,
      });
    }
    if (env.vms.length > 0) {
      // RDMA 故障关联到第一台未在快照故障里被用掉的 VM
      const target = env.vms.find((v) => v !== snapshotVm) ?? env.vms[0];
      candidates.push({ def: FAULT_CATALOG.RDMA_UNSUPPORTED, vm: target });
    }

    // 洗牌（Fisher-Yates）后取前 N
    shuffleInPlace(candidates, rng);
    const picked = candidates.slice(0, Math.min(targetN, candidates.length));

    return picked.map((c, idx) => {
      const ctx = c.def.description
        .replace('{vm}', c.vm?.name ?? '未知 VM')
        .replace('{network}', c.network ?? '未知网络');
      return {
        id: `fault-${idx}-${c.def.type}`,
        def: c.def,
        vmName: c.vm?.name,
        contextDescription: ctx,
      };
    });
  }

  /** 用工具尝试修复（toolUsed=null 表示忽略） */
  resolve(fault: InjectedFault, toolUsed: ToolType | null): FaultResolution {
    if (toolUsed === null) {
      return {
        faultId: fault.id,
        toolUsed: null,
        resolved: false,
        rule: fault.def.ignoreRule,
        message: `已忽略：${fault.def.title}`,
      };
    }
    if (toolUsed !== fault.def.requiredTool) {
      return {
        faultId: fault.id,
        toolUsed,
        resolved: false,
        rule: null,
        message: `${toolUsed} 无法修复 ${fault.def.title}，请尝试 ${fault.def.requiredTool}`,
      };
    }
    return {
      faultId: fault.id,
      toolUsed,
      resolved: true,
      rule: fault.def.fixRule,
      message: `已修复：${fault.def.title}（${fault.def.smartxNarrative}）`,
    };
  }
}

/** mulberry32：tiny seedable PRNG，非密码学用途（仅用于游戏故障池洗牌） */
function defaultRng(): () => number {
  // 用一个稳定但每次进程启动都不同的种子。`Date.now() & 0xffffffff` 已是非安全语义。
  let a = (Date.now() & 0xffffffff) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}
