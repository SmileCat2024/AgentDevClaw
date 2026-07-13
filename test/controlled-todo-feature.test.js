import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ControlledTodoFeature } from '../prebuilt-agents/official/programming-helper/controlled-todo-feature.js';

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
