/**
 * remoteOnly 守卫迁移到能力矩阵（batch9/r2-guard-migration）。
 *
 * Covers:
 *   1. phSwitchProject 门控迁移：视图切换 / 本地工作区切换的路由由项目
 *      本地宿主身份 + window.RemoteConnections.capabilityFor（签名
 *      (agentId, action) → boolean）决定
 *   2. 语义保持（ADR-0012 决策 1）：remoteOnly 桶（目录仅存在于远程主机）
 *      无论握手能力与否都只做 surface 视图切换，不触发本地
 *      ph_project/switch——本地切换写的是本机工作区，真本地事实优先于能力位
 *   3. 本地回归：本地项目照常本地切换；集成期无 capabilityFor 时行为不变；
 *      未知项目 id 保持既有 fall-through 路由
 *
 * 装载路线（P2 W2-8 测试改造）：project-data / ph-project-actions 已迁 ESM →
 * withP2EsmCase 真实 import（每 case 一张图）；classic 侧仍真实 loadSource 跑
 * action-dispatcher / app-core（p2-bootstrap 工厂 + isPhStyleWorkspaceAgent）/
 * i18n / remote-connections（remoteOnly 桶与 capabilityFor 的真实实现）。
 * 断言改为调用命名导出，网络与能力位仍按真实请求形状 / 真实契约 stub 驱动。
 *
 * Identity discipline (ADR-0012): 集成期依赖——capabilityFor 以 stub 注入；
 * remoteOnly 桶由真实 remote-connections.js + project-data.js 数据层合成，
 * 不在测试里手造标记。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { ensureSidebarRenderHostSeam } from './p2-classic-hosts.js';

const PROJECT_DATA = 'public/src/modules/project-data.js';
const PH_PROJECT_ACTIONS = 'public/src/modules/ph-project-actions.js';
const PH_SESSION_LIST = 'public/src/modules/ph-session-list.js';

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
  activeSessionId: null,
  sessions: [
    { id: 'session-hist-1', title: '远程历史 A', updatedAt: '2026-08-30T09:00:00.000Z', openDirectory: '/srv/project-c' },
    { id: 'session-hist-2', title: '远程历史 B', updatedAt: '2026-08-29T10:00:00.000Z', openDirectory: '/srv/project-c' },
  ],
};

const LOCAL_PROJECT_ID = 'dir:d:/proj-a';
const REMOTE_ONLY_PROJECT_ID = 'dir:/srv/project-c';

function makeElement(id = '') {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    dataset: {},
    hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    insertBefore() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
}

function createDocumentStub() {
  const byId = new Map();
  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement(id));
      return byId.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return makeElement(); },
    createTextNode(text) { return { textContent: text }; },
    addEventListener() {},
    removeEventListener() {},
    body: makeElement('body'),
    head: makeElement('head'),
    documentElement: makeElement('html'),
    readyState: 'complete',
    activeElement: null,
  };
}

async function withGuard(probe) {
  const requests = [];
  const capabilities = [];
  const document = createDocumentStub();
  const phAgent = {
    id: 'programming-helper',
    source: 'prebuilt',
    workspace_state: { openDirectory: 'D:/proj-a', forms: {}, phProjects: [] },
    workspace_sessions: { activeSessionId: 'session-local', sessions: [
      { id: 'session-local', title: '本地会话', openDirectory: 'D:/proj-a', updatedAt: '2026-08-30T12:00:00.000Z' },
    ] },
  };
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      sandbox.loadSource('public/src/app-core.js');
      // classic 宿主面：当前 agent 记录与主视图重绘（app-main / app-ui 仍 classic）。
      sandbox.__phAgent = phAgent;
      sandbox.allAgents = [phAgent];
      sandbox.run(`
        window.getCurrentAgentRecord = () => window.__phAgent;
        window.renderCurrentMainView = function () {};
        // ESM 图求值期读取的 loader host 工厂（最小契约替身，不重写实现）。
        createAgentSnapshotLoaderHost = () => ({ state: {} });
        createRuntimeSwitchHost = () => ({ state: {} });
        // 轮询协调器宿主（classic app-main 工厂）：ESM 图经 agent-data-loader →
        // input-actions 触达 poll-coordinator-host，后者在模块求值期取该工厂。
        createPollCoordinatorHost = () => ({
          run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
        });
        createWorkspaceSurfaceHost = () => ({ state: {} });
        createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
        createAgentCallStatesHost = () => ({ state: {} });
        createSessionViewCommitHost = () => ({ state: {} });
        createP2BootstrapSidebarRenderHost = () => ({ lastAgentListRenderSignature: '' });
      `);
      // 侧栏渲染自 P4 T2 起在模块相：remote-connections 的目录刷新经真实
      // `renderAgentList` 重建侧栏，classic 协作面按生产宿主面补齐（断言不落
      // 在侧栏 DOM 上）。
      ensureSidebarRenderHostSeam(sandbox);
      // 高亮谓词（app-main 的 classic 函数，sidebar-render 经 window 晚绑定）。
      // 本文件不验高亮，按「无 runtime 选中」的生产分支给最小实现。
      sandbox.isAgentActive = () => false;
      sandbox.isRuntimeItemActive = () => false;
    },
    globals: {
      document,
      URLSearchParams,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        const path = String(url).split('?')[0];
        if (path === '/protoclaw/remote_catalog') {
          return { ok: true, status: 200, json: async () => CATALOG };
        }
        if (path === '/protoclaw/prebuilt_sessions') {
          return { ok: true, status: 200, json: async () => REMOTE_HISTORY };
        }
        if (path === '/protoclaw/ph_project/switch') {
          return { ok: true, status: 200, json: async () => ({ state: { openDirectory: 'D:/proj-a', forms: {} } }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    },
  }, async (c) => {
    // 远程目录（已迁 ESM，P4 T3）：project-data 的 remoteOnly 桶与
    // capabilityFor 门控都经 window.RemoteConnections 取数。
    await c.load('public/src/modules/remote-connections.js');
    const data = await c.load(PROJECT_DATA);
    const actions = await c.load(PH_PROJECT_ACTIONS);
    // 远程视图覆盖状态 owner（P2 项目/装配批：ClawFW.phSurfaceViewProjectId 窗面已撤，
    // 读写统一走 ph-session-list 的命名导出）。
    const sessionList = await c.load(PH_SESSION_LIST);
    return probe({ c, data, actions, sessionList, requests, capabilities });
  });
}

async function refreshRemoteHistory(c) {
  await c.window.RemoteConnections.refresh();
  c.window.RemoteConnections.maybeRefreshRemoteHistory();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// 集成期依赖：capabilityFor 由并行工单在 remote-connections.js 实现，
// 测试按契约签名 (agentId, action) → boolean stub（记录调用面）。
function stubCapability(c, capabilities, result) {
  capabilities.length = 0;
  c.window.RemoteConnections.capabilityFor = (agentId, action) => {
    capabilities.push({ agentId, action });
    return result;
  };
}

function switchCalls(requests) {
  return requests.filter((r) => r.url === '/protoclaw/ph_project/switch');
}

describe('phSwitchProject capability guard migration (remoteOnly → capabilityFor)', () => {
  it('remoteOnly bucket stays view-only even when the handshake grants write', async () => {
    await withGuard(async ({ c, actions, sessionList, requests, capabilities }) => {
      await refreshRemoteHistory(c);
      stubCapability(c, capabilities, true);

      await actions.phSwitchProject(REMOTE_ONLY_PROJECT_ID);

      // 本地 ph_project/switch 会把本机工作区切到远程路径（错误语义）——
      // 宿主写能力为 true 也不改变视图切换路由（真本地事实，非能力位）。
      assert.equal(switchCalls(requests).length, 0, 'no local workspace switch for remote-only bucket');
      assert.equal(
        sessionList.getPhSurfaceViewProjectId(),
        REMOTE_ONLY_PROJECT_ID,
        'surface view override marks the remote-only bucket',
      );
    });
  });

  it('remoteOnly bucket stays view-only when the write capability is denied', async () => {
    await withGuard(async ({ c, actions, sessionList, requests, capabilities }) => {
      await refreshRemoteHistory(c);
      stubCapability(c, capabilities, false);

      await actions.phSwitchProject(REMOTE_ONLY_PROJECT_ID);

      assert.equal(switchCalls(requests).length, 0, 'no local workspace switch for remote-only bucket');
      assert.equal(sessionList.getPhSurfaceViewProjectId(), REMOTE_ONLY_PROJECT_ID);
    });
  });

  it('local project switches the local workspace when the host write capability is available', async () => {
    await withGuard(async ({ c, actions, sessionList, requests, capabilities }) => {
      await refreshRemoteHistory(c);
      stubCapability(c, capabilities, true);

      await actions.phSwitchProject(LOCAL_PROJECT_ID);

      const calls = switchCalls(requests);
      assert.equal(calls.length, 1, 'exactly one local workspace switch');
      assert.equal(calls[0].init.method, 'POST');
      assert.deepEqual(JSON.parse(calls[0].init.body), {
        agentId: 'programming-helper',
        projectId: LOCAL_PROJECT_ID,
      });
      assert.equal(sessionList.getPhSurfaceViewProjectId(), null, 'no view override for local project');
      // 门控查询按契约签名走本地宿主身份。
      assert.deepEqual(capabilities, [{ agentId: 'programming-helper', action: 'write' }]);
      // 切片请求观察：目录切换后必须按 projectDir 拉首屏切片——该请求被
      // phLoadProjectSessions 的 catch 吞掉曾是静默失败（沙箱缺
      // URLSearchParams 时的假阳性），在此显式锚定。（日志里还混有远程历史
      // 刷新的 prebuilt_sessions 请求，按归属参数区分。）
      const sliceCalls = requests.filter((r) => r.url.includes('projectDir=D%3A%2Fproj-a'));
      assert.ok(sliceCalls.length >= 1, 'slice request must actually fire after directory switch');
      assert.match(sliceCalls[0].url, /agentId=programming-helper/);
      assert.doesNotMatch(sliceCalls[0].url, /projectId=/);
    });
  });

  it('legacy parity: without RemoteConnections.capabilityFor local switching still works and remoteOnly stays view-only', async () => {
    await withGuard(async ({ c, actions, sessionList, requests }) => {
      await refreshRemoteHistory(c);
      // 不 stub capabilityFor（集成期前模块未提供该函数）。

      await actions.phSwitchProject(LOCAL_PROJECT_ID);
      assert.equal(switchCalls(requests).length, 1, 'local project keeps switching locally');

      await actions.phSwitchProject(REMOTE_ONLY_PROJECT_ID);
      assert.equal(switchCalls(requests).length, 1, 'remote-only bucket never reaches the local switch');
      assert.equal(sessionList.getPhSurfaceViewProjectId(), REMOTE_ONLY_PROJECT_ID);
    });
  });

  it('unknown project id keeps the legacy fall-through to the local switch endpoint', async () => {
    await withGuard(async ({ c, actions, sessionList, requests, capabilities }) => {
      await refreshRemoteHistory(c);
      stubCapability(c, capabilities, true);

      await actions.phSwitchProject('dir:/nowhere');

      const calls = switchCalls(requests);
      assert.equal(calls.length, 1, 'unknown id falls through to the switch endpoint (server rejects)');
      assert.equal(JSON.parse(calls[0].init.body).projectId, 'dir:/nowhere');
      assert.equal(sessionList.getPhSurfaceViewProjectId(), null);
    });
  });
});
