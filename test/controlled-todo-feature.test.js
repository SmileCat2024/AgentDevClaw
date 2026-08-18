import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ControlledTodoFeature } from '../local-features/dist/feature-wrappers/src/index.js';

describe('ControlledTodoFeature terminal timestamps', () => {
  it('records a stable completion timestamp', () => {
    const feature = new ControlledTodoFeature();
    const task = feature.createTask('运行测试', '执行测试', '正在运行测试');
    const completed = feature.updateTask(task.id, { status: 'completed' });
    assert.ok(completed.metadata.finishedAt > 0);
    assert.equal(completed.metadata.completedAt, completed.metadata.finishedAt);

    const finishedAt = completed.metadata.finishedAt;
    const edited = feature.updateTask(task.id, { subject: '运行完整测试' });
    assert.equal(edited.metadata.finishedAt, finishedAt);
  });

  it('records cancellation time when clearing active Tasks', () => {
    const feature = new ControlledTodoFeature();
    const task = feature.createTask('编写文档', '编写文档', '正在编写文档');
    feature.clearTasks();
    const cancelled = feature.getTask(task.id);
    assert.equal(cancelled.status, 'deleted');
    assert.ok(cancelled.metadata.cancelledAt > 0);
    assert.equal(cancelled.metadata.finishedAt, cancelled.metadata.cancelledAt);
  });

  it('clears terminal timestamps when a Task is reopened', () => {
    const feature = new ControlledTodoFeature();
    const task = feature.createTask('修复问题', '修复问题', '正在修复问题');
    feature.updateTask(task.id, { status: 'completed' });
    const reopened = feature.updateTask(task.id, { status: 'in_progress' });
    assert.equal(reopened.metadata.finishedAt, undefined);
    assert.equal(reopened.metadata.completedAt, undefined);
  });
});

describe('ControlledTodoFeature interrupt target on restore (zombie breakpoint fix)', () => {
  it('clears interrupt target when target task is already completed', () => {
    const feature = new ControlledTodoFeature();
    const task1 = feature.createTask('任务一', '描述', '正在执行');
    const task2 = feature.createTask('任务二', '描述', '正在执行');
    feature.updateTask(task2.id, { status: 'completed' });

    // 模拟 captureState 快照：interruptTargetId 指向已完成的 task2
    const snapshot = {
      ...feature.captureState(),
      interruptTargetId: task2.id,
    };

    // 新实例模拟 restoreState
    const restored = new ControlledTodoFeature();
    restored.restoreState(snapshot);

    assert.equal(restored.getInterruptTarget(), null,
      'interruptTargetId should be null because task2 is already completed');
  });

  it('clears interrupt target when target task is already deleted', () => {
    const feature = new ControlledTodoFeature();
    const task = feature.createTask('任务', '描述', '正在执行');
    feature.updateTask(task.id, { status: 'deleted' });

    const snapshot = {
      ...feature.captureState(),
      interruptTargetId: task.id,
    };

    const restored = new ControlledTodoFeature();
    restored.restoreState(snapshot);

    assert.equal(restored.getInterruptTarget(), null,
      'interruptTargetId should be null because task is already deleted');
  });

  it('clears interrupt target when target task does not exist in restored tasks', () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('任务一', '描述', '正在执行');

    // interruptTargetId 指向一个在 task 列表中不存在的 ID
    const snapshot = {
      ...feature.captureState(),
      interruptTargetId: '999',
    };

    const restored = new ControlledTodoFeature();
    restored.restoreState(snapshot);

    assert.equal(restored.getInterruptTarget(), null,
      'interruptTargetId should be null because task 999 does not exist');
  });

  it('preserves interrupt target when target task is still pending', () => {
    const feature = new ControlledTodoFeature();
    const task1 = feature.createTask('任务一', '描述', '正在执行');
    const task2 = feature.createTask('任务二', '描述', '正在执行');

    const snapshot = {
      ...feature.captureState(),
      interruptTargetId: task2.id,
    };

    const restored = new ControlledTodoFeature();
    restored.restoreState(snapshot);

    assert.equal(restored.getInterruptTarget(), task2.id,
      'interruptTargetId should be preserved because task2 is still pending');
  });

  it('preserves interrupt target when target task is in_progress', () => {
    const feature = new ControlledTodoFeature();
    const task = feature.createTask('进行中任务', '描述', '正在执行');
    feature.updateTask(task.id, { status: 'in_progress' });

    const snapshot = {
      ...feature.captureState(),
      interruptTargetId: task.id,
    };

    const restored = new ControlledTodoFeature();
    restored.restoreState(snapshot);

    assert.equal(restored.getInterruptTarget(), task.id,
      'interruptTargetId should be preserved because task is in_progress');
  });
});
