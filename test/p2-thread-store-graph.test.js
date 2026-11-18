/**
 * thread-store 交互域的真实整图与静态环证据（A↔B）。
 *
 * 拆分后出现一处静态环：
 *   `thread-store-domain.js → workspace-actions.js`（无 runtime 时回退
 *   open_session）与 `workspace-actions.js → thread-store-domain.js`
 *   （409 挡板直接进等待表面）。
 *
 * 环合法的前提是两侧**只在函数体内**引用对端绑定：本文件不复刻业务逻辑，
 * 只证明图本身——以生产入口 `kernel-entry.js`（→ p2-entry → 各批入口）求值整张
 * 真实图。交互域由 p2-entry 链上的 workspace-actions 具名 import 带入（入口
 * 接线已落地），本文件按这一真实形态验证；并反过来以交互域为入口先求值，
 * 确认换入口不改变可求值性（顶层零解引用 → 无 TDZ）。
 *
 * 除求值外还各走一次环的两个方向，证明 import 拿到的是真实实现而非空绑定：
 *   - 交互域 → 工作空间动作：无 runtime 的线程打开回退 `open_session`
 *     （真实网络面出现 activate / user 端请求）；
 *   - 工作空间动作 → 交互域：activate 返回 409 挡板时直接挂等待表面。
 *
 * 另有一条**单向**新增边（D1 收口）：`p2-w2-3a-queue-projection.js →
 * thread-store-domain.js`（线程暂存文本改具名 import，交互域那条纯 ESM 桥键
 * 注销）。回程没有静态路径——本文件用与 check:cycles 同款的相对导入图遍历
 * 断言「无回程边」，并以任一模块为入口先求值，证明这条边不引入新的求值顺序
 * 依赖；随后在真实图上渲染一次线程暂存气泡（真实 DOM 投影，不是源码正则）。
 *
 * classic 相用 `prepareThreadClassicSandbox`（真实先行脚本序 + classic 刷新
 * 引擎），因此运行时宿主能力都是生产实现。三个 Observer 是浏览器平台全局。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareThreadClassicSandbox, seedThreadFacts, withThreadCaseEnv } from './p2-thread-case.js';

const KERNEL_ENTRY = 'public/src/modules/kernel-entry.js';
const DOMAIN = 'public/src/modules/thread-store-domain.js';
const WORKSPACE_ACTIONS = 'public/src/modules/workspace-actions.js';
const QUEUE_PROJECTION = 'public/src/modules/p2-w2-3a-queue-projection.js';

const HOST = {
  id: 'coder',
  source: 'prebuilt',
  kind: 'workspace',
  runtime_session_id: '',
  active_workspace_session_id: 'sess-head',
  workspace_sessions: {
    revision: 1,
    activeSessionId: 'sess-head',
    sessions: [{ id: 'sess-head', title: 'T' }],
  },
};

/**
 * 惰性元素树：本文件求值整张生产图（含 app-ui），其宿主面直接调用 sidebar-render
 * 的具名导出（模块相之后 `window.renderAgentList` 的夹具覆盖对它无效），因此
 * 等待表面的切换会真的走一遍侧栏渲染。本文件的断言是图 / 网络 / 线程事实，
 * 不看侧栏 DOM——这里给一条链路自洽的惰性元素树，让真实渲染跑完不抛错，
 * 而不是把渲染器短路掉（渲染路径必须保持真实）。
 */
function createInertElement() {
  const element = {
    dataset: {},
    style: { setProperty() {}, getPropertyValue() { return ''; } },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [],
    innerHTML: '',
    textContent: '',
    value: '',
    scrollTop: 0,
    appendChild() {},
    removeChild() {},
    insertBefore() {},
    insertAdjacentHTML() {},
    remove() {},
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    closest() { return null; },
    matches() { return false; },
    contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    querySelector() { return createInertElement(); },
    querySelectorAll() { return []; },
  };
  return element;
}

function createInertDocument() {
  const inert = () => createInertElement();
  return {
    getElementById: (id) => (id === 'rail-cust-overlay' ? null : inert()),
    querySelector: () => inert(),
    querySelectorAll: () => [],
    createElement: () => inert(),
    createTextNode: (text) => ({ textContent: String(text ?? '') }),
    addEventListener() {},
    removeEventListener() {},
    body: inert(),
    head: inert(),
    documentElement: inert(),
    activeElement: { dataset: {} },
    contains: () => false,
    readyState: 'complete',
    fonts: { ready: Promise.resolve(), addEventListener() {} },
  };
}

function graphCase({ requests, mode, document = createInertDocument() }) {
  const thread = {
    threadId: 'wt-graph', agentId: 'coder', headSessionId: 'sess-head',
    sessionIds: ['sess-head'], status: 'rotating', handoffStartedAt: Date.now(),
  };
  return {
    label: `p2-thread-store-graph:${mode}`,
    ...(document ? { globals: { document } } : {}),
    fetch: async (url) => {
      requests.push(String(url));
      if (String(url).includes('/protoclaw/prebuilt_sessions/activate')) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            ok: false,
            code: 'thread_handoff_in_progress',
            message: 'Thread wt-graph 正在接续',
            threadId: 'wt-graph',
            headSessionId: 'sess-head',
          }),
          text: async () => 'conflict',
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, messages: [] }), text: async () => '' };
    },
    classic: (sandbox) => {
      prepareThreadClassicSandbox(sandbox, {
        getCurrentAgentRecord: () => HOST,
        getCurrentHostAgentRecord: () => ({ id: 'coder', source: 'prebuilt', kind: 'workspace' }),
        getRuntimeWorkspaceSessionId: () => '',
        setViewerSessionBinding: () => {},
        renderAgentList: () => {},
        renderCurrentMainView: () => {},
        updateQueueIndicator: () => {},
        updateThreadHeaderIndicator: () => {},
        focusedAgentId: 'coder',
        currentRuntimeAgentId: '',
        allAgents: [HOST],
      });
      seedThreadFacts(sandbox, [thread]);
      // rail-cust-overlay 是懒创建的（openModal 才建）。默认沙箱桩给任意 id 都返回
      // 元素，与生产不变量「overlay 存在 ⇒ 已建好内部结构」冲突，会让 rail-customize
      // 在模块求值期的 updateLang 走进"渲染空 overlay"的非法状态。
      const getById = sandbox.document.getElementById.bind(sandbox.document);
      sandbox.document.getElementById = (id) => (id === 'rail-cust-overlay' ? null : getById(id));
      // 插件宿主缝：新建会话选择只做透传（生产由 claw-host 提供同名注册表）。
      sandbox.run('window.ClawFW = window.ClawFW || {}; window.ClawFW.workspaceAgents = {'
        + ' selectForNewSession: function (agent, action) { return action; } };');
      sandbox.window.alert = () => {};
    },
  };
}

test('生产入口整图 + 交互域：环可求值，两侧调用都指向真实实现', async () => {
  const requests = [];
  await withThreadCaseEnv(graphCase({ requests, mode: 'kernel-first' }), async ({ c }) => {
    // 生产入口（纯副作用）先求值：整张已接线图无 TDZ
    const entry = await c.load(KERNEL_ENTRY);
    assert.deepEqual(Object.keys(entry), [], 'kernel-entry 是纯副作用入口');

    // 生产接线（入口 owner 的 p2-entry 一行 import）后，交互域进入同一张图
    const domain = await c.load(DOMAIN);
    const actions = await c.load(WORKSPACE_ACTIONS);
    assert.equal(typeof actions.runWorkspaceAction, 'function');
    assert.equal(typeof domain.openConversationTarget, 'function');
    // 环两侧的桥键都指向各自模块的真实导出（同一实例，不是第二份实现）
    assert.equal(c.window.runWorkspaceAction, actions.runWorkspaceAction);
    assert.equal(c.window.openConversationTarget, domain.openConversationTarget);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

test('环方向一（交互域 → 工作空间动作）：无 runtime 时回退的 open_session 真的发出去', async () => {
  const requests = [];
  await withThreadCaseEnv(graphCase({ requests, mode: 'domain-to-actions' }), async ({ c }) => {
    const domain = await c.load(DOMAIN);
    c.sandbox.run(`(function () {
      const t = { threadId: 'wt-open', agentId: 'coder', headSessionId: 'sess-open',
        sessionIds: ['sess-open'], status: 'open' };
      const s = window.ClawThreads;
      s.threads = [t];
      s.byId = { 'wt-open': t };
      s.sessionIndex = { 'coder::sess-open': t };
    })();`);

    const opened = await domain.openConversationTarget({ agentId: 'coder', threadId: 'wt-open' });
    assert.ok(requests.some((url) => url.includes('/activate')),
      '无 runtime 的线程打开必须真的走到工作空间动作（runWorkspaceAction 的 open_session）');
    assert.equal(opened?.ok, false, '服务端 409 时导航本身不成功（消费方转等待表面）');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

test('环方向二（工作空间动作 → 交互域）：409 挡板直接进等待表面', async () => {
  const requests = [];
  await withThreadCaseEnv(graphCase({ requests, mode: 'actions-to-domain' }), async ({ c }) => {
    await c.load(KERNEL_ENTRY);
    await c.load(DOMAIN);
    await c.sandbox.run(`window.runWorkspaceAction(${JSON.stringify({ type: 'open_session', sessionId: 'sess-head' })}, null)`);

    const conversation = c.read('window.ClawThreads.activeConversation');
    assert.equal(conversation?.threadId, 'wt-graph', '工作空间动作的 409 分支经交互域挂等待表面');
    assert.equal(conversation?.awaitSurface, true);
    assert.ok(requests.some((url) => url.includes('/activate')), '激活请求确实发出（409 是服务端结论）');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

test('以交互域为入口先求值：静态环反向闭合，同样可导出可调用', async () => {
  const requests = [];
  await withThreadCaseEnv(graphCase({ requests, mode: 'domain-first' }), async ({ c }) => {
    // 先求值交互域：此时 workspace-actions 在环的另一侧尚未初始化，
    // 环内顶层零解引用 → 不应抛 TDZ。
    const domain = await c.load(DOMAIN);
    assert.equal(typeof domain.openConversationTarget, 'function');
    assert.equal(typeof domain.enterThreadAwaitView, 'function');

    // 再求值生产入口：同一张图里两模块仍是同一实例
    await c.load(KERNEL_ENTRY);
    const actions = await c.load(WORKSPACE_ACTIONS);
    assert.equal(c.window.runWorkspaceAction, actions.runWorkspaceAction);
    assert.equal(c.window.openConversationTarget, domain.openConversationTarget);

    // 环内的实际调用在反向求值下同样成立
    const awaited = await domain.enterThreadAwaitView({ threadId: 'wt-graph' });
    assert.equal(awaited?.ok, true);
    assert.equal(c.read('window.ClawThreads.activeConversation?.awaitSurface'), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

/**
 * 相对导入图遍历（与 scripts/check-import-cycles.mjs 同款口径：只看静态
 * `import ... from './x'` 边，`import type` 与动态 import 不在 public/src 出现）。
 * 返回从 `from` 到 `to` 的所有边路径；空数组表示不可达。
 */
function importPaths(from, to) {
  const found = [];
  const seen = new Set();
  const walk = (abs, chain) => {
    if (path.resolve(abs) === path.resolve(to)) {
      found.push([...chain, path.basename(abs)].join(' -> '));
      return;
    }
    if (seen.has(path.resolve(abs))) return;
    seen.add(path.resolve(abs));
    const source = fs.readFileSync(abs, 'utf8');
    for (const match of source.matchAll(/^\s*import\s+[^'"]*from\s+'(\.[^']+)'/gm)) {
      walk(path.resolve(path.dirname(abs), match[1]), [...chain, path.basename(abs)]);
    }
  };
  walk(from, []);
  return found;
}

test('新增边（queue-projection → 交互域）是单向的：无回程静态路径', () => {
  // 回程若存在（交互域 → … → queue-projection），本批就该按环处理；这里证明
  // 它不存在，因此不需要为求值顺序做任何妥协。
  assert.deepEqual(
    importPaths(DOMAIN, QUEUE_PROJECTION),
    [],
    '交互域到排队投影之间不得出现静态导入路径',
  );
  assert.deepEqual(importPaths(QUEUE_PROJECTION, DOMAIN), [`${path.basename(QUEUE_PROJECTION)} -> ${path.basename(DOMAIN)}`],
    '新增边就是这一条具名 import');
});

test('以排队投影为入口先求值：新边闭合，交互域导出可用（反向装载顺序）', async () => {
  const requests = [];
  await withThreadCaseEnv(graphCase({ requests, mode: 'queue-first' }), async ({ c }) => {
    const projection = await c.load(QUEUE_PROJECTION);
    assert.equal(typeof projection._renderQueueBubbles, 'function');
    const domain = await c.load(DOMAIN);
    // 同一张图里两模块的桥面一致
    assert.equal(c.window.openConversationTarget, domain.openConversationTarget);
    // 桥键已注销：排队投影拿到的必然是具名导出，不是 window 读写
    assert.equal(c.window.getThreadPendingTexts, undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

/** 记录子节点的最小容器/元素（真实 DOM 结构，不是 stub 断言）。 */
function createRecordingDom() {
  const make = () => ({
    className: '',
    textContent: '',
    title: '',
    children: [],
    style: {},
    // dataset 是真实元素的必备面：整图求值时 debug-logs 的列表滚动绑定读
    // featurePanelBody.dataset.logScrollBound（幂等标记）。
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.push(child); return child; },
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
  });
  return {
    getElementById() { return make(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: make,
    createTextNode: (text) => ({ textContent: String(text) }),
    addEventListener() {},
    removeEventListener() {},
    body: make(),
    documentElement: make(),
    activeElement: null,
    hidden: false,
    readyState: 'complete',
  };
}

test('真实线程暂存气泡：排队投影经具名 import 读交互域的暂存文本并渲染', async () => {
  const requests = [];
  const document = createRecordingDom();
  const thread = {
    threadId: 'wt-staged', agentId: 'coder', headSessionId: 'sess-staged',
    sessionIds: ['sess-staged'], status: 'open', pendingTexts: ['暂存一', '暂存二'],
  };
  // 用同一份夹具线程：graphCase 默认线程用于 409 分支，这里替换为暂存线程。
  const options = graphCase({ requests, mode: 'staged-bubble', document });
  const classic = options.classic;
  options.classic = (sandbox) => {
    classic(sandbox);
    seedThreadFacts(sandbox, [thread]);
    sandbox.run(`
      focusedAgentId = 'coder';
      currentRuntimeAgentId = 'rt-staged';
    `);
    sandbox.getRuntimeWorkspaceSessionId = () => 'sess-staged';
  };

  await withThreadCaseEnv(options, async ({ c }) => {
    // thread-store 已迁 ESM：activeConversation 只能在模块求值之后写（classic 相里
    // window.ClawThreads 还不存在）。桥键是活绑定，写进去与生产等价。
    c.read(`window.ClawThreads.activeConversation = { agentId: 'coder', threadId: 'wt-staged',
      sessionId: 'sess-staged', runtimeId: 'rt-staged', wasHead: true }`);
    const projection = await c.load(QUEUE_PROJECTION);
    const domain = await c.load(DOMAIN);
    // 交互域读到的暂存文本（唯一实现），再由投影渲染成线程暂存气泡
    assert.equal(JSON.stringify(domain.getThreadPendingTexts()), '["暂存一","暂存二"]');

    const container = document.createElement('div');
    container.className = 'user-input-container';
    projection._renderQueueBubbles(container);

    const stack = container.children.find((child) => child.className === 'queue-bubbles-stack');
    assert.ok(stack, '暂存文本必须渲染出气泡栈');
    const staged = stack.children.filter((child) => child.className === 'queue-bubble thread-staged');
    assert.equal(staged.length, 2, '两条暂存文本各出一个线程暂存气泡');
    assert.deepEqual(staged.map((child) => child.textContent), ['暂存一', '暂存二']);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
