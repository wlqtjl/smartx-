import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MigrationStateMachine,
  IllegalTransitionError,
} from '../src/simulation/MigrationStateMachine.js';

test('FSM: legal happy-path transitions succeed', () => {
  const fsm = new MigrationStateMachine();
  const task = fsm.createTask('vm-1', 'vm-test', 100);
  const path = [
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
  ] as const;
  for (const s of path) {
    fsm.transition(task.id, s);
  }
  assert.equal(fsm.getTask(task.id)?.state, 'COMPLETED');
  assert.equal(task.timeline.length, path.length);
});

test('FSM: illegal transition throws', () => {
  const fsm = new MigrationStateMachine();
  const task = fsm.createTask('vm-2', 'vm-test2', 50);
  assert.throws(() => fsm.transition(task.id, 'FULL_SYNC'), IllegalTransitionError);
});

test('FSM: terminal COMPLETED has no outgoing edges', () => {
  assert.equal(MigrationStateMachine.canTransition('COMPLETED', 'IDLE'), false);
  assert.equal(MigrationStateMachine.canTransition('COMPLETED', 'ENV_SCAN'), false);
});

test('FSM: pause + resume path', () => {
  const fsm = new MigrationStateMachine();
  const task = fsm.createTask('vm-3', 'vm-test3', 100);
  fsm.transition(task.id, 'ENV_SCAN');
  fsm.transition(task.id, 'COMPATIBILITY_CHECK');
  fsm.transition(task.id, 'NETWORK_MAPPING');
  fsm.transition(task.id, 'STORAGE_MAPPING');
  fsm.transition(task.id, 'PRE_SNAPSHOT');
  fsm.transition(task.id, 'FULL_SYNC');
  fsm.transition(task.id, 'PAUSED_NETWORK_FAULT');
  fsm.transition(task.id, 'RESUMING');
  fsm.transition(task.id, 'FULL_SYNC');
  assert.equal(fsm.getTask(task.id)?.state, 'FULL_SYNC');
});
