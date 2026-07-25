/**
 * Round-trip 测试：验证前端 normalizeTodoPlan（public/src/modules/todo-plan.js）
 * 在重建 TodoPlanSnapshot 对象时不丢弃字段。
 *
 * 背景：框架侧 viewer-worker 的 normalizeTodoPlan 曾因手动重建对象而丢弃
 * interruptTargetId。前端侧也有一份同名的逐字段重建函数，存在同样的风险。
 * 此测试确保含 interruptTargetId 在内的所有字段穿过 normalize 后完整保留。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function createTodoSandbox() {
  const ctx = createFrontendSandbox();
  // todo-plan.js 依赖 app-core.js 中定义的全局变量和函数（featurePanelBody、
  // getRuntimeContextKey、getInterruptTargetId 等）
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/todo-plan.js');
  return ctx;
}

function buildFullPlan() {
  return {
    feature: 'todo',
    updatedAt: 1700000000000,
    counter: 3,
    tasks: [
      {
        id: 'task-1',
        subject: '已完成任务',
        description: '描述一',
        activeForm: '正在完成任务一',
        status: 'completed',
        owner: 'agent-A',
        blocks: ['task-2'],
        blockedBy: [],
        metadata: { finishedAt: 1700000001000 },
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
      },
      {
        id: 'task-2',
        subject: '进行中任务',
        description: '描述二',
        activeForm: '正在执行任务二',
        status: 'in_progress',
        owner: '',
        blocks: [],
        blockedBy: ['task-1'],
        metadata: {},
        createdAt: 1700000002000,
        updatedAt: 1700000002000,
      },
    ],
    summary: {
      total: 2,
      pending: 0,
      inProgress: 1,
      completed: 1,
      cancelled: 0,
      blocked: 0,
    },
    interruptTargetId: 'task-2',
  };
}

describe('frontend normalizeTodoPlan round-trip', () => {
  it('preserves interruptTargetId through normalize', () => {
    const ctx = createTodoSandbox();
    ctx.run(`globalThis.__testInput = ${JSON.stringify(buildFullPlan())}`);
    const output = ctx.run('normalizeTodoPlan(globalThis.__testInput)');

    // 这是框架侧曾丢弃的字段，前端侧必须保留
    assert.equal(output.interruptTargetId, 'task-2');
  });

  it('preserves all task fields through normalize', () => {
    const ctx = createTodoSandbox();
    ctx.run(`globalThis.__testInput = ${JSON.stringify(buildFullPlan())}`);
    const output = ctx.run('normalizeTodoPlan(globalThis.__testInput)');

    assert.equal(output.tasks.length, 2);

    const task1 = output.tasks[0];
    assert.equal(task1.id, 'task-1');
    assert.equal(task1.status, 'completed');
    assert.equal(task1.owner, 'agent-A');
    assert.deepEqual(task1.blocks, ['task-2']);
    assert.deepEqual(task1.metadata, { finishedAt: 1700000001000 });
    assert.equal(task1.activeForm, '正在完成任务一');

    const task2 = output.tasks[1];
    assert.equal(task2.status, 'in_progress');
    assert.deepEqual(task2.blockedBy, ['task-1']);
  });

  it('preserves summary fields through normalize', () => {
    const ctx = createTodoSandbox();
    ctx.run(`globalThis.__testInput = ${JSON.stringify(buildFullPlan())}`);
    const output = ctx.run('normalizeTodoPlan(globalThis.__testInput)');

    assert.equal(output.summary.total, 2);
    assert.equal(output.summary.inProgress, 1);
    assert.equal(output.summary.completed, 1);
    assert.equal(output.summary.cancelled, 0);
    assert.equal(output.summary.blocked, 0);
  });

  it('returns null interruptTargetId when input lacks it', () => {
    const ctx = createTodoSandbox();
    const plan = buildFullPlan();
    delete plan.interruptTargetId;
    ctx.run(`globalThis.__testInput = ${JSON.stringify(plan)}`);
    const output = ctx.run('normalizeTodoPlan(globalThis.__testInput)');

    assert.equal(output.interruptTargetId, null);
  });

  it('round-trip stability: normalize(normalize(x)) deep-equals normalize(x)', () => {
    const ctx = createTodoSandbox();
    ctx.run(`globalThis.__testInput = ${JSON.stringify(buildFullPlan())}`);
    const once = ctx.run('normalizeTodoPlan(globalThis.__testInput)');
    ctx.run(`globalThis.__once = ${JSON.stringify(once)}`);
    const twice = ctx.run('normalizeTodoPlan(globalThis.__once)');

    // 幂等性：二次 normalize 不应改变结果（所有字段稳定）
    assert.deepEqual(twice, once);
  });
});
