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
        kind: 'fix',
        metadata: { finishedAt: 1700000001000 },
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
      },
      {
        id: 'task-2',
        subject: '进行中任务',
        description: '描述二',
        status: 'in_progress',
        kind: 'investigate',
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
    // kind 是面板徽章的唯一数据来源，normalize 重建任务对象时不能丢
    assert.equal(task1.kind, 'fix');

    const task2 = output.tasks[1];
    assert.equal(task2.status, 'in_progress');
    assert.equal(task2.kind, 'investigate');
  });

  it('sanitizes invalid kind to empty string, keeps valid kinds intact', () => {
    const ctx = createTodoSandbox();
    const plan = buildFullPlan();
    plan.tasks[0].kind = 'not-a-kind';
    ctx.run(`globalThis.__testInput = ${JSON.stringify(plan)}`);
    const output = ctx.run('normalizeTodoPlan(globalThis.__testInput)');

    // 非法 kind 清洗为空串（不渲染徽章的哨兵值），合法 kind 不受影响
    assert.equal(output.tasks[0].kind, '');
    assert.equal(output.tasks[1].kind, 'investigate');
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

  it('preserves deliver through normalize', () => {
    const ctx = createTodoSandbox();
    const plan = buildFullPlan();
    plan.tasks[0].deliver = 'test/foo.test.js 通过';
    ctx.run(`globalThis.__testInput = ${JSON.stringify(plan)}`);
    const output = ctx.run('normalizeTodoPlan(globalThis.__testInput)');

    // 交付物是面板副行的唯一数据来源，normalize 重建任务对象时不能丢
    assert.equal(output.tasks[0].deliver, 'test/foo.test.js 通过');
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

describe('frontend plan controls presentation', () => {
  it('keeps run-to-here and cancellation actions on the same task', () => {
    const ctx = createTodoSandbox();
    const html = ctx.run(`renderPlanTask({ id: 'next', subject: 'Next', status: 'pending' })`);
    assert.match(html, /data-action="set" data-task-id="next"/);
    ctx.run(`currentRuntimeAgentId = 'runtime-test'; setInterruptTargetId('next')`);
    const selected = ctx.run(`renderPlanTask({ id: 'next', subject: 'Next', status: 'pending' })`);
    assert.match(selected, /is-interrupt-target/);
    assert.match(selected, /data-action="cancel" data-task-id="next"/);
  });

  it('renders SVG disclosure controls with accessible expansion state', () => {
    const ctx = createTodoSandbox();
    const html = ctx.run(`renderPlanTask({ id: 'done', subject: 'Done', description: 'Details', status: 'completed' })`);
    assert.match(html, /role="button" tabindex="0" aria-expanded="false"/);
    assert.match(html, /<svg class="plan-task-check"/);
    assert.match(html, /<svg class="plan-task-detail-chev/);
    const fold = ctx.run('renderPlanFoldButton(3, 0, true)');
    assert.match(fold, /aria-expanded="true"/);
    assert.match(fold, /<svg class="plan-fold-chev"/);
    assert.ok(!html.includes('▸') && !fold.includes('▸'));
  });

  it('renders a kind badge in the title line for tasks with a valid kind', () => {
    const ctx = createTodoSandbox();
    const html = ctx.run(`renderPlanTask({ id: 'k1', subject: '修复登录缺陷', kind: 'fix', status: 'in_progress' })`);

    // 徽章带 kind 修饰类（配色的钩子）与 i18n 文案，位于标题行 subject 之前
    assert.match(html, /class="plan-task-kind kind-fix">修复<\/span>修复登录缺陷/);
  });

  it('omits the kind badge for tasks without a kind or with an invalid kind', () => {
    const ctx = createTodoSandbox();
    const none = ctx.run(`renderPlanTask({ id: 'k2', subject: '普通任务', status: 'pending' })`);
    assert.ok(!none.includes('plan-task-kind'));

    const invalid = ctx.run(`renderPlanTask({ id: 'k3', subject: '脏数据任务', kind: 'not-a-kind', status: 'pending' })`);
    // 非法 kind 不产生徽章，也不得把原始值漏进 class 或文本
    assert.ok(!invalid.includes('plan-task-kind'));
    assert.ok(!invalid.includes('not-a-kind'));
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

  it('renders deliver on its own line, still weaker than the description', () => {
    const ctx = createTodoSandbox();
    const withDeliver = (status) => {
      const task = { ...mkTask('a', status, 'D-a'), deliver: 'src/a.ts 已提交' };
      return ctx.run(`renderPlanTask(${JSON.stringify(task)})`);
    };

    // 非终态：交付物是描述之外的独立一行，单节点无嵌套
    const inline = withDeliver('in_progress');
    assert.match(inline, /class="plan-task-deliver"[^>]*>交付 · src\/a\.ts 已提交</);
    assert.match(inline, /class="plan-task-desc">D-a</);
    assert.ok(!inline.includes('plan-task-deliver-label'));

    // 终态默认收起详情，交付物随之折叠（与描述同一折叠口径）
    const collapsed = withDeliver('completed');
    assert.ok(!collapsed.includes('src/a.ts 已提交'));
    assert.ok(!collapsed.includes('D-a'));
    assert.ok(collapsed.includes('data-plan-task-detail="a"'));
  });

  it('expands deliver together with description for terminal tasks', () => {
    const ctx = createTodoSandbox();
    ctx.run('_planTerminalDetailState.set("a", true)');
    const task = { ...mkTask('a', 'completed', 'D-a'), deliver: 'src/a.ts 已提交' };
    const html = ctx.run(`renderPlanTask(${JSON.stringify(task)})`);

    assert.ok(html.includes('D-a'));
    assert.match(html, /class="plan-task-deliver"[^>]*>交付 · src\/a\.ts 已提交</);
    assert.match(html, /aria-expanded="true"/);
  });

  it('keeps the full deliver text reachable when the line is clamped', () => {
    const ctx = createTodoSandbox();
    const long = 'src/a.ts 与 src/b.ts 都已提交，附三条回归用例';
    const task = { ...mkTask('a', 'in_progress', ''), deliver: long };
    const html = ctx.run(`renderPlanTask(${JSON.stringify(task)})`);

    // 视觉上截断为两行，完整内容仍在 title 里，不丢失信息
    assert.match(html, new RegExp(`title="${long}"`));
    assert.ok(html.includes(long));
  });

  it('makes a terminal task expandable when only deliver exists', () => {
    const ctx = createTodoSandbox();
    const task = { ...mkTask('a', 'completed', ''), deliver: 'src/a.ts 已提交' };
    const html = ctx.run(`renderPlanTask(${JSON.stringify(task)})`);

    // 无描述但有交付物：仍可展开查看结果
    assert.match(html, /data-plan-task-detail="a"/);
    assert.ok(!html.includes('src/a.ts 已提交'));
  });

  it('omits the deliver line when the task has none', () => {
    const ctx = createTodoSandbox();
    const html = ctx.run(`renderPlanTask(${JSON.stringify(mkTask('a', 'in_progress', 'D-a'))})`);

    assert.ok(!html.includes('交付'));
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
