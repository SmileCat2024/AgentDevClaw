/**
 * 编辑按钮竞态回归：慢 poll / 初始加载的旧快照不得覆盖 SSE 或本地写入。
 * 使用真实 SessionView、metadata commit、SSE 消费与聊天渲染，断言最终按钮，
 * 不只检查状态。通过受控 Promise 制造异步窗口，不访问浏览器或用户数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sourceBetween } from './helpers/frontend-vm.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const POLL_SRC = sourceBetween(
  load('public/src/app-main.js'),
  '// ── Runtime poll coordinator',
  '// ── Input request rendering → modules/input-render.js',
);

// ── mini DOM：行 / meta / 按钮最小可追踪桩 ─────────────────────────────
// 只需支撑 render() 的 innerHTML 落地与 syncRollbackActionButtons 的
// querySelector('.message-meta') / meta.querySelector('.message-action') /
// meta.insertAdjacentHTML('beforeend', html) / button.remove()。
function makeRowEl(html) {
  const row = {
    _html: String(html),
    className: 'message-row',
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    matches: () => false,
    dataset: {},
    style: {},
    _meta: null,
    querySelector(sel) {
      if (sel === '.message-meta') return this._meta;
      if (sel === '.message-content') return { id: /id="(msg-\d+)"/.exec(this._html)?.[1] || '' };
      return null;
    },
    querySelectorAll: () => [],
    insertAdjacentHTML() {},
    remove() {},
  };
  const mkButton = () => ({
    _removed: false,
    setAttribute() {},
    style: {},
    remove() { this._removed = true; row._meta._button = null; },
  });
  row._meta = {
    // 编辑按钮与复制按钮的区分：编辑按钮的 class 是
    // "message-action message-icon-action"，复制按钮只有 message-icon-action。
    _button: row._html.includes('message-action message-icon-action') ? mkButton() : null,
    querySelector(sel) {
      if (sel === '.message-action') return this._button && !this._button._removed ? this._button : null;
      return null;
    },
    insertAdjacentHTML(_pos, insertHtml) {
      if (String(insertHtml).includes('message-action')) this._button = mkButton();
    },
  };
  return row;
}

function makeContainer() {
  return {
    _rows: [],
    rebuildCount: 0,
    set innerHTML(html) {
      const chunks = String(html).split(/(?=<div class="message-row)/);
      this._rows = chunks
        .filter((chunk) => chunk.startsWith('<div class="message-row'))
        .map((chunk) => makeRowEl(chunk));
      this.rebuildCount += 1;
    },
    get innerHTML() { return ''; },
    get lastElementChild() { return this._rows[this._rows.length - 1] || null; },
    querySelector(sel) {
      if (sel === '.message-row') return this._rows[0] || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.message-row' || String(sel).endsWith('.message-row')) return [...this._rows];
      return [];
    },
    insertAdjacentHTML(_pos, html) {
      const chunks = String(html).split(/(?=<div class="message-row)/);
      for (const chunk of chunks) {
        if (chunk.startsWith('<div class="message-row')) this._rows.push(makeRowEl(chunk));
      }
    },
    getElementsByTagName: () => [],
    scrollTop: 0,
    style: {},
    dataset: {},
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
  };
}

function createChatSandbox() {
  const container = makeContainer();
  const noop = () => undefined;
  const base = {
    window: {},
    container,
    currentMessages: [],
    currentInputRequests: [],
    currentRuntimeAgentId: 'rt-1',
    focusedAgentId: null,
    allAgents: [],
    _switchEpoch: 0,
    followLatestEnabled: false,
    showChatProcess: true,
    _userExpandedMsgs: new Set(),
    _userCollapsedMsgs: new Set(),
    _userExpandedReasoning: [],
    // chat-renderer / commitMetadataUpdate 的自由标识符桩（Proxy 兜底之外
    // 需要真实语义的几个）
    renderMarkdown: (s) => String(s ?? ''),
    escapeHtml: (s) => String(s ?? ''),
    t: (s) => String(s ?? ''),
    prependTimeSeparatorHtml: (_messages, _index, rowHtml) => rowHtml,
    renderUserImages: () => '',
    runWithSuppressedChatViewportObservers: (fn) => fn(),
    setCurrentHookInspector: noop,
    // updateChatProcessToggle 的空守卫需要 falsy（Proxy 兜底的 noop 函数
    // 是 truthy，会绕过守卫后在 classList 上崩溃）
    chatProcessToggle: null,
    __clawAuthReady: new Promise(() => {}),
    GenUIPanel: null,
    BgPanel: null,
    loadFeatureTemplateMap: async () => {},
    loadAgentDetail: async () => {},
    console: { ...console, error: (...args) => { throw new Error(args.map(String).join(' ')); } },
    setTimeout: () => 1,
    clearTimeout: noop,
    prebuiltSessionSwitchInFlight: false,
    _lastChoiceAlertCheckAt: Date.now(),
    FEATURE_TEMPLATE_MAP: { loaded: true },
    lastAgentListRefreshAt: Date.now(),
    _lastWsSessionRefreshAt: Date.now(),
    attachMessagesTimestamps: (messages) => messages,
    normalizeOverviewSnapshot: (value) => value,
    getOverviewSignature: JSON.stringify,
    normalizeTodoPlan: (value) => value,
    getTodoPlanSignature: JSON.stringify,
    activeFeaturePanel: null,
    setCurrentOverviewSnapshot(value) {
      base.currentOverviewSnapshot = value;
      base.currentOverviewSignature = JSON.stringify(value);
    },
    setCurrentTodoPlan(value) {
      base.currentTodoPlan = value;
      base.currentTodoPlanSignature = JSON.stringify(value);
    },
  };
  // Proxy 兜底（同 frontend-chat-render-signature.test.js）：未声明的项目级
  // 自由标识符落到 no-op，宿主真实全局（Map/JSON 等）透传。
  const sandbox = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in globalThis) return globalThis[prop];
      return noop;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
    has() { return true; },
  });
  base.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(load('public/src/modules/session-view-state.js'), sandbox, { filename: 'session-view-state.js' });
  vm.runInContext(load('public/src/modules/input-helpers.js'), sandbox, { filename: 'input-helpers.js' });
  vm.runInContext(load('public/src/modules/chat-renderer.js'), sandbox, { filename: 'chat-renderer.js' });
  vm.runInContext(POLL_SRC, sandbox, { filename: 'app-main.js#poll' });
  vm.runInContext(load('public/src/modules/sse-client.js'), sandbox, { filename: 'sse-client.js' });
  vm.runInContext(load('public/src/modules/agent-data-loader.js'), sandbox, { filename: 'agent-data-loader.js' });
  return { sandbox, container };
}

// ── 场景数据 ───────────────────────────────────────────────────────────
// 4 条消息、无错误聚合组（错误组错位是另一缺陷：refresh 也救不回，与"刷新
// 恢复"的症状不符，故本复现聚焦陈旧响应覆盖）。
const LEASE = {
  requestId: 'req-lease-1',
  mode: 'text',
  actions: [{ id: 'rollback_to_call', data: { availableCallIndices: [0, 1] } }],
};
const MSGS = [
  { role: 'user', content: 'u0', turn: 0 },
  { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'u2', turn: 1 },
  { role: 'assistant', content: 'a3' },
];

const rowHasEditButton = (row) => !!(row._meta._button && !row._meta._button._removed);

test('控制组：运行中渲染（无 lease）→ 事件路径 commit → user 行出现编辑按钮', () => {
  const { sandbox, container } = createChatSandbox();
  sandbox.currentMessages = MSGS;
  sandbox.currentInputRequests = [];
  sandbox.render(MSGS);
  assert.equal(container._rows.length, 4);
  container._rows.forEach((row) => assert.equal(rowHasEditButton(row), false, '无 lease 时不应有编辑按钮'));

  // 运行结束：SSE input-requests 帧到达（sse-client handleInputRequestsEvent
  // 的真实路径：capture → commitMetadataUpdate）
  const evtToken = sandbox.captureSessionViewToken('rt-1');
  const committed = sandbox.commitMetadataUpdate(evtToken, { inputRequestsRaw: [LEASE] });
  assert.equal(committed, true, '事件路径 token 应有效');
  assert.equal(rowHasEditButton(container._rows[0]), true, 'user(u0/turn0) 应有编辑按钮');
  assert.equal(rowHasEditButton(container._rows[1]), false, 'assistant 行不应有编辑按钮');
  assert.equal(rowHasEditButton(container._rows[2]), true, 'user(u2/turn1) 应有编辑按钮');
  assert.equal(rowHasEditButton(container._rows[3]), false, 'assistant 行不应有编辑按钮');
});

test('回归：陈旧 poll 响应不能覆盖事件已写入的 lease，编辑按钮保持可见', () => {
  const { sandbox, container } = createChatSandbox();
  sandbox.currentMessages = MSGS;
  sandbox.currentInputRequests = [];
  sandbox.render(MSGS);

  // poll 全量周期开始（SSE 掉线 / forceFull 对账轮）：fetch 派发时刻早于
  // lease 创建，响应将是 []。token 捕获于周期开始。
  const pollToken = sandbox.captureSessionViewToken('rt-1');

  // 运行结束、SSE 重连：重放的 input-requests 帧先 commit（真实时序：
  // handleInputRequestsEvent → commitMetadataUpdate）
  const evtToken = sandbox.captureSessionViewToken('rt-1');
  assert.equal(sandbox.commitMetadataUpdate(evtToken, { inputRequestsRaw: [LEASE] }), true);
  assert.equal(rowHasEditButton(container._rows[0]), true, '事件到达后按钮已画好');
  assert.equal(rowHasEditButton(container._rows[2]), true);

  // 慢 poll 的视图身份仍有效，但输入请求已被事件更新，不得回退。
  const staleCommitted = sandbox.commitMetadataUpdate(pollToken, { inputRequestsRaw: [] });
  assert.equal(staleCommitted, true, '只丢弃过期的输入维度，不废弃整批数据');
  assert.equal(sandbox.getRollbackInputRequest().requestId, LEASE.requestId);
  assert.equal(rowHasEditButton(container._rows[0]), true, '旧响应不能移除编辑按钮');
  assert.equal(rowHasEditButton(container._rows[2]), true, '旧响应不能移除编辑按钮');
  assert.equal(sandbox.currentInputRequests[0], LEASE);
});

test('错误聚合后编辑按钮仍绑定实际 user 消息，而不是 DOM 行下标', () => {
  const { sandbox, container } = createChatSandbox();
  const error = content => ({ role: 'assistant', content,
    execution: { status: 'failed', error: { category: 'server_error' } } });
  sandbox.currentMessages = [MSGS[0], error('first'), error('second'), MSGS[2], MSGS[3]];
  sandbox.render(sandbox.currentMessages);
  assert.equal(container._rows.length, 4, '两条错误合并为一行');
  emitInput(sandbox, [LEASE]);
  assert.equal(rowHasEditButton(container._rows[0]), true);
  assert.equal(rowHasEditButton(container._rows[1]), false, '聚合错误行没有编辑按钮');
  assert.equal(rowHasEditButton(container._rows[2]), true, 'DOM 行 2 对应消息 3 的 user');
  assert.equal(rowHasEditButton(container._rows[3]), false, 'assistant 不能冒领 user 编辑按钮');
});

test('刷新恢复：全新加载（等价刷新）带 lease 全量渲染 → 按钮正确', () => {
  const { sandbox, container } = createChatSandbox();
  sandbox.currentMessages = MSGS;
  sandbox.currentInputRequests = [LEASE]; // loadAgentData 全量拉取的结果
  sandbox.render(MSGS);
  assert.equal(rowHasEditButton(container._rows[0]), true);
  assert.equal(rowHasEditButton(container._rows[2]), true);
  assert.equal(rowHasEditButton(container._rows[1]), false);
  assert.equal(rowHasEditButton(container._rows[3]), false);
});

test('顺序正确时无回归：poll（[]）先提交、事件（lease）后提交 → 按钮在', () => {
  const { sandbox, container } = createChatSandbox();
  sandbox.currentMessages = MSGS;
  sandbox.currentInputRequests = [];
  sandbox.render(MSGS);

  const pollToken = sandbox.captureSessionViewToken('rt-1');
  sandbox.commitMetadataUpdate(pollToken, { inputRequestsRaw: [] }); // 内容相同，仍提交观察版本
  const evtToken = sandbox.captureSessionViewToken('rt-1');
  sandbox.commitMetadataUpdate(evtToken, { inputRequestsRaw: [LEASE] });

  assert.equal(rowHasEditButton(container._rows[0]), true);
  assert.equal(rowHasEditButton(container._rows[2]), true);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function emitInput(sandbox, data, runtimeId = 'rt-1') {
  sandbox.handleInputRequestsEvent({ agentId: runtimeId, data });
}

for (const producer of ['poll', 'load']) {
  test(`${producer} 真实异步链：旧空快照晚于 SSE，最终保留编辑按钮和其他数据`, { timeout: 1000 }, async () => {
    const { sandbox, container } = createChatSandbox();
    sandbox.currentMessages = MSGS;
    sandbox.render(MSGS);
    const inputBody = deferred();
    const inputRequested = deferred();
    const oldMessages = deferred();
    sandbox.isUiOnlyAgentId = () => false;
    sandbox.refreshCurrentRuntimeStatus = async () => null;
    sandbox.renderCurrentMainView = () => sandbox.render(sandbox.currentMessages);
    sandbox.fetch = async (url) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (url.endsWith('/input-requests')) {
          inputRequested.resolve();
          return inputBody.promise;
        }
        if (url.endsWith('/messages')) return oldMessages.promise;
        if (url.endsWith('/overview')) return { modelName: 'loaded-model' };
        if (url.endsWith('/todo')) return { tasks: [] };
        return [];
      },
    });
    const pending = producer === 'poll' ? sandbox.runPollCycle() : sandbox.loadAgentData('rt-1');
    // poll 先等消息；load 并行读 body。两者都将 input 响应挂起至 SSE 之后。
    oldMessages.resolve({ messages: MSGS });
    await inputRequested.promise;
    emitInput(sandbox, [LEASE]);
    assert.equal(rowHasEditButton(container._rows[0]), true);
    inputBody.resolve([]);
    await pending;
    assert.equal(sandbox.currentInputRequests[0].requestId, LEASE.requestId);
    assert.equal(sandbox.currentOverviewSnapshot.modelName, 'loaded-model', '其他维度继续提交');
    assert.equal(rowHasEditButton(container._rows[0]), true);
    assert.equal(rowHasEditButton(container._rows[2]), true);
  });
}

for (const change of ['empty-event', 'same-lease-event', 'local-clear']) {
  test(`${change}：新观察阻止旧 lease 复活，后续新请求仍可更新`, () => {
    const { sandbox, container } = createChatSandbox();
    sandbox.currentMessages = MSGS;
    sandbox.render(MSGS);
    emitInput(sandbox, [LEASE]);
    const oldToken = sandbox.captureSessionViewToken('rt-1');
    const keepLease = change === 'same-lease-event';
    if (change === 'local-clear') sandbox.applySessionViewPatch({ inputRequests: [] });
    else if (keepLease) emitInput(sandbox, [LEASE]);
    else {
      emitInput(sandbox, []);
      emitInput(sandbox, []); // 内容未变也必须推进观察版本。
    }
    const oldLease = { ...LEASE, requestId: 'old-lease', actions: [] };
    sandbox.commitMetadataUpdate(oldToken, { inputRequestsRaw: [oldLease] });
    assert.equal(sandbox.currentInputRequests.length, keepLease ? 1 : 0);
    if (keepLease) assert.equal(sandbox.currentInputRequests[0].requestId, LEASE.requestId);
    sandbox.updateRollbackActionVisibility();
    assert.equal(rowHasEditButton(container._rows[0]), keepLease);

    const freshToken = sandbox.captureSessionViewToken('rt-1');
    sandbox.commitMetadataUpdate(freshToken, { inputRequestsRaw: keepLease ? [] : [LEASE] });
    assert.equal(rowHasEditButton(container._rows[0]), !keepLease, '新请求可正常创建/清除按钮');
  });
}

test('相同空事件也使在途旧 lease 失效；非焦点事件不干扰当前快照', () => {
  const { sandbox } = createChatSandbox();
  const token = sandbox.captureSessionViewToken('rt-1');
  emitInput(sandbox, []);
  sandbox.commitMetadataUpdate(token, { inputRequestsRaw: [LEASE] });
  assert.equal(sandbox.currentInputRequests.length, 0);
  const fresh = sandbox.captureSessionViewToken('rt-1');
  emitInput(sandbox, [], 'other-runtime');
  sandbox.commitMetadataUpdate(fresh, { inputRequestsRaw: [LEASE] });
  assert.equal(sandbox.currentInputRequests[0].requestId, LEASE.requestId);
});
