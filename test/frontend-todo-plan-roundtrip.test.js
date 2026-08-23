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
  // t()/I18N 已拆分至 i18n.js（ticket 021），须先于 app-core.js 加载（与 index.html 一致）
  ctx.loadSource('public/src/i18n.js');
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
        status: 'completed',
        metadata: { finishedAt: 1700000001000 },
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
      },
      {
        id: 'task-2',
        subject: '进行中任务',
        description: '描述二',
        status: 'in_progress',
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
    assert.deepEqual(task1.metadata, { finishedAt: 1700000001000 });

    const task2 = output.tasks[1];
    assert.equal(task2.status, 'in_progress');
  });

  it('preserves summary fields through normalize', () => {
    const ctx = createTodoSandbox();
    ctx.run(`globalThis.__testInput = ${JSON.stringify(buildFullPlan())}`);
    const output = ctx.run('normalizeTodoPlan(globalThis.__testInput)');

    assert.equal(output.summary.total, 2);
    assert.equal(output.summary.inProgress, 1);
    assert.equal(output.summary.completed, 1);
    assert.equal(output.summary.cancelled, 0);
  });

  it('strips old schema fields (activeForm/owner/blocks/blockedBy) during normalize', () => {
    const ctx = createTodoSandbox();
    // Feed plan with old fields
    const oldPlan = {
      feature: 'todo',
      updatedAt: 1700000000000,
      counter: 1,
      tasks: [{
        id: 'task-old',
        subject: 'Old',
        description: 'desc',
        activeForm: 'Doing old',
        status: 'pending',
        owner: 'agent-A',
        blocks: ['task-2'],
        blockedBy: ['task-3'],
        metadata: {},
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      }],
      summary: { total: 1, pending: 1, inProgress: 0, completed: 0, cancelled: 0 },
    };
    ctx.run(`globalThis.__testInput = ${JSON.stringify(oldPlan)}`);
    const output = ctx.run('normalizeTodoPlan(globalThis.__testInput)');

    const task = output.tasks[0];
    assert.equal(task.id, 'task-old');
    assert.equal(task.subject, 'Old');
    // Old fields should be gone
    assert.equal(task.activeForm, undefined);
    assert.equal(task.owner, undefined);
    assert.equal(task.blocks, undefined);
    assert.equal(task.blockedBy, undefined);
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

describe('frontend renderPlanTaskList fold logic', () => {
  function mkTask(id, status, desc = '') {
    return { id, subject: 'T' + id, description: desc, status, metadata: {}, createdAt: 0, updatedAt: 0 };
  }

  it('folds a long head terminal run and keeps the tail visible', () => {
    const ctx = createTodoSandbox();
    const tasks = [
      mkTask('1', 'completed'), mkTask('2', 'completed'), mkTask('3', 'completed'),
      mkTask('4', 'completed'), mkTask('5', 'completed'), mkTask('6', 'completed'),
      mkTask('7', 'completed'),
      mkTask('8', 'in_progress'),
    ];
    const html = ctx.run(`renderPlanTaskList(${JSON.stringify(tasks)})`);

    // 段首折叠按钮（隐藏 7 - 4 = 3 个），头部 3 个不渲染，段尾 4 个保留
    assert.ok(html.includes('data-plan-toggle-run="0"'));
    assert.ok(!html.includes('>T1<'));
    assert.ok(!html.includes('>T2<'));
    assert.ok(!html.includes('>T3<'));
    assert.ok(html.includes('T4') && html.includes('T7'));
    // 非终态任务正常渲染
    assert.ok(html.includes('T8'));
  });

  it('folds terminal runs in the middle of the list, not only at the head', () => {
    const ctx = createTodoSandbox();
    const tasks = [
      mkTask('1', 'in_progress'),
      mkTask('2', 'completed'), mkTask('3', 'completed'), mkTask('4', 'completed'),
      mkTask('5', 'completed'), mkTask('6', 'completed'), mkTask('7', 'completed'),
      mkTask('8', 'pending'),
    ];
    const html = ctx.run(`renderPlanTaskList(${JSON.stringify(tasks)})`);

    assert.ok(html.includes('data-plan-toggle-run="1"'));
    assert.ok(!html.includes('>T2<'));
    assert.ok(!html.includes('>T3<'));
    assert.ok(html.includes('T4') && html.includes('T7'));
    assert.ok(html.includes('T1') && html.includes('T8'));
  });

  it('leaves short terminal runs (<= KEEP_VISIBLE_TERMINAL) unfolded', () => {
    const ctx = createTodoSandbox();
    const tasks = [
      mkTask('1', 'completed'), mkTask('2', 'completed'), mkTask('3', 'completed'),
      mkTask('4', 'completed'),
      mkTask('5', 'pending'),
    ];
    const html = ctx.run(`renderPlanTaskList(${JSON.stringify(tasks)})`);

    assert.ok(!html.includes('data-plan-toggle-run'));
    assert.ok(html.includes('T1') && html.includes('T4'));
  });

  it('renders the whole run flat when expanded', () => {
    const ctx = createTodoSandbox();
    ctx.run('_planExpandedRuns.add(0)');
    const tasks = [
      mkTask('1', 'completed'), mkTask('2', 'completed'), mkTask('3', 'completed'),
      mkTask('4', 'completed'), mkTask('5', 'completed'), mkTask('6', 'completed'),
      mkTask('7', 'pending'),
    ];
    const html = ctx.run(`renderPlanTaskList(${JSON.stringify(tasks)})`);

    assert.ok(html.includes('data-plan-toggle-run="0"'));
    assert.ok(html.includes('is-open'));
    assert.ok(html.includes('T1'));
  });

  it('folds a fully terminal list', () => {
    const ctx = createTodoSandbox();
    const tasks = [
      mkTask('1', 'completed'), mkTask('2', 'deleted'), mkTask('3', 'completed'),
      mkTask('4', 'completed'), mkTask('5', 'completed'),
    ];
    const html = ctx.run(`renderPlanTaskList(${JSON.stringify(tasks)})`);

    assert.ok(html.includes('data-plan-toggle-run="0"'));
    assert.ok(!html.includes('>T1<'));
    assert.ok(html.includes('T2') && html.includes('T5'));
  });
});

describe('frontend terminal task detail expansion', () => {
  function mkTask(id, status, desc) {
    return { id, subject: 'T' + id, description: desc, status, metadata: {}, createdAt: 0, updatedAt: 0 };
  }

  it('hides description by default for every terminal task', () => {
    const ctx = createTodoSandbox();
    const html = ctx.run(`renderPlanTask(${JSON.stringify(mkTask('a', 'completed', 'D-a'))})`);

    assert.ok(html.includes('data-plan-task-detail="a"'));
    assert.ok(!html.includes('D-a'));
    assert.ok(!html.includes('is-open'));
  });

  it('hides description by default for cancelled terminal tasks too', () => {
    const ctx = createTodoSandbox();
    const html = ctx.run(`renderPlanTask(${JSON.stringify(mkTask('a', 'deleted', 'D-a'))})`);

    assert.ok(html.includes('data-plan-task-detail="a"'));
    assert.ok(!html.includes('D-a'));
    assert.ok(!html.includes('is-open'));
  });

  it('honors manual detail expansion over the default collapsed state', () => {
    const ctx = createTodoSandbox();
    ctx.run('_planTerminalDetailState.set("a", true)');
    const html = ctx.run(`renderPlanTask(${JSON.stringify(mkTask('a', 'completed', 'D-a'))})`);

    assert.ok(html.includes('D-a'));
    assert.ok(html.includes('is-open'));
  });

  it('is not interactive for terminal tasks without description', () => {
    const ctx = createTodoSandbox();
    const flat = ctx.run(`renderPlanTask(${JSON.stringify(mkTask('a', 'completed', ''))})`);
    const fromRun = ctx.run(`renderPlanTask(${JSON.stringify(mkTask('a', 'completed', ''))}, true)`);
    assert.ok(!flat.includes('data-plan-task-detail'));
    assert.ok(!fromRun.includes('data-plan-task-detail'));
  });

  it('shows description inline for non-terminal tasks (unchanged)', () => {
    const ctx = createTodoSandbox();
    const html = ctx.run(`renderPlanTask(${JSON.stringify(mkTask('a', 'in_progress', 'D-a'))})`);

    assert.ok(html.includes('D-a'));
    assert.ok(!html.includes('data-plan-task-detail'));
  });

  it('keeps every terminal task detail collapsed when a fold run is expanded', () => {
    const ctx = createTodoSandbox();
    ctx.run('_planExpandedRuns.add(0)');
    const tasks = [
      { id: '1', subject: 'T1', description: 'D1', status: 'completed', metadata: {}, createdAt: 0, updatedAt: 0 },
      { id: '2', subject: 'T2', description: 'D2', status: 'completed', metadata: {}, createdAt: 0, updatedAt: 0 },
      { id: '3', subject: 'T3', description: 'D3', status: 'completed', metadata: {}, createdAt: 0, updatedAt: 0 },
      { id: '4', subject: 'T4', description: 'D4', status: 'completed', metadata: {}, createdAt: 0, updatedAt: 0 },
      { id: '5', subject: 'T5', description: 'D5', status: 'completed', metadata: {}, createdAt: 0, updatedAt: 0 },
      { id: '6', subject: 'T6', description: 'D6', status: 'completed', metadata: {}, createdAt: 0, updatedAt: 0 },
      { id: '7', subject: 'T7', description: 'D7', status: 'pending', metadata: {}, createdAt: 0, updatedAt: 0 },
    ];
    const html = ctx.run(`renderPlanTaskList(${JSON.stringify(tasks)})`);

    assert.ok(html.includes('T1') && html.includes('T6'));
    assert.ok(!html.includes('D1'));
    assert.ok(!html.includes('D6'));
  });
});
