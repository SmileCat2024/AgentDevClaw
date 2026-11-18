/**
 * P2 第二波 3a「输入面状态所有者」——排队同步 `_syncPersistentInputUi`
 * （p2-w2-3a-queue-projection.js）的真实链路回归。
 *
 * 装载路线：`withP2EsmCase` 真实 import 本批 ESM 图；classic 相跑**真实先行
 * 脚本序**（`prepareThreadClassicSandbox`：index.html 的 classic 标签链 +
 * classic 刷新引擎），宿主工厂因此是生产实现本身——不再用
 * `createXHost => ({ state: {} })` 的伪映射（那种写法把宿主契约复制进测试，
 * 生产改动无法被发现）。首屏 boot 与周期排程由该基座关掉。
 * classic 相之外仍有五个**函数级**直调边界（生产来自 persistent-input /
 * input-render / runtime-status，本链不加载这些文件），按生产签名给最小实现：
 * 迁出后它们是无守卫直调，本文件正是钉住这一点（缺桩即响亮失败）。
 * SSE 侧不再注入同形桩：排队投影已 import sse-client（两个方向都在函数体内
 * 调用，构成可接受的双向环），事件通道状态与快照缓存只经**真实 EventSource
 * 帧**驱动（hello 激活 + queued-inputs 快照），reconcile 的消费效果用
 * sse-client 的公开入口 `noteQueuedOptimistic`（已观察 id 返回 false）核对。
 *
 * 钉住五件事（对齐原实现语义，不新增兜底）：
 *   1. SSE 缓存命中 → 零 HTTP，直接消费事件通道快照；
 *   2. 缓存缺席 → 回退一次 HTTP，按快照落地文本/权威计数；
 *   3. JSON 解析后视图 token 过期 → 整笔丢弃（不写投影、不吞 reconcile）；
 *   4. 请求期间 SSE 带来更新的观察 → HTTP 快照失去队列写入权；
 *   5. 并发守卫：在飞期间第二次调用不开新请求；成功后与失败后都必须释放锁
 *      （失败仍由原 catch 语义吞掉、不向调用方抛）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareThreadClassicSandbox } from './p2-thread-case.js';

const QUEUE_PROJECTION = 'public/src/modules/p2-w2-3a-queue-projection.js';
const QUEUE_STATE = 'public/src/modules/p2-w2-3a-input-queue-state.js';
const ORCHESTRATION = 'public/src/modules/orchestration-state.js';
const SSE_CLIENT = 'public/src/modules/sse-client.js';

function createDocumentStub(onQuery = () => {}) {
  // children 记录真实子节点：队列气泡（含线程暂存气泡）的结构由用例直接断言，
  // 不是"函数被调用过"的替身。
  const element = () => ({
    style: {},
    dataset: {},
    children: [],
    className: '',
    innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.push(child); return child; },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    removeAttribute() {},
  });
  return {
    // 与 frontend-vm 的 document 桩同形：app-core 在 classic 相用
    // `document.getElementById('agent-list')` 取容器并注册委托，返回 null 会让
    // 真实先行脚本序在装载期就崩。查询照旧记录（模型/思考切换器的 DOM 读取
    // 就是靠它观测的）。
    getElementById(id) { onQuery(id); return element(); },
    querySelector(selector) { onQuery(selector); return null; },
    querySelectorAll() { return []; },
    createElement: element,
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    removeEventListener() {},
    body: element(),
    documentElement: element(),
    activeElement: null,
    hidden: false,
    readyState: 'complete',
  };
}

/**
 * 真实 EventSource 替身（浏览器规范的最小面）：只负责把帧交给 sse-client 自己
 * 注册的监听器，不复制任何传输语义。
 */
function createEventSourceClass() {
  return class MockEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = MockEventSource.CONNECTING;
      this.listeners = new Map();
      this.onerror = null;
      MockEventSource.instances.push(this);
    }

    addEventListener(kind, fn) {
      if (!this.listeners.has(kind)) this.listeners.set(kind, []);
      this.listeners.get(kind).push(fn);
    }

    close() {
      this.readyState = MockEventSource.CLOSED;
    }

    emit(kind, data) {
      this.readyState = MockEventSource.OPEN;
      for (const fn of this.listeners.get(kind) || []) fn({ data: JSON.stringify(data) });
    }
  };
}

function syncCaseOptions() {
  const calls = { domQueries: [], actionButton: 0, notify: [], fetch: [], rebind: [] };
  const EventSourceMock = createEventSourceClass();
  const latestSource = () => EventSourceMock.instances[EventSourceMock.instances.length - 1] || null;
  const sse = {
    /** hello 激活事件通道（isSseActive 由此为真）。 */
    activate() {
      latestSource()?.emit('hello', { ok: true, choiceAlerts: [] });
    },
    /** 事件通道投递一份 queued-inputs 快照（sse-client 自己写缓存与投影）。 */
    queue(runtimeId, items) {
      latestSource()?.emit('queued-inputs', { agentId: runtimeId, data: items, at: Date.now() });
    },
    latestSource,
  };
  let fetchImpl = async () => { throw new Error('unexpected fetch'); };

  const options = {
    classic: (sandbox) => {
      // 真实 classic 相：index.html 的先行脚本序 + classic 刷新引擎。宿主工厂
      // （createSessionViewCommitHost / createRuntimeSwitchHost / createP2Bootstrap*）
      // 因此是生产实现，不再是 `({ state: {} })` 伪映射。
      prepareThreadClassicSandbox(sandbox, {
        // 五个函数级直调边界（生产：persistent-input / input-render /
        // runtime-status 的 classic 实现；本链不加载那三个文件）。它们是无守卫
        // 直调点，缺实现必须响亮失败——桩在这里就是"这些边界被真的调用到了"
        // 的观测面。
        _syncPersistentActionButton: () => { calls.actionButton += 1; },
        notifyInputSurfaceChanged: (requests) => { calls.notify.push(requests); },
        isRuntimeCalling: () => false,
        rebindQueueProjectionForRuntime: (runtimeId) => { calls.rebind.push(runtimeId); },
        _interactiveSurfaceOccupiesInput: () => false,
        // 线程暂存读取走"当前激活会话"判定（交互域的 _currentActiveSession，
        // 内部读 getCurrentHostAgentRecord + getRuntimeWorkspaceSessionId）：
        // 用例给一条确定的宿主/绑定事实，函数本身仍是生产实现。
        getCurrentHostAgentRecord: () => ({ id: 'rt-a', source: 'prebuilt' }),
        // 会话身份（P4 T1：identity 域 owner）：window 桩不再生效，用例改用
        // viewer 侧绑定（生产 switchAgent 的同一入口）播种，见各用例体。
        renderAgentList: () => {},
        renderCurrentMainView: () => {},
        updateQueueIndicator: () => {},
        updateThreadHeaderIndicator: () => {},
      });
    },
    globals: {
      document: createDocumentStub((selector) => calls.domQueries.push(selector)),
      ClawFW: { actions: { registerMany() {} } },
      EventSource: EventSourceMock,
      fetch: (url, init) => { calls.fetch.push(String(url)); return fetchImpl(url, init); },
    },
  };

  return {
    options,
    calls,
    sse,
    setFetch(fn) { fetchImpl = fn; },
  };
}

/** 排队同步只允许打这条端点；其它请求属于宿主链路（SSE hello 的全量对账）。 */
function queuedFetches(calls) {
  return calls.fetch.filter((url) => url.includes('/queued-inputs'));
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitFor 超时：${label}`);
}

async function loadGraph(c) {
  // 五个函数级直调边界的桩在 classic 相写下，但 app-ui（P4 T2 末件）迁 ESM 后
  // 会随内核图在模块相装载并 import input-render —— 后者在求值期用
  // KernelState.defineKey 重新定义 window.notifyInputSurfaceChanged（访问器），
  // 覆盖 classic 相的普通属性赋值。因此在模块相之后按同一夹具面重放一次
  // （与 p2-thread-case 的 __caseOverrides 重放同义，语义不变：这些边界就是
  // 用例的观测点）。
  const overrides = c.sandbox.__caseOverrides;
  if (overrides) for (const [name, value] of Object.entries(overrides)) c.sandbox[name] = value;
  // 刷新引擎（P4 T3 起是真实 ESM）：交互域 thread-store-domain 在**装载期**取它的
  // 窄宿主 createThreadStoreHost，必须先于 queue-projection 的 import 链进入同一张图。
  await c.load('public/src/modules/thread-store.js');
  const orchestration = await c.load(ORCHESTRATION);
  const queueState = await c.load(QUEUE_STATE);
  const projection = await c.load(QUEUE_PROJECTION);
  // 真实传输层（排队投影已 import 它）：reconcile 的消费效果经其公开入口
  // noteQueuedOptimistic 核对——已观察到的排队 id 会返回 false。
  const sseClient = await c.load(SSE_CLIENT);
  // 生产由 `__clawAuthReady` 触发建连；本基座把该 promise 保持 pending（关掉
  // 首屏 boot 与周期排程），因此显式调用同一公开入口，等价于"鉴权就绪后建连"。
  sseClient.bootSseClient();
  orchestration.setCurrentRuntimeAgentId('rt-a');
  return { orchestration, queueState, projection, sseClient };
}

/** 权威快照是否已喂给 reconcile：已观察 id 不再接受乐观标记。 */
function wasReconciled(sseClient, id, runtimeId = 'rt-a') {
  return sseClient.noteQueuedOptimistic(id, 'probe', runtimeId) === false;
}

test('SSE 缓存命中：零 HTTP，按事件通道快照落地文本与权威计数', async () => {
  const { options, calls, sse } = syncCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const { orchestration, queueState, projection, sseClient } = await loadGraph(c);
    sse.activate();
    // 非焦点期间事件通道收到该 runtime 的快照：只入缓存，不写投影
    orchestration.setCurrentRuntimeAgentId('rt-b');
    sse.queue('rt-a', [
      { id: 'q1', text: 'queued-1' },
      { id: 'q2', text: 'reminder text', kind: 'reminder' },
      { id: 'q3', text: 'leased text', inputLease: true },
    ]);
    orchestration.setCurrentRuntimeAgentId('rt-a');

    await projection._syncPersistentInputUi('rt-a');

    assert.deepEqual(queuedFetches(calls), [], 'SSE 缓存命中必须零排队同步 HTTP');
    assert.ok(wasReconciled(sseClient, 'q1'), '权威快照仍要喂给 reconcile');
    assert.deepEqual([...queueState.queuedTexts], ['queued-1']);
    assert.equal(queueState.pendingQueuedCount, 1, 'reminder 与已领取项不计入待发送计数');
    assert.equal(queueState.queuedProjectionRuntimeId, 'rt-a');
    assert.equal(calls.notify.length, 1, '写入后必须声明输入面变更');
    // 模型/思考按钮与动作按钮同步：迁出后仍是无守卫直调（不是被跳过的可选调用）
    assert.ok(calls.domQueries.includes('.input-model-name'), '模型切换器更新必须真的执行（无 typeof 跳过）');
    assert.ok(calls.domQueries.includes('.input-thinking-name'), '思考档位切换器更新必须真的执行（无 typeof 跳过）');
    assert.ok(calls.actionButton >= 1, '动作按钮同步必须发生');
  });
});

test('缓存缺席：回退一次 HTTP，按响应体落地文本、计数与 reconcile', async () => {
  const { options, calls, sse, setFetch } = syncCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const { queueState, projection, sseClient } = await loadGraph(c);
    sse.activate(); // SSE 激活但本 runtime 还没有快照
    setFetch(async () => ({
      ok: true,
      json: async () => ([
        { id: 'h1', text: 'http-1' },
        { id: 'h2', text: '', images: [{ path: '/tmp/a.png' }] },
        { id: 'h3', text: 'rem', kind: 'reminder' },
      ]),
    }));

    await projection._syncPersistentInputUi('rt-a');

    assert.deepEqual(queuedFetches(calls), ['/api/agents/rt-a/queued-inputs']);
    assert.deepEqual([...queueState.queuedTexts], ['http-1', '🖼']);
    assert.equal(queueState.pendingQueuedCount, 2);
    assert.ok(wasReconciled(sseClient, 'h1'), '即使文本相同也消费权威队列');
    assert.ok(wasReconciled(sseClient, 'h2'), '权威队列的用户输入 id 全部进 reconcile');
  });
});

test('JSON 解析后视图 token 过期：整笔丢弃，不写投影也不消费 reconcile', async () => {
  const { options, sse, setFetch } = syncCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const { orchestration, queueState, projection, sseClient } = await loadGraph(c);
    let resolveJson;
    setFetch(async () => ({
      ok: true,
      json: () => new Promise((resolve) => { resolveJson = resolve; }),
    }));

    const pending = projection._syncPersistentInputUi('rt-a');
    await waitFor(() => typeof resolveJson === 'function', 'fetch 进入 json()');
    // 响应体到达前用户切走：switchEpoch 变化让 token 过期
    orchestration.setSwitchEpoch(1);
    resolveJson([{ id: 'late-1', text: 'late-http' }]);
    await pending;

    assert.deepEqual([...queueState.queuedTexts], [], '过期响应不得写入排队投影');
    assert.equal(queueState.pendingQueuedCount, 0);
    assert.equal(wasReconciled(sseClient, 'late-1'), false, '过期响应不得污染 reconcile 基线');
  });
});

test('请求期间 SSE 带来更新快照：HTTP 快照失去写入权', async () => {
  const { options, sse, setFetch } = syncCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const { queueState, projection, sseClient } = await loadGraph(c);
    let resolveJson;
    setFetch(async () => ({
      ok: true,
      json: () => new Promise((resolve) => { resolveJson = resolve; }),
    }));

    const pending = projection._syncPersistentInputUi('rt-a');
    await waitFor(() => typeof resolveJson === 'function', 'fetch 进入 json()');
    // 请求在飞期间事件通道先到达了更新的观察（焦点会话 → 投影立即落到事件文本）
    sse.queue('rt-a', [{ id: 's1', text: 'from-sse' }]);
    resolveJson([{ id: 'http-1', text: 'from-http' }]);
    await pending;

    assert.deepEqual([...queueState.queuedTexts], ['from-sse'],
      'SSE 已有更新观察时 HTTP 快照不得写入');
    assert.equal(wasReconciled(sseClient, 'http-1'), false, 'HTTP 快照不得喂给 reconcile');
  });
});

test('并发守卫：在飞期间不开新请求，成功后与失败后都释放锁', async () => {
  const { options, sse, setFetch } = syncCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const { queueState, projection, sseClient } = await loadGraph(c);
    let fetchCount = 0;
    let releaseFirst;
    setFetch(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return {
          ok: true,
          json: () => new Promise((resolve) => {
            releaseFirst = () => resolve([{ id: 'first-1', text: 'first' }]);
          }),
        };
      }
      return { ok: true, json: async () => ([]) };
    });

    const first = projection._syncPersistentInputUi('rt-a');
    await waitFor(() => fetchCount === 1, '首个请求已发出');
    // 在飞期间第二次调用：并发守卫直接返回，不发第二个请求
    await projection._syncPersistentInputUi('rt-a');
    assert.equal(fetchCount, 1, '在飞期间不得开第二个请求');

    releaseFirst();
    await first;
    assert.deepEqual([...queueState.queuedTexts], ['first']);
    assert.ok(wasReconciled(sseClient, 'first-1'), '成功路径的权威队列进 reconcile');

    // 成功路径结束后锁已释放：下一次调用真的发请求
    await projection._syncPersistentInputUi('rt-a');
    assert.equal(fetchCount, 2, '成功后锁必须释放');

    // 失败路径：原 catch 语义吞掉同步失败（不向调用方抛），且锁同样释放
    setFetch(async () => { throw new Error('network down'); });
    await assert.doesNotReject(() => projection._syncPersistentInputUi('rt-a'),
      '队列同步失败沿用原 catch 语义，不向调用方传播');
    assert.deepEqual([...queueState.queuedTexts], [],
      '失败请求不改写排队投影（上一次成功同步已按空队列排空）');
    assert.equal(wasReconciled(sseClient, 'failed-1'), false, '失败请求不得消费 reconcile');

    let afterFailureFetch = 0;
    setFetch(async () => { afterFailureFetch += 1; return { ok: true, json: async () => ([]) }; });
    await projection._syncPersistentInputUi('rt-a');
    assert.equal(afterFailureFetch, 1, '失败后锁必须释放，下一次调用可重试');
  });
});

test('迁出后不新增可选调用守卫：classic 直调保持无守卫，已 ESM 策略走 direct import', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('public/src/modules/p2-w2-3a-queue-projection.js', 'utf8');

  // 原实现是无守卫直调的 classic 函数：不得引入 typeof 静默跳过
  for (const name of [
    'updateInputModelSwitcher',
    'updateThinkingEffortSwitcher',
    'captureSessionViewToken',
    'notifyInputSurfaceChanged',
    'rebindQueueProjectionForRuntime',
    '_syncPersistentActionButton',
    'isRuntimeCalling',
    'interactiveSurfaceOccupiesInput', // window._interactiveSurfaceOccupiesInput()
  ]) {
    assert.doesNotMatch(source, new RegExp(`typeof (window\\.)?_?${name.replace(/^_/, '')}`),
      `${name} 不得新增 typeof 守卫`);
  }

  // 已 ESM 的会话视图策略：direct import，不经 window / 桥键
  assert.match(source, /import \{ isSessionViewTokenCurrent \} from '\.\/session-view-commit-host\.js';/);
  assert.doesNotMatch(source, /window\.isSessionViewTokenCurrent/);

  // 线程暂存文本：交互域具名导出 → direct import；纯 ESM 消费不留 window 面，
  // 也不再保留「实现可能缺席」的 typeof 守卫（行为覆盖见本文件末尾的暂存气泡用例）。
  assert.match(source, /import \{ getThreadPendingTexts \} from '\.\/thread-store-domain\.js';/);
  assert.doesNotMatch(source, /window\.getThreadPendingTexts/);
  assert.doesNotMatch(source, /typeof getThreadPendingTexts/);

  // 已 ESM 的传输层与输入面更新器：direct import，不经 window / ClawFW 命名空间
  assert.match(source, /import \{ isSseActive, getLastQueuedSnapshot, reconcileQueuedTexts \} from '\.\/sse-client\.js';/);
  assert.match(source, /import \{ updateInputModelSwitcher, updateThinkingEffortSwitcher \} from '\.\/input-model-switcher\.js';/);
  assert.doesNotMatch(source, /window\.ClawFW\?\.SseClient/);
  assert.doesNotMatch(source, /window\.updateInputModelSwitcher/);
  assert.doesNotMatch(source, /window\.updateThinkingEffortSwitcher/);
  assert.match(source, /if \(isSseActive\(\)\)/);

  // 不保留同名 wrapper：直调点必须直接落在 window.<原函数名> 上
  assert.doesNotMatch(source, /function _syncPersistentActionButton\(/);
  assert.doesNotMatch(source, /function isRuntimeCalling\(/);
});

test('线程暂存文本：投影经具名 import 读交互域状态并渲染真实线程暂存气泡', async () => {
  // 替换原先的源码正则（`typeof window.getThreadPendingTexts === 'function'`）：
  // 那条断言只能证明代码"长得对"，不能证明暂存文本真的进了气泡。这里用真实
  // 线程事实驱动真实投影，并同时覆盖「无暂存 → 无气泡」的负例。
  const { options } = syncCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const { orchestration, projection } = await loadGraph(c);
    const identity = await c.load('public/src/modules/identity.js');
    identity.setViewerSessionBinding('rt-a', 'sess-q');
    const thread = {
      threadId: 'wt-q', agentId: 'rt-a', headSessionId: 'sess-q',
      sessionIds: ['sess-q'], status: 'rotating', pendingTexts: ['暂存一', '暂存二'],
    };
    c.sandbox.run(`window.ClawThreads.threads = ${JSON.stringify([thread])};
      (function () {
        const s = window.ClawThreads;
        s.byId = { 'wt-q': s.threads[0] };
        s.sessionIndex = { 'rt-a::sess-q': s.threads[0] };
        s.activeConversation = { agentId: 'rt-a', threadId: 'wt-q', sessionId: 'sess-q', runtimeId: 'rt-a', wasHead: true };
      })();`);
    orchestration.setCurrentRuntimeAgentId('rt-a');

    const container = c.window.document.createElement('div');
    projection._renderQueueBubbles(container);
    const stack = container.children.find((child) => child.className === 'queue-bubbles-stack');
    assert.ok(stack, '暂存文本必须真的渲染出气泡栈');
    const staged = stack.children.filter((child) => child.className === 'queue-bubble thread-staged');
    assert.equal(staged.length, 2, '两条暂存文本各出一个线程暂存气泡');
    assert.deepEqual(staged.map((child) => child.textContent), ['暂存一', '暂存二']);

    // 负例：暂存清空后重渲染不再产出暂存气泡（读取的是真实状态，不是常量）
    c.sandbox.run("window.ClawThreads.byId['wt-q'].pendingTexts = [];");
    const empty = c.window.document.createElement('div');
    projection._renderQueueBubbles(empty);
    assert.equal(
      empty.children.filter((child) => child.className === 'queue-bubbles-stack').length,
      0,
      '无暂存时不得渲染空气泡栈',
    );
  });
});
