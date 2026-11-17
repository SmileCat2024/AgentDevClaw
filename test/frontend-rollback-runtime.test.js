/**
 * frontend-rollback-runtime.test.js — 回退运行期编排与失败可见化
 *
 * 修复背景（session-1791877250587-9c07ad 诊断）：
 *   1. 回退能力由输入 lease 驱动，轮次执行期间（模型思考中 / 报错重试中 /
 *      工具运行中）lease 已被本轮消费，点击「编辑此轮」静默失效（100% 触发
 *      的设计缺口）→ 运行期路径：确认后自动打断 + 等终态 + 提交所选动作。
 *   2. lease 广播的 availableCallIndices 偶发缺最新轮 checkpoint（低概率
 *      竞态）→ 前端对最新一条用户消息放宽（执行时 runtime 按实际
 *      checkpoints 校验，真不存在会明确失败并 toast）。
 *   3. 回退失败只进下一次输入框 placeholder（几乎不可见）→ 失败原因随
 *      下一次 lease actions 一次性携带，前端 toast 呈现；无 lease 点击给
 *      明确反馈。
 *
 * 加载路线（P2 输入面收尾批次）：
 *   - classic 相：session-view-state（会话视图同步读取与 token 捕获；
 *     本文件另按生产协议注册会话存储 / 编排桥键）+ rollback-dialog（本域五个
 *     状态键的 classic 相注册壳）。输入面渲染器不在本文件验收面内。
 *   - ESM 相：`input-actions`（动作提交与回退可用性）、`rollback-dialog-runtime`
 *     （对话框装配与运行期编排）、`call-interrupt-host`（打断抑制状态）真实 import。
 *     提交断言看真实 HTTP 请求（url + body），不桩掉 submitInputAction。
 *   - 判定「会话已切走」不用测试开关：走真实 `applySessionViewPatch({ identity })`
 *     让 token 代次推进，验证的是生产 stale 语义。
 *   - 等待链时序是模块私有 400ms 轮询 / 30s 上限（与原 classic 实现同值，无测试
 *     注入面）：用例用 node:test 的 mock.timers 推进时钟，不引入真实 sleep。
 *   - ClawToast / poll 都是 ESM 依赖：通知观察 toast-notify 模块对象的 show 调用，
 *     轮询经 poll-coordinator-host 的宿主 seam 记次，两者都不再经 window 桩。
 */
import fs from 'node:fs';
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

/**
 * tick() 只推进时钟并同步执行到期的定时器回调，不跑微任务队列；等待链是
 * `await new Promise(setTimeout)`，需要让微任务续体跑完再断言。setImmediate
 * 不在 mock 的 apis 内，作为真实宏任务边界使用。
 */
const drainMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

// ── Mini DOM（含 addEventListener 记录，供对话框按钮点击路径） ────────────

function matchesSimple(part, el) {
  if (part.startsWith('.')) return el.classList.contains(part.slice(1));
  if (part.startsWith('#')) return el.id === part.slice(1);
  if (part.startsWith('[')) {
    const inner = part.slice(1, -1);
    const eqIdx = inner.indexOf('=');
    if (eqIdx === -1) return el.getAttribute(inner) != null;
    const attr = inner.slice(0, eqIdx);
    const value = inner.slice(eqIdx + 1).replace(/^"|"$/g, '');
    return String(el.getAttribute(attr)) === value;
  }
  return el.tagName === part.toUpperCase();
}

function selectorPredicate(selector) {
  return (el) => String(selector).split(/\s+/).filter(Boolean).every((part) =>
    matchesSimple(part, el));
}

function findFirst(root, predicate) {
  for (const child of root.children) {
    if (predicate(child)) return child;
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return null;
}

function findAllDeep(root, predicate, out = []) {
  for (const child of root.children) {
    predicate(child) && out.push(child);
    findAllDeep(child, predicate, out);
  }
  return out;
}

function createMiniElement(tagName, doc) {
  const classes = new Set();
  const attributes = new Map();
  const handlers = {};
  const el = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    parentNode: null,
    textContent: '',
    value: '',
    style: {},
    get id() { return attributes.has('id') ? attributes.get('id') : ''; },
    set id(value) {
      if (value) attributes.set('id', String(value));
      else attributes.delete('id');
    },
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (name, force) => {
        const want = force === undefined ? !classes.has(name) : Boolean(force);
        if (want) classes.add(name); else classes.delete(name);
        return want;
      },
      contains: (name) => classes.has(name),
    },
    get className() { return Array.from(classes).join(' '); },
    set className(value) {
      classes.clear();
      String(value).split(/\s+/).filter(Boolean).forEach((n) => classes.add(n));
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(type, handler) {
      (handlers[type] = handlers[type] || []).push(handler);
    },
    removeEventListener() {},
    dispatch(type) {
      // 聚合 handler 返回的 promise：async handler（确认后打断+等待链）被
      // 真正 await，断言不抢跑、等待链不残留为悬空 handle
      return Promise.all((handlers[type] || []).map((handler) => handler()));
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      el.children = el.children.filter((c) => c !== child);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    contains(target) {
      return el.children.some((c) => c === target || c.contains(target));
    },
    querySelector(selector) {
      return findFirst(el, selectorPredicate(selector));
    },
    querySelectorAll(selector) {
      return findAllDeep(el, selectorPredicate(selector));
    },
    get isConnected() {
      let node = el;
      while (node.parentNode) node = node.parentNode;
      return doc ? node === doc.body : false;
    },
    focus() {},
  };
  // 极简 innerHTML 解析：只构建标签/属性树（class/id/data-* 等），文本节点
  // 忽略——对话框断言只关心结构与按钮 wiring，不关心文案渲染。
  let _innerHTML = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return _innerHTML; },
    set(html) {
      _innerHTML = String(html);
      el.children = [];
      const stack = [el];
      const tagRe = /<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/)?>/g;
      let match;
      while ((match = tagRe.exec(_innerHTML))) {
        const [, closing, tag, attrText, selfClosing] = match;
        if (closing) { if (stack.length > 1) stack.pop(); continue; }
        const child = createMiniElement(tag, doc);
        const attrRe = /([\w-]+)(?:="([^"]*)")?/g;
        let attr;
        while ((attr = attrRe.exec(attrText))) {
          if (attr[1] === 'class') child.className = attr[2] || '';
          else child.setAttribute(attr[1], attr[2] ?? '');
        }
        stack[stack.length - 1].appendChild(child);
        if (!selfClosing) stack.push(child);
      }
    },
  });
  return el;
}

function createMiniDocument() {
  const doc = { activeElement: null, readyState: 'complete' };
  doc.body = createMiniElement('body', doc);
  doc.createElement = (tag) => createMiniElement(tag, doc);
  doc.getElementById = (id) => findAllDeep(doc.body, (el) => el.id === id)[0] || null;
  doc.addEventListener = () => {};
  return doc;
}

// ── 用例装载环境：真实 classic 输入面状态 + 真实 ESM 域 ────────────────────

/**
 * 会话存储 / 编排 / 语言桥键按**生产协议**在 classic 相注册（app-core 与 i18n 的
 * 角色）：ESM owner claim 后，classic 侧 `applySessionViewPatch` 的写入与 ESM 侧
 * 读取同一份状态——不需要在测试里维护第二副本。
 */
const BRIDGE_PRELUDE = `
  window.KernelState.defineKey('session-view-storage', 'currentMessages', []);
  window.KernelState.defineKey('session-view-storage', 'currentInputRequests', []);
  window.KernelState.defineKey('session-view-storage', 'toolRenderConfigs', {});
  window.KernelState.defineKey('session-view-storage', 'TOOL_NAMES', {});
  window.KernelState.defineKey('session-view-storage', 'currentHookInspector', {});
  window.KernelState.defineKey('session-view-storage', 'currentHookInspectorSignature', '');
  window.KernelState.defineKey('session-view-storage', 'currentOverviewSnapshot', {});
  window.KernelState.defineKey('session-view-storage', 'currentOverviewSignature', '');
  window.KernelState.defineKey('session-view-storage', 'currentTodoPlan', {});
  window.KernelState.defineKey('session-view-storage', 'currentTodoPlanSignature', '');
  window.KernelState.defineKey('orchestration', 'currentRuntimeAgentId', null);
  window.KernelState.defineKey('orchestration', '_switchEpoch', 0);
  window.KernelState.defineKey('i18n-environment', 'currentLanguage', 'zh');
  currentRuntimeConnected = true;
`;

function rollbackCase({ messages = [], inputRequests = [] } = {}) {
  const doc = createMiniDocument();
  const inputContainer = createMiniElement('div', doc);
  inputContainer.id = 'user-input-container';
  doc.body.appendChild(inputContainer);
  const choiceContainer = createMiniElement('div', doc);
  choiceContainer.id = 'choice-input-container';
  doc.body.appendChild(choiceContainer);

  const state = {
    doc,
    inputContainer,
    choiceContainer,
    toasts: [],
    calls: { interruptAgent: [], requests: [], surfaceNotices: 0 },
    interruptPending: new Map(),
    flags: { runtimeCalling: false, interruptResult: { ok: true } },
    sessionKey: 'test-session',
  };

  const options = {
    classic: (sandbox) => {
      // 分发器最先装载（生产加载序）：markdown-utils 等 ESM 域在装载期注册动作
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      sandbox.run(BRIDGE_PRELUDE);
      // 会话视图同步实现（token 捕获 / patch 门）与主视图渲染读取它
      sandbox.loadSource('public/src/modules/session-view-state.js');
      // 本域状态键注册壳已迁 ESM（P4 T2）：改由 async 相 c.load 装载。
    },
    globals: {
      document: doc,
      // P2 宿主工厂（生产由 app-core 提供）：打断抑制容器、call 活动容器、DOM 引用。
      createCallInterruptHost: () => ({ pending: state.interruptPending, now: () => Date.now() }),
      createP2BootstrapCallActivityHost: () => ({
        _agentCallActive: new Map(),
        _recentlyFinishedRuntimes: new Set(),
        _seenChoiceAlertIds: new Set(),
        _autoTitleTriggered: new Set(),
        _lastInterruptUserActionAt: 0,
      }),
      createP2BootstrapDomHost: () => ({ container: inputContainer }),
      escapeHtml: (text) => String(text == null ? '' : String(text)
        .replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]))),
      // 真实 poll 模块的宿主 seam（生产由 app-main 提供）：本文件不断言轮询次数，
      // 只要求真实 poll 可调用且不引第二条定时链。
      createPollCoordinatorHost: () => ({
        run: () => Promise.resolve(),
        fastInterval: () => 2000,
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (id) => clearTimeout(id),
      }),
      // 打断链（真实实现属 persistent-input 域）：按用例设置的行为记录调用。
      isRuntimeCalling: () => state.flags.runtimeCalling,
      interruptAgent: async () => {
        state.calls.interruptAgent.push(Date.now());
        return state.flags.interruptResult;
      },
      notifyInputSurfaceChanged: () => { state.calls.surfaceNotices += 1; },
      detachTransientInputContent: () => {},
      hidePersistentComposerCard: () => {},
      runWithSuppressedChatViewportObservers: (fn) => fn(),
      _getSessionInputCacheKey: () => state.sessionKey,
      // 动作提交的 classic 汇点（生产分别定义于 app-main / chat-viewport /
      // persistent-input / sidebar-render）；提交本身走真实 HTTP 请求断言。
      _markAgentCallStartedForNotify: () => {},
      _syncPersistentActionButton: () => {},
      renderAgentList: () => {},
      beginFollowLatestEntryWindow: () => {},
      requestFollowLatest: () => {},
      fetch: async (url, init = {}) => {
        let body = null;
        if (init.body) {
          try { body = JSON.parse(init.body); } catch { body = init.body; }
        }
        state.calls.requests.push({ url: String(url), method: init.method || 'GET', body });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    },
  };

  return { state, options };
}

/**
 * 一个用例：classic 沙箱 + 真实 ESM 图。返回用例面（状态、动作入口与断言工具）。
 */
async function withRollbackCase(options, fn) {
  const { state, options: caseOptions } = rollbackCase(options);
  return withP2EsmCase(caseOptions, async (c) => {
    c.window.currentRuntimeAgentId = 'agent-1';
    c.window.currentMessages = options?.messages || [];
    c.window.currentInputRequests = options?.inputRequests || [];
    // 真实 classic interrupt owner：独立 app-core 沙箱的唯一 policy 实例，
    // 接到本用例 window（不复制实现、不建第二套 factory）。
    const interruptOwner = createFrontendSandbox();
    interruptOwner.loadSource('public/src/app-core.js');
    for (const name of ['getNotificationCallStartedAt', 'markInterruptPending',
      'isInterruptSuppressed', 'clearInterruptSuppression']) {
      c.window[name] = interruptOwner[name];
    }
    // 状态键注册壳（ESM 相）：先注册，owner 随后在本文件 import 链里 claim 吸收。
    await c.load('public/src/modules/rollback-dialog.js');
    await c.load('public/src/modules/rollback-dialog-runtime.js');
    // 压缩状态 owner：`_partialCompactContextKey` 桥键已注销（唯一消费方改 import），
    // 该键的断言直读 owner 活绑定。
    const rollbackDomain = await c.load('public/src/modules/p2-w2-3b-rollback-domain.js');
    // 显式 window 调用不等于永久外部协议：入口按配方经 KernelState 桥注册
    // （访问器 + 可写转发），而不是散装 window 赋值。
    const rollbackEditDescriptor = Object.getOwnPropertyDescriptor(c.window, 'requestRollbackEdit');
    assert.equal(typeof rollbackEditDescriptor?.get, 'function', '回退编辑入口已上桥');
    assert.equal(typeof rollbackEditDescriptor?.set, 'function', '桥键保持可写转发');
    const actions = await c.load('public/src/modules/input-actions.js');
    const interrupt = await c.load('public/src/modules/call-interrupt-host.js');
    // ClawToast 已是 ESM 依赖：替换真实对象的 show 接口观察通知（同一实例）。
    const toast = await c.load('public/src/modules/toast-notify.js');
    const realToastShow = toast.ClawToast.show;
    toast.ClawToast.show = (opts) => { state.toasts.push(opts); };
    // 等待链时序是模块私有 400ms / 30s：mock 时钟推进（无生产测试注入面）。
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      return await fn({
        c,
        state,
        actions,
        interrupt,
        rollbackDomain,
        /** 生产写入口：classic 侧的会话视图写入（bridge 双向转发）。 */
        setRequests: (requests) => { c.window.currentInputRequests = requests; },
        setMessages: (messages) => { c.window.currentMessages = messages; },
        openDialog: () => c.read('window.requestRollbackEdit(0)'),
        /** 在 mock 时钟上安排一个真实定时器（如 lease 迟到的时刻）。 */
        timer: (ms, handler) => setTimeout(handler, ms),
        /** 推进 mock 时钟并让等待链的微任务续体跑完。 */
        advance: async (ms) => { mock.timers.tick(ms); await drainMicrotasks(); },
        clickRollback: async () => {
          const card = state.choiceContainer.children[0];
          assert.ok(card, '交互面必须已有对话框卡片');
          await card.querySelector('[data-mode="rollback"]').dispatch('click');
        },
        clickCompact: async () => {
          const card = state.choiceContainer.children[0];
          assert.ok(card, '交互面必须已有对话框卡片');
          await card.querySelector('[data-mode="compact"]').dispatch('click');
        },
      });
    } finally {
      toast.ClawToast.show = realToastShow;
      mock.timers.reset();
    }
  });
}

function leaseWithIndices(indices) {
  return [{
    requestId: `lease-${indices.join('-')}`,
    actions: [{ id: 'rollback_to_call', data: { availableCallIndices: indices } }],
  }];
}

const submittedActions = (state) => state.calls.requests
  .filter((entry) => entry.url.startsWith('/api/agents/'))
  .map((entry) => ({ ...entry, input: entry.body?.response || null }));

// ── canRollbackMessage：lease 缺最新轮的竞态防御 ──────────────────────────

describe('canRollbackMessage race guard (latest user message relaxation)', () => {
  it('latest user turn stays rollbackable when lease indices miss it', async () => {
    const messages = [
      { role: 'user', turn: 0, content: 'first' },
      { role: 'assistant', turn: 0 },
      { role: 'user', turn: 1, content: 'second' },
      { role: 'assistant', turn: 1 },
    ];
    await withRollbackCase({ inputRequests: leaseWithIndices([0]), messages }, ({ actions, setMessages }) => {
      setMessages(messages);
      assert.equal(actions.canRollbackMessage(messages[2]), true,
        '最新用户消息（被打断轮）即使不在 availableCallIndices 也可回退');
      assert.equal(actions.canRollbackMessage(messages[0]), true,
        '在列表内的轮次照常可回退');
    });
  });

  it('non-latest user turns stay disabled when missing from indices', async () => {
    const messages = [
      { role: 'user', turn: 0, content: 'a' },
      { role: 'user', turn: 1, content: 'b' },
      { role: 'user', turn: 2, content: 'c' },
    ];
    await withRollbackCase({ inputRequests: leaseWithIndices([0, 2]), messages }, ({ actions, setMessages }) => {
      setMessages(messages);
      assert.equal(actions.canRollbackMessage(messages[1]), false,
        '非最新的中间轮（不在列表）保持禁用——放宽只覆盖最新用户消息');
      assert.equal(actions.canRollbackMessage(messages[0]), true);
      assert.equal(actions.canRollbackMessage(messages[2]), true,
        '最新轮在列表内照常可回退');
    });
  });

  it('legacy lease without indices still allows all; handoff seeds stay disabled', async () => {
    const messages = [
      { role: 'user', turn: 0, source: 'handoff-seed', content: 'seed' },
      { role: 'user', turn: 1, content: 'real' },
    ];
    const inputRequests = [{ requestId: 'legacy', actions: [{ id: 'rollback_to_call' }] }];
    await withRollbackCase({ inputRequests, messages }, ({ actions, setMessages }) => {
      setMessages(messages);
      assert.equal(actions.canRollbackMessage(messages[0]), false, 'handoff seed 永不可回退');
      assert.equal(actions.canRollbackMessage(messages[1]), true,
        '无 availableCallIndices 时回退全允许（旧行为回归）');
    });
  });
});

// ── requestRollbackEdit：无 lease 分流 ────────────────────────────────────

describe('requestRollbackEdit routing without a lease', () => {
  it('idle runtime (no lease, not calling) yields an explicit toast', async () => {
    await withRollbackCase({ messages: [{ role: 'user', turn: 0, content: 'hi' }] },
      ({ openDialog, state }) => {
        openDialog();
        assert.equal(state.toasts.length, 1, '静默返回被替换为明确反馈');
        assert.equal(state.toasts[0].status, 'error');
        assert.equal(state.choiceContainer.children.length, 0, '不弹对话框');
      });
  });

  it('running turn (no lease, calling) opens the runtime-mode dialog', async () => {
    await withRollbackCase({ messages: [{ role: 'user', turn: 0, content: 'hi' }] },
      ({ openDialog, state }) => {
        state.flags.runtimeCalling = true;
        openDialog();
        assert.equal(state.toasts.length, 0, '运行期不是错误，打开对话框');
        const card = state.choiceContainer.children[0];
        assert.ok(card, '对话框渲染到交互面');
        assert.ok(card.querySelector('.user-choice-running-hint'),
          '运行期模式显示打断提示行');
      });
  });

  it('interrupting runtime (suppression sticky) also counts as running', async () => {
    await withRollbackCase({ messages: [{ role: 'user', turn: 0, content: 'hi' }] },
      ({ openDialog, state, interrupt }) => {
        // 真实打断抑制状态：标记该 runtime 的打断已发出（callStartedAt=0 → 粘性）
        interrupt.markInterruptPending('agent-1', 0);
        openDialog();
        assert.ok(state.choiceContainer.children[0],
          '打断进行中（lease 未重发）同样进入运行期对话框');
      });
  });
});

// ── 运行期确认链路：打断 → 等 lease → 提交 ────────────────────────────────

describe('runtime-mode confirm path (interrupt then wait for the next lease)', () => {
  it('confirm interrupts the turn and submits with the refreshed lease', async () => {
    await withRollbackCase({ messages: [{ role: 'user', turn: 0, content: 'draft me' }] },
      async ({ openDialog, clickRollback, state, c, timer, advance }) => {
        state.flags.runtimeCalling = true;
        // 打断后（首个轮询间隔 400ms）输入循环重发携带回退动作的 lease
        const refreshed = leaseWithIndices([0]);
        timer(400, () => { c.window.currentInputRequests = refreshed; });
        openDialog();
        const click = clickRollback();
        await drainMicrotasks();
        await advance(400);
        await click;

        assert.equal(state.calls.interruptAgent.length, 1, '确认后自动打断当前轮次');
        const submits = submittedActions(state);
        assert.equal(submits.length, 1, '等待到 lease 后提交回退动作');
        const submit = submits[0];
        assert.equal(submit.url, '/api/agents/agent-1/input', '提交打到渲染该 lease 的 runtime');
        assert.equal(submit.input.kind, 'action');
        assert.equal(submit.input.actionId, 'rollback_to_call');
        assert.equal(submit.input.payload.callIndex, 0);
        assert.equal(submit.input.payload.draftInput, 'draft me');
        assert.ok(state.toasts.some((t) => t.status === 'info' && t.title.includes('打断')),
          '打断动作对用户透明（info toast）');
      });
  });

  it('waits through empty polls until the refreshed lease arrives', async () => {
    await withRollbackCase({ messages: [{ role: 'user', turn: 0, content: 'x' }] },
      async ({ openDialog, clickRollback, state, interrupt, c, timer, advance }) => {
        assert.equal(state.flags.runtimeCalling, false);
        interrupt.markInterruptPending('agent-1', 0); // 打断已发出、收尾中：不再重复打断
        // 三个轮询周期后的同一时刻出现 lease（模拟打断收尾耗时）
        timer(1200, () => {
          c.window.currentInputRequests = [{ requestId: 'late-lease', actions: [
            { id: 'rollback_to_call', data: { availableCallIndices: [0] } },
          ] }];
        });
        openDialog();
        const click = clickRollback();
        await drainMicrotasks();
        await advance(400); // 第 1 次空轮询
        await advance(400); // 第 2 次空轮询
        await advance(400); // 第 3 次：lease 已到达
        await click;
        assert.equal(state.calls.interruptAgent.length, 0, '抑制粘性态不重复打断');
        const submits = submittedActions(state);
        assert.equal(submits.length, 1);
        assert.equal(submits[0].body.requestId, 'late-lease');
      });
  });

  it('times out with an explicit toast when no lease ever arrives', async () => {
    await withRollbackCase({ messages: [{ role: 'user', turn: 0, content: 'x' }] },
      async ({ openDialog, clickRollback, state, interrupt, advance }) => {
        interrupt.markInterruptPending('agent-1', 0);
        openDialog();
        const click = clickRollback();
        await drainMicrotasks();
        await advance(30000); // 模块私有 30s 上限
        await click;
        assert.equal(submittedActions(state).length, 0, '无 lease 不提交');
        assert.ok(state.toasts.some((t) => t.status === 'error' && t.title.includes('超时')),
          '超时给出明确 toast');
      });
  });

  it('fails fast when the refreshed lease has no rollback targets', async () => {
    await withRollbackCase({ messages: [{ role: 'user', turn: 0, content: 'x' }] },
      async ({ openDialog, clickRollback, state, interrupt, c, timer, advance }) => {
        interrupt.markInterruptPending('agent-1', 0);
        timer(400, () => {
          c.window.currentInputRequests = [{ requestId: 'bare-lease', actions: [] }];
        });
        openDialog();
        const click = clickRollback();
        await drainMicrotasks();
        await advance(400);
        await click;
        assert.equal(submittedActions(state).length, 0);
        assert.ok(state.toasts.some((t) => t.status === 'error' && t.title.includes('可回退')),
          'lease 无回退点时明确提示');
      });
  });

  it('aborts without submitting when the session is switched away while waiting', async () => {
    await withRollbackCase({ messages: [{ role: 'user', turn: 0, content: 'x' }] },
      async ({ openDialog, clickRollback, state, interrupt, c, setMessages, timer, advance }) => {
        interrupt.markInterruptPending('agent-1', 0);
        // 视图身份先落定（token 携带身份）：身份切换会清空视图内容（生产语义），
        // 随后按真实加载顺序装入本会话消息。等待期间再切到另一个会话。
        c.read(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'A' } })`);
        setMessages([{ role: 'user', turn: 0, content: 'x' }]);
        timer(400, () => {
          c.read(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'B' } });
            currentInputRequests = [{ requestId: 'other-session-lease', actions: [
              { id: 'rollback_to_call', data: { availableCallIndices: [0] } },
            ] }];`);
        });
        openDialog();
        const click = clickRollback();
        await drainMicrotasks();
        await advance(400);
        await click;
        assert.equal(submittedActions(state).length, 0,
          '会话切走后绝不把旧会话的回退提交出去');
      });
  });

  it('aborts immediately when the interrupt request itself fails', async () => {
    await withRollbackCase({ messages: [{ role: 'user', turn: 0, content: 'x' }] },
      async ({ openDialog, clickRollback, state }) => {
        state.flags.runtimeCalling = true;
        state.flags.interruptResult = { ok: false, reason: 'request-failed' };
        openDialog();
        await clickRollback();
        assert.equal(submittedActions(state).length, 0,
          '打断失败（轮次不会终止）时放弃等待');
        assert.equal(state.toasts.filter((t) => t.title.includes('超时')).length, 0,
          '不经历超时才发现失败');
      });
  });

  it('compact confirm marks the compact lease and submits the same bound runtime', async () => {
    await withRollbackCase({
      messages: [{ role: 'user', turn: 0, content: 'x' }],
      inputRequests: [{ requestId: 'compact-lease', actions: [{ id: 'compact_from_call', data: { availableCallIndices: [0] } }] }],
    }, async ({ openDialog, clickCompact, state, c, rollbackDomain }) => {
      openDialog();
      await clickCompact();
      const submits = submittedActions(state);
      assert.equal(submits.length, 1);
      assert.equal(submits[0].input.actionId, 'compact_from_call');
      assert.equal(submits[0].input.payload.callIndex, 0);
      // 压缩标志与 patch 在提交前落地（渲染据此进入 compacting 模式）
      assert.equal(c.read('_partialCompactInFlight'), true);
      assert.equal(rollbackDomain.partialCompactContextKey, 'test-session',
        '压缩上下文键写入 owner（桥键已注销，消费方直读活绑定）');
      assert.equal(c.read('JSON.stringify(currentInputRequests)'), '[]',
        '压缩动作乐观清空输入请求（patch 门写入）');
    });
  });
});

// ── 等待链重入保护 ──────────────────────────────────────────────────────

describe('rollback lease await re-entrancy guard', () => {
  it('second confirm while one await is in flight gets a busy toast and no second submit', async () => {
    await withRollbackCase({ messages: [{ role: 'user', turn: 0, content: 'x' }] },
      async ({ openDialog, state, c, advance }) => {
        let releaseInterrupt;
        const gate = new Promise((resolve) => { releaseInterrupt = resolve; });
        state.flags.runtimeCalling = true;
        c.window.interruptAgent = async () => { await gate; return { ok: true }; };

        openDialog();
        const card = state.choiceContainer.children[0];
        const button = card.querySelector('[data-mode="rollback"]');
        const first = button.dispatch('click');
        await drainMicrotasks();
        // 首次确认挂在 interruptAgent 的 gate 上，此时再次点击同一个按钮
        await button.dispatch('click');
        assert.ok(state.toasts.some((t) => t.title.includes('等待轮次结束')),
          '重入给出「已在等待」提示');

        releaseInterrupt();
        await drainMicrotasks(); // 首个等待链进入轮询
        await advance(30000);    // 无 lease 到达 → 私有 30s 上限超时
        await first;
        assert.equal(submittedActions(state).length, 0, '重入与超时都不得提交');
      });
  });
});

// ── input-render：lease 携带的动作失败 toast ──────────────────────────────

describe('lease action error toast (input-render.js)', () => {
  function loadNotifyLeaseActionError() {
    const ctx = createFrontendSandbox({ currentLanguage: 'zh' });
    const toasts = [];
    ctx.ClawToast = { show: (opts) => { toasts.push(opts); } };
    const source = fs.readFileSync('public/src/modules/input-render.js', 'utf8');
    const block = source.slice(
      source.indexOf('let _lastLeaseActionErrorToastedId = null;'),
      source.indexOf('// 渲染输入请求'),
    );
    assert.ok(block.includes('function _notifyLeaseActionError'),
      '源码提取块应包含目标函数（提取锚点漂移时失败提醒同步）');
    ctx.run(block);
    ctx.state = { toasts };
    return ctx;
  }

  it('toasts the carried error once per lease and dedupes re-renders', () => {
    const ctx = loadNotifyLeaseActionError();
    const lease = {
      requestId: 'err-lease',
      actions: [{ id: 'rollback_to_call', data: { availableCallIndices: [0], lastActionError: 'checkpoint 不存在' } }],
    };
    ctx.run(`_notifyLeaseActionError(${JSON.stringify(lease)})`);
    ctx.run(`_notifyLeaseActionError(${JSON.stringify(lease)})`);
    assert.equal(ctx.state.toasts.length, 1, '同一 lease 重复渲染只提示一次');
    assert.equal(ctx.state.toasts[0].status, 'error');
    assert.equal(ctx.state.toasts[0].description, 'checkpoint 不存在');

    // 下一个 lease（不同 requestId）携带新错误时再次提示
    const next = {
      requestId: 'err-lease-2',
      actions: [{ id: 'rollback_to_call', data: { lastActionError: '另一个错误' } }],
    };
    ctx.run(`_notifyLeaseActionError(${JSON.stringify(next)})`);
    assert.equal(ctx.state.toasts.length, 2);
  });

  it('stays silent for leases without a carried error', () => {
    const ctx = loadNotifyLeaseActionError();
    ctx.run(`_notifyLeaseActionError({ requestId: 'ok-lease', actions: [
      { id: 'rollback_to_call', data: { availableCallIndices: [0] } },
    ] })`);
    ctx.run('_notifyLeaseActionError({ requestId: "no-actions" })');
    assert.equal(ctx.state.toasts.length, 0);
  });
});

// ── runtime：getNextTurnActions 一次性携带 lastActionError ────────────────

describe('runtime getNextTurnActions carries lastActionError once', () => {
  function loadGetNextTurnActions() {
    const ctx = createFrontendSandbox({ console: { ...console, warn() {} } });
    const source = fs.readFileSync('scripts/run-prebuilt-agent.js', 'utf8');
    const block = source.slice(
      source.indexOf('getNextTurnActions() {'),
      source.indexOf('\n  }', source.indexOf('getNextTurnActions() {')) + 4,
    );
    assert.ok(block.includes('availableCallIndices'), '源码提取锚点校验');
    ctx.run(`
      var NEXT_TURN_ACTIONS = [
        { id: 'rollback_to_call', label: '回滚到指定轮次', kind: 'rollback', variant: 'secondary' },
        { id: 'compact_from_call', label: '从指定轮次压缩', kind: 'compact', variant: 'secondary' },
      ];
      var lifecycle = { agent: null, _lastActionError: null };
      lifecycle.getNextTurnActions = function ${block.trim()};
    `);
    return ctx;
  }

  it('attaches the recorded error once, then clears it', () => {
    const ctx = loadGetNextTurnActions();
    ctx.run(`
      lifecycle.agent = { _callIndex: 1, _callCheckpoints: [
        { callIndex: 0 }, { callIndex: 1 },
      ] };
      lifecycle._lastActionError = 'rollbackToCall 失败';
    `);
    const first = ctx.run('lifecycle.getNextTurnActions()');
    assert.ok(first.every((action) => action.data.lastActionError === 'rollbackToCall 失败'),
      '失败原因随本轮 lease actions 携带');
    assert.equal(JSON.stringify(first[0].data.availableCallIndices), '[0,1]');

    const second = ctx.run('lifecycle.getNextTurnActions()');
    assert.ok(second.every((action) => !('lastActionError' in action.data)),
      '读后即清：下一次广播不再携带');
  });

  it('keeps returning undefined when no checkpoints exist', () => {
    const ctx = loadGetNextTurnActions();
    ctx.run('lifecycle.agent = { _callIndex: 0, _callCheckpoints: [] };');
    assert.equal(ctx.run('lifecycle.getNextTurnActions()'), undefined,
      '无回退点时不广播动作（回归：回退到空转录后输入面无动作 lease）');
  });
});
