// Isolated browser fixture for the PH dual-selector + session-move surface.
// Real frontend modules + real CSS; curated API subset on an isolated data root
// (AGENTDEV_DATA_DIR set before any server import). No real user data, no models.
//
// Sessions live in the REAL session index (server/shared/session-access.js):
// seeds go through updateSessionIndex, the slice endpoint reads via
// readSessionIndex, and sessions_move is the REAL route from
// setupPhProjectRoutes — so browser-driven moves actually mutate the real
// index and slice re-pulls reflect it (ownership round-trip, no mocks of the
// move itself). Runtime lifecycle deps are injected fakes with a switchable
// busy mode.
import express from 'express';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.AGENTDEV_DATA_DIR = ''; // set below before imports resolve constants

/**
 * 真实应用外壳（public/index.html 的 body，剥掉全部 <script>）：已迁 ESM 的模块
 * 在装载期解析并监听对话框骨架上的元素（分支对话框、精简页等），fixture 页面必须
 * 提供与生产同构的 DOM，否则模块在装载期就抛 null.addEventListener。
 * 样式表仍由 fixture 自己引入（真实 CSS，检查项依赖真实尺寸）。
 */
function readAppShell() {
  const indexHtml = fsSync.readFileSync(path.join(process.cwd(), 'public/index.html'), 'utf8');
  const match = indexHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!match) throw new Error('ph-project fixture: public/index.html 缺少 body');
  return match[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

export async function startPhProjectFixture(port = 0) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-ph-project-browser-'));
  process.env.AGENTDEV_DATA_DIR = dataDir;

  const { setupPhProjectRoutes, createPhProject, listPhProjects } = await import('../server/routes/ph-projects.js');
  const { setupFeatureConfigRoutes } = await import('../server/routes/feature-config.js');
  const { readSessionIndex, updateSessionIndex } = await import('../server/shared/session-access.js');

  const cwd = process.cwd().replace(/\\/g, '/');
  // 同目录 D/A/B：目录桶 + 两个项目共用同一物理目录；
  // plain 空目录桶（无任何项目）：验证无项目目录的子菜单行为
  const plainDir = cwd + '/.tmp/plain-dir';
  const projA = await createPhProject({ name: 'Alpha', workDirectory: cwd });
  const projB = await createPhProject({ name: 'Beta', workDirectory: cwd });
  const projects = await listPhProjects();

  // 会话种子写入真实索引（sessions_move / 切片都对着这份索引工作）
  const seedSessions = [
    { id: 'sess_dir_1', title: 'Dir chat D', updatedAt: '2026-10-22T10:00:00.000Z', createdAt: '2026-10-20T00:00:00.000Z', openDirectory: cwd, messageCount: 4, archived: false },
    { id: 'sess_a_1', title: 'A1 project chat', updatedAt: '2026-10-22T11:00:00.000Z', createdAt: '2026-10-20T00:00:00.000Z', projectId: projA.id, messageCount: 2, archived: false },
    { id: 'sess_b_1', title: 'B1 project chat', updatedAt: '2026-10-22T12:00:00.000Z', createdAt: '2026-10-20T00:00:00.000Z', projectId: projB.id, messageCount: 3, archived: false },
  ];
  await updateSessionIndex('programming-helper', (index) => ({ ...index, sessions: seedSessions }));

  const captured = { sessions: [], search: [], actions: [], stopped: [] };
  // 生命周期 deps 假件：默认无存活实例；busy 模式可切换（模拟执行中轮次）
  const runtimeState = { runtime: null, running: false, viewer: null };
  const deps = {
    getAgentRuntime: () => runtimeState.runtime,
    isManagedRuntimeRunning: () => runtimeState.running,
    stopManagedAgent: async (_agentId, sessionId) => { captured.stopped.push(sessionId); runtimeState.runtime = null; runtimeState.running = false; },
    readViewerJson: async (viewerPath) => {
      if (runtimeState.viewer) return runtimeState.viewer(viewerPath);
      if (viewerPath.endsWith('/notification')) return { callActive: false };
      if (viewerPath.endsWith('/queued-inputs')) return [];
      return {};
    },
  };

  const app = express();
  setupPhProjectRoutes(app, express, deps);
  setupFeatureConfigRoutes(app, express);
  // 生产同款失败序列化（server.js 末段契约：code/message/error 字段形状）
  const { buildLocalFailureResponse, readOperationMetadata } = await import('../server/shared/operation-contract.js');
  app.use((error, req, res, _next) => {
    const status = error.statusCode || error.status || 500;
    res.status(status).json(buildLocalFailureResponse(error, readOperationMetadata(req)));
  });

  // 目录切换（curated mock）：切换即返回目录 state（fixture 只有一个本地目录）
  const wsState = { openDirectory: cwd, phProjects: [{ openDirectory: cwd }, { openDirectory: plainDir }] };
  app.post('/protoclaw/ph_project/switch', express.json(), (req, res) => {
    captured.actions.push({ type: 'dir-switch', projectId: req.body?.projectId });
    res.json({ ok: true, state: wsState });
  });
  app.get('/protoclaw/workspace_state', (_req, res) => res.json(wsState));

  // 切片端点：从真实索引读取（移动后归属变化立即反映）
  app.get('/protoclaw/prebuilt_sessions', async (req, res) => {
    const entry = { url: req.originalUrl };
    captured.sessions.push(entry);
    const index = await readSessionIndex('programming-helper');
    const allSessions = index.sessions || [];
    let sessions = [];
    let sessionProjectId = '';
    if (typeof req.query.projectId === 'string' && req.query.projectId) {
      sessionProjectId = req.query.projectId;
      sessions = allSessions.filter((s) => s.projectId === req.query.projectId);
    } else if (typeof req.query.projectDir === 'string' && req.query.projectDir) {
      sessions = allSessions.filter((s) => !s.projectId && String(s.openDirectory || '').replace(/\\/g, '/').toLowerCase() === String(req.query.projectDir).replace(/\\/g, '/').toLowerCase());
    } else {
      sessions = allSessions;
    }
    const main = sessions.filter((s) => !s.archived).length;
    res.json({
      revision: index.revision, activeSessionId: index.activeSessionId || null, sessions,
      sessionProjectId, sessionTotal: sessions.length, mainTotal: main, archivedTotal: sessions.length - main,
    });
  });

  app.get('/protoclaw/search_sessions', (req, res) => {
    captured.search.push({ url: req.originalUrl, query: { ...req.query } });
    res.json({
      results: [{ sessionId: 'sess_a_1', title: 'A1 needle hit', updatedAt: '2026-10-22T11:00:00.000Z', messageCount: 2, matchCount: 1, matches: [{ index: 1, role: 'user', snippet: 'needle question' }] }],
      total: 1,
    });
  });

  app.use('/vendor/marked', express.static(path.join(process.cwd(), 'node_modules/marked/lib')));
  app.use(express.static('public'));
  app.get('/fixture', (_req, res) => res.type('html').send(`<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/styles/base.css"><link rel="stylesheet" href="/styles/layout.css"><link rel="stylesheet" href="/styles/components.css">
    </head><body data-theme="dark">${readAppShell()}
    <script src="/vendor/marked/marked.umd.js"></script>
    <script src="/src/modules/kernel-state.js"></script>
    <script src="/src/i18n.js"></script>
    <script src="/src/modules/action-dispatcher.js"></script>
    <script src="/src/app-core.js"></script>
    <script src="/src/modules/markdown-bootstrap.js"></script>
    <script src="/src/modules/session-view-state.js"></script>
    <script src="/src/modules/runtime-status.js"></script>
    <script src="/src/modules/sidebar-render.js"></script>
    <script>
    // 宿主工厂替身只剩 app-main / app-ui 两个入口文件所属的三个
    //（createRuntimeSwitchHost / createCompactResumeHost /
    // createWorkspaceSurfaceHost）：它们住在整条应用 bootstrap 里，装载即启动
    // 全应用。其余工厂已由真实 owner 提供——sidebar-render（侧栏渲染、
    // 调用态、快照装载）、session-view-state（视图提交）、app-core（调用中断、
    // 视图缓存）。
    (function () {

      // 其余 classic 宿主工厂住在 app-main / agent-data-loader / sidebar-render 等
      // 未随 fixture 装载的文件里；按真实接口面补最小替身，图形装载期只取用这些面。

      if (typeof window.createRuntimeSwitchHost !== 'function') {
        window.createRuntimeSwitchHost = function () {
          return { state: {}, switchAgent: function () { return Promise.resolve(); }, setTimeout: function (cb) { return window.setTimeout(cb, 0); } };
        };
      }
      if (typeof window.createCompactResumeHost !== 'function') {
        window.createCompactResumeHost = function () {
          return {
            isRemote: function () { return false; }, remote: function () { return null; },
            createOperationId: function () { return 'op-auto'; }, now: function () { return Date.now(); },
            observe: function () { return function () {}; }, checkpoint: function () {},
            fetch: function () { return window.fetch.apply(window, arguments); },
            idempotencyKey: function () { return 'fixture-key'; }, refreshThreads: function () {},
          };
        };
      }

      if (typeof window.createWorkspaceSurfaceHost !== 'function') {
        window.createWorkspaceSurfaceHost = function () {
          var noop = function () {};
          return {
            bumpNavigationGuard: noop, closeReadOnlySession: noop, hasDetail: function () { return false; },
            loadDetail: noop, findAgent: function () { return null; }, currentAgent: function () { return null; },
            preferenceKey: function () { return ''; }, tabs: function () { return []; },
            surfacePreference: function () { return null; }, defaultMode: function () { return 'chat'; },
            ui: function () { return {}; }, focusedAgentId: function () { return null; },
            runtimeId: function () { return null; }, contextKey: function () { return ''; },
            saveScroll: noop, readOnlyMode: function () { return false; }, saveCache: noop,
            bindWorkspace: noop, setFollowLatest: noop, resetRuntimeState: noop, beginPending: noop,
            setTab: noop, beginLoading: noop, clearPending: noop, renderAgents: noop, render: noop,
            renderPanel: noop, refreshPanels: noop,
          };
        };
      }
    })();
    </script>
    <script>
    // fixture 的 classic 状态与未迁移依赖桩。内核桥键（currentLanguage /
    // focusedAgentId / currentRuntimeAgentId / allAgents / lastRenderedWorkspaceHtml /
    // escapeHtml / 时间格式化 / 会话查询）已由 classic bootstrap 或已迁 ESM 模块
    // 注册真实访问器：这里只按赋值写初值、只补模块未提供的桩，绝不重复声明
    // 同名函数（函数声明会占死 window 属性，后续 defineKey 会直接抛错）。
    currentLanguage = 'zh';
    focusedAgentId = 'programming-helper';
    currentRuntimeAgentId = null;
    phSearchQuery = ''; _phSearchTimer = null; savedPhTabState = {}; phSessionSortMode = 'updatedAt';
    lastRenderedWorkspaceHtml = '';
    _phOpenSessionsCache = { html: '' };
    allAgents = [{
      id: 'programming-helper', name: '智能编码空间', modelPresets: { default: { primary: 'm1' } },
      workspace_state: { openDirectory: ${JSON.stringify(cwd)}, phProjects: [{ openDirectory: ${JSON.stringify(cwd)} }, { openDirectory: ${JSON.stringify(plainDir)} }] },
      workspace_sessions: { sessions: [], sessionProjectId: '', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
    }];
    function getCurrentAgentRecord() { return allAgents.find(function (a) { return a.id === 'programming-helper'; }); }
    function isRemoteNamespaceAgentId() { return false; }
    function isPhStyleWorkspaceAgent(a) { return !!(a && a.id === 'programming-helper'); }
    function t(key) { return key; }
    function sortPhSessionsByMode(list) { return list.slice().sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; }); }
    function renderSessionTokenBar() { return ''; }
    function renderSessionResumeBadge() { return ''; }
    function renderSessionTodoBadge() { return ''; }
    function renderSessionArchivedBadge(s) { return s && s.archived ? '已归档' : ''; }
    function renderSessionTitleAiButton() { return ''; }
    function renderCurrentMainView() {
      const agent = getCurrentAgentRecord();
      lastRenderedWorkspaceHtml = '';
      // 会话列表渲染已迁 ESM（session-list-render.js）：classic 侧经兼容桥键
      // 调用同一实现（生产 app-ui 的 ClawHost block 回调同此路径）。
      document.getElementById('fixture-inner').innerHTML =
        renderWorkspaceSessionList(agent, { description: 'fixture' });
    }
    // classic 相的动作入口（生产 workspace-actions.js）：会话列表渲染的动作按钮经
    // data-action="sessions.workspaceAction" 分发到这里，fixture 只记录不执行。
    window.runWorkspaceAction = function (raw) { capturedActionsPush(JSON.parse(raw)); };
    window.runWorkspaceActionFromEvent = function (event, raw) { capturedActionsPush(JSON.parse(raw)); };
    window.phLoadOpenSessionsCard = function () { /* disabled surface: capture only */ };
    function capturedActionsPush(action) { window.__capturedActions.push(action); }
    window.__capturedActions = [];
    </script>
    <script type="module" src="/src/modules/project-data.js"></script>
    <script type="module" src="/src/modules/ph-session-move.js"></script>
    <script type="module" src="/src/modules/ph-project-actions.js"></script>
    <script type="module" src="/src/modules/ph-session-list.js"></script>
    <script type="module" src="/src/modules/feature-config-editor.js"></script>
    <script type="module" src="/src/modules/dir-config-dialog.js"></script>
    <script type="module" src="/src/modules/session-list-render.js"></script>
    <script>
    // 首屏对齐真实 loadAgentData 时序：实体清单 + 目录切片就绪后再渲染
    //（真实应用里轮询会自然重渲染；fixture 无轮询，采用 await 后一次到位）。
    // 挂在 DOMContentLoaded：静态 module 脚本在此之前执行完毕，桥键（会话列表
    // 渲染入口等）此时已由 ESM owner 注册。
    window.addEventListener('DOMContentLoaded', function () {
      // 真实外壳只保留对话框骨架等交互 DOM；主区域换成 fixture 的会话列表容器
      const main = document.querySelector('.main-content');
      if (main) main.innerHTML = '<div style="width:100%;min-width:0;max-width:900px;margin:0 auto;padding:16px" id="fixture-inner"></div>';
      Promise.all([
        ensurePhProjectEntitiesLoaded(),
        phLoadProjectSessions({ projectDir: ${JSON.stringify(cwd)} }),
      ]).then(function () {
        renderCurrentMainView();
        document.body.dataset.ready = 'true';
      });
    });
    </script></body></html>`));

  const server = app.listen(port, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/fixture`,
      dataDir, cwd, plainDir, projA, projB, projects, captured, deps,
    runtimeState,
    readIndex: () => readSessionIndex('programming-helper'),
    /** busy 模式：让指定会话表现为「执行中轮次」的存活实例。 */
    setBusy(sessionId) {
      runtimeState.runtime = { viewerAgentId: 'v-fixture-busy', selectedSessionId: sessionId };
      runtimeState.running = true;
      runtimeState.viewer = (p) => (p.endsWith('/notification') ? { callActive: true } : []);
    },
    clearBusy() {
      runtimeState.runtime = null;
      runtimeState.running = false;
      runtimeState.viewer = null;
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fixture = await startPhProjectFixture(Number(process.env.PORT) || 0);
  console.log(`ready ${fixture.url}`);
  process.stdin.resume();
}
