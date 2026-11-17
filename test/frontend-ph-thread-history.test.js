// PH 历史存档面板（ticket 050）：面板渲染与「从这段继续」分支动作。
// 面板契约（ADR-0032 决策 3 用户语言模型）：按时间倒序呈现「精简 / 摘要
// 发生前的完整记录」存档卡（时间锚 + 触发方式 + 规模），head 不在存档
// 列表；查看原文走 view_session_record；从这段继续 = 整代保留的分支
// （cutMsgIndexEnd 到最后一条消息），成功后经 open_session 打开新对话。
//
// 装载路线（P2 测试改造）：ph-thread-history 已迁 ESM，经 withP2EsmCase
// 真实 import（每 case 整图隔离）；classic 侧先载 action-dispatcher（模块
// 装载时经 window.ClawFW.actions 注册面板动作，真实验证注册面）与 app-core
// （真实 bootstrap：语言桥键初值）。toast 经真实 ClawToast 模块对象观察
// （面板只依赖 show 的入参契约）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const PH_THREAD_HISTORY = 'public/src/modules/ph-thread-history.js';
const TOAST_NOTIFY = 'public/src/modules/toast-notify.js';

/** 面板 DOM 夹具：记录 createElement 产物（overlay 断言用）。 */
function createPanelDom() {
  const created = [];
  const hosts = new Map();
  const makeElement = () => {
    const el = {
      id: '',
      className: '',
      innerHTML: '',
      parentNode: null,
      children: [],
      style: {},
      dataset: {},
      appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
      removeChild(child) { el.children = el.children.filter((c) => c !== child); child.parentNode = null; },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      remove() { el.parentNode?.removeChild?.(el); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    };
    created.push(el);
    return el;
  };
  return {
    created,
    document: {
      // 面板自己创建 #ph-thread-history-host（宿主未提供时）
      getElementById(id) { return hosts.has(id) ? hosts.get(id) : null; },
      createElement: () => makeElement(),
      createTextNode: (text) => ({ textContent: text }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      body: makeElement(),
      documentElement: makeElement(),
      readyState: 'complete',
    },
  };
}

const CHAIN_META = [
  { sessionId: 'sess-head', role: 'head', endKind: null, title: 'head-title', messageCount: 2 },
  { sessionId: 'sess-arch', role: 'predecessor', endKind: 'trim', endedAt: '2026-10-24T10:30:00+08:00', title: '当时的标题', messageCount: 12 },
  { sessionId: 'sess-arch2', role: 'predecessor', endKind: 'summary', endedAt: '2026-10-20T09:15:00+08:00', title: '更早的标题', messageCount: 30 },
];

function findOverlay(created) {
  return created.find((el) => el.className === 'feature-detail-overlay') || null;
}

/**
 * 一次用例：真实 classic bootstrap + 真实 ESM 图。`probe` 在 case 存续期间
 * 运行（面板与 toast 都读 window / 图内状态）。
 */
async function withThreadHistory({ fetchImpl }, probe) {
  const dom = createPanelDom();
  const actions = [];
  const toasts = [];
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      sandbox.loadSource('public/src/app-core.js');
      sandbox.runWorkspaceAction = (action) => actions.push(action);
    },
    globals: {
      fetch: fetchImpl,
      document: dom.document,
    },
  }, async (c) => {
    const toastModule = await c.load(TOAST_NOTIFY);
    // toast 观察面：面板调用的是本模块对象的方法（无 id 的 show 由真实实现
    // 原样接受/忽略，只断言调用入参契约）。
    const realShow = toastModule.ClawToast.show;
    toastModule.ClawToast.show = (opts) => { toasts.push(opts); return undefined; };
    try {
      const mod = await c.load(PH_THREAD_HISTORY);
      assert.equal(typeof mod.openThreadHistory, 'function', '面板入口是命名导出');
      return await probe({ c, mod, created: dom.created, actions, toasts });
    } finally {
      toastModule.ClawToast.show = realShow;
    }
  });
}

test('面板渲染：存档卡按用户语言呈现（时间锚 + 触发方式 + 规模），head 不出现', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, sessionChainMeta: CHAIN_META }) });
  const { created } = await withThreadHistory({ fetchImpl }, async ({ mod, created, c }) => {
    await mod.openThreadHistory('programming-helper', 'wt-1');
    // 面板动作经真实分发器注册（window.ClawFW.actions）
    assert.equal(c.read('window.ClawFW.actions.has("phHistory.continueFrom")'), true);
    assert.equal(c.read('window.ClawFW.actions.has("phHistory.viewOriginal")'), true);
    assert.equal(c.read('window.ClawFW.actions.has("phHistory.close")'), true);
    return { created };
  });
  const overlay = findOverlay(created);
  assert.ok(overlay, '面板 overlay 已创建');
  const html = overlay.innerHTML;
  assert.ok(html.includes('历史记录'), '面板标题');
  assert.ok(html.includes('精简前'), 'trim 存档触发方式标签');
  assert.ok(html.includes('摘要前'), 'summary 存档触发方式标签');
  assert.ok(html.includes('10 月 24 日'), '时间锚（用户语言格式）');
  assert.ok(html.includes('12 条消息'), '存档规模');
  assert.ok(!html.includes('head-title'), 'head 不作为存档卡渲染');
  assert.ok(html.includes('查看原文') && html.includes('从这段继续'), '两张动作按钮');
});

test('整代保留：从这段继续 → 分支 cut 到最后一条消息，成功后打开新对话', async () => {
  const branchCalls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/protoclaw/session_record')) {
      return { ok: true, status: 200, json: async () => ({ messages: [{}, {}, {}] }) };
    }
    if (String(url).includes('/protoclaw/sessions/branch')) {
      branchCalls.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, newSessionId: 'sess-new' }) };
    }
    return { ok: true, status: 200, json: async () => ({ sessionChainMeta: CHAIN_META }) };
  };
  const { created, toasts, actions } = await withThreadHistory({ fetchImpl }, async ({ mod, created, toasts, actions, c }) => {
    await mod.openThreadHistory('programming-helper', 'wt-1');
    assert.ok(findOverlay(created), '前置：面板已打开');
    // 程序化公开入口（window.PhThreadHistory 是既有 API，面板动作经它转调）
    await c.window.PhThreadHistory.continueFrom('sess-arch');
    return { created, toasts, actions };
  });
  assert.equal(branchCalls.length, 1, '一次分支请求');
  assert.deepEqual(branchCalls[0], {
    agentId: 'programming-helper',
    sourceSessionId: 'sess-arch',
    cutMsgIndexEnd: 2, // 3 条消息 → 保留到索引 2（整代）
  });
  assert.ok(toasts.some((t) => String(t.title).includes('新对话')), '成功提示');
  assert.equal(actions.length, 1, '面板关闭后打开新对话');
  assert.equal(JSON.parse(actions[0]).type, 'open_session');
  assert.equal(JSON.parse(actions[0]).sessionId, 'sess-new');
  assert.equal(findOverlay(created).parentNode, null, '成功后面板已从宿主摘除');
});

test('空历史：提示且不开面板', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ sessionChainMeta: [] }) });
  const { created, toasts } = await withThreadHistory({ fetchImpl }, async ({ mod, created, toasts }) => {
    await mod.openThreadHistory('programming-helper', 'wt-1');
    return { created, toasts };
  });
  assert.equal(findOverlay(created), null, '无 overlay 创建');
  assert.ok(toasts.some((t) => String(t.title).includes('暂无历史存档')), '空历史提示');
});

test('详情请求失败：错误提示，不开面板', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const { created, toasts } = await withThreadHistory({ fetchImpl }, async ({ mod, created, toasts }) => {
    await mod.openThreadHistory('programming-helper', 'wt-1');
    return { created, toasts };
  });
  assert.equal(findOverlay(created), null, '失败不开面板');
  assert.ok(toasts.some((t) => t.status === 'error'), '错误 toast');
});
