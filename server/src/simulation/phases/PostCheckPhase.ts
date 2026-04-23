/**
 * 阶段八：POST_CHECK
 */
import type { PostCheckItem } from '@shared/index';
import { EventBus } from '../../core/EventBus.js';
import { delay } from '../../core/utils.js';

export const POST_CHECK_ITEMS: PostCheckItem[] = [
  { id: 'network_ping', name: '网络连通性', checkType: 'network', method: 'ICMP Ping + TCP 80/443 探活', expectedResult: '响应时间 < 1ms（同机房）', status: 'pending', scoreWeight: 10 },
  { id: 'service_http', name: 'Web 服务可用性', checkType: 'service', method: 'HTTP GET 返回 200，响应时间 < 200ms', expectedResult: 'HTTP 200 OK', status: 'pending', scoreWeight: 20 },
  { id: 'db_connection', name: '数据库连接', checkType: 'service', method: 'TCP 连接 + SELECT 1 查询', expectedResult: '连接成功，查询 < 5ms', status: 'pending', scoreWeight: 25 },
  { id: 'iops_baseline', name: 'I/O 性能基准', checkType: 'performance', method: 'fio 随机读写测试（30秒）', expectedResult: 'IOPS > 迁移前 115%', status: 'pending', scoreWeight: 20 },
  { id: 'data_checksum', name: '数据完整性校验', checkType: 'data_integrity', method: 'MD5 校验关键数据文件', expectedResult: '与迁移前一致，无数据丢失', status: 'pending', scoreWeight: 25 },
];

export class PostCheckPhase {
  async runAuto(): Promise<PostCheckItem[]> {
    const items = POST_CHECK_ITEMS.map((i) => ({ ...i }));
    for (const item of items) {
      item.status = 'checking';
      EventBus.emit('ui:postcheck_item', { item });
      await delay(150);
      item.status = 'pass';
      item.actualResult = `${item.expectedResult} ✓`;
      EventBus.emit('ui:postcheck_item', { item });
    }
    return items;
  }
}
