# SmartX FPS Client

实现《数据中心攻坚战》FPS × SmartX 迁移架构文档（见仓库根目录 `README.md` §九实现优先级）。

## 目录

```
src/
  core/                     通用工具：EventBus、delay、凭据类型
  fps/                      FPS 控制：Player/HeadBob/Tool/Interaction/Collision
  simulation/               迁移状态机
    MigrationStateMachine.ts
    CheckpointResumeSystem.ts
    phases/
      EnvScanPhase.ts               # 阶段一：ENV_SCAN
      CompatibilityCheckPhase.ts    # 阶段二：COMPATIBILITY_CHECK
      NetworkMappingPhase.ts        # 阶段三：NETWORK_MAPPING
      StorageMappingPhase.ts        # 阶段四：STORAGE_MAPPING
      DataSyncPhase.ts              # 阶段五：FULL_SYNC / INCREMENTAL_SYNC
      DriverInjectionPhase.ts       # 阶段六：DRIVER_INJECTION
      CutoverPhase.ts               # CUTOVER_EXECUTING
      PostCheckPhase.ts             # POST_CHECK
  engine/ScoringSystem.ts   评分规则（与 SmartX 功能绑定）
  audio/DataCenterAudio.ts  音效配置 + EventBus 路由
  theme/cloudtower.theme.ts CloudTower 暗色主题令牌
  ui/UIManager.ts           UI 异步回调容器（等待玩家选择/登录）
  net/socketClient.ts       后端 socket 占位
  mock/MockDataGenerator.ts 离线 vCenter 扫描 mock
  main.ts                   入口：Three.js 场景 + FPS 输入 + 迁移剧情编排
```

## 开发

```bash
cd client
npm install
npm run dev        # 启动 Vite 开发服务器
npm run typecheck  # TypeScript 严格模式类型检查
npm run build      # 生产构建
```

## 关键约束实现位置

| 约束 (README §九) | 实现位置 |
| --- | --- |
| SmartX vs VMware 量化对比 | `simulation/phases/CutoverPhase.ts` `BeforeAfterMetrics` |
| 无代理（Agentless） | `simulation/MigrationStateMachine.ts` `MigrationTask.agentless = true` |
| 断点续传必选 | `simulation/CheckpointResumeSystem.ts` |
| 存储错误配置爆红 | `simulation/phases/StorageMappingPhase.ts` `checkStorageMismatch` |
| Cutover 帧同步音效 | `simulation/phases/CutoverPhase.ts` `CutoverDirector.executeCutover` |
