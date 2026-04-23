/**
 * 应用容器：集中构造所有单例并暴露给 HTTP/WebSocket 路由。
 */
import { EventBus } from './core/EventBus.js';
import { sessionStore } from './core/sessions.js';
import { MigrationStateMachine } from './simulation/MigrationStateMachine.js';
import { CheckpointSystem } from './simulation/CheckpointSystem.js';
import { ScoringRegistry } from './simulation/ScoringSystem.js';
import { EnvScanPhase } from './simulation/phases/EnvScanPhase.js';
import { CompatibilityCheckPhase } from './simulation/phases/CompatibilityCheckPhase.js';
import { NetworkMappingPhase } from './simulation/phases/NetworkMappingPhase.js';
import { StorageMappingPhase } from './simulation/phases/StorageMappingPhase.js';
import { DataSyncPhase } from './simulation/phases/DataSyncPhase.js';
import { DriverInjectionPhase } from './simulation/phases/DriverInjectionPhase.js';
import { CutoverDirector } from './simulation/phases/CutoverPhase.js';
import { PostCheckPhase } from './simulation/phases/PostCheckPhase.js';
import { JsonStore } from './storage/JsonStore.js';

export interface AppContainer {
  eventBus: typeof EventBus;
  sessions: typeof sessionStore;
  fsm: MigrationStateMachine;
  checkpoints: CheckpointSystem;
  scoring: ScoringRegistry;
  envScan: EnvScanPhase;
  compat: CompatibilityCheckPhase;
  storage: JsonStore;
  driverInjection: DriverInjectionPhase;
  cutover: CutoverDirector;
  postCheck: PostCheckPhase;
  /** Per-task singletons for phases that carry state. */
  networkMappings: Map<string, NetworkMappingPhase>;
  storageMappings: Map<string, StorageMappingPhase>;
  dataSyncs: Map<string, DataSyncPhase>;
}

export const createAppContainer = (opts: { dataPath?: string } = {}): AppContainer => {
  const fsm = new MigrationStateMachine();
  const checkpoints = new CheckpointSystem();
  const scoring = new ScoringRegistry();
  const storage = new JsonStore(fsm, checkpoints, opts.dataPath);

  // 把关键状态变化与持久化挂钩
  EventBus.on('migration:stateChange', () => storage.scheduleSave());
  EventBus.on('migration:created', () => storage.scheduleSave());
  EventBus.on('checkpoint:save', () => storage.scheduleSave());

  return {
    eventBus: EventBus,
    sessions: sessionStore,
    fsm,
    checkpoints,
    scoring,
    envScan: new EnvScanPhase(),
    compat: new CompatibilityCheckPhase(),
    storage,
    driverInjection: new DriverInjectionPhase(),
    cutover: new CutoverDirector(),
    postCheck: new PostCheckPhase(),
    networkMappings: new Map(),
    storageMappings: new Map(),
    dataSyncs: new Map(),
  };
};
