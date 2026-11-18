/**
 * R2-01 remote session history — frontend merge render + activation request shape.
 *
 * Covers (vm sandbox, no real network):
 *   1. getRemoteHistorySessions: directory-bucketed merge from forwarded lists
 *   2. getProgrammingHelperProjects: remote history merged into the local
 *      project bucket (mixed recency sort, no source partition, no badge)
 *   3. open_session activation request shape (host-namespace agentId +
 *      namespaced sessionId + idempotency key) and explicit failure when the
 *      catalog has no entry for the session
 *
 * Identity discipline (ADR-0012): ids flow from the data layer; the render
 * layer carries no remote-branch UI logic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { installForegroundSyncOwner, prepareSidebarDomain } from './p2-classic-hosts.js';

const CATALOG = {
  connections: [{
    connectionId: 'server-a',
    name: 'Lab-B',
    status: 'connected',
    workspaces: [{
      groupKey: 'remote:server-a:programming-helper:%2Fsrv%2Fproject-c',
      displayName: 'Lab-B：project-c',
      projectName: 'Lab-B：project-c',
      projectDir: '/srv/project-c',
      entries: [{
        id: 'remote:server-a:runtime-main',
        runtimeId: 'remote:server-a:runtime-main',
        agentId: 'remote:server-a:programming-helper',
        sidebarEntryId: 'programming-helper',
        sessionType: 'main',
        sessionId: 'remote:server-a:session-running',
        name: '运行中',
        kind: 'runtime',
      }],
    }],
  }],
};

// Remote list payload as the forwarded endpoint returns it (bare ids from the
// remote host); the history layer namespaces them client-side.
const REMOTE_HISTORY = {
  revision: 3,
  activeSessionId: 'session-running',
  sessions: [
    { id: 'session-hist-1', title: '远程历史 A', updatedAt: '2026-08-30T09:00:00.000Z', openDirectory: '/srv/project-c', messageCount: 4 },
    { id: 'session-hist-2', title: '远程历史 B', updatedAt: '2026-08-29T10:00:00.000Z', openDirectory: '/srv/project-c' },
    { id: 'session-nodir', title: '无目录会话', openDirectory: '' },
    { id: 'session-other-dir', title: '其他目录', openDirectory: 'D:/elsewhere' },
  ],
};

// ── workspace-actions（ESM）远程激活链路的用例上下文 ─────────────────────
// workspace-actions.js 已迁 ESM（P2 本批）：真实 import，激活分支经 import 的
// sidebar-operations / project-data / ph-search-locate 等模块真实执行；
// remote-connections（目录投影与命名空间工具）已迁 ESM（P4 T3）→ 同为真实
// import，其命名空间对象经桥键 window.RemoteConnections 投放给各消费方。
// 动作入口仍是桥键 window.runWorkspaceAction，因此驱动方式与迁移前一致。
const WORKSPACE_ACTIONS = 'public/src/modules/workspace-actions.js';

/**
 * 控制台契约（本文件所有用例）：warn / error 一律逐条登记后深比较，不按
 * 关键词过滤——任何未登记的告警或错误（无论 TypeError / ReferenceError 还是
 * 其它异常、拒答、降级文案）都会以实际内容红掉。成功路径的期望是空列表；
 * 预期降级路径（如空 runtime 世界的侧栏快照诊断）把对应文案逐字写进期望。
 * 记录器只旁听，不改写、不吞错：原始输出照常打到宿主控制台。
 */
function createConsoleRecorder({ onInfo } = {}) {
  // 词法捕获宿主 console：用例期间 globalThis.console 已被换成记录器本身，
  // 运行时再取 console 会自我递归。
  const host = console;
  const lines = [];
  const format = (args) => args
    .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
    .join(' ');
  const recorder = {
    log: (...args) => host.log(...args),
    debug: (...args) => (typeof host.debug === 'function' ? host.debug(...args) : undefined),
    info: (...args) => {
      if (typeof onInfo === 'function') onInfo(args);
      else host.info(...args);
    },
    warn: (...args) => { lines.push(`warn: ${format(args)}`); host.warn(...args); },
    error: (...args) => { lines.push(`error: ${format(args)}`); host.error(...args); },
  };
  return { recorder, lines };
}

/** 控制台契约断言：整份日志与登记的预期逐条一致（不是关键词黑名单）。 */
function assertConsoleContract(lines, expected) {
  assert.deepEqual(
    lines,
    expected,
    '控制台告警/错误必须与登记的预期逐条一致（成功路径应为空；预期降级须逐字登记）',
  );
}
const REMOTE_CONNECTIONS = 'public/src/modules/remote-connections.js';

/**
 * 成功路径会经真实 toast-notify 弹「远程会话已启动」。它的 buildToastElement 用
 * createElement 造节点、再 querySelector 取子节点挂监听：默认元素桩的
 * querySelector 返回 null，会在无关的提示渲染上抛错。这里给 createElement 产出的
 * 节点补一个非空 querySelector（纯桩，不含业务语义）。
 */
function createDomElement() {
  return {
    style: {}, dataset: {}, classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    children: [], innerHTML: '', textContent: '', title: '', className: '', type: '',
    scrollTop: 0, scrollHeight: 0, offsetHeight: 0, clientHeight: 0, isConnected: true,
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.push(child); return child; },
    removeChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector() { return createDomElement(); },
    querySelectorAll() { return []; },
    focus() {}, blur() {},
  };
}

async function withRemoteActivateCase({ fetchStub, bumpEpochDuringWait = false }, fn) {
  const requests = [];
  const events = { switchAgent: [], alerts: [], order: [] };
  const { recorder: consoleProxy, lines: consoleLines } = createConsoleRecorder();
  return withP2EsmCase({
    classic: (sandbox) => {
      // 与 withDialogsCase 同一条真实 classic 引导：workspace-actions 的
      // 激活分支会以真实 ESM switchAgent 落地切换，其收尾的 loadAgentData 链
      // 读 app-core / runtime-status / sidebar-render 的真实实现。
      loadClassicBootstrap(sandbox, {
        onSwitch: (runtimeId) => { events.switchAgent.push(runtimeId); events.order.push('switch'); },
      });
      sandbox.window.createWorkspaceEntryHost = () => ({});
      sandbox.document = {
        ...sandbox.document,
        createElement: () => createDomElement(),
        createElementNS: () => createDomElement(),
        createTextNode: (text) => ({ textContent: String(text) }),
      };
      sandbox.window.alert = (msg) => { events.alerts.push(String(msg)); };
      sandbox.window.markActionLoading = () => {};
    },
    globals: { navigator: undefined, fetch: fetchStub, console: consoleProxy },
  }, async (c) => {
    // 刷新引擎（P4 T3 起是真实 ESM）：交互域在装载期取它的窄宿主，必须先入图。
    await c.load('public/src/modules/thread-store.js');
    // 远程目录 accessor（已迁 ESM）：真实 import 后命名空间对象才存在，覆盖
    // 就绪观察必须在它求值之后——生产消费方（workspace-actions）从
    // window.RemoteConnections 取成员，因此覆盖对象成员即生效。
    await c.load(REMOTE_CONNECTIONS);
    c.window.RemoteConnections.waitForRuntimeForSession = async () => {
      if (bumpEpochDuringWait) c.window.bumpNavigationGuard();
      return 'remote:server-a:rt-x';
    };
    await c.load(WORKSPACE_ACTIONS);
    return fn(c, { requests, events, consoleLines });
  });
}

/**
 * 目录 / 历史数据面用例上下文（P4 T3）：remote-connections 已迁 ESM → 真实
 * import；端点与 renderAgentList 观察面经 globals 注入。`fetchOverride` 给
 * 「网络失败」一类用例替换整个端点面。
 */
function withHistoryCase({
  catalog = CATALOG, history = REMOTE_HISTORY, requests = [], fetchOverride = null,
} = {}, fn) {
  const { recorder, lines } = createConsoleRecorder();
  return withP2EsmCase({
    globals: {
      console: recorder,
      renderAgentList: () => {},
      fetch: fetchOverride || (async (url, init) => {
        requests.push({ url: String(url), init });
        const path = String(url).split('?')[0];
        if (path === '/protoclaw/remote_catalog') {
          return { ok: true, status: 200, json: async () => catalog };
        }
        if (path === '/protoclaw/prebuilt_sessions') {
          return { ok: true, status: 200, json: async () => history };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    },
  }, async (c) => fn(await c.load(REMOTE_CONNECTIONS), { ctx: c, requests, logs: lines }));
}

describe('remote session history merge (R2-01)', () => {
  it('fetches forwarded lists per connected host and buckets them by directory', async () => {
    await withHistoryCase({}, async (rc, { requests, logs }) => {
      await rc.refreshRemoteCatalog();
      await rc.maybeRefreshRemoteHistory();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const historyCalls = requests.filter((r) => r.url.startsWith('/protoclaw/prebuilt_sessions'));
      assert.equal(historyCalls.length, 1, 'exactly one forwarded list fetch');
      assert.equal(
        historyCalls[0].url,
        '/protoclaw/prebuilt_sessions?agentId=remote%3Aserver-a%3Aprogramming-helper',
        'forwarded list uses the host-level namespace id',
      );

      // Directory-matching sessions merge; directoryless and other-directory
      // host sessions stay out (ADR-0010: 无目录会话不并入列表).
      const merged = rc.getRemoteHistorySessions('/srv/project-c');
      assert.deepEqual(merged.map((s) => s.id).sort(), [
        'remote:server-a:session-hist-1',
        'remote:server-a:session-hist-2',
      ]);
      assert.equal(merged[0].remoteConnectionId, 'server-a');
      assert.ok(!merged.some((s) => s.id.includes('session-nodir')), 'directoryless host session stays out');
      assert.ok(!merged.some((s) => s.id === 'remote:server-a:session-other-dir'), 'other-directory session not merged');
      // 控制台契约：成功刷新不得有告警/错误（逐条登记为空，异常文本一律红）。
      assertConsoleContract(logs, []);
    });
  });

  it('keeps remote history buckets empty after a failed fetch (no fabricated data)', async () => {
    await withHistoryCase({
      fetchOverride: async (url) => {
        const path = String(url).split('?')[0];
        if (path === '/protoclaw/remote_catalog') {
          return { ok: true, status: 200, json: async () => CATALOG };
        }
        return { ok: false, status: 503, json: async () => null };
      },
    }, async (rc, { logs }) => {
      await rc.refreshRemoteCatalog();
      await rc.maybeRefreshRemoteHistory();
      const merged = rc.getRemoteHistorySessions('/srv/project-c');
      assert.equal(merged.length, 0);
      // 预期网络失败（503）：失败契约是「不伪造数据、不静默重试」，且不产生
      // 告警/错误——日志内容逐条登记为空。若将来该路径新增播报（或异常文本
      // 泄露到控制台），这里会以实际内容红掉，由人确认后登记。
      assertConsoleContract(logs, []);
    });
  });

  it('mixed merge: local and remote ids share the project bucket, no badge fields', async () => {
    // project-data.js 与 remote-connections.js 均已迁 ESM：真实 import 后调
    // 命名导出（合并语义不变），远程历史桶经桥键 window.getRemoteHistoryProjectBuckets
    // 供 project-data 读取。
    const { recorder, lines: consoleLines } = createConsoleRecorder();
    const projects = await withP2EsmCase({
      label: 'project-data merge',
      classic: (sandbox) => {
        loadClassicBootstrap(sandbox);
        sandbox.run(`
          var getAgentWorkspaceState = function (agent) {
            return agent?.workspace_state && typeof agent.workspace_state === 'object'
              ? agent.workspace_state
              : { forms: {}, openDirectory: '', updatedAt: null };
          };
          function isPhStyleWorkspaceAgent(agent) {
            return !!(agent && agent.source === 'prebuilt' && agent.id === 'programming-helper');
          }
          function getCurrentAgentRecord() { return null; }
        `);
      },
      globals: {
        t: (key) => key,
        console: recorder,
        fetch: async (url) => {
          const target = String(url).split('?')[0];
          if (target === '/protoclaw/remote_catalog') {
            return { ok: true, status: 200, json: async () => CATALOG };
          }
          if (target === '/protoclaw/prebuilt_sessions') {
            return { ok: true, status: 200, json: async () => REMOTE_HISTORY };
          }
          return { ok: true, status: 200, json: async () => ({}) };
        },
      },
    }, async (c) => {
      await c.load('public/src/modules/thread-store.js');
      const rc = await c.load(REMOTE_CONNECTIONS);
      await rc.refreshRemoteCatalog();
      await rc.maybeRefreshRemoteHistory();
      const projectData = await c.load('public/src/modules/project-data.js');
      const agent = {
        id: 'programming-helper',
        source: 'prebuilt',
        workspace_state: { openDirectory: '/srv/project-c', forms: {}, phProjects: [] },
        workspace_sessions: {
          activeSessionId: 'session-local',
          sessions: [
            { id: 'session-local', title: '本地会话', openDirectory: '/srv/project-c', updatedAt: '2026-08-30T12:00:00.000Z' },
          ],
        },
      };
      return JSON.parse(JSON.stringify(
        projectData.getProgrammingHelperProjects(agent).map((p) => ({ id: p.id, sessions: p.sessions })),
      ));
    });
    const project = projects.find((p) => p.id === 'dir:/srv/project-c');
    assert.ok(project, 'local project bucket exists');
    const ids = project.sessions.map((s) => s.id);
    // Mixed, no source partition: local and remote ids live in the same array.
    assert.ok(ids.includes('session-local'), 'local session present');
    assert.ok(ids.includes('remote:server-a:session-hist-1'), 'remote history merged');
    assert.ok(!ids.includes('remote:server-a:session-other-dir'), 'unmatched directory not merged');
    // The merge never fabricates remote markers — presentation stays identical.
    const remoteSession = project.sessions.find((s) => s.id === 'remote:server-a:session-hist-1');
    assert.ok(remoteSession);
    assert.equal(remoteSession.remoteBadge, undefined);
    assert.equal(remoteSession.isRemote, undefined);
    // 控制台契约：合并路径（真实 project-data + classic 目录投影）无告警/错误。
    assertConsoleContract(consoleLines, []);
  });

  it('open_session activation posts to the activate endpoint with host namespace id and idempotency key', async () => {
    const requests = [];
    // 就绪观察按集成期契约留空（目录未出现）：激活请求形状与命名空间寻址才是本用例断言点。
    await withRemoteActivateCase({
      fetchStub: async (url, init) => {
        requests.push({ url: String(url).split('?')[0], init });
        return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
      },
    }, async (c, { consoleLines }) => {
      c.window.RemoteConnections.getEntryHostNamespaceId = (id) => (
        id === 'remote:server-a:session-hist-1' ? 'remote:server-a:programming-helper' : null);
      await c.read(
        `window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId: 'remote:server-a:session-hist-1' }))`,
      );
      // 切换收尾的侧栏刷新是 fire-and-forget（switchAgent 内部不 await），先让
      // 这一跳落定，控制台契约才是在核对完整日志而不是半份。P4 T2 起侧栏渲染是
      // sidebar-render 的模块实现，那一跳会跑真实 loadAgents，并报出「本世界没有
      // 运行中 runtime」的登记降级诊断。
      await new Promise((resolve) => setTimeout(resolve, 0));
      // 成功路径：只允许登记过的一条降级诊断（本世界没有运行中 runtime，
      // 真实切换收尾的侧栏刷新会报空连接快照），其余任何告警/错误——含全部
      // 异常文本——都会让整份日志与预期不一致而红。
      assertConsoleContract(consoleLines, [
        'warn: [sidebar] empty connected snapshot (both-sources-empty): prev=0 viewerRuntime=0',
      ]);
    });
    const activateCalls = requests.filter((r) => r.url === '/protoclaw/prebuilt_sessions/activate');
    assert.equal(activateCalls.length, 1, 'exactly one activate call');
    const call = activateCalls[0];
    assert.equal(call.init.method, 'POST');
    assert.ok(String(call.init.headers['x-idempotency-key'] || ''), 'activation carries an idempotency key');
    assert.deepEqual(JSON.parse(call.init.body), {
      agentId: 'remote:server-a:programming-helper',
      sessionId: 'remote:server-a:session-hist-1',
      responseMode: 'delta',
    });
  });

  it('open_session fails explicitly when the catalog has no entry for the session', async () => {
    const requests = [];
    await withRemoteActivateCase({
      fetchStub: async (url, init) => {
        requests.push({ url: String(url).split('?')[0], init });
        if (String(url).split('?')[0] === '/protoclaw/remote_catalog') {
          return { ok: true, status: 200, json: async () => CATALOG };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      },
    }, async (c, { events, consoleLines }) => {
      await c.window.RemoteConnections.refresh();
      c.window.RemoteConnections.getEntryHostNamespaceId = () => null;
      await c.read(
        `window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId: 'remote:server-a:session-ghost' }))`,
      );
      assert.equal(events.alerts.length, 1, '目录不含该会话时显式失败');
      // 预期失败：失败契约是弹窗（文案按连接不可用），且该路径不产生告警/错误
      // ——逐条登记为空，任何异常文本都会红掉。
      assert.equal(
        events.alerts[0],
        '远程连接不可用，无法打开该会话',
        '失败文案即契约：不猜测宿主',
      );
      assertConsoleContract(consoleLines, []);
    });
    assert.equal(requests.filter((r) => String(r.url).includes('activate')).length, 0, 'no request when host unresolvable');
  });
});

// ── R2-02: session write workflows (branch / compact / summary) ──────────
//
// Covers (vm sandbox, no real network):
//   1. RemoteConnections accessors: getHostNamespaceIdForSession /
//      namespaceMutationResult / waitForRuntimeForSession
//   2. submitBranch request shape for a remote session: host-namespace
//      agentId + namespaced sourceSessionId + idempotency key
//
// Identity discipline (ADR-0011/0012): the write body carries the
// host-level namespace id; bare ids appear only after the server strips
// the namespace before forwarding.

describe('remote session write identity helpers (R2-02)', () => {
  it('getHostNamespaceIdForSession resolves the host namespace from a catalog entry', async () => {
    await withHistoryCase({}, async (rc, { logs }) => {
      await rc.refreshRemoteCatalog();
      const hostNsId = rc.getHostNamespaceIdForSession('remote:server-a:session-running', 'programming-helper');
      assert.equal(hostNsId, 'remote:server-a:programming-helper');
      assertConsoleContract(logs, []);
    });
  });

  it('namespaceMutationResult prefixes bare ids in branch/compact responses and leaves local payloads untouched', async () => {
    await withHistoryCase({}, async (rc) => {
      const branchResult = rc.namespaceMutationResult('remote:server-a:session-1', {
        ok: true,
        newSessionId: 'session-b1',
        session: { id: 'session-b1', title: '（分支）x' },
        sessionDelta: {
          revision: 4,
          activeSessionId: 'session-b1',
          upsert: [{ id: 'session-b1', title: '（分支）x' }],
          remove: [],
        },
        archive: { requested: true, succeeded: true, error: null },
      });
      assert.equal(branchResult.newSessionId, 'remote:server-a:session-b1');
      assert.equal(branchResult.session.id, 'remote:server-a:session-b1');
      assert.equal(branchResult.sessionDelta.activeSessionId, 'remote:server-a:session-b1');
      assert.deepEqual(branchResult.sessionDelta.upsert.map((s) => s.id), ['remote:server-a:session-b1']);
      // archive 等非身份字段原样保留。
      assert.deepEqual(branchResult.archive, { requested: true, succeeded: true, error: null });

      // compact 响应形状（session.id / targetSessionId / sessionDelta）。
      const compactResult = rc.namespaceMutationResult('remote:server-a:session-1', {
        session: { id: 'session-c2' },
        targetSessionId: 'session-c2',
        sessionDelta: { revision: 2, activeSessionId: 'session-c2', upsert: [{ id: 'session-c2' }], remove: [] },
      });
      assert.equal(compactResult.session.id, 'remote:server-a:session-c2');
      assert.equal(compactResult.targetSessionId, 'remote:server-a:session-c2');
      assert.equal(compactResult.sessionDelta.activeSessionId, 'remote:server-a:session-c2');

      // 本地载荷（裸 sessionId）原样返回，零转换。
      assert.equal(rc.namespaceMutationResult('session-local', 'sentinel'), 'sentinel');
      assert.deepEqual(
        rc.namespaceMutationResult('session-local', { newSessionId: 's1', sessionDelta: { activeSessionId: null, upsert: [] } }),
        { newSessionId: 's1', sessionDelta: { activeSessionId: null, upsert: [] } },
      );
    });
  });

  it('waitForRuntimeForSession resolves the namespaced runtime ref once it appears in the catalog', async () => {
    await withHistoryCase({}, async (rc, { logs }) => {
      await rc.refreshRemoteCatalog();
      const ref = await rc.waitForRuntimeForSession('remote:server-a:runtime-main', 2);
      assert.equal(ref, 'remote:server-a:runtime-main');
      assertConsoleContract(logs, []);
    });
  });

  it('waitForRuntimeForSession returns null after exhausting attempts for an absent runtime', async () => {
    await withHistoryCase({
      catalog: { connections: [{ connectionId: 'server-a', name: 'Lab-B', status: 'connected', workspaces: [] }] },
    }, async (rc, { logs }) => {
      await rc.refreshRemoteCatalog();
      const ref = await rc.waitForRuntimeForSession('remote:server-a:session-ghost', 1);
      // 预期「等不到就绪」路径：契约是返回 null（不伪装成功、不静默重试），
      // 且不产生任何告警/错误——日志内容逐条登记为空。
      assert.equal(ref, null);
      assertConsoleContract(logs, []);
    });
  });
});

// ── R2-02: frontend write request shapes ─────────────────────────────────

// session-dialogs.js 已迁 ESM（P2 W1-4）：装载期解析对话框 DOM 并在轮次列表上
// 注册 click 监听，提交经 ClawFW.actions 分发（'sessionDialogs.submitBranch'）。
// 因此这里给出按 id 定位、可派发 click 的最小 DOM 替身——「选分支点」走真实
// 处理器（data-branch-index → selectedIdx），不再直接写模块私有状态。
const SESSION_DIALOGS = 'public/src/modules/session-dialogs.js';

function createBranchDialogDom() {
  const elements = new Map();
  const roundItems = [{
    dataset: { branchIndex: '0' },
    classList: { add() {}, remove() {} },
  }];
  const makeElement = (id) => {
    const listeners = new Map();
    return {
      id,
      style: {},
      dataset: {},
      innerHTML: '',
      textContent: '',
      disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      },
      dispatch(type, event) {
        for (const callback of listeners.get(type) || []) callback(event);
      },
      querySelector() { return null; },
      // 轮次列表的条目集合与真实 querySelectorAll 语义对齐（渲染时按 index 产出）
      querySelectorAll() { return id === 'branch-round-list' ? roundItems : []; },
      appendChild(child) { return child; },
      removeChild(child) { return child; },
      focus() {},
      select() {},
    };
  };
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const body = makeElement('body');
  return {
    roundItems,
    elements,
    document: {
      getElementById,
      createElement: () => makeElement('created'),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body,
      documentElement: makeElement('html'),
      activeElement: null,
      readyState: 'complete',
    },
    /** 用户点击第 idx 个分支点（真实 click 处理器由模块在装载期注册）。 */
    clickRound(idx) {
      getElementById('branch-round-list').dispatch('click', {
        target: {
          closest: (selector) => (String(selector).includes('data-branch-index') ? roundItems[idx] : null),
        },
      });
    },
  };
}

/**
 * classic 相真实装载链（顺序同 index.html：classic 先行于 deferred ESM）。图装载期
 * 读到的宿主因此是真实实现：app-core（p2-bootstrap-* 全套等）→ runtime-status
 * （`_agentSuspended` 等 const 容器）→ session-view-state（commit host）→
 * sidebar-render（侧栏签名 / call-states / 列表快照 host 工厂）。
 * 仅 app-main / app-ui 的 host 工厂走 seam（顶层是整条首屏 boot），按真实成员面补全。
 */
const CLASSIC_BOOTSTRAP = [
  'public/src/modules/action-dispatcher.js',
  'public/src/app-core.js',
  // session-view-state 自 P4 T2 起是 ESM：由 prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN)
  // / prepareClassicSandbox 在模块相装载，classic 链里不再有它。
];

function installSeamFactories(sandbox, hooks = {}) {
  const noop = () => {};
  const falsy = () => false;
  const nil = () => null;
  const onSwitch = typeof hooks.onSwitch === 'function' ? hooks.onSwitch : noop;
  sandbox.createRuntimeSwitchHost = () => ({
    state: {
      pendingSwitchTarget: null, pendingSwitchSerial: 0, navigationEpoch: 0, switchEpoch: 0,
      focusedAgentId: null, runtimeId: null, readOnlyMode: false, lastRenderedWorkspaceHtml: '',
      followLatest: false, restoredScrollTop: 0,
    },
    // 生产里 host.switchAgent 是 classic app-main 的落地动作；本文件驱动的是
    // ESM switchAgent（runtime-switch）本体——它只经宿主原语落地，因此这里给
    // 完整原语面，并把「切到哪个 runtime」经 persistFocus 宿主缝记录。
    switchAgent: async (runtimeId) => { onSwitch(String(runtimeId)); },
    setTimeout: (callback, delay) => sandbox.setTimeout(callback, delay),
    hasPendingNavigation: falsy, bumpNavigationGuard: noop, closeContextMenu: noop,
    findAgent: nil, isWorkspaceHost: falsy,
    runtimeId: (agent) => agent?.id || '', agentRuntimeId: (agent) => agent?.id || '',
    isRemote: falsy, remote: nil, closeReadOnlySession: noop, isWorkspaceSurface: falsy,
    selectWorkspace: noop, storeDraft: noop, saveWorkspaceScroll: noop, saveCache: noop,
    logicalId: (agent) => agent?.id || '', normalize: (value) => value ?? '',
    clearFinished: noop, deriveSession: nil, bindSession: noop, updateThreadIndicators: noop,
    browseOnly: falsy, resetSurface: noop, resetScroll: noop, resetStatus: noop,
    activateCollapse: noop, contextKey: nil, restoreCache: noop, setPendingScroll: noop,
    render: noop, renderPanel: noop, patch: noop,
    emptyOverview: () => ({}), emptyTodo: () => ({}),
    setFollowLatest: noop, beginFollowWindows: noop, renderAgents: noop,
    // 真实 switchAgent 的其余宿主原语（预取通知 / 呼叫态投影 / 焦点持久化 /
    // 诊断与错误出口）：本文件不让这些副作用进入断言面，但必须是完整面，
    // 否则真实切换会在自身 try/catch 里抛缺键错误。
    fetch: (...args) => sandbox.fetch(...args),
    applyCalling: noop, syncActionButton: noop,
    isCalling: falsy,
    persistFocus: (runtimeId) => { onSwitch(String(runtimeId)); },
    warn: noop, error: noop, alert: noop, clearLoading: noop,
  });
  sandbox.createCompactResumeHost = () => ({
    isRemote: falsy,
    remote: () => sandbox.RemoteConnections || null,
    createOperationId: (reason) => `op-${reason || 'compact'}`,
    now: () => Date.now(),
    observe: () => noop,
    checkpoint: noop,
    fetch: (...args) => sandbox.fetch(...args),
    idempotencyKey: () => 'seam-key',
    refreshThreads: noop,
  });
  // 身份投影（owner: classic app-core / app-main）：本链世界没有运行中 runtime、
  // 也没有焦点 agent——真实切换与状态刷新会读这两个投影。
  sandbox.window.getCurrentRuntimeRecord = () => null;
  sandbox.window.getCurrentAgentRecord = () => null;
  // 轮询协调者宿主（owner: classic app-main，本链不加载其 boot）：请求立即轮询
  // 的交互路径会经它落地；本文件不断言轮询，按宿主缝给惰性实现。
  sandbox.createPollCoordinatorHost = () => ({
    run: noop,
    fastInterval: () => 0,
    setTimeout: (callback, delay) => sandbox.setTimeout(callback, delay),
    clearTimeout: (id) => sandbox.clearTimeout(id),
  });
  sandbox.createWorkspaceSurfaceHost = () => ({
    bumpNavigationGuard: noop, closeReadOnlySession: noop, hasDetail: falsy,
    loadDetail: async () => {}, findAgent: nil, currentAgent: nil,
    preferenceKey: () => '', tabs: () => [], surfacePreference: nil,
    defaultMode: () => 'chat', ui: () => ({}), focusedAgentId: nil, runtimeId: nil,
    contextKey: () => '', saveScroll: noop, readOnlyMode: falsy, saveCache: noop,
    bindWorkspace: noop, setFollowLatest: noop, resetRuntimeState: noop,
    beginPending: noop, setTab: noop, beginLoading: noop, clearPending: noop,
    renderAgents: noop, render: noop, renderPanel: noop, refreshPanels: noop,
  });
}

/** classic 相引导：语言初值经真实路径（localStorage → app-core 桥键）进入。 */
function loadClassicBootstrap(sandbox, hooks) {
  sandbox.localStorage.setItem('agentdev-language', 'zh');
  // 浏览器高精度计时器：vm 沙箱不自带，而 classic sidebar-render 的
  // createAgentSnapshotLoaderHost 以 performance.now() 计时（真实 loadAgents
  // 会调它）。宿主环境缺失不是被测契约，按浏览器能力补齐。
  sandbox.performance = { now: () => Date.now() };
  for (const file of CLASSIC_BOOTSTRAP) sandbox.loadSource(file);
  prepareSidebarDomain(sandbox);
  // app-main 的 classic 同步引擎（唯一 owner）：登记 sidebar-render 轮询/裁剪
  // 路径消费的两个桥键；boot 体挂在永不 resolve 的 __clawAuthReady 上。
  installForegroundSyncOwner(sandbox);
  installSeamFactories(sandbox, hooks);
  // 渲染副作用不在本文件断言面内：远程目录刷新会触发侧栏整表重绘。P4 T2 起
  // renderAgentList 是 sidebar-render 的模块实现（桥键 setter 也能覆盖它，
  // 但装载是异步的、这一步早于模块求值），因此按布局接口给最小面，让真实重绘
  // 只做投影、不触碰 DOM。
  sandbox.ClawSidebarLayout = { load: async () => {}, signature: () => '', isInteracting: () => false, render() {} };
  sandbox.renderCurrentMainView = () => {};
  // 右栏渲染入口（owner: classic app-ui，本链不加载）：真实 loadAgents 收尾会
  // 调 renderFeaturePanel，缺键会在刷新链上抛 ReferenceError。
  sandbox.renderFeaturePanel = () => {};
  // 常驻输入的动作按钮同步（owner: classic persistent-input 的
  // _syncPersistentActionButton）：运行期状态刷新链会裸调用它，缺键即
  // ReferenceError。本文件不断言该按钮，作为壳层宿主缝给空实现。
  sandbox.window._syncPersistentActionButton = () => {};
  // 宿主 IPC 回执的真实 wire 形状：连接快照是数组，其余命令是对象。
  // 真实 loadAgents 会读连接快照，缺这条 wire 会在刷新链上抛 TypeError。
  sandbox.window.invoke = async (command) => (command === 'get_connected_agents' ? [] : {});

}

function withDialogsCase({ requests = [] } = {}, fn) {
  const dom = createBranchDialogDom();
  const sidebarPhases = [];
  // 真实 sidebar-operations 以 console.info('[SIDEBAR_OPERATION]', record) 播报
  // 操作阶段（settled 后记录即从存储删除）——用它观察提交载荷里的 operationId
  // 是否就是本次分支操作的真实 id。
  const captureInfo = (args) => {
    if (args[0] === '[SIDEBAR_OPERATION]' && args[1] && typeof args[1] === 'object') sidebarPhases.push(args[1]);
    else console.info(...args);
  };
  const { recorder: consoleProxy, lines: consoleLines } = createConsoleRecorder({ onInfo: captureInfo });

  return withP2EsmCase({
    label: 'session-dialogs',
    classic: (sandbox) => {
      // classic 相：真实 classic 链先行（内置桥键与宿主），再补写提交路径需要的
      // classic 顶层函数替身。内核桥键（allAgents / currentLanguage /
      // currentRuntimeAgentId / lastRenderedWorkspaceHtml / _navigationGuardEpoch）
      // 已由 app-core 注册真初值，这里不再重复声明，避免覆盖访问器造成双存储。
      loadClassicBootstrap(sandbox);
      sandbox.run(`
        var bumpNavigationGuard = function () {};
        var isRemoteNamespaceAgentId = function (value) { return String(value || '').startsWith('remote:'); };
        var closeCompactMenu = function () {};
        var renderCurrentMainView = function () {};
        var getCurrentAgentRecord = function () { return null; };
        var getWorkspaceSessionById = function () { return null; };
        var getPathLeaf = function (value) { return String(value || ''); };
        var upsertConnectedAgent = function (agent) { return agent; };
        var setPreferredUnitMode = function () {};
        var markSessionLoading = function () {};
        var clearSessionLoading = function () {};
        var clearChatLoadingSession = function () {};
        var escapeHtml = function (value) { return String(value ?? ''); };
        var fmtPct = function (frac) { return (frac * 100).toFixed(1) + '%'; }; // app-core 全局的沙箱替身
      `);
    },
    globals: {
      document: dom.document,
      t: (key) => key,
      isRemoteNamespaceAgentId: (value) => String(value || '').startsWith('remote:'),
      currentRuntimeAgentId: null,
      allAgents: [],
      console: consoleProxy,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        const path = String(url).split('?')[0];
        if (path === '/protoclaw/remote_catalog') {
          return { ok: true, status: 200, json: async () => CATALOG };
        }
        if (path === '/protoclaw/session_trim_preview') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ rounds: [{ msgIndexEnd: 5, turnStart: 1, charPercent: 0.2, cumulativePercent: 0.8 }], preamblePercent: 0.1 }),
          };
        }
        if (path === '/protoclaw/runtime_status') {
          return { ok: false, status: 404, json: async () => ({ ok: false }) };
        }
        if (path === '/api/agents') {
          // Viewer 存活快照：本用例世界没有运行中的 runtime。
          return { ok: true, status: 200, json: async () => ({ agents: [] }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            newSessionId: 'session-b1',
            branchTitle: '（分支）远程会话',
            session: { id: 'session-b1', title: '（分支）远程会话' },
            revision: 4,
            sessionDelta: {
              revision: 4,
              activeSessionId: 'session-b1',
              upsert: [{ id: 'session-b1', title: '（分支）远程会话' }],
              remove: [],
            },
            archive: { requested: true, succeeded: true, error: null },
          }),
        };
      },
    },
  }, async (c) => {
    // 刷新引擎（P4 T3 起是真实 ESM）：交互域在装载期取它的窄宿主，必须先入图。
    await c.load('public/src/modules/thread-store.js');
    // 远程目录 accessor（已迁 ESM，P4 T3）：真实 import 后才存在
    // window.RemoteConnections；catalog 身份来自 mock 的 remote_catalog 响应。
    const rc = await c.load(REMOTE_CONNECTIONS);
    const dialogs = await c.load(SESSION_DIALOGS);
    return fn({ c, rc, dialogs, dom, sidebarPhases, requests, consoleLines });
  });
}


describe('frontend session write request shapes (R2-02)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** 打开分支对话框 → 点选第 0 个分支点（真实 click 处理器）→ 经分发器提交。 */
  async function openAndSubmitBranch({ c, dom, dialogs }, agentId, sessionId) {
    await dialogs.openBranchDialog(agentId, sessionId, true);
    await tick();
    dom.clickRound(0);
    c.read("window.ClawFW.actions.invoke('sessionDialogs.submitBranch')");
    await tick();
    await tick();
  }

  it('submitBranch posts a namespaced host agentId and idempotency key for a remote session', async () => {
    const requests = [];
    await withDialogsCase({ requests }, async (harness) => {
      const { c, sidebarPhases } = harness;
      await c.window.RemoteConnections.refresh();
      // 就绪观察留空（目录不出现）：本用例断言提交载荷，不触发切换。
      c.read(`
        window.RemoteConnections.waitForRuntimeForSession = async function () { return null; };
      `);
      await openAndSubmitBranch(harness, 'programming-helper', 'remote:server-a:session-7');

      const branchCalls = requests.filter((r) => r.url === '/protoclaw/sessions/branch');
      assert.equal(branchCalls.length, 1, 'exactly one branch call');
      const call = branchCalls[0];
      assert.equal(call.init.method, 'POST');
      assert.ok(String(call.init.headers['x-idempotency-key'] || ''), 'branch carries an idempotency key');
      const body = JSON.parse(call.init.body);
      // 提交载荷的 operationId 就是本次分支操作在侧栏操作状态机里的真实 id
      // （原用例钉的是替身常量 'op-branch'，真实实现下改为对真实操作 id 断言）。
      const branchPhase = sidebarPhases.find((phase) => phase.operation === 'branch');
      assert.ok(branchPhase, 'branch operation must be recorded by the sidebar operation state');
      assert.equal(typeof body.operationId, 'string');
      assert.equal(body.operationId, branchPhase.operationId, 'payload carries the real branch operation id');
      assert.deepEqual({ ...body, operationId: 'op-branch' }, {
        agentId: 'remote:server-a:programming-helper',
        sourceSessionId: 'remote:server-a:session-7',
        cutMsgIndexEnd: 5,
        archiveOriginal: true,
        responseMode: 'delta',
        operationId: 'op-branch',
      });
      // 控制台契约（逐条登记，不做关键词过滤）：本用例世界没有运行中的
      // runtime，提交后的真实侧栏刷新会留下一条「空连接快照」降级诊断——
      // 它是本世界唯一允许的告警；任何新增告警、任何 error（含全部异常文本）
      // 都会让整份日志与预期不一致而红。
      assertConsoleContract(harness.consoleLines, [
        'warn: [sidebar] empty connected snapshot (both-sources-empty): prev=0 viewerRuntime=0',
      ]);
    });
  });

  // ADR-0032：线程会话的分支即新线程，「归档原会话」只对链中旧快照打
  // 不可见标志——本地线程会话钳制关闭；非线程会话归档意图原样透传。
  const branchWithThreadFlag = async (isThread) => {
    const requests = [];
    let body = null;
    await withDialogsCase({ requests }, async (harness) => {
      const { c } = harness;
      await c.window.RemoteConnections.refresh();
      c.read(`
        window.RemoteConnections.waitForRuntimeForSession = async function () { return null; };
        window.isThreadHostAgentId = function () { return ${isThread}; };
        var getRuntimeId = function (agent) { return (agent && agent.id) || ''; };
      `);
      await openAndSubmitBranch(harness, 'programming-helper', 'session-local-1');
      const call = requests.find((r) => r.url === '/protoclaw/sessions/branch');
      assert.ok(call, 'branch call fired');
      body = JSON.parse(call.init.body);
      // 控制台契约：本地分支的提交后刷新在本世界不产生告警/错误；任何告警
      // （含异常文本）都会让整份日志与空预期不一致而红。
      assertConsoleContract(harness.consoleLines, []);
    });
    return body;
  };

  it('clamps archiveOriginal for thread-carried local sessions', async () => {
    const body = await branchWithThreadFlag(true);
    assert.notEqual(body.archiveOriginal, true, 'thread-carried session must not archive the original');
  });

  it('keeps archiveOriginal passthrough for non-thread local sessions', async () => {
    const body = await branchWithThreadFlag(false);
    assert.equal(body.archiveOriginal, true, 'plain session keeps the archive intent');
  });
});
