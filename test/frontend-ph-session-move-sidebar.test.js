/**
 * PH 移动弹窗的归属兜底（ph-session-move.js）：
 *
 *  单条 ctx 入口从会话记录解析归属，切片缓存/项目实体缓存 miss 时弹
 *  「无法确定该会话的归属目录」，而会话在服务端索引里归属明确。修复：
 *  切片 miss 走列表接口 sessionId 精确过滤（索引读模型），消费与切片
 *  同管线的 wire 记录字段（projectId / openDirectory）。
 *
 *  （原「移动后侧栏乐观退场」用例已随服务端释放语义退役删除：移动不再
 *  释放存活实例，侧栏分组由每轮 loadAgents 从索引现读，无需退场注册。）
 *
 *  字段往返：本文件 fetch mock 的记录形态与服务端接线测试
 *  test/ph-session-record-wire.test.js 同构（同一条 wire 投影管线产出）。
 *
 *  DOM 编排边界：弹窗表单渲染/submit 全链依赖真实 innerHTML 解析，
 *  frontend-vm 沙箱不承载；此处只钉归属解析的可见后果。
 *
 *  装载路线（P2 ESM 配方第三节）：ph-session-move.js 已迁 ESM，经
 *  withP2EsmCase 的 `c.load` 真实 import（归属解析 helper 是模块私有，不上桥，
 *  因此断言钉在公开入口 `phOpenSessionMoveDialog` 的真实后果上）：
 *   1. 服务端索引查询带 sessionId 精确过滤；
 *   2. ownerKey 归一（project 归属 / directory 归属含反斜杠与小写归一）决定
 *      「默认项目」目标行可用或置灰——即「移到哪儿去」的真实用户可见差异；
 *   3. 查无此会话 → 显式报错、不弹窗、不猜测页面焦点。
 *  classic 首屏 bootstrap（app-core / sidebar-render）提供模块顶层依赖的
 *  kernel 桥与宿主工厂。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareEsmModules, prepareSidebarDomain, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const PH_MOVE = 'public/src/modules/ph-session-move.js';

function makeElement(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    isConnected: true,
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    focus() {},
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    setAttribute() {},
    getBoundingClientRect() { return { right: 0, bottom: 0 }; },
  };
}

function createDocumentStub() {
  const elements = new Map();
  const created = [];
  const stable = (id) => {
    if (!elements.has(id)) {
      const el = makeElement();
      el.id = id;
      elements.set(id, el);
    }
    return elements.get(id);
  };
  return {
    elements,
    created,
    document: {
      getElementById: (id) => stable(id),
      createElement: (tag) => { const el = makeElement(tag); created.push(el); return el; },
      createTextNode: (text) => ({ textContent: String(text) }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      body: makeElement('body'),
      head: makeElement('head'),
      documentElement: makeElement('html'),
      readyState: 'complete',
      activeElement: null,
    },
  };
}

/** classic 首屏 bootstrap：kernel 访问器桥 + ESM 模块顶层需要的宿主工厂。 */
function bootstrapClassic(sandbox) {
  sandbox.setInterval = () => 0;
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  sandbox.loadSource('public/src/app-core.js');
  prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
  // sidebar-render / runtime-status 自 P4 T2 起是 ESM：经 prepareSidebarDomain 在
  // classic 之后进模块相（真正装载由 withP2EsmCase 消费 pending prep 完成）。
  prepareSidebarDomain(sandbox);
  sandbox.AgentLoaderHost = { loadedAgentDetailIds: new Set() };
  // 调用状态宿主：owner 是 classic sidebar-render 的 createAgentCallStatesHost，
  // 但它引用 app-main 的词法容器与未定义的通知钩子（_markAgentCallStartedForNotify）。
  // 这里按它的键集合给等价实现：容器取真实 owner 的那一份（app-core /
  // runtime-status 的 Map/Set），读操作委托真实函数，副作用只保留渲染入口。
  let callStateRefreshAt = Date.now();
  const callStatesSlot = (expression, fallback) => {
    try { return sandbox.run(expression); } catch { return fallback; }
  };
  sandbox.createAgentCallStatesHost = () => ({
    calling: callStatesSlot('_agentCallActive', new Map()),
    suspended: callStatesSlot('_agentSuspended', new Map()),
    interrupting: callStatesSlot('_interruptSuppression', new Map()),
    finished: callStatesSlot('_recentlyFinishedRuntimes', new Set()),
    agents: () => sandbox.allAgents,
    currentRuntimeId: () => sandbox.currentRuntimeAgentId,
    runtimeId: (agent) => sandbox.getAgentRuntimeId(agent),
    remoteEntries: () => (typeof sandbox.getVisibleRemoteEntries === 'function'
      ? sandbox.getVisibleRemoteEntries() : []),
    normalize: (value) => sandbox.normalizeAgentIdentity(value),
    resolveCalling: (payload) => sandbox.resolveNotificationCallingState?.(payload) === true,
    isSuspended: (payload) => sandbox.isSuspendedNotificationPayload?.(payload) === true,
    markStarted: () => {},
    syncActionButton: () => {},
    isSseActive: () => (typeof sandbox.isSseActive === 'function' ? sandbox.isSseActive() === true : true),
    isRemote: (id) => typeof sandbox.isRemoteNamespaceAgentId === 'function'
      && sandbox.isRemoteNamespaceAgentId(id) === true,
    fetch: (...args) => sandbox.fetch(...args),
    now: () => Date.now(),
    lastRefresh: () => callStateRefreshAt,
    setLastRefresh: (value) => { callStateRefreshAt = value; },
    render: () => sandbox.renderAgentList(),
  });
  sandbox.createRuntimeSwitchHost = () => ({ state: {} });
  // 轮询协调器宿主（classic app-main 工厂）：ESM 图经 agent-data-loader → input-actions
  // 触达 poll-coordinator-host，后者在模块求值期取该工厂。本文件不驱动轮询。
  sandbox.createPollCoordinatorHost = () => ({
    run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
  });
  sandbox.createWorkspaceSurfaceHost = () => ({});
  sandbox.createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
  sandbox.performance = { now: () => 0 };
  sandbox.CSS = { escape: (value) => String(value) };
  sandbox.isRemoteNamespaceAgentId = (id) => typeof id === 'string' && id.startsWith('remote:');
  sandbox.setPreferredUnitMode = () => {};
  sandbox.renderAgentList = () => {};
  sandbox.renderCurrentMainView = () => {};
}

/**
 * 真实 workspace 宿主记录：`isPhStyleWorkspaceAgent`（app-core 的真实闸门）
 * 要求 id ∈ PH_STYLE_WORKSPACE_AGENT_IDS 且 source === 'prebuilt'。
 */
const HOST = {
  id: 'programming-helper',
  name: '智能编码空间',
  source: 'prebuilt',
  kind: 'workspace',
  workspace_sessions: { revision: 1, activeSessionId: 's-head', sessions: [{ id: 's-head', title: 'T' }] },
};

/** 非 PH 宿主（真实闸门关闭）：同一 APP 形态但不是 PH，入口应静默返回。 */
const NON_PH_HOST = { id: 'agent-studio', name: 'Agent Studio', source: 'prebuilt', kind: 'workspace' };

/**
 * 构造一次真实装载：`fetchImpl` 决定服务端索引读的返回；
 * 回调拿到装载面（模块导出、DOM 夹具、请求与 alert 记录）。
 */
async function withMoveCase(fetchImpl, fn, { hostRecord = HOST, expectConsole = [] } = {}) {
  const doc = createDocumentStub();
  const fetchCalls = [];
  const alerts = [];
  const host = globalThis.console; // 词法捕获：用例期间 globalThis.console 被替换
  const consoleEntries = { error: [], warn: [] };
  const format = (args) => args
    .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
    .join(' ');
  const consoleRecorder = {
    ...host,
    error: (...args) => { consoleEntries.error.push(format(args)); host.error(...args); },
    warn: (...args) => { consoleEntries.warn.push(format(args)); host.warn(...args); },
  };
  const fetchStub = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (fetchImpl) return fetchImpl(String(url), options);
    return { ok: true, json: async () => ({}) };
  };
  return withP2EsmCase({
    classic: bootstrapClassic,
    globals: {
      navigator: undefined,
      fetch: fetchStub,
      document: doc.document,
      console: consoleRecorder,
      URLSearchParams,
      currentLanguage: 'zh',
    },
  }, async (c) => {
    // classic 装配 seam 已迁 ESM，先求值（后续 host 模块在求值期取它的工厂）
    await c.load('public/src/modules/agent-data-loader.js');
    const move = await c.load(PH_MOVE);
    // classic 宿主面在 bootstrap 之后注入（app-core 也声明同名函数，不得被覆盖）。
    // 注意：不再替换 `isPhStyleWorkspaceAgent`——闸门用 app-core 的真实实现。
    Object.assign(c.sandbox, {
      getCurrentAgentRecord: () => hostRecord,
      alert: (message) => { alerts.push(String(message)); },
    });
    const result = await fn({ move, doc, fetchCalls, alerts, ctx: c.sandbox, consoleEntries });
    const unexpected = [...consoleEntries.error, ...consoleEntries.warn]
      .filter((line) => !expectConsole.some((pattern) => pattern.test(line)));
    assert.deepEqual(unexpected, [], '成功路径不应产生未预期的 console.error / console.warn');
    return result;
  });
}

const overlayOf = (doc) => doc.created.find((el) => el.className === 'feature-detail-overlay') || null;

describe('归属解析的服务端权威兜底（sessionId 精确过滤消费）', () => {
  it('项目会话：wire 记录 projectId + openDirectory → project ownerKey', async () => {
    await withMoveCase(async () => ({
      ok: true,
      json: async () => ({
        sessions: [{
          id: 's-proj-head',
          title: '(精简)A',
          projectId: 'prj_move01',
          openDirectory: 'D:\\proj-a',
        }],
      }),
    }), async ({ move, doc, fetchCalls, alerts }) => {
      await move.phOpenSessionMoveDialog(['s-proj-head']);
      // 请求打到既有列表接口的 sessionId 过滤（非私搭端点）
      assert.ok(fetchCalls[0].url.includes('/protoclaw/prebuilt_sessions?'), '走既有列表接口');
      assert.ok(fetchCalls[0].url.includes('sessionId=s-proj-head'), 'sessionId 精确过滤参数');
      assert.equal(alerts.length, 0, '归属解析成功时不得报错');
      const overlay = overlayOf(doc);
      assert.ok(overlay, '归属解析成功后弹出移动弹窗');
      // 归属是项目：目录「默认项目」不是当前归属 → 可选，且展示目录路径
      assert.match(overlay.innerHTML, /ph-move-target-item selected/);
      assert.doesNotMatch(overlay.innerHTML, /ph-move-target-item disabled/);
      assert.match(overlay.innerHTML, /D:\\proj-a/);
    });
  });

  it('目录会话：projectId 空 → directory ownerKey（与本地解析同构归一）', async () => {
    await withMoveCase(async () => ({
      ok: true,
      json: async () => ({
        sessions: [{ id: 's-dir', title: '目录对话', openDirectory: 'D:\\proj-a' }],
      }),
    }), async ({ move, doc, alerts }) => {
      await move.phOpenSessionMoveDialog(['s-dir']);
      assert.equal(alerts.length, 0, '归属解析成功时不得报错');
      const overlay = overlayOf(doc);
      assert.ok(overlay, '归属解析成功后弹出移动弹窗');
      // 会话已归属该目录（ownerKey 归一后相等）：默认目录目标置灰
      assert.match(overlay.innerHTML, /ph-move-target-item disabled/, 'directory ownerKey 归一后与默认目标一致');
      assert.match(overlay.innerHTML, /D:\\proj-a/);
    });
  });

  it('服务端查无此会话：返回 null（调用方显式报错，不猜测）', async () => {
    await withMoveCase(async () => ({ ok: true, json: async () => ({ sessions: [] }) }), async ({ move, doc, alerts }) => {
      await move.phOpenSessionMoveDialog(['s-none']);
      assert.equal(alerts.length, 1, '无法确定归属时必须显式报错');
      assert.match(alerts[0], /无法确定该会话的归属目录/);
      assert.equal(overlayOf(doc), null, '归属不明不得弹出移动弹窗');
    });
  });

  it('非 PH 工作空间（真实闸门关闭）：不弹窗、不查索引、不报错', async () => {
    await withMoveCase(async () => ({
      ok: true,
      json: async () => ({ sessions: [{ id: 's-x', projectId: 'prj_1', openDirectory: 'D:\\proj-a' }] }),
    }), async ({ move, doc, fetchCalls, alerts }) => {
      await move.phOpenSessionMoveDialog(['s-x']);
      // 真实闸门（isPhStyleWorkspaceAgent）在入口第一句拦下：无请求、无弹窗、无告警
      assert.equal(fetchCalls.length, 0, '非 PH 宿主不得发起归属查询');
      assert.equal(overlayOf(doc), null, '非 PH 宿主不得弹出移动弹窗');
      assert.equal(alerts.length, 0, '闸门关闭是静默返回，不是错误');
    }, { hostRecord: NON_PH_HOST });
  });
});
