/**
 * 孤儿桥注销回归：sidebar-operations 8 键 + ctx-menu-items 1 键。
 *
 * 背景（P2 输入/线程批审核 F1）：这 9 个键的 window 消费者已全部归零——真实
 * 消费方（session-mutation / workspace-actions / ctx-menu-items / ctx-menu-handlers /
 * session-ui / session-dialogs / trim-page / assembly-actions / auto-title）都是
 * 从定义模块具名 import；最后一批 window 消费方（auto-title 的
 * applySessionMutationDelta）已随本批转换收敛。按配方步 5-1 注销桥键：
 * 删除 defineKey、bridgeApi 属性与过时保桥说明，保留命名导出与业务实现。
 *
 * 本文件钉两件事（不复制业务逻辑、不恢复测试桥）：
 *   1. 窗口键缺席：9 个键在真实 classic 链 + 真实 ESM 图求值后既不是 window
 *      属性（访问器），也不可从 classic 沙箱裸标识符解析；
 *   2. 命名导出可用：状态机、pending-stop 抑制、增量应用与 ctx 归档入口经
 *      真实导出调用仍然工作，且整段过程无 console.warn / console.error。
 *
 * 装载路线：classic 相用 `prepareClassicSandbox`（index.html 的先行脚本序，
 * 含真实 app-main / app-ui 宿主工厂）；ESM 相全部走 `c.load` 的真实 import。
 *
 * 端点纪律：三个 Observer 与 fetch 端点按生产契约给出；未登记端点**记录**后由
 * case 收尾断言为空——生产链 try/catch 会吞掉失败响应，只回 `{ ok: false }`
 * 会让「请求了未登记端点」静默变绿。第 3 个用例自证该机制：故意请求未登记
 * 端点，断言用例收尾必红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const SIDEBAR_OPERATIONS = 'public/src/modules/sidebar-operations.js';
const CTX_MENU_ITEMS = 'public/src/modules/ctx-menu-items.js';

/** 已注销的 sidebar-operations 桥键（消费方全部改为具名 import）。 */
const RETIRED_SIDEBAR_KEYS = [
  'markPendingRuntimeStop',
  'releasePendingRuntimeStop',
  'beginSidebarOperation',
  'getSidebarOperation',
  'updateSidebarOperation',
  'finishSidebarOperation',
  'applySessionMutationDelta',
  'applySidebarMutationDeltaWithDiagnostics',
];

/** 已注销的 ctx-menu-items 桥键。 */
const RETIRED_CTX_KEYS = ['ctxArchiveSession'];

class NoopObserver {
  observe() {}

  unobserve() {}

  disconnect() {}

  takeRecords() { return []; }
}

const DECLARATIONS_API = '/api/feature-ui/declarations';
const APP_INFO_API = '/protoclaw/app_info';
const ARCHIVE_API = '/protoclaw/prebuilt_sessions/archive';

const jsonResponse = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
  text: async () => '',
});

const TEST_AGENT = {
  id: 'programming-helper',
  active_workspace_session_id: 'sess-1',
  workspace_sessions: {
    activeSessionId: 'sess-1',
    revision: 3,
    sessions: [
      { id: 'sess-1', archived: false, title: 'Session 1' },
      { id: 'sess-2', archived: false, title: 'Session 2' },
    ],
  },
};

/**
 * 一个用例的 fixture：真实 classic 链 + 真实端点契约 + 噪音记录。
 *
 * 未登记端点**先记录、case 收尾断言为空**：装载期/调用期的真实请求形状必须与
 * 生产一致。只在 stub 里回 `{ ok: false }` 不算证据——生产链的 try/catch 会把
 * 失败吞成静默降级（ctxArchiveSession 的 catch 还会弹 alert），用例照样绿。
 */
async function withBridgeCase(fn) {
  const warnings = [];
  const errors = [];
  const archiveBodies = [];
  const unexpectedEndpoints = [];
  const fetchStub = async (url, options = {}) => {
    const target = String(url);
    if (target === DECLARATIONS_API) return jsonResponse({ ok: true, declarations: [], warnings: [] });
    if (target === APP_INFO_API) {
      return jsonResponse({ ok: true, version: '0.0.0-bridge-fixture', frameworkVersion: '0.0.0-bridge-fixture' });
    }
    if (target === ARCHIVE_API) {
      archiveBodies.push(JSON.parse(options.body || '{}'));
      return jsonResponse({
        ok: true,
        agentId: TEST_AGENT.id,
        sessionId: 'sess-1',
        sessionDelta: { revision: 4, upsert: [{ id: 'sess-1', archived: true }] },
      });
    }
    unexpectedEndpoints.push(target);
    return jsonResponse({ ok: false, error: `unexpected endpoint: ${target}` });
  };
  const result = await withP2EsmCase({
    label: 'p2-orphan-sidebar-bridges',
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
      // 渲染汇点：状态机/增量应用会触发侧栏与主视图重渲染（classic owner）；
      // 本文件不测渲染，按宿主契约注入召回，避免 DOM 装配噪音。
      sandbox.renderAgentList = () => {};
      sandbox.renderCurrentMainView = () => {};
      sandbox.alert = () => {};
    },
    globals: {
      fetch: fetchStub,
      MutationObserver: NoopObserver,
      ResizeObserver: NoopObserver,
      IntersectionObserver: NoopObserver,
      // 诊断队列排程以 navigator 为门；用例不驱动 flush，不残留定时器。
      navigator: undefined,
      console: {
        ...console,
        log() {},
        info() {},
        debug() {},
        warn: (...args) => { warnings.push(args); },
        error: (...args) => { errors.push(args); },
      },
    },
  }, (c) => fn(c, { warnings, errors, archiveBodies, unexpectedEndpoints }));

  assert.deepEqual(
    unexpectedEndpoints,
    [],
    '未登记端点必须按生产契约补进 stub：生产 catch 会吞掉失败，不能靠回落响应放过',
  );
  assert.deepEqual(warnings, [], '桥注销后真实图装载与调用不得产生 console.warn');
  assert.deepEqual(errors, [], '桥注销后真实图装载与调用不得产生 console.error');
  return result;
}

/** 窗口键缺席：既非访问器属性，也不可从 classic 沙箱裸标识符解析。 */
function assertWindowKeyAbsent(c, key) {
  assert.equal(
    Object.getOwnPropertyDescriptor(c.window, key),
    undefined,
    `${key} 已无 window 消费者，桥键必须注销（window 上不得再有访问器）`,
  );
  assert.equal(c.read(`typeof ${key}`), 'undefined', `${key} 不得在 classic 沙箱里可解析`);
}

test('sidebar-operations 的 8 个孤儿键：命名导出可工作且 window 键缺席', async () => {
  await withBridgeCase(async (c) => {
        // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主
        // createThreadStoreHost，必须先于 thread-store-domain 进同一张图。
    await c.load('public/src/modules/thread-store.js');
    const ops = await c.load(SIDEBAR_OPERATIONS);

    for (const key of RETIRED_SIDEBAR_KEYS) {
      assert.equal(typeof ops[key], 'function', `${key} 必须保留真实命名导出`);
      assertWindowKeyAbsent(c, key);
    }

    // 注销是逐个键的：仍有 classic 消费方的键（runtime-status 读 isRuntimeStopPending）
    // 照旧留在桥上，不能把整域桥面一起拆掉。
    assert.equal(c.read('typeof isRuntimeStopPending'), 'function', '仍有 classic 消费方的键必须保留桥访问器');

    // 操作状态机：begin → get → update → finish 全程走命名导出。
    const begun = ops.beginSidebarOperation({
      operationId: 'orphan:op-1',
      type: 'archive',
      kind: 'archive',
      agentId: TEST_AGENT.id,
      sourceSessionId: 'sess-1',
      phase: 'committing',
    });
    assert.equal(begun.phase, 'committing');
    assert.equal(ops.getSidebarOperation('orphan:op-1').phase, 'committing');
    assert.equal(ops.updateSidebarOperation('orphan:op-1', { phase: 'target-ready' }).phase, 'target-ready');
    assert.equal(ops.finishSidebarOperation('orphan:op-1', 'settled').phase, 'settled');
    assert.equal(ops.getSidebarOperation('orphan:op-1'), null, '结算后记录离开在飞登记表');

    // pending-stop 抑制：mark → 可观测 → release → 解除。
    ops.markPendingRuntimeStop(TEST_AGENT.id, 'sess-1', 'runtime-1');
    assert.equal(ops.isRuntimeStopPending(TEST_AGENT.id, 'sess-1', 'runtime-1'), true);
    ops.releasePendingRuntimeStop('runtime-1');
    assert.equal(ops.isRuntimeStopPending(TEST_AGENT.id, 'sess-1', 'runtime-1'), false);

    // 增量应用：经真实 agent-store 状态观测效果（window.allAgents 是既有桥，
    // 写入落到 ESM owner，断言读回同一状态）。
    c.window.allAgents = [TEST_AGENT];
    const applied = ops.applySessionMutationDelta(TEST_AGENT.id, {
      sessionDelta: { revision: 4, remove: ['sess-2'] },
    });
    assert.equal(applied, true);
    assert.equal(
      c.read('allAgents[0].workspace_sessions.sessions.map((s) => s.id).join(",")'),
      'sess-1',
      '增量应用后会话列表只剩未被移除的会话',
    );

    // 带诊断的增量应用：真实调用并返回应用结果。
    assert.equal(
      ops.applySidebarMutationDeltaWithDiagnostics('orphan:op-2', TEST_AGENT.id, {
        sessionDelta: { revision: 5, upsert: [{ id: 'sess-3', archived: false }] },
      }),
      true,
    );
    assert.equal(
      c.read('allAgents[0].workspace_sessions.sessions.map((s) => s.id).join(",")'),
      'sess-3,sess-1',
      'upsert 会话进入列表头部',
    );
  });
});

test('ctx-menu-items 的 ctxArchiveSession：命名导出可归档会话且 window 键缺席', async () => {
  await withBridgeCase(async (c, harness) => {
    const ctx = await c.load(CTX_MENU_ITEMS);

    for (const key of RETIRED_CTX_KEYS) {
      assert.equal(typeof ctx[key], 'function', `${key} 必须保留真实命名导出`);
      assertWindowKeyAbsent(c, key);
    }

    // 仍有 classic 消费方的两个键（sidebar-render 的菜单构建与 pin 点击）保留桥。
    assert.equal(c.read('typeof getCtxMenuItems'), 'function', 'getCtxMenuItems 桥必须保留');
    assert.equal(c.read('typeof dispatchCtxAction'), 'function', 'dispatchCtxAction 桥必须保留');

    c.window.allAgents = [TEST_AGENT];
    await ctx.ctxArchiveSession({ ns: TEST_AGENT.id, id: 'sess-1' });

    assert.deepEqual(harness.archiveBodies.map((body) => ({
      agentId: body.agentId,
      sessionId: body.sessionId,
      archived: body.archived,
    })), [{ agentId: TEST_AGENT.id, sessionId: 'sess-1', archived: true }], '归档请求走真实端点');
    assert.equal(c.read('allAgents[0].workspace_sessions.sessions[0].archived'), true, '乐观归档落到真实 agent 状态');
  });
});

test('自证：请求未登记端点会让用例收尾断言必红（不可被生产 catch 吞掉）', async () => {
  await assert.rejects(
    () => withBridgeCase(async (c) => {
      // 生产链里这样的响应会被 try/catch 吞成静默降级；本用例证明 harness 不吞。
      await c.window.fetch('/protoclaw/__unregistered_bridge_probe__', { method: 'POST' });
    }),
    /未登记端点必须按生产契约补进 stub/,
    '未登记端点必须在 case 收尾断言处失败，而不是回落后继续绿',
  );
});
