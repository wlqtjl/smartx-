import { describe, expect, it } from 'vitest';
import { MigrationStateMachine, type MigrationState } from './MigrationStateMachine';

describe('MigrationStateMachine (client mirror)', () => {
  it('creates a task in IDLE state with sane defaults', () => {
    const fsm = new MigrationStateMachine();
    const task = fsm.createTask('vm-1', 'VM-1', 120);
    expect(task.state).toBe('IDLE');
    expect(task.progress.dataTotalGB).toBe(120);
    expect(task.progress.fullSyncPercent).toBe(0);
    expect(task.timeline).toEqual([]);
    expect(task.agentless).toBe(true);
  });

  it('accepts the legal IDLE → ENV_SCAN transition and records timeline', () => {
    const fsm = new MigrationStateMachine();
    const task = fsm.createTask('vm-1', 'VM-1', 10);
    fsm.transition(task.id, 'ENV_SCAN');
    expect(task.state).toBe('ENV_SCAN');
    expect(task.timeline).toHaveLength(1);
    expect(task.timeline[0]).toMatchObject({ fromState: 'IDLE', toState: 'ENV_SCAN' });
  });

  it('rejects an illegal transition', () => {
    const fsm = new MigrationStateMachine();
    const task = fsm.createTask('vm-1', 'VM-1', 10);
    expect(() => fsm.transition(task.id, 'FULL_SYNC')).toThrowError(/非法状态转换/);
  });

  it('walks the full happy-path from IDLE to COMPLETED', () => {
    const fsm = new MigrationStateMachine();
    const task = fsm.createTask('vm-1', 'VM-1', 10);
    const path: MigrationState[] = [
      'ENV_SCAN',
      'COMPATIBILITY_CHECK',
      'NETWORK_MAPPING',
      'STORAGE_MAPPING',
      'PRE_SNAPSHOT',
      'FULL_SYNC',
      'INCREMENTAL_SYNC',
      'DRIVER_INJECTION',
      'CUTOVER_READY',
      'CUTOVER_EXECUTING',
      'POST_CHECK',
      'COMPLETED',
    ];
    for (const s of path) fsm.transition(task.id, s);
    expect(task.state).toBe('COMPLETED');
    expect(task.timeline).toHaveLength(path.length);
  });

  it('supports the network-fault pause/resume branch', () => {
    const fsm = new MigrationStateMachine();
    const task = fsm.createTask('vm-1', 'VM-1', 10);
    fsm.transition(task.id, 'ENV_SCAN');
    fsm.transition(task.id, 'COMPATIBILITY_CHECK');
    fsm.transition(task.id, 'NETWORK_MAPPING');
    fsm.transition(task.id, 'STORAGE_MAPPING');
    fsm.transition(task.id, 'PRE_SNAPSHOT');
    fsm.transition(task.id, 'FULL_SYNC');
    fsm.transition(task.id, 'PAUSED_NETWORK_FAULT');
    fsm.transition(task.id, 'RESUMING');
    fsm.transition(task.id, 'FULL_SYNC');
    expect(task.state).toBe('FULL_SYNC');
  });

  it('throws TaskNotFound-equivalent error for unknown task ids', () => {
    const fsm = new MigrationStateMachine();
    expect(() => fsm.transition('unknown', 'ENV_SCAN')).toThrowError(/未知任务/);
  });

  it('canTransition matches the transition table', () => {
    const fsm = new MigrationStateMachine();
    expect(fsm.canTransition('IDLE', 'ENV_SCAN')).toBe(true);
    expect(fsm.canTransition('IDLE', 'COMPLETED')).toBe(false);
    expect(fsm.canTransition('FULL_SYNC', 'PAUSED_NETWORK_FAULT')).toBe(true);
    expect(fsm.canTransition('COMPLETED', 'ENV_SCAN')).toBe(false);
  });

  it('records errors without mutating state', () => {
    const fsm = new MigrationStateMachine();
    const task = fsm.createTask('vm-1', 'VM-1', 10);
    fsm.recordError(task.id, 'E_NET', 'network jitter');
    expect(task.errors).toHaveLength(1);
    expect(task.errors[0]).toMatchObject({ code: 'E_NET', message: 'network jitter' });
    expect(task.state).toBe('IDLE');
  });
});
