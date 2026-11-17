/**
 * 编辑按钮竞态回归：慢 poll / 初始加载的旧快照不得覆盖 SSE 或本地写入。
 * 使用真实 SessionView、metadata commit、SSE 消费与聊天渲染，断言最终按钮，
 * 不只检查状态。通过受控 Promise 制造异步窗口，不访问浏览器或用户数据。
 *
 * 加载路线（P2 跨批测试迁移：真实 import，不再对 ESM 模块做源码切片/手工实例化）：
 *   - classic 相（`sandbox.loadSource`）：action-dispatcher → app-core →
 *     session-view-state → chat-renderer → sidebar-render → runtime-status →
 *     todo-plan → rollback-dialog（状态键注册壳）→ app-main。它们仍是 classic
 *     唯一实现，提供聊天渲染、宿主工厂与状态容器。
 *   - 输入面域（回退按钮可见性 / 过程显隐）已迁 ESM，经 `c.load` 真实 import；
 *     chat-renderer 与 app-main 的调用点仍是 classic 裸调，经桥键解析。
 *   - ESM 相（`c.load`）：agent-data-loader（两个 host 工厂 seam）、sse-client
 *     （SSE 输入帧的真实消费方）、message-timeline / overview-data（提交链的
 *     normalizer 桥键）、poll-cycle-host（runPollCycle）、session-data-loader-host
 *     （loadAgentData）——这些图的静态依赖
 *     （session-view-commit / metadata-commit / message-probe / poll-* ）在图内
 *     真实执行并各自 claim 自己的桥域，无需测试手工 new 出来 mixin 进沙箱。
 *   - SSE 输入帧一律走真实公开入口：bootSseClient() + MockEventSource 事件帧。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const SSE_CLIENT = 'public/src/modules/sse-client.js';
const POLL_CYCLE_HOST = 'public/src/modules/poll-cycle-host.js';
const SESSION_DATA_LOADER_HOST = 'public/src/modules/session-data-loader-host.js';
const MESSAGE_TIMELINE = 'public/src/modules/message-timeline.js';
const RECAP_HINT = 'public/src/modules/recap-hint.js';
const OVERVIEW_DATA = 'public/src/modules/overview-data.js';
// 输入面域（P2 输入面收尾批次已迁 ESM）：回退按钮可见性与过程显隐的真实实现，
// chat-renderer / app-main 的 classic 消费方经桥键取用。
const INPUT_ACTIONS = 'public/src/modules/input-actions.js';
const CHAT_PROCESS_VISIBILITY = 'public/src/modules/chat-process-visibility.js';

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
      if (sel === '.message-content') {
        // 折叠同步会读 classList / scrollHeight 并在写入相位改 class
        return {
          id: /id="(msg-\d+)"/.exec(this._html)?.[1] || '',
          classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
          style: {},
          scrollHeight: 0,
          dataset: {},
          querySelector() { return null; },
          querySelectorAll() { return []; },
          getAttribute() { return null; },
          setAttribute() {},
          appendChild() {},
          insertAdjacentHTML() {},
          remove() {},
        };
      }
      return null;
    },
    querySelectorAll: () => [],
    insertAdjacentHTML() {},
    remove() {},
  };
  const mkButton = () => ({
    _removed: false,
    setAttribute() {},
    // syncRollbackActionButtons 经 dataset 重写动作指向（data-action / data-args）
    dataset: {},
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
    // lazy-tool-content（过程窗口分级）在装载期给聊天容器挂滚动监听
    addEventListener() {}, removeEventListener() {},
  };
}

function makeElement() {
  return {
    innerHTML: '', textContent: '', value: '', className: '', style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, insertBefore() {}, remove() {}, replaceWith() {},
    focus() {}, blur() {}, click() {}, select() {}, setSelectionRange() {}, scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    closest() { return null; }, matches() { return false; }, contains() { return false; },
    insertAdjacentHTML() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    getAttribute() { return null; }, setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; },
    getElementsByTagName() { return []; }, getElementsByClassName() { return []; },
  };
}

/** app-main 顶层依赖的 classic 全局；__clawAuthReady 永不 resolve 挡住页面 boot。 */
const APP_MAIN_PRELUDE = `
  getCurrentHostAgentRecord = () => ({ id: 'agent-1' });
  renderAgentList = () => {};
  renderCurrentMainView = () => {};
  renderFeaturePanel = () => {};
  resetRuntimeStatusForSwitch = () => {};
  applyLanguage = () => {};
  applyTheme = () => {};
  isChatSurfaceActive = () => true;
  getRuntimeAwareAgentRecord = () => null;
  notifyChatViewportMutation = () => {};
  isRemoteNamespaceAgentId = (value) => typeof value === 'string' && value.startsWith('remote:');
  notifyInputSurfaceChanged = () => {};
  getAgentRuntimeId = (agent) => agent?.id || '';
  window.__clawAuthReady = new Promise(() => {});
`;

class MockEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.onerror = null;
    MockEventSource.instances.push(this);
  }
  addEventListener(kind, fn) {
    if (!this.listeners.has(kind)) this.listeners.set(kind, []);
    this.listeners.get(kind).push(fn);
  }
  close() { this.readyState = 2; }
  emit(kind, data) {
    this.readyState = 1;
    for (const fn of this.listeners.get(kind) || []) fn({ data: JSON.stringify(data) });
  }
}

const latestSource = () => MockEventSource.instances[MockEventSource.instances.length - 1] || null;

/** 在「非预期 warn/error 必须为空」的守卫下跑一个 case（失败也要还原 console）。 */
async function withNoiseClean(label, fn) {
  const noise = captureConsoleNoise(NOISE_ALLOWED);
  try {
    const result = await fn();
    noise.assertClean(label);
    return result;
  } finally {
    noise.restore();
  }
}

/**
 * 建立一个「真实 SessionView + 真实 metadata commit + 真实 SSE 消费 + 真实聊天
 * 渲染」的用例上下文。每个用例独占一份 window 与一张 ESM 图。
 */
async function withChatCase(fn) {
  const container = makeContainer();
  const document = {
    // app-core 的 `const container` 与 chat-renderer 的渲染目标都是它
    getElementById: (id) => (id === 'chat-container' ? container : makeElement()),
    createElement: () => makeElement(),
    createTextNode: (text) => ({ textContent: text }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    getElementsByTagName: () => [], getElementsByClassName: () => [],
    body: makeElement(), head: makeElement(), documentElement: makeElement(),
    readyState: 'complete',
  };
  const fetchStub = async (url) => {
    const target = String(url);
    if (target.includes('/protoclaw/get_connected_agents')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (target === '/api/agents') return { ok: true, status: 200, json: async () => ({ agents: [] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  return withP2EsmCase({
    classic: (sandbox) => {
      // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂（含 app-main / app-ui
      // 提供的 runtime-switch / poll / workspace-surface）都是生产实现，首屏 boot 与
      // 周期排程由基座关掉。基座之外按 index.html 顺序补本用例需要的真实 classic：
      // 过程显隐按钮同步（input-helpers）、聊天渲染链（chat-renderer）、todo / 回退
      // 对话框状态。
      prepareClassicSandbox(sandbox);
      sandbox.loadSource('public/src/modules/chat-viewport.js');
      sandbox.loadSource('public/src/modules/chat-renderer.js');
      // todo-plan 已迁 ESM（P4 L1）：classic 相只补 markdown-utils 的 classic 实现，
      // 模块本体在 async 相 c.load。
      sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
      // input-helpers / rollback-dialog 已迁 ESM（P4 T2）：两者都改由 async 相
      // c.load 装载（见下），classic 相不再有它们的脚本。
      // 用例的窄行为观察面（真源之后覆盖：app-main / app-ui 会定义同名入口）：
      // 侧栏列表与主视图渲染在执行期被各用例替换成记录器，这里先给出无操作默认。
      sandbox.run(APP_MAIN_PRELUDE);
      // 线程暂存文本经交互域取自 classic 刷新引擎：按生产顺序装真实引擎，不复制宿主契约。
      sandbox.loadSource('public/src/modules/thread-store.js');
    },
    globals: {
      document,
      EventSource: MockEventSource,
      URLSearchParams,
      ClawToast: { show() {} },
      // 视口 / 工作区表面 / 跟随最新按钮：UI 落点，按既有注入面提供（原用例同款）
      runWithSuppressedChatViewportObservers: (fn) => fn(),
      consumePendingChatScrollRestore: () => null,
      clearProcessDistance: () => {},
      shouldRenderWorkspaceSurface: () => false,
      updateFollowLatestButton: () => {},
      // vendor 侧 markdown 解析器（真实标记渲染管线由 markdown-bootstrap 的 marked
      // 实例提供；本文件的断言只看编辑按钮，不需要完整标记渲染）
      marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: (markdown) => String(markdown ?? '') },
      hljs: { getLanguage: () => null, highlight: () => ({ value: '' }) },
      performance: { now: () => Date.now() },
      fetch: fetchStub,
      // 以下 classic 汇点不在本文件验收面内（聊天渲染 / 输入面 / 模型切换器等 UI
      // 落点），按既有注入面提供。
      _markAgentCallStartedForNotify: () => {},
      _syncPersistentInputUi: () => {},
      updateChatContextBar: () => {},
      updateInputModelSwitcher: () => {},
      updateThinkingEffortSwitcher: () => {},
      refreshCurrentRuntimeStatus: async () => null,
      refreshContextGuardStatus: async () => null,
      _syncPersistentActionButton: () => {},
      _syncQueueFromBackend: () => {},
      applyQueuedInputsTexts: () => {},
      _lastCallFinishTime: 0,
      _recapPendingTrigger: false,
      _maybeFetchRecap: () => {},
    },
  }, async (c) => withNoiseClean('rollback 竞态用例', async () => {
    // 输入面两件已迁 ESM（P4 T2）：过程显隐按钮同步（桥键
    // updateChatProcessToggle）与回退域状态键注册，必须先于消费它们的模块求值。
    await c.load('public/src/modules/rollback-dialog.js');
    await c.load('public/src/modules/input-helpers.js');
    // plan 快照归一 / 成对签名（已迁 ESM，P4 L1）。
    await c.load('public/src/modules/todo-plan.js');
    const orchestration = await c.load('public/src/modules/orchestration-state.js');
    // 输入面域：回退按钮可见性（syncRollbackActionButtons）与过程显隐
    const inputActions = await c.load(INPUT_ACTIONS);
    await c.load(CHAT_PROCESS_VISIBILITY);
    orchestration.setCurrentRuntimeAgentId('rt-1');
    // agent-data-loader（已迁 ESM）：session-data-loader / runtime-status-loader 的
    // host 工厂 seam，必须先于消费它们的 host 模块求值
    await c.load('public/src/modules/agent-data-loader.js');
    await c.load(MESSAGE_TIMELINE);
    // recap 域（P2 W2-3a 已迁 ESM）：app-main 轮询尾部的 trackRecap 经桥键调用
    // _trackRecapSessionPresence，真实依赖而不是让它落在 poll 的 catch 里
    await c.load(RECAP_HINT);
    await c.load(OVERVIEW_DATA);
    const sse = await c.load(SSE_CLIENT);
    const pollCycle = await c.load(POLL_CYCLE_HOST);
    const dataLoader = await c.load(SESSION_DATA_LOADER_HOST);
    MockEventSource.instances.length = 0;
    sse.bootSseClient();
    latestSource().emit('hello', { hello: true });
    return fn({ c, sse, pollCycle, dataLoader, container, inputActions });
  }));
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

/**
 * 本文件允许的既有生产诊断（逐条理由；其余任何 warn/error 一律失败）：
 *   - 【sidebar】empty connected snapshot：fixture 没有任何已连接 agent（connected
 *     与 viewer 两侧快照皆空）时 loadAgents 的稳态提示，不是失败。
 */
const NOISE_ALLOWED = [/^warn: \[sidebar\] empty connected snapshot/];

/**
 * 用例级控制台噪音捕获：production 的 `host.warn` 与 `promise.catch` 会把
 * 失败降级成 warn 输出（轮询 catch、probe .catch），测试若不看输出就可能带着
 * ReferenceError 变绿。这里在 case 内接管 console.warn / console.error，用例
 * 结束断言为空——不吞错、不靠捕获让测试绿。
 * @param {RegExp[]} [allowed] 明确允许的既有诊断（逐条给出理由）；其余一律算非预期。
 */
function captureConsoleNoise(allowed = []) {
  const entries = [];
  const original = { warn: console.warn, error: console.error };
  const record = (level) => (...args) => {
    const line = `${level}: ${args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ')}`;
    entries.push(line);
  };
  console.warn = record('warn');
  console.error = record('error');
  return {
    entries,
    restore() {
      console.warn = original.warn;
      console.error = original.error;
    },
    assertClean(label) {
      const unexpected = entries.filter((line) => !allowed.some((pattern) => pattern.test(line)));
      assert.deepEqual(unexpected, [],
        `${label} 不得出现非预期 warn/error 输出：\n${unexpected.join('\n')}`);
    },
  };
}

/** 运行结束：SSE input-requests 帧到达（sse-client 的真实消费路径）。 */
function emitInput(data, runtimeId = 'rt-1') {
  latestSource().emit('input-requests', { kind: 'input-requests', agentId: runtimeId, data });
}

const readJson = (c, expr) => JSON.parse(c.read(expr));

test('控制组：运行中渲染（无 lease）→ 事件路径 commit → user 行出现编辑按钮', async () => {
  await withChatCase(async ({ c, container }) => {
    c.read(`currentMessages = ${JSON.stringify(MSGS)}`);
    c.read('currentInputRequests = []');
    c.read(`render(currentMessages)`);
    assert.equal(container._rows.length, 4);
    container._rows.forEach((row) => assert.equal(rowHasEditButton(row), false, '无 lease 时不应有编辑按钮'));

    // 运行结束：SSE input-requests 帧到达（sse-client handleInputRequestsEvent
    // 的真实路径：capture → commitMetadataUpdate）
    emitInput([LEASE]);
    // 值契约而非引用同一性：input-requests 帧在真实链路上是 JSON 载荷
    // （MockEventSource.emit → JSON.stringify → sse-client JSON.parse），提交到
    // 会话视图的必然是结构副本。旧用例的 `currentInputRequests[0] === LEASE`
    // 依赖「直调 handler 传对象引用」这条测试内部通道；改走真实事件路由后，
    // 引用同一性不是产品契约，故断言租约的业务身份（requestId）与最终 DOM 结果，
    // 不为保住引用同一性而造内部 API。
    assert.equal(readJson(c, 'JSON.stringify(currentInputRequests)')[0].requestId, LEASE.requestId);
    assert.equal(rowHasEditButton(container._rows[0]), true, 'user(u0/turn0) 应有编辑按钮');
    assert.equal(rowHasEditButton(container._rows[1]), false, 'assistant 行不应有编辑按钮');
    assert.equal(rowHasEditButton(container._rows[2]), true, 'user(u2/turn1) 应有编辑按钮');
    assert.equal(rowHasEditButton(container._rows[3]), false, 'assistant 行不应有编辑按钮');
  });
});

test('回归：陈旧 poll 响应不能覆盖事件已写入的 lease，编辑按钮保持可见', async () => {
  await withChatCase(async ({ c, container, inputActions }) => {
    c.read(`currentMessages = ${JSON.stringify(MSGS)}`);
    c.read('currentInputRequests = []');
    c.read(`render(currentMessages)`);

    // poll 全量周期开始（SSE 掉线 / forceFull 对账轮）：fetch 派发时刻早于
    // lease 创建，响应将是 []。token 捕获于周期开始。
    c.read('globalThis.pollToken = captureSessionViewToken("rt-1")');

    // 运行结束、SSE 重连：重放的 input-requests 帧先 commit（真实时序：
    // handleInputRequestsEvent → commitMetadataUpdate）
    emitInput([LEASE]);
    assert.equal(rowHasEditButton(container._rows[0]), true, '事件到达后按钮已画好');
    assert.equal(rowHasEditButton(container._rows[2]), true);

    // 慢 poll 的视图身份仍有效，但输入请求已被事件更新，不得回退。
    const staleCommitted = c.read(`commitMetadataUpdate(pollToken, { inputRequestsRaw: [] })`);
    assert.equal(staleCommitted, true, '只丢弃过期的输入维度，不废弃整批数据');
    // 同上：事件帧是 JSON 副本，断言业务身份而不是对象引用
    assert.equal(inputActions.getRollbackInputRequest().requestId, LEASE.requestId);
    assert.equal(rowHasEditButton(container._rows[0]), true, '旧响应不能移除编辑按钮');
    assert.equal(rowHasEditButton(container._rows[2]), true, '旧响应不能移除编辑按钮');
    assert.equal(readJson(c, 'JSON.stringify(currentInputRequests)')[0].requestId, LEASE.requestId);
  });
});

test('错误聚合后编辑按钮仍绑定实际 user 消息，而不是 DOM 行下标', async () => {
  await withChatCase(async ({ c, container }) => {
    const error = (content) => ({ role: 'assistant', content,
      execution: { status: 'failed', error: { category: 'server_error' } } });
    const messages = [MSGS[0], error('first'), error('second'), MSGS[2], MSGS[3]];
    c.read(`currentMessages = ${JSON.stringify(messages)}`);
    c.read('render(currentMessages)');
    assert.equal(container._rows.length, 4, '两条错误合并为一行');
    emitInput([LEASE]);
    assert.equal(rowHasEditButton(container._rows[0]), true);
    assert.equal(rowHasEditButton(container._rows[1]), false, '聚合错误行没有编辑按钮');
    assert.equal(rowHasEditButton(container._rows[2]), true, 'DOM 行 2 对应消息 3 的 user');
    assert.equal(rowHasEditButton(container._rows[3]), false, 'assistant 不能冒领 user 编辑按钮');
  });
});

test('刷新恢复：全新加载（等价刷新）带 lease 全量渲染 → 按钮正确', async () => {
  await withChatCase(async ({ c, container }) => {
    c.read(`currentMessages = ${JSON.stringify(MSGS)}`);
    c.read(`currentInputRequests = ${JSON.stringify([LEASE])}`); // loadAgentData 全量拉取的结果
    c.read('render(currentMessages)');
    assert.equal(rowHasEditButton(container._rows[0]), true);
    assert.equal(rowHasEditButton(container._rows[2]), true);
    assert.equal(rowHasEditButton(container._rows[1]), false);
    assert.equal(rowHasEditButton(container._rows[3]), false);
  });
});

test('顺序正确时无回归：poll（[]）先提交、事件（lease）后提交 → 按钮在', async () => {
  await withChatCase(async ({ c, container }) => {
    c.read(`currentMessages = ${JSON.stringify(MSGS)}`);
    c.read('currentInputRequests = []');
    c.read('render(currentMessages)');

    c.read('globalThis.pollToken = captureSessionViewToken("rt-1")');
    c.read(`commitMetadataUpdate(pollToken, { inputRequestsRaw: [] })`); // 内容相同，仍提交观察版本
    emitInput([LEASE]);

    assert.equal(rowHasEditButton(container._rows[0]), true);
    assert.equal(rowHasEditButton(container._rows[2]), true);
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const producer of ['poll', 'load']) {
  test(`${producer} 真实异步链：旧空快照晚于 SSE，最终保留编辑按钮和其他数据`, { timeout: 1000 }, async () => {
    await withChatCase(async ({ c, container, pollCycle, dataLoader }) => {
      c.read(`currentMessages = ${JSON.stringify(MSGS)}`);
      c.read('render(currentMessages)');
      const inputBody = deferred();
      const inputRequested = deferred();
      const oldMessages = deferred();
      c.read('renderCurrentMainView = () => render(currentMessages)');
      // 网络面：input-requests 响应被挂起，SSE 之后才返回旧空快照
      c.window.fetch = async (url) => {
        const target = String(url);
        if (target.startsWith('/api/templates/feature')) {
          return { ok: true, status: 200, json: async () => ({ read: { name: 'read' } }) };
        }
        if (target.endsWith('/input-requests')) {
          inputRequested.resolve();
          return { ok: true, status: 200, json: async () => inputBody.promise };
        }
        if (target.endsWith('/messages')) {
          return { ok: true, status: 200, json: async () => oldMessages.promise };
        }
        if (target.endsWith('/overview')) return { ok: true, status: 200, json: async () => ({ modelName: 'loaded-model' }) };
        if (target.endsWith('/todo')) return { ok: true, status: 200, json: async () => ({ tasks: [] }) };
        if (target.includes('/protoclaw/get_connected_agents')) return { ok: true, status: 200, json: async () => [] };
        return { ok: true, status: 200, json: async () => [] };
      };
      // 本轮是 SSE 掉线窗口中的全量对账：先关闭 SSE 激活态（poll 走全量形态，
      // 才会真正去拉 input-requests —— SSE 激活态下输入租约由事件通道投递）
      latestSource().emit('shutdown', {});
      const pending = producer === 'poll'
        ? pollCycle.runPollCycle()
        : dataLoader.loadAgentData('rt-1');
      // poll 先等消息；load 并行读 body。两者都将 input 响应挂起至 SSE 之后。
      oldMessages.resolve({ messages: MSGS });
      await inputRequested.promise;
      emitInput([LEASE]);
      assert.equal(rowHasEditButton(container._rows[0]), true);
      inputBody.resolve([]);
      await pending;
      assert.equal(readJson(c, 'JSON.stringify(currentInputRequests)')[0].requestId, LEASE.requestId);
      assert.equal(readJson(c, 'JSON.stringify(currentOverviewSnapshot)').modelName, 'loaded-model',
        '其他维度继续提交');
      assert.equal(rowHasEditButton(container._rows[0]), true);
      assert.equal(rowHasEditButton(container._rows[2]), true);
    });
  });
}

for (const change of ['empty-event', 'same-lease-event', 'local-clear']) {
  test(`${change}：新观察阻止旧 lease 复活，后续新请求仍可更新`, async () => {
    await withChatCase(async ({ c, container }) => {
      c.read(`currentMessages = ${JSON.stringify(MSGS)}`);
      c.read('render(currentMessages)');
      emitInput([LEASE]);
      c.read('globalThis.oldToken = captureSessionViewToken("rt-1")');
      const keepLease = change === 'same-lease-event';
      if (change === 'local-clear') c.read('applySessionViewPatch({ inputRequests: [] })');
      else if (keepLease) emitInput([LEASE]);
      else {
        emitInput([]);
        emitInput([]); // 内容未变也必须推进观察版本。
      }
      const oldLease = { ...LEASE, requestId: 'old-lease', actions: [] };
      c.read(`commitMetadataUpdate(oldToken, { inputRequestsRaw: ${JSON.stringify([oldLease])} })`);
      assert.equal(readJson(c, 'JSON.stringify(currentInputRequests)').length, keepLease ? 1 : 0);
      if (keepLease) {
        assert.equal(readJson(c, 'JSON.stringify(currentInputRequests)')[0].requestId, LEASE.requestId);
      }
      c.read('updateRollbackActionVisibility()');
      assert.equal(rowHasEditButton(container._rows[0]), keepLease);

      c.read('globalThis.freshToken = captureSessionViewToken("rt-1")');
      c.read(`commitMetadataUpdate(freshToken, { inputRequestsRaw: ${JSON.stringify(keepLease ? [] : [LEASE])} })`);
      assert.equal(rowHasEditButton(container._rows[0]), !keepLease, '新请求可正常创建/清除按钮');
    });
  });
}

test('相同空事件也使在途旧 lease 失效；非焦点事件不干扰当前快照', async () => {
  await withChatCase(async ({ c }) => {
    c.read('globalThis.token = captureSessionViewToken("rt-1")');
    emitInput([]);
    c.read(`commitMetadataUpdate(token, { inputRequestsRaw: ${JSON.stringify([LEASE])} })`);
    assert.equal(readJson(c, 'JSON.stringify(currentInputRequests)').length, 0);
    c.read('globalThis.fresh = captureSessionViewToken("rt-1")');
    emitInput([], 'other-runtime');
    c.read(`commitMetadataUpdate(fresh, { inputRequestsRaw: ${JSON.stringify([LEASE])} })`);
    assert.equal(readJson(c, 'JSON.stringify(currentInputRequests)')[0].requestId, LEASE.requestId);
  });
});
