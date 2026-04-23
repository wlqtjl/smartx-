/**
 * 阶段一：ENV_SCAN —— 源端环境扫描。
 * 服务端权威版：接受凭据并返回 mock 环境数据；可被真实 vCenter SDK 替换。
 */
import type { ESXiScanResult, VCenterCredential } from '@shared/index';
import { EventBus } from '../../core/EventBus.js';
import { delay } from '../../core/utils.js';
import { generateESXiEnvironment } from '../MockData.js';

const SCAN_BASE_MS = 1500;
const SCAN_JITTER_MS = 1500;

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export const validateCredential = (c: VCenterCredential): string | null => {
  if (!c || typeof c !== 'object') return 'credential missing';
  if (!isNonEmptyString(c.host)) return 'host required';
  if (!Number.isInteger(c.port) || c.port <= 0 || c.port > 65535) return 'invalid port';
  if (!isNonEmptyString(c.username)) return 'username required';
  if (!isNonEmptyString(c.password)) return 'password required';
  return null;
};

export class EnvScanPhase {
  async execute(credential: VCenterCredential): Promise<ESXiScanResult> {
    const err = validateCredential(credential);
    if (err) throw new Error(err);

    EventBus.emit('fx:rack_lights_scanning', { color: '#00AAFF', pattern: 'blink' });
    const start = Date.now();
    await delay(SCAN_BASE_MS + Math.floor(Math.random() * SCAN_JITTER_MS));
    const env = await generateESXiEnvironment();
    const result = { ...env, scanDurationMs: Date.now() - start };
    EventBus.emit('ui:show_scan_results', result);
    return result;
  }
}
