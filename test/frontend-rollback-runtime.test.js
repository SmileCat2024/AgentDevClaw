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
 * 沙箱加载真实 input-helpers.js / rollback-dialog.js（与 index.html 加载序
 * 语义一致）；mini DOM 方式参考 frontend-input-convergence.test.js。
 */

import fs from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// ── Mini DOM（含 addEventListener 记录，供对话框按钮点击路径） ────────────

function matchesSimple(part, el) {
  if (part.startsWith('.')) return el.classList.contains(part.slice(1));
  if (part.startsWith('#')) return el.id === part;
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

// ── 沙箱工厂：真实 input-helpers.js + rollback-dialog.js ──────────────────

function createRollbackSandbox({ messages = [], inputRequests = [] } = {}) {
  const doc = createMiniDocument();
  const inputContainer = createMiniElement('div', doc);
  inputContainer.id = 'user-input-container';
  doc.body.appendChild(inputContainer);
  const choiceContainer = createMiniElement('div', doc);
  choiceContainer.id = 'choice-input-container';
  doc.body.appendChild(choiceContainer);

  const toasts = [];
  const calls = {
    interruptAgent: [],
    submitInputAction: [],
    notifyInputSurfaceChanged: 0,
  };

  const ctx = createFrontendSandbox({
    document: doc,
    currentLanguage: 'zh',
    currentRuntimeAgentId: 'agent-1',
    currentMessages: messages,
    currentInputRequests: inputRequests,
    ClawToast: {
      show: (opts) => { toasts.push(opts); },
    },
    isRuntimeCalling: () => false,
    isInterruptSuppressed: () => false,
    interruptAgent: async () => { calls.interruptAgent.push(Date.now()); return { ok: true }; },
    submitInputAction: async (requestId, actionId, payload, runtimeId, viewToken) => {
      calls.submitInputAction.push({ requestId, actionId, payload, runtimeId });
    },
    captureSessionViewToken: (runtimeId) => ({ runtimeId }),
    isSessionViewTokenCurrent: () => true,
    commitSessionViewState: (token, fn) => fn(),
    _getSessionInputCacheKey: () => 'test-session',
    notifyInputSurfaceChanged: () => { calls.notifyInputSurfaceChanged += 1; },
    detachTransientInputContent: () => {},
    hidePersistentComposerCard: () => {},
    applySessionViewPatch: (patch) => {
      if (patch && Array.isArray(patch.inputRequests)) {
        ctx.currentInputRequests = patch.inputRequests;
      }
    },
    runWithSuppressedChatViewportObservers: (fn) => fn(),
  });

  ctx.loadSource('public/src/modules/input-helpers.js');
  ctx.loadSource('public/src/modules/rollback-dialog.js');
  // loadSource 的 function 声明会覆盖 overrides 先注入的同名 stub（如
  // submitInputAction），记录型 stub 必须在加载后重新接管。
  ctx.submitInputAction = async (requestId, actionId, payload, runtimeId, viewToken) => {
    calls.submitInputAction.push({ requestId, actionId, payload, runtimeId });
  };
  // 等待参数注入短周期（生产默认 400ms / 30s，测试不等待真实时长）
  ctx.run('_rollbackLeasePollIntervalMs = 1; _rollbackLeaseWaitTimeoutMs = 60;');

  ctx.state = { doc, inputContainer, choiceContainer, toasts, calls };
  return ctx;
}

function leaseWithIndices(indices) {
  return [{
    requestId: `lease-${indices.join('-')}`,
    actions: [{ id: 'rollback_to_call', data: { availableCallIndices: indices } }],
  }];
}

// ── canRollbackMessage：lease 缺最新轮的竞态防御 ──────────────────────────

describe('canRollbackMessage race guard (latest user message relaxation)', () => {
  it('latest user turn stays rollbackable when lease indices miss it', () => {
    const ctx = createRollbackSandbox({
      inputRequests: leaseWithIndices([0]),
      messages: [
        { role: 'user', turn: 0, content: 'first' },
        { role: 'assistant', turn: 0 },
        { role: 'user', turn: 1, content: 'second' },
        { role: 'assistant', turn: 1 },
      ],
    });
    assert.equal(ctx.run('canRollbackMessage(currentMessages[2])'), true,
      '最新用户消息（被打断轮）即使不在 availableCallIndices 也可回退');
    assert.equal(ctx.run('canRollbackMessage(currentMessages[0])'), true,
      '在列表内的轮次照常可回退');
  });

  it('non-latest user turns stay disabled when missing from indices', () => {
    const ctx = createRollbackSandbox({
      inputRequests: leaseWithIndices([0, 2]),
      messages: [
        { role: 'user', turn: 0, content: 'a' },
        { role: 'user', turn: 1, content: 'b' },
        { role: 'user', turn: 2, content: 'c' },
      ],
    });
    assert.equal(ctx.run('canRollbackMessage(currentMessages[1])'), false,
      '非最新的中间轮（不在列表）保持禁用——放宽只覆盖最新用户消息');
    assert.equal(ctx.run('canRollbackMessage(currentMessages[0])'), true);
    assert.equal(ctx.run('canRollbackMessage(currentMessages[2])'), true,
      '最新轮在列表内照常可回退');
  });

  it('legacy lease without indices still allows all; handoff seeds stay disabled', () => {
    const ctx = createRollbackSandbox({
      inputRequests: [{ requestId: 'legacy', actions: [{ id: 'rollback_to_call' }] }],
      messages: [
        { role: 'user', turn: 0, source: 'handoff-seed', content: 'seed' },
        { role: 'user', turn: 1, content: 'real' },
      ],
    });
    assert.equal(ctx.run('canRollbackMessage(currentMessages[0])'), false,
      'handoff seed 永不可回退');
    assert.equal(ctx.run('canRollbackMessage(currentMessages[1])'), true,
      '无 availableCallIndices 时回退全允许（旧行为回归）');
  });
});

// ── requestRollbackEdit：无 lease 分流 ────────────────────────────────────

describe('requestRollbackEdit routing without a lease', () => {
  it('idle runtime (no lease, not calling) yields an explicit toast', () => {
    const ctx = createRollbackSandbox({ messages: [{ role: 'user', turn: 0, content: 'hi' }] });
    ctx.run('window.requestRollbackEdit(0)');
    assert.equal(ctx.state.toasts.length, 1, '静默返回被替换为明确反馈');
    assert.equal(ctx.state.toasts[0].status, 'error');
    assert.equal(ctx.state.choiceContainer.children.length, 0, '不弹对话框');
  });

  it('running turn (no lease, calling) opens the runtime-mode dialog', () => {
    const ctx = createRollbackSandbox({
      messages: [{ role: 'user', turn: 0, content: 'hi' }],
    });
    ctx.isRuntimeCalling = () => true;
    ctx.run('window.requestRollbackEdit(0)');
    assert.equal(ctx.state.toasts.length, 0, '运行期不是错误，打开对话框');
    const card = ctx.state.choiceContainer.children[0];
    assert.ok(card, '对话框渲染到交互面');
    assert.ok(card.querySelector('.user-choice-running-hint'),
      '运行期模式显示打断提示行');
  });

  it('interrupting runtime (suppression sticky) also counts as running', () => {
    const ctx = createRollbackSandbox({
      messages: [{ role: 'user', turn: 0, content: 'hi' }],
    });
    ctx.isInterruptSuppressed = () => true;
    ctx.run('window.requestRollbackEdit(0)');
    assert.ok(ctx.state.choiceContainer.children[0],
      '打断进行中（lease 未重发）同样进入运行期对话框');
  });
});

// ── 运行期确认链路：打断 → 等 lease → 提交 ────────────────────────────────

describe('runtime-mode confirm path (interrupt then wait for the next lease)', () => {
  async function clickRollback(ctx) {
    ctx.run('window.requestRollbackEdit(0)');
    const card = ctx.state.choiceContainer.children[0];
    const button = card.querySelector('[data-mode="rollback"]');
    await button.dispatch('click');
  }

  it('confirm interrupts the turn and submits with the refreshed lease', async () => {
    const ctx = createRollbackSandbox({
      messages: [{ role: 'user', turn: 0, content: 'draft me' }],
    });
    ctx.isRuntimeCalling = () => true;
    // 打断后（首个轮询间隔后）输入循环重发携带回退动作的 lease
    const refreshed = leaseWithIndices([0]);
    ctx.run(`
      setTimeout(() => { currentInputRequests = ${JSON.stringify(refreshed)}; }, 2);
    `);
    await clickRollback(ctx);

    assert.equal(ctx.state.calls.interruptAgent.length, 1, '确认后自动打断当前轮次');
    assert.equal(ctx.state.calls.submitInputAction.length, 1, '等待到 lease 后提交回退动作');
    const submitted = ctx.state.calls.submitInputAction[0];
    assert.equal(submitted.requestId, 'lease-0', '使用重发后的 lease requestId');
    assert.equal(submitted.actionId, 'rollback_to_call');
    assert.equal(submitted.payload.callIndex, 0);
    assert.equal(submitted.payload.draftInput, 'draft me');
    assert.ok(ctx.state.toasts.some((t) => t.status === 'info' && t.title.includes('打断')),
      '打断动作对用户透明（info toast）');
  });

  it('waits through empty polls until the refreshed lease arrives', async () => {
    const ctx = createRollbackSandbox({
      messages: [{ role: 'user', turn: 0, content: 'x' }],
    });
    // 打断已发出、收尾中（suppression 粘性态）：不再重复打断，直接等终态
    ctx.isInterruptSuppressed = () => true;
    // 数个轮询周期后才出现 lease（模拟打断收尾耗时）
    let polls = 0;
    ctx.getPrimaryInputRequest = null; // 使用 fallback（读 currentInputRequests）
    ctx.run(`
      var polls = 0;
      const _tick = setInterval(() => {
        polls += 1;
        if (polls >= 3) {
          currentInputRequests = [{ requestId: 'late-lease', actions: [
            { id: 'rollback_to_call', data: { availableCallIndices: [0] } },
          ] }];
          clearInterval(_tick);
        }
      }, 3);
    `);
    await clickRollback(ctx);
    assert.equal(ctx.state.calls.submitInputAction.length, 1);
    assert.equal(ctx.state.calls.submitInputAction[0].requestId, 'late-lease');
  });

  it('times out with an explicit toast when no lease ever arrives', async () => {
    const ctx = createRollbackSandbox({
      messages: [{ role: 'user', turn: 0, content: 'x' }],
    });
    // 打断已发出、收尾中：等待重发 lease，但永远不到达 → 超时
    ctx.isInterruptSuppressed = () => true;
    await clickRollback(ctx);
    assert.equal(ctx.state.calls.submitInputAction.length, 0, '无 lease 不提交');
    assert.ok(ctx.state.toasts.some((t) => t.status === 'error' && t.title.includes('超时')),
      '超时给出明确 toast');
  });

  it('fails fast when the refreshed lease has no rollback targets', async () => {
    const ctx = createRollbackSandbox({
      messages: [{ role: 'user', turn: 0, content: 'x' }],
    });
    ctx.isInterruptSuppressed = () => true;
    ctx.run(`
      setTimeout(() => {
        currentInputRequests = [{ requestId: 'bare-lease', actions: [] }];
      }, 2);
    `);
    await clickRollback(ctx);
    assert.equal(ctx.state.calls.submitInputAction.length, 0);
    assert.ok(ctx.state.toasts.some((t) => t.status === 'error' && t.title.includes('可回退')),
      'lease 无回退点时明确提示');
  });

  it('aborts without submitting when the session is switched away while waiting', async () => {
    const ctx = createRollbackSandbox({
      messages: [{ role: 'user', turn: 0, content: 'x' }],
    });
    ctx.isInterruptSuppressed = () => true;
    // 等待期间视图切走：isSessionViewTokenCurrent 返回 false
    ctx.isSessionViewTokenCurrent = () => false;
    ctx.run(`
      setTimeout(() => {
        currentInputRequests = [{ requestId: 'other-session-lease', actions: [
          { id: 'rollback_to_call', data: { availableCallIndices: [0] } },
        ] }];
      }, 2);
    `);
    await clickRollback(ctx);
    assert.equal(ctx.state.calls.submitInputAction.length, 0,
      '会话切走后绝不把旧会话的回退提交出去');
  });

  it('aborts immediately when the interrupt request itself fails', async () => {
    const ctx = createRollbackSandbox({
      messages: [{ role: 'user', turn: 0, content: 'x' }],
    });
    ctx.isRuntimeCalling = () => true;
    ctx.interruptAgent = async () => ({ ok: false, reason: 'request-failed' });
    await clickRollback(ctx);
    assert.equal(ctx.state.calls.submitInputAction.length, 0,
      '打断失败（轮次不会终止）时放弃等待');
    assert.equal(ctx.state.toasts.filter((t) => t.title.includes('超时')).length, 0,
      '不经历 30s 超时才发现失败');
  });
});

// ── _ensureRollbackLeaseAfterInterrupt：重入保护 ──────────────────────────

describe('rollback lease await re-entrancy guard', () => {
  it('second invocation while one await is in flight gets a busy toast and null', async () => {
    const ctx = createRollbackSandbox();
    let releaseInterrupt;
    const gate = new Promise((resolve) => { releaseInterrupt = resolve; });
    ctx.interruptAgent = async () => { await gate; return { ok: true }; };
    ctx.isRuntimeCalling = () => true;

    const first = ctx.run('_ensureRollbackLeaseAfterInterrupt("agent-1", null)');
    // 首次调用挂在 interruptAgent 的 gate 上，此时发起第二次
    const second = await ctx.run('_ensureRollbackLeaseAfterInterrupt("agent-1", null)');
    assert.equal(second, null, '重入直接返回 null');
    assert.ok(ctx.state.toasts.some((t) => t.title.includes('等待轮次结束')),
      '重入给出「已在等待」提示');

    releaseInterrupt();
    // 无 lease 到达 → 首次调用超时返回 null（等待周期已注入为 1ms/60ms）
    assert.equal(await first, null);
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
