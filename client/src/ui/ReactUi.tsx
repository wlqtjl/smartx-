/**
 * React UI 层：挂载到 `#ui-root`，订阅 `uiStore` 渲染所有面板 + HUD。
 * 每个面板通过 `UIManager.submit*` 解决上游 Promise。
 */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { uiStore, type UiState } from './uiStore';
import { UIManager } from './UIManager';
import { CLOUDTOWER_THEME } from '../theme/cloudtower.theme';
import type { VCenterCredential } from '../core/credential';
import type { VSwitchNode, BridgeNode, NetworkMapping } from '../simulation/phases/NetworkMappingPhase';
import { validateNetworkMapping } from '../simulation/phases/NetworkMappingPhase';
import type { StoragePool } from '../simulation/phases/StorageMappingPhase';

const C = CLOUDTOWER_THEME.colors;

// ---------------- shared style helpers ----------------
const panelBase: React.CSSProperties = {
  background: C.bg.panel,
  border: `1px solid ${C.bg.panelBorder}`,
  color: C.text.primary,
  borderRadius: 8,
  boxShadow: '0 0 24px rgba(0, 180, 255, 0.15)',
  fontFamily: CLOUDTOWER_THEME.typography.fontBody,
  padding: 20,
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(10, 14, 26, 0.65)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 20,
};

const btn = (primary = false): React.CSSProperties => ({
  background: primary ? C.accent.primary : 'transparent',
  color: primary ? '#0A0E1A' : C.accent.primary,
  border: `1px solid ${C.accent.primary}`,
  padding: '8px 16px',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: CLOUDTOWER_THEME.typography.fontDisplay,
  fontSize: 13,
  letterSpacing: 1,
});

const inputStyle: React.CSSProperties = {
  background: C.bg.secondary,
  border: `1px solid ${C.bg.panelBorder}`,
  color: C.text.primary,
  padding: '6px 10px',
  borderRadius: 4,
  fontFamily: CLOUDTOWER_THEME.typography.fontMono,
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

// ---------------- hooks ----------------
function useUiStore(): UiState {
  const [state, setState] = useState<UiState>(uiStore.snapshot);
  useEffect(() => uiStore.subscribe(setState), []);
  return state;
}

// ---------------- HUD ----------------
const zoneLabel: Record<string, string> = {
  COMMAND_POST: '指挥台',
  NETWORK_ROOM: '网络间',
  STORAGE_ROOM: '存储间',
  COLD_AISLE: '冷风道',
  HOT_AISLE: '热风道',
};

const stateLabel: Record<string, string> = {
  IDLE: '空闲',
  ENV_SCAN: '环境扫描',
  COMPATIBILITY_CHECK: '兼容性检查',
  NETWORK_MAPPING: '网络映射',
  STORAGE_MAPPING: '存储映射',
  PRE_SNAPSHOT: '快照准备',
  FULL_SYNC: '全量同步',
  INCREMENTAL_SYNC: '增量同步',
  DRIVER_INJECTION: '驱动注入',
  CUTOVER_READY: '切换就绪',
  CUTOVER_EXECUTING: '切换中',
  POST_CHECK: '切换后验证',
  COMPLETED: '完成',
  FAILED: '失败',
};

const Hud: React.FC<{ state: UiState }> = ({ state }) => {
  const { hud, score } = state;
  const syncing = hud.state === 'FULL_SYNC' || hud.state === 'INCREMENTAL_SYNC';
  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        left: 12,
        color: C.accent.primary,
        fontFamily: CLOUDTOWER_THEME.typography.fontMono,
        fontSize: 12,
        pointerEvents: 'none',
        textShadow: '0 0 6px rgba(0,180,255,0.6)',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, color: C.text.primary }}>
        SmartX FPS · {zoneLabel[hud.zone] ?? hud.zone}
      </div>
      <div>状态 {stateLabel[hud.state] ?? hud.state} · 体力 {hud.stamina.toFixed(0)}%</div>
      <div>工具 {hud.tool || '空手'} · 分数 {hud.score}</div>
      {syncing && (
        <div style={{ marginTop: 4, width: 220 }}>
          <div>同步 {hud.fullSyncPercent.toFixed(1)}% · 增量轮次 {hud.incrementalRounds}</div>
          <div style={{ background: C.bg.panelBorder, height: 4, borderRadius: 2, marginTop: 2 }}>
            <div
              style={{
                width: `${Math.min(100, hud.fullSyncPercent)}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #0066CC, #00B4FF)',
                borderRadius: 2,
              }}
            />
          </div>
        </div>
      )}
      <div style={{ marginTop: 6, color: C.text.secondary }}>目标：{hud.objective}</div>
      <div style={{ marginTop: 2, color: C.text.muted, fontSize: 11 }}>
        WSAD 移动 · 鼠标视角 · Shift 冲刺 · E 交互 · 1-6 切工具 · ESC 释放鼠标
      </div>
      {hud.hoverHint && (
        <div style={{ marginTop: 6, color: C.accent.success }}>[E] {hud.hoverHint}</div>
      )}
    </div>
  );
};

const Crosshair: React.FC = () => (
  <div
    style={{
      position: 'fixed',
      left: '50%',
      top: '50%',
      width: 8,
      height: 8,
      marginLeft: -4,
      marginTop: -4,
      borderRadius: '50%',
      border: `1px solid ${C.accent.primary}`,
      pointerEvents: 'none',
      opacity: 0.8,
    }}
  />
);

// ---------------- Login panel ----------------
const LoginPanel: React.FC<{ state: UiState }> = ({ state }) => {
  const [host, setHost] = useState(state.login.defaultHost ?? '10.0.0.1');
  const [port, setPort] = useState(443);
  const [user, setUser] = useState('administrator@vsphere.local');
  const [pw, setPw] = useState('demo');
  useEffect(() => setHost(state.login.defaultHost ?? '10.0.0.1'), [state.login.defaultHost]);
  if (!state.login.open) return null;
  const submit = (): void => {
    const cred: VCenterCredential = { host, port, username: user, password: pw };
    UIManager.submitVCenterLogin(cred);
  };
  return (
    <div style={overlayStyle}>
      <form
        style={{ ...panelBase, width: 420 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 style={{ color: C.accent.primary, margin: 0, fontFamily: CLOUDTOWER_THEME.typography.fontDisplay }}>
          连接 vCenter
        </h2>
        <p style={{ color: C.text.secondary, marginTop: 4, fontSize: 12 }}>
          提示：演示环境任意凭据均可通过，服务端不校验密码。
        </p>
        <label style={labelStyle}>主机</label>
        <input style={inputStyle} value={host} onChange={(e) => setHost(e.target.value)} />
        <label style={labelStyle}>端口</label>
        <input
          style={inputStyle}
          type="number"
          value={port}
          onChange={(e) => setPort(Number(e.target.value) || 443)}
        />
        <label style={labelStyle}>用户名</label>
        <input style={inputStyle} value={user} onChange={(e) => setUser(e.target.value)} />
        <label style={labelStyle}>密码</label>
        <input style={inputStyle} type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="submit" style={btn(true)}>
            连接并扫描
          </button>
        </div>
      </form>
    </div>
  );
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  margin: '12px 0 4px',
  color: C.text.secondary,
  fontSize: 12,
};

// ---------------- Scan progress ----------------
const ScanProgress: React.FC<{ state: UiState }> = ({ state }) => {
  if (!state.scanProgress.open) return null;
  return (
    <div style={overlayStyle}>
      <div style={{ ...panelBase, width: 320, textAlign: 'center' }}>
        <div style={{ color: C.accent.primary, fontSize: 14 }}>正在扫描 vCenter…</div>
        <div
          style={{
            marginTop: 12,
            height: 4,
            background: C.bg.panelBorder,
            borderRadius: 2,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: '40%',
              background: 'linear-gradient(90deg, #0066CC, #00B4FF)',
              animation: 'scan-shimmer 1.2s linear infinite',
            }}
          />
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: C.text.muted }}>
          枚举 ESXi 主机 / 数据存储 / 虚拟机元数据…
        </div>
      </div>
      <style>{'@keyframes scan-shimmer { 0%{transform:translateX(-50%)} 100%{transform:translateX(250%)} }'}</style>
    </div>
  );
};

// ---------------- Env result ----------------
const EnvResultPanel: React.FC<{ state: UiState }> = ({ state }) => {
  if (!state.envResult.open || !state.envResult.result) return null;
  const r = state.envResult.result;
  return (
    <div style={overlayStyle}>
      <div style={{ ...panelBase, width: 640, maxHeight: '80vh', overflow: 'auto' }}>
        <h2 style={{ color: C.accent.success, margin: 0, fontFamily: CLOUDTOWER_THEME.typography.fontDisplay }}>
          扫描完成 · vCenter {r.vCenterVersion}
        </h2>
        <div style={{ color: C.text.secondary, fontSize: 12, marginTop: 4 }}>
          用时 {(r.scanDurationMs / 1000).toFixed(1)}s
        </div>
        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Stat label="ESXi 主机" value={r.esxiHosts.length} />
          <Stat label="数据存储" value={r.datastores.length} />
          <Stat label="虚拟网络" value={r.networks.length} />
          <Stat label="发现 VM" value={r.vms.length} />
        </div>
        <h3 style={{ color: C.accent.primary, marginTop: 20 }}>VM 清单</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: C.text.secondary, textAlign: 'left' }}>
              <th style={td}>名称</th>
              <th style={td}>OS</th>
              <th style={td}>CPU</th>
              <th style={td}>内存</th>
              <th style={td}>磁盘</th>
              <th style={td}>快照</th>
            </tr>
          </thead>
          <tbody>
            {r.vms.map((v) => (
              <tr key={v.moRef}>
                <td style={td}>{v.name}</td>
                <td style={td}>{v.guestOS}</td>
                <td style={td}>{v.cpu}</td>
                <td style={td}>{v.memoryGB}GB</td>
                <td style={td}>{v.disks.length}</td>
                <td style={td}>{v.snapshotExists ? '⚠️' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button style={btn(true)} onClick={() => UIManager.acknowledgeScanResults()}>
            下一步：兼容性检查
          </button>
        </div>
      </div>
    </div>
  );
};

const td: React.CSSProperties = { padding: '4px 8px', borderBottom: `1px solid ${C.bg.panelBorder}` };

const Stat: React.FC<{ label: string; value: number | string }> = ({ label, value }) => (
  <div
    style={{
      background: C.bg.secondary,
      border: `1px solid ${C.bg.panelBorder}`,
      borderRadius: 4,
      padding: 12,
    }}
  >
    <div style={{ fontSize: 11, color: C.text.secondary }}>{label}</div>
    <div
      style={{
        fontSize: 28,
        color: C.accent.primary,
        fontFamily: CLOUDTOWER_THEME.typography.fontDisplay,
      }}
    >
      {value}
    </div>
  </div>
);

// ---------------- Compat ----------------
const CompatPanel: React.FC<{ state: UiState }> = ({ state }) => {
  if (!state.compat.open) return null;
  const hasError = state.compat.issues.some((i) => i.severity === 'error');
  return (
    <div style={overlayStyle}>
      <div style={{ ...panelBase, width: 560, maxHeight: '70vh', overflow: 'auto' }}>
        <h2 style={{ color: hasError ? C.accent.error : C.accent.success, margin: 0 }}>
          兼容性检查 {hasError ? '· 发现严重问题' : '· 全部通过'}
        </h2>
        <p style={{ color: C.text.secondary, fontSize: 12 }}>
          已检查 {state.compat.vms.length} 台 VM 的 GuestOS / 磁盘 / 网卡。
        </p>
        {state.compat.issues.length === 0 ? (
          <div style={{ color: C.accent.success }}>✓ 没有阻塞性问题，可以进入网络映射。</div>
        ) : (
          <ul style={{ paddingLeft: 18 }}>
            {state.compat.issues.map((i, idx) => (
              <li
                key={idx}
                style={{ color: i.severity === 'error' ? C.accent.error : C.accent.warning }}
              >
                [{i.vmName}] {i.message}
              </li>
            ))}
          </ul>
        )}
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button style={btn(true)} onClick={() => UIManager.acknowledgeCompatibility()}>
            接受并继续
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------- Network Mapping ----------------
const NetworkPanel: React.FC<{ state: UiState }> = ({ state }) => {
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [localCompleted, setLocalCompleted] = useState<NetworkMapping[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.network.open) {
      setLocalCompleted([]);
      setSelectedSource(null);
      setError(null);
    }
  }, [state.network.open]);

  if (!state.network.open) return null;

  const mappedSourceNames = new Set(localCompleted.map((m) => m.sourceVSwitch));
  const mappedTargetNames = new Set(localCompleted.map((m) => m.targetBridgeName));

  const tryMap = (source: VSwitchNode, target: BridgeNode): void => {
    const validation = validateNetworkMapping(source, target, localCompleted);
    if (!validation.valid) {
      setError(validation.error ?? 'invalid');
      return;
    }
    const next: NetworkMapping = {
      sourceVSwitch: source.name,
      sourcePortGroup: source.portGroups[0] ?? 'default',
      targetBridgeType: target.type,
      targetBridgeName: target.name,
      vlanId: source.vlanIds[0] ?? null,
      validated: true,
    };
    const updated = [...localCompleted, next];
    setLocalCompleted(updated);
    UIManager.updateNetworkMappingState(updated);
    setSelectedSource(null);
    setError(validation.warning ?? null);
  };

  const allMapped = state.network.sources.every((s) => mappedSourceNames.has(s.name));

  return (
    <div style={overlayStyle}>
      <div style={{ ...panelBase, width: 720 }}>
        <h2 style={{ color: C.accent.primary, margin: 0 }}>网络映射</h2>
        <p style={{ color: C.text.secondary, fontSize: 12 }}>
          选中左侧 vSwitch，再点击右侧 Bridge 建立连接。每个 vSwitch 必须连接一个 Bridge。
        </p>
        <div style={{ display: 'flex', gap: 24, marginTop: 12 }}>
          <div style={{ flex: 1 }}>
            <h3 style={{ color: C.accent.vmware, fontSize: 13 }}>源 vSwitch</h3>
            {state.network.sources.map((s) => {
              const done = mappedSourceNames.has(s.name);
              const selected = selectedSource === s.id;
              return (
                <div
                  key={s.id}
                  onClick={() => !done && setSelectedSource(s.id)}
                  style={{
                    ...cardStyle,
                    borderColor: done
                      ? C.accent.success
                      : selected
                        ? C.accent.primary
                        : C.bg.panelBorder,
                    opacity: done ? 0.6 : 1,
                    cursor: done ? 'default' : 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{s.name}</div>
                  <div style={{ fontSize: 11, color: C.text.muted }}>
                    {s.portGroups.join(',')} · VLAN {s.vlanIds.join(',') || '—'}
                  </div>
                  {done && <div style={{ fontSize: 11, color: C.accent.success }}>✓ 已映射</div>}
                </div>
              );
            })}
          </div>
          <div style={{ flex: 1 }}>
            <h3 style={{ color: C.accent.smartx, fontSize: 13 }}>目标 SmartX Bridge</h3>
            {state.network.targets.map((t) => {
              const done = mappedTargetNames.has(t.name);
              return (
                <div
                  key={t.id}
                  onClick={() => {
                    if (done || !selectedSource) return;
                    const src = state.network.sources.find((s) => s.id === selectedSource);
                    if (src) tryMap(src, t);
                  }}
                  style={{
                    ...cardStyle,
                    borderColor: done ? C.accent.success : C.bg.panelBorder,
                    opacity: done ? 0.6 : 1,
                    cursor: done || !selectedSource ? 'default' : 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: C.text.muted }}>
                    {t.type} · {t.availableBandwidthGbps} Gbps
                  </div>
                  {done && <div style={{ fontSize: 11, color: C.accent.success }}>✓ 已接入</div>}
                </div>
              );
            })}
          </div>
        </div>
        {error && (
          <div style={{ marginTop: 12, color: C.accent.error, fontSize: 12 }}>{error}</div>
        )}
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 12, color: C.text.secondary }}>
            已完成 {localCompleted.length} / {state.network.sources.length}
          </div>
          <button
            style={btn(allMapped)}
            disabled={!allMapped}
            onClick={() => allMapped && UIManager.submitNetworkMapping({ mappings: localCompleted })}
          >
            提交映射
          </button>
        </div>
      </div>
    </div>
  );
};

const cardStyle: React.CSSProperties = {
  background: C.bg.secondary,
  border: `1px solid ${C.bg.panelBorder}`,
  borderRadius: 6,
  padding: 10,
  marginBottom: 8,
};

// ---------------- Storage Mapping ----------------
const StoragePanelView: React.FC<{ state: UiState }> = ({ state }) => {
  const [selectedPool, setSelectedPool] = useState<string | null>(null);
  const [ioLocality, setIoLocality] = useState(true);
  const [rdma, setRdma] = useState(true);

  useEffect(() => {
    if (state.storage.open) {
      setSelectedPool(null);
      setIoLocality(true);
      setRdma(true);
    }
  }, [state.storage.open]);

  if (!state.storage.open || !state.storage.vm) return null;
  const vm = state.storage.vm;
  const pool = state.storage.pools.find((p) => p.id === selectedPool) ?? null;

  const submit = (): void => {
    if (!selectedPool) return;
    UIManager.submitStorageMapping({
      poolId: selectedPool,
      ioLocality: ioLocality && (pool?.ioLocalitySupport ?? false),
      rdma: rdma && (pool?.rdmaSupport ?? false),
    });
  };

  return (
    <div style={overlayStyle}>
      <div style={{ ...panelBase, width: 680 }}>
        <h2 style={{ color: C.accent.primary, margin: 0 }}>存储映射 · {vm.name}</h2>
        <p style={{ color: C.text.secondary, fontSize: 12 }}>
          工作负载：<b>{vm.workloadType}</b> · 磁盘 {vm.disks.length} · 请选择目标 SmartX 存储池。
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 12 }}>
          {state.storage.pools.map((p: StoragePool) => {
            const selected = selectedPool === p.id;
            return (
              <div
                key={p.id}
                onClick={() => setSelectedPool(p.id)}
                style={{
                  ...cardStyle,
                  borderColor: selected ? C.accent.primary : C.bg.panelBorder,
                  cursor: 'pointer',
                }}
              >
                <div style={{ color: p.color, fontWeight: 600 }}>
                  {p.name} · {p.tier.toUpperCase()}
                </div>
                <div style={{ fontSize: 11, color: C.text.muted }}>
                  {p.availableTB}/{p.totalTB} TB · {p.maxIOPS.toLocaleString()} IOPS · {p.avgLatencyMs}ms
                </div>
                <div style={{ fontSize: 11, color: C.text.secondary, marginTop: 4 }}>
                  I/O 本地化 {p.ioLocalitySupport ? '✓' : '✗'} · RDMA {p.rdmaSupport ? '✓' : '✗'}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 16 }}>
          <label style={{ color: C.text.secondary, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={ioLocality}
              disabled={!pool?.ioLocalitySupport}
              onChange={(e) => setIoLocality(e.target.checked)}
            />{' '}
            启用 I/O 本地化
          </label>
          <label style={{ color: C.text.secondary, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={rdma}
              disabled={!pool?.rdmaSupport}
              onChange={(e) => setRdma(e.target.checked)}
            />{' '}
            启用 RDMA
          </label>
        </div>
        {state.storage.warning && (
          <div
            style={{
              marginTop: 12,
              padding: 10,
              border: `1px solid ${C.accent.error}`,
              background: 'rgba(255,23,68,0.08)',
              color: C.accent.error,
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            {state.storage.warning.message}
            <div style={{ color: C.text.secondary, marginTop: 4 }}>
              建议：{state.storage.warning.suggestedAction}
            </div>
          </div>
        )}
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button style={btn(!!selectedPool)} disabled={!selectedPool} onClick={submit}>
            确认分配
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------- Sync Challenge ----------------
const ChallengeModal: React.FC<{ state: UiState }> = ({ state }) => {
  const c = state.challenge.challenge;
  if (!state.challenge.open || !c) return null;
  return (
    <div style={overlayStyle}>
      <div style={{ ...panelBase, width: 520, borderColor: C.accent.warning }}>
        <h2 style={{ color: C.accent.warning, margin: 0 }}>⚠️ 挑战事件 · {c.type}</h2>
        <p style={{ fontSize: 13 }}>{c.description}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {c.responses.map((r) => (
            <button
              key={r.id}
              style={{
                ...btn(r.isSmartXWay),
                textAlign: 'left',
                borderColor: r.isSmartXWay ? C.accent.smartx : C.bg.panelBorder,
                color: r.isSmartXWay ? '#0A0E1A' : C.text.primary,
                background: r.isSmartXWay ? C.accent.smartx : 'transparent',
                padding: '10px 14px',
              }}
              onClick={() => UIManager.submitChallengeResponse(r)}
            >
              <div style={{ fontWeight: 600 }}>
                {r.isSmartXWay ? '★ ' : ''}
                {r.label}
              </div>
              <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{r.effect}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

// ---------------- Fault Injection panel ----------------
const FaultPanelView: React.FC<{ state: UiState }> = ({ state }) => {
  if (!state.fault.open) return null;
  const { faults, resolutions } = state.fault;

  const onPick = (faultId: string, action: 'use' | 'ignore'): void => {
    const fault = faults.find((f) => f.id === faultId);
    if (!fault) return;
    // 当前面板只提供"使用 [requiredTool] 修复"和"忽略"两个按钮，
    // 因此 action='use' 等价于用了正确工具。这里仍按真实判定写入 `resolved`，
    // 防止未来扩展为"选择任意工具"时这块预览失真。
    const toolUsed = action === 'use' ? fault.def.requiredTool : null;
    const resolved = toolUsed === fault.def.requiredTool;
    UIManager.recordFaultResolution({
      faultId,
      toolUsed,
      resolved,
      rule: resolved ? fault.def.fixRule : fault.def.ignoreRule,
      message: resolved ? `已修复：${fault.def.title}` : `已忽略：${fault.def.title}`,
    });
  };

  // 计算"全部决策完毕"
  const allDone =
    faults.length > 0 && faults.every((f) => resolutions.some((r) => r.faultId === f.id));

  // 把 UI 累积的 resolution 反推成 choice 列表交给上游 promise
  const submit = (): void => {
    const choices = resolutions.map((r) => ({
      faultId: r.faultId,
      action: (r.toolUsed === null ? 'ignore' : 'use') as 'use' | 'ignore',
    }));
    UIManager.submitFaultChoices(choices);
  };

  return (
    <div style={overlayStyle}>
      <div style={{ ...panelBase, width: 600, maxHeight: '80vh', overflowY: 'auto' }}>
        <h2 style={{ color: C.accent.warning, margin: 0 }}>
          ⚠️ 故障注入 · 扫描期检测到 {faults.length} 个问题
        </h2>
        <p style={{ color: C.text.secondary, fontSize: 12, marginTop: 4 }}>
          每条故障可用专用工具修复（加分），也可以选择忽略（扣分，但不阻塞迁移）。
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          {faults.map((f) => {
            const decided = resolutions.find((r) => r.faultId === f.id);
            const fixed = decided?.resolved === true;
            const ignored = decided !== undefined && decided.toolUsed === null;
            return (
              <div
                key={f.id}
                style={{
                  border: `1px solid ${
                    fixed ? C.accent.success : ignored ? C.accent.error : C.bg.panelBorder
                  }`,
                  borderRadius: 4,
                  padding: 12,
                  background: C.bg.secondary,
                }}
              >
                <div style={{ fontWeight: 600, color: C.text.primary }}>
                  {fixed ? '✓ ' : ignored ? '✗ ' : ''}
                  {f.def.title}
                </div>
                <div style={{ fontSize: 12, color: C.text.secondary, marginTop: 4 }}>
                  {f.contextDescription}
                </div>
                <div style={{ fontSize: 11, color: C.accent.smartx, marginTop: 6 }}>
                  {f.def.toolHint}
                </div>
                <div style={{ fontSize: 11, color: C.text.muted, marginTop: 2, fontStyle: 'italic' }}>
                  {f.def.smartxNarrative}
                </div>
                {!decided && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <button style={btn(true)} onClick={() => onPick(f.id, 'use')}>
                      使用 {f.def.requiredTool} 修复
                    </button>
                    <button style={btn(false)} onClick={() => onPick(f.id, 'ignore')}>
                      忽略
                    </button>
                  </div>
                )}
                {decided && (
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      color: fixed ? C.accent.success : C.accent.error,
                    }}
                  >
                    {decided.message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button style={btn(allDone)} disabled={!allDone} onClick={submit}>
            提交决议 →
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------- Score summary ----------------
const ScorePanel: React.FC<{ state: UiState }> = ({ state }) => {
  if (!state.score.open || !state.score.breakdown) return null;
  const b = state.score.breakdown;
  return (
    <div style={overlayStyle}>
      <div style={{ ...panelBase, width: 520 }}>
        <h2 style={{ color: C.accent.success, margin: 0 }}>迁移完成 · 总分 {b.total}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
          <Stat label="速度" value={b.categories.speed} />
          <Stat label="正确性" value={b.categories.correctness} />
          <Stat label="业务连续性" value={b.categories.businessContinuity} />
          <Stat label="SmartX 特性" value={b.categories.smartxFeatureUsage} />
        </div>
        {b.bonuses.length > 0 && (
          <>
            <h3 style={{ color: C.accent.success, marginTop: 16 }}>加分</h3>
            <ul style={{ paddingLeft: 18, fontSize: 12 }}>
              {b.bonuses.map((x, i) => (
                <li key={i}>
                  +{x.points} · {x.reason}
                </li>
              ))}
            </ul>
          </>
        )}
        {b.penalties.length > 0 && (
          <>
            <h3 style={{ color: C.accent.error, marginTop: 8 }}>扣分</h3>
            <ul style={{ paddingLeft: 18, fontSize: 12 }}>
              {b.penalties.map((x, i) => (
                <li key={i}>
                  {x.points} · {x.reason}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
};

// ---------------- Toasts ----------------
const Toasts: React.FC<{ state: UiState }> = ({ state }) => (
  <div style={{ position: 'fixed', top: 12, right: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
    {state.toast.map((t) => (
      <div
        key={t.id}
        style={{
          ...panelBase,
          padding: '6px 12px',
          borderColor:
            t.level === 'error' ? C.accent.error : t.level === 'warn' ? C.accent.warning : C.accent.primary,
          fontSize: 12,
        }}
      >
        {t.text}
      </div>
    ))}
  </div>
);

// ---------------- Root ----------------
const App: React.FC = () => {
  const state = useUiStore();
  return (
    <>
      <Hud state={state} />
      <Crosshair />
      <Toasts state={state} />
      <LoginPanel state={state} />
      <ScanProgress state={state} />
      <EnvResultPanel state={state} />
      <CompatPanel state={state} />
      <NetworkPanel state={state} />
      <StoragePanelView state={state} />
      <ChallengeModal state={state} />
      <FaultPanelView state={state} />
      <ScorePanel state={state} />
    </>
  );
};

export function mountReactUi(target: HTMLElement): void {
  const root = createRoot(target);
  root.render(<App />);
}
