/**
 * Round-trip 测试：验证前端 normalizeTodoPlan（public/src/modules/todo-plan.js）
 * 在重建 TodoPlanSnapshot 对象时不丢弃字段。
 *
 * 背景：框架侧 viewer-worker 的 normalizeTodoPlan 曾因手动重建对象而丢弃
 * interruptTargetId。前端侧也有一份同名的逐字段重建函数，存在同样的风险。
 * 此测试确保含 interruptTargetId 在内的所有字段穿过 normalize 后完整保留。
 *
 * 装载路线（P4 L1：todo-plan 已迁 ESM）：withP2EsmCase + 真实 import。
 * classic 相只装 app-core（DOM 引用 / call 活动 / 身份函数宿主工厂与桥键注册）；
 * 断言一律调用模块命名导出，不再经沙箱全局。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const TODO_PLAN = 'public/src/modules/todo-plan.js';

/** vendor markdown 解析器最小等价桩（markdown-bootstrap 装载期构造 Renderer）。 */
const MARKED_STUB = { Renderer: class { constructor() {} }, setOptions() {}, parse: () => '' };

/**
 * 一个用例 = 一份 classic 沙箱 + 一张真实 ESM 图（模块级折叠/详情状态互不残留）。
 * classic 相按 index.html 顺序装 todo-plan 的依赖面：action-dispatcher（ClawFW
 * 动作注册表）、app-core（桥键注册 + P2 bootstrap 宿主工厂：domRefs / callActivity）、
 * markdown-bootstrap（escapeHtml / renderer 的 classic 实现）。
 * @param {(env: { ctx: object, todo: object }) => any} fn
 */
function withTodoCase(fn) {
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      sandbox.loadSource('public/src/app-core.js');
      sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
    },
    globals: {
      marked: MARKED_STUB,
      hljs: { getLanguage: () => null, highlight: () => ({ value: '' }) },
    },
  }, async (c) => {
    const todo = await c.load(TODO_PLAN);
    return fn({ ctx: c.window, todo });
  });
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
  it('preserves interruptTargetId through normalize', async () => {
    await withTodoCase(({ todo }) => {
      const output = todo.normalizeTodoPlan(buildFullPlan());

      // 这是框架侧曾丢弃的字段，前端侧必须保留
      assert.equal(output.interruptTargetId, 'task-2');
    });
  });

  it('preserves all task fields through normalize', async () => {
    await withTodoCase(({ todo }) => {
      const output = todo.normalizeTodoPlan(buildFullPlan());

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
  });

  it('sanitizes invalid kind to empty string, keeps valid kinds intact', async () => {
    await withTodoCase(({ todo }) => {
      const plan = buildFullPlan();
      plan.tasks[0].kind = 'not-a-kind';
      const output = todo.normalizeTodoPlan(plan);

      // 非法 kind 清洗为空串（不渲染徽章的哨兵值），合法 kind 不受影响
      assert.equal(output.tasks[0].kind, '');
      assert.equal(output.tasks[1].kind, 'investigate');
    });
  });

  it('preserves the other fallback kind in data while keeping it badge-less', async () => {
    await withTodoCase(({ todo }) => {
      const plan = buildFullPlan();
      plan.tasks[0].kind = 'other';
      const output = todo.normalizeTodoPlan(plan);

      // other 是模型侧 kind 必填的兜底值：数据层必须保留（回读与后续分析的来源），
      // 渲染层不出徽章（渲染白名单五值，见 isPlanTaskKind）
      assert.equal(output.tasks[0].kind, 'other');
      const html = todo.renderPlanTask({ id: 'k4', subject: '杂项任务', kind: 'other', status: 'pending' });
      assert.ok(!html.includes('plan-task-kind'));
    });
  });

  it('preserves summary fields through normalize', async () => {
    await withTodoCase(({ todo }) => {
      const output = todo.normalizeTodoPlan(buildFullPlan());

      assert.equal(output.summary.total, 2);
      assert.equal(output.summary.inProgress, 1);
      assert.equal(output.summary.completed, 1);
      assert.equal(output.summary.cancelled, 0);
    });
  });

  it('strips old schema fields (activeForm/owner/blocks/blockedBy) during normalize', async () => {
    await withTodoCase(({ todo }) => {
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
      const output = todo.normalizeTodoPlan(oldPlan);

      const task = output.tasks[0];
      assert.equal(task.id, 'task-old');
      assert.equal(task.subject, 'Old');
      // Old fields should be gone
      assert.equal(task.activeForm, undefined);
      assert.equal(task.owner, undefined);
      assert.equal(task.blocks, undefined);
      assert.equal(task.blockedBy, undefined);
    });
  });

  it('returns null interruptTargetId when input lacks it', async () => {
    await withTodoCase(({ todo }) => {
      const plan = buildFullPlan();
      delete plan.interruptTargetId;
      const output = todo.normalizeTodoPlan(plan);

      assert.equal(output.interruptTargetId, null);
    });
  });

  it('preserves deliver through normalize', async () => {
    await withTodoCase(({ todo }) => {
      const plan = buildFullPlan();
      plan.tasks[0].deliver = 'test/foo.test.js 通过';
      const output = todo.normalizeTodoPlan(plan);

      // 交付物是面板副行的唯一数据来源，normalize 重建任务对象时不能丢
      assert.equal(output.tasks[0].deliver, 'test/foo.test.js 通过');
    });
  });

  it('round-trip stability: normalize(normalize(x)) deep-equals normalize(x)', async () => {
    await withTodoCase(({ todo }) => {
      const once = todo.normalizeTodoPlan(buildFullPlan());
      const twice = todo.normalizeTodoPlan(JSON.parse(JSON.stringify(once)));

      // 幂等性：二次 normalize 不应改变结果（所有字段稳定）
      assert.deepEqual(twice, once);
    });
  });
});

describe('frontend renderPlanTaskList fold logic', () => {
  function mkTask(id, status, desc = '') {
    return { id, subject: 'T' + id, description: desc, status, metadata: {}, createdAt: 0, updatedAt: 0 };
  }

  it('folds a long head terminal run and keeps the tail visible', async () => {
    await withTodoCase(({ todo }) => {
      const tasks = [
        mkTask('1', 'completed'), mkTask('2', 'completed'), mkTask('3', 'completed'),
        mkTask('4', 'completed'), mkTask('5', 'completed'), mkTask('6', 'completed'),
        mkTask('7', 'completed'),
        mkTask('8', 'in_progress'),
      ];
      const html = todo.renderPlanTaskList(tasks);

      // 段首折叠按钮（隐藏 7 - 4 = 3 个），头部 3 个不渲染，段尾 4 个保留
      assert.ok(html.includes('data-plan-toggle-run="0"'));
      assert.ok(!html.includes('>T1<'));
      assert.ok(!html.includes('>T2<'));
      assert.ok(!html.includes('>T3<'));
      assert.ok(html.includes('T4') && html.includes('T7'));
      // 非终态任务正常渲染
      assert.ok(html.includes('T8'));
    });
  });

  it('folds terminal runs in the middle of the list, not only at the head', async () => {
    await withTodoCase(({ todo }) => {
      const tasks = [
        mkTask('1', 'in_progress'),
        mkTask('2', 'completed'), mkTask('3', 'completed'), mkTask('4', 'completed'),
        mkTask('5', 'completed'), mkTask('6', 'completed'), mkTask('7', 'completed'),
        mkTask('8', 'pending'),
      ];
      const html = todo.renderPlanTaskList(tasks);

      assert.ok(html.includes('data-plan-toggle-run="1"'));
      assert.ok(!html.includes('>T2<'));
      assert.ok(!html.includes('>T3<'));
      assert.ok(html.includes('T4') && html.includes('T7'));
      assert.ok(html.includes('T1') && html.includes('T8'));
    });
  });

  it('leaves short terminal runs (<= KEEP_VISIBLE_TERMINAL) unfolded', async () => {
    await withTodoCase(({ todo }) => {
      const tasks = [
        mkTask('1', 'completed'), mkTask('2', 'completed'), mkTask('3', 'completed'),
        mkTask('4', 'completed'),
        mkTask('5', 'pending'),
      ];
      const html = todo.renderPlanTaskList(tasks);

      assert.ok(!html.includes('data-plan-toggle-run'));
      assert.ok(html.includes('T1') && html.includes('T4'));
    });
  });

  it('renders the whole run flat when expanded', async () => {
    await withTodoCase(({ todo }) => {
      todo._planExpandedRuns.add(0);
      const tasks = [
        mkTask('1', 'completed'), mkTask('2', 'completed'), mkTask('3', 'completed'),
        mkTask('4', 'completed'), mkTask('5', 'completed'), mkTask('6', 'completed'),
        mkTask('7', 'pending'),
      ];
      const html = todo.renderPlanTaskList(tasks);

      assert.ok(html.includes('data-plan-toggle-run="0"'));
      assert.ok(html.includes('is-open'));
      assert.ok(html.includes('T1'));
    });
  });

  it('folds a fully terminal list', async () => {
    await withTodoCase(({ todo }) => {
      const tasks = [
        mkTask('1', 'completed'), mkTask('2', 'deleted'), mkTask('3', 'completed'),
        mkTask('4', 'completed'), mkTask('5', 'completed'),
      ];
      const html = todo.renderPlanTaskList(tasks);

      assert.ok(html.includes('data-plan-toggle-run="0"'));
      assert.ok(!html.includes('>T1<'));
      assert.ok(html.includes('T2') && html.includes('T5'));
    });
  });
});

describe('frontend plan controls presentation', () => {
  it('keeps run-to-here and cancellation actions on the same task', async () => {
    await withTodoCase(({ ctx, todo }) => {
      const html = todo.renderPlanTask({ id: 'next', subject: 'Next', status: 'pending' });
      assert.match(html, /data-action="set" data-task-id="next"/);
      ctx.run(`currentRuntimeAgentId = 'runtime-test'; setInterruptTargetId('next')`);
      const selected = todo.renderPlanTask({ id: 'next', subject: 'Next', status: 'pending' });
      assert.match(selected, /is-interrupt-target/);
      assert.match(selected, /data-action="cancel" data-task-id="next"/);
    });
  });

  it('renders SVG disclosure controls with accessible expansion state', async () => {
    await withTodoCase(({ todo }) => {
      const html = todo.renderPlanTask({ id: 'done', subject: 'Done', description: 'Details', status: 'completed' });
      assert.match(html, /role="button" tabindex="0" aria-expanded="false"/);
      assert.match(html, /<svg class="plan-task-check"/);
      assert.match(html, /<svg class="plan-task-detail-chev/);
      const fold = todo.renderPlanFoldButton(3, 0, true);
      assert.match(fold, /aria-expanded="true"/);
      assert.match(fold, /<svg class="plan-fold-chev"/);
      assert.ok(!html.includes('▸') && !fold.includes('▸'));
    });
  });

  it('renders a kind badge in the title line for tasks with a valid kind', async () => {
    await withTodoCase(({ todo }) => {
      const html = todo.renderPlanTask({ id: 'k1', subject: '修复登录缺陷', kind: 'fix', status: 'in_progress' });

      // 徽章带 kind 修饰类（配色的钩子）与 i18n 文案，位于标题行 subject 之前
      assert.match(html, /class="plan-task-kind kind-fix">修复<\/span>修复登录缺陷/);
    });
  });

  it('omits the kind badge for tasks without a kind or with an invalid kind', async () => {
    await withTodoCase(({ todo }) => {
      const none = todo.renderPlanTask({ id: 'k2', subject: '普通任务', status: 'pending' });
      assert.ok(!none.includes('plan-task-kind'));

      const invalid = todo.renderPlanTask({ id: 'k3', subject: '脏数据任务', kind: 'not-a-kind', status: 'pending' });
      // 非法 kind 不产生徽章，也不得把原始值漏进 class 或文本
      assert.ok(!invalid.includes('plan-task-kind'));
      assert.ok(!invalid.includes('not-a-kind'));
    });
  });
});

describe('frontend terminal task detail expansion', () => {
  function mkTask(id, status, desc) {
    return { id, subject: 'T' + id, description: desc, status, metadata: {}, createdAt: 0, updatedAt: 0 };
  }

  it('hides description by default for every terminal task', async () => {
    await withTodoCase(({ todo }) => {
      const html = todo.renderPlanTask(mkTask('a', 'completed', 'D-a'));

      assert.ok(html.includes('data-plan-task-detail="a"'));
      assert.ok(!html.includes('D-a'));
      assert.ok(!html.includes('is-open'));
    });
  });

  it('hides description by default for cancelled terminal tasks too', async () => {
    await withTodoCase(({ todo }) => {
      const html = todo.renderPlanTask(mkTask('a', 'deleted', 'D-a'));

      assert.ok(html.includes('data-plan-task-detail="a"'));
      assert.ok(!html.includes('D-a'));
      assert.ok(!html.includes('is-open'));
    });
  });

  it('honors manual detail expansion over the default collapsed state', async () => {
    await withTodoCase(({ todo }) => {
      todo._planTerminalDetailState.set('a', true);
      const html = todo.renderPlanTask(mkTask('a', 'completed', 'D-a'));

      assert.ok(html.includes('D-a'));
      assert.ok(html.includes('is-open'));
    });
  });

  it('is not interactive for terminal tasks without description', async () => {
    await withTodoCase(({ todo }) => {
      const flat = todo.renderPlanTask(mkTask('a', 'completed', ''));
      const fromRun = todo.renderPlanTask(mkTask('a', 'completed', ''), true);
      assert.ok(!flat.includes('data-plan-task-detail'));
      assert.ok(!fromRun.includes('data-plan-task-detail'));
    });
  });

  it('shows description inline for non-terminal tasks (unchanged)', async () => {
    await withTodoCase(({ todo }) => {
      const html = todo.renderPlanTask(mkTask('a', 'in_progress', 'D-a'));

      assert.ok(html.includes('D-a'));
      assert.ok(!html.includes('data-plan-task-detail'));
    });
  });

  it('renders deliver on its own line, still weaker than the description', async () => {
    await withTodoCase(({ todo }) => {
      const withDeliver = (status) => {
        const task = { ...mkTask('a', status, 'D-a'), deliver: 'src/a.ts 已提交' };
        return todo.renderPlanTask(task);
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
  });

  it('expands deliver together with description for terminal tasks', async () => {
    await withTodoCase(({ todo }) => {
      todo._planTerminalDetailState.set('a', true);
      const task = { ...mkTask('a', 'completed', 'D-a'), deliver: 'src/a.ts 已提交' };
      const html = todo.renderPlanTask(task);

      assert.ok(html.includes('D-a'));
      assert.match(html, /class="plan-task-deliver"[^>]*>交付 · src\/a\.ts 已提交</);
      assert.match(html, /aria-expanded="true"/);
    });
  });

  it('keeps the full deliver text reachable when the line is clamped', async () => {
    await withTodoCase(({ todo }) => {
      const long = 'src/a.ts 与 src/b.ts 都已提交，附三条回归用例';
      const task = { ...mkTask('a', 'in_progress', ''), deliver: long };
      const html = todo.renderPlanTask(task);

      // 视觉上截断为两行，完整内容仍在 title 里，不丢失信息
      assert.match(html, new RegExp(`title="${long}"`));
      assert.ok(html.includes(long));
    });
  });

  it('makes a terminal task expandable when only deliver exists', async () => {
    await withTodoCase(({ todo }) => {
      const task = { ...mkTask('a', 'completed', ''), deliver: 'src/a.ts 已提交' };
      const html = todo.renderPlanTask(task);

      // 无描述但有交付物：仍可展开查看结果
      assert.match(html, /data-plan-task-detail="a"/);
      assert.ok(!html.includes('src/a.ts 已提交'));
    });
  });

  it('omits the deliver line when the task has none', async () => {
    await withTodoCase(({ todo }) => {
      const html = todo.renderPlanTask(mkTask('a', 'in_progress', 'D-a'));

      assert.ok(!html.includes('交付'));
    });
  });

  it('keeps every terminal task detail collapsed when a fold run is expanded', async () => {
    await withTodoCase(({ todo }) => {
      todo._planExpandedRuns.add(0);
      const tasks = [
        { id: '1', subject: 'T1', description: 'D1', status: 'completed', metadata: {}, createdAt: 0, updatedAt: 0 },
        { id: '2', subject: 'T2', description: 'D2', status: 'completed', metadata: {}, createdAt: 0, updatedAt: 0 },
        { id: '3', subject: 'T3', description: 'D3', status: 'completed', metadata: {}, createdAt: 0, updatedAt: 0 },
        { id: '4', subject: 'T4', description: 'D4', status: 'completed', metadata: {}, createdAt: 0, updatedAt: 0 },
        { id: '5', subject: 'T5', description: 'D5', status: 'completed', metadata: {}, createdAt: 0, updatedAt: 0 },
        { id: '6', subject: 'T6', description: 'D6', status: 'completed', metadata: {}, createdAt: 0, updatedAt: 0 },
        { id: '7', subject: 'T7', description: 'D7', status: 'pending', metadata: {}, createdAt: 0, updatedAt: 0 },
      ];
      const html = todo.renderPlanTaskList(tasks);

      assert.ok(html.includes('T1') && html.includes('T6'));
      assert.ok(!html.includes('D1'));
      assert.ok(!html.includes('D6'));
    });
  });
});
