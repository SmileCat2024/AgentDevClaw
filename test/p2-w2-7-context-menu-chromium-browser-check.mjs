/**
 * 真实 Chromium 隔离回归 —— W2-7 菜单尾部 + app-ui 的 fw 对话框渲染器兼容面。
 *
 * 钉三件事（全部在真浏览器里）：
 *  A. H1 求值约束：`classic <script>` 顶层 `function` 声明是 **non-configurable**
 *     window 属性（Node vm 里是 configurable:true）。真实 app-main 的
 *     `newIdempotencyKey` 已占住该名字时，入口模块图必须仍能求值；对同名再
 *     defineKey 必须抛 `TypeError: Cannot redefine property`（反向取证）。
 *  B. 补充漏兼容：classic app-ui 的 `renderFWList` 以**裸标识符**调用 5 个
 *     `renderFW*Dialog`，它们必须是真实可达的（桥访问器 + 具名导出同源），
 *     且确认对话框的真实 DOM 能渲染出来（app-ui 拼出来的 HTML 注入真容器）。
 *  C. 动作门控：对话框 DOM 可见后，点真实「删除」按钮才提交，点「取消」零提交；
 *     两次都走真实 `data-action` → 真实 action-dispatcher → 真实 fw 动作。
 *
 * 隔离纪律：临时端口（port 0）静态服务仓库根，只提供
 *   - /__fixture__/index.html        现场生成的探针页（含真实菜单元素）
 *   - /__fixture__/dom-shim.js       DOM 垫片（缺失 id 返回稳定 stub）
 *   - /__fixture__/classic-stubs.js  classic 替身（含真实 app-main 的
 *                                    `function newIdempotencyKey()` 源码、fetch 记录器）
 *   - /public/src/...                真实仓库文件（kernel-state / action-dispatcher /
 *                                    i18n / app-core / markdown-bootstrap / app-ui /
 *                                    两个被测模块 / 整个 P2 ESM 图）
 * 不启动 Claw、不读真实用户数据、不连 ViewerWorker；无写入仓库；不联网（fetch 由
 * 记录器接管，返回固定桩响应）。
 *
 * 用法：node test/p2-w2-7-context-menu-chromium-browser-check.mjs
 * 退出码 0 = 全部通过。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY_URL = '/public/src/modules/p2-w2-7-context-menu-bootstrap.js';

/** 真实 app-main.js 的顶层函数源码：classic 相的全局赢家。 */
const appMainSource = fs.readFileSync(path.join(ROOT, 'public/src/app-main.js'), 'utf8');
const idemSource = appMainSource.match(/function newIdempotencyKey\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(idemSource, 'app-main.js 中必须存在顶层 function newIdempotencyKey()');

/** DOM 垫片：探针页缺的 id 返回稳定 stub（生产里来自 index.html）；真实元素优先。 */
const DOM_SHIM = `
// 缺失 id 的稳定元素：用**真实 DOM 元素**（detached div），这样 ResizeObserver、
// classList、dataset、style.setProperty 等原生语义全部可用；只把 id 补上，便于
// 被测代码按 id 抓引用。生产里这些元素来自 index.html。
window.__stubEl = (id) => {
  const node = document.createElement('div');
  node.id = String(id);
  return node;
};
const stubMap = new Map();
window.__stableEl = (id) => { if (!stubMap.has(id)) stubMap.set(id, window.__stubEl(id)); return stubMap.get(id); };
const realGetById = document.getElementById.bind(document);
document.getElementById = (id) => realGetById(id) || window.__stableEl(String(id));
const realQuerySelector = document.querySelector.bind(document);
document.querySelector = (selector) => realQuerySelector(selector) || window.__stubEl(String(selector));

// 生产里这些由 vendor 脚本（marked / hljs）与 claw-host.js 在 classic 相先提供。
window.marked = { Renderer: function Renderer() {}, setOptions() {}, parse: (text) => String(text === undefined ? '' : text), use() {} };
window.hljs = { getLanguage: () => null, highlight: (text) => ({ value: String(text) }) };
window.ClawPanels = { getAvailable: () => [], register() {}, unregister() {} };
`;
/**
 * classic 替身（**在真实 classic 文件之后加载**）：只补生产里由 app-main /
 * sidebar-render / agent-data-loader 等 classic owner 提供、而本探针不加载的
 * factory 与全局。每项都带 `if (window[name] === undefined)` 守卫，绝不覆盖真实文件。
 */
const CLASSIC_STUBS = `
const define = (name, value) => { if (window[name] === undefined) window[name] = value; };

// 真实 classic 赢家（逐字取自 app-main.js 的顶层 function 声明）
${idemSource}
window.__classicIdem = newIdempotencyKey;

// fetch 记录器：探针不发真实网络请求，删除类提交在此记账
window.__fetches = [];
window.fetch = async (url, init) => {
  const options = init || {};
  let body = null;
  try { body = options.body ? JSON.parse(String(options.body)) : null; } catch (error) { body = String(options.body); }
  window.__fetches.push({ url: String(url), method: options.method || 'GET', body, headers: options.headers || null });
  return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
};

define('readCurrentSessionViewState', () => ({}));
// 主视图渲染（渲染入口域）依赖几乎整个 classic 壳（chat-viewport / input-render /
// context bar…），不在本探针范围内：打开/关闭对话框时的 fwRerender 在此只记账。
// 对话框 DOM 由真实 app-ui renderFWList 产出（它末尾就是 renderFWConfirmDialog()），
// 与生产路径一致；主视图渲染的时序边界由渲染入口域自己的批次钉住。
window.__renderCalls = 0;
window.renderCurrentMainView = () => { window.__renderCalls += 1; };
define('isChatSurfaceActive', () => false);
define('getCurrentAgentRecord', () => null);
define('getRuntimeId', (agent) => (agent && (agent.runtime_session_id || agent.id)) || null);
define('resolveWorkspaceFallbackAgentId', (agent) => (agent && agent.id) || null);
define('renderAgentList', () => {});
define('updateAssemblySideRailPosition', () => {});
define('setPreferredUnitMode', () => {});
define('runWorkspaceAction', () => {});
define('showCtxMenu', () => {});
define('closeCtxMenu', () => {});
define('bumpNavigationGuard', () => {});
define('invoke', async () => ({}));
define('alert', () => {});
define('confirm', () => false);
define('NavigationCore', {
  resolveHostAgentId: (_agent, id) => id,
  extractRuntimeId: (result) => (result && result.runtime_session_id) || null,
  resolveStoppedRuntimeFallback: () => null,
});

// app-core 之外的 classic owner 工厂（app-main / sidebar-render / agent-data-loader）
// 侧栏渲染签名宿主由 classic sidebar-render.js 提供（本探针不加载该文件）。
define('createP2BootstrapSidebarRenderHost', () => ({ lastAgentListRenderSignature: '' }));
define('AgentLoaderHost', { loadedAgentDetailIds: new Set() });
define('createAgentCallStatesHost', () => ({ calling: new Map(), suspended: new Set(), interrupting: new Set() }));
define('createAgentSnapshotLoaderHost', () => ({
  state: {}, now: () => 0, captureToken: () => null, ownership: () => ({}),
  connected: async () => [], viewer: async () => ({ ok: false, json: async () => ({ agents: [] }) }),
  loadLayout: async () => ({}), loadProjects: async () => {}, isTokenCurrent: () => true,
  runtimeId: (agent) => (agent && (agent.runtime_session_id || agent.id)) || '',
  agentRuntimeId: (agent) => (agent && (agent.runtime_session_id || agent.id)) || '',
  detailIds: new Set(), mergeSessions: (previous) => previous, reconcileStops() {},
  pruneCallStates() {}, diagnostic() {}, warn() {}, error() {}, log() {}, schedule() {},
  renderList() {}, renderPanel() {}, refreshCalls: async () => {}, isRemote: () => false,
  fallback: () => null, loadDetail: async () => {}, selectSurface() {}, preferHome() {},
  resolveFocus: () => null, clickPrebuilt() {}, logicalId: (agent) => (agent && agent.id) || null,
  loadData: async () => {},
}));
define('createSessionDataLoaderHost', () => ({}));
define('createRuntimeStatusLoaderHost', () => ({}));
define('createRuntimeSwitchHost', () => ({
  state: {}, switchAgent: async () => {}, setTimeout: (fn, delay) => setTimeout(fn, delay),
  hasPendingNavigation: () => false, bumpNavigationGuard() {}, closeContextMenu() {},
  findAgent: () => null, isWorkspaceHost: () => false, runtimeId: () => '',
  agentRuntimeId: () => '', isRemote: () => false, remote: () => null,
  closeReadOnlySession() {}, isWorkspaceSurface: () => false, selectWorkspace() {},
  storeDraft() {}, saveWorkspaceScroll() {}, saveCache() {}, logicalId: (agent) => (agent && agent.id) || null,
  normalize: (id) => String(id || ''), clearFinished() {}, deriveSession: () => null,
  bindSession() {}, updateThreadIndicators() {}, browseOnly: () => false,
  resetSurface() {}, resetScroll() {}, resetStatus() {}, activateCollapse() {},
  contextKey: () => '', restoreCache: () => null, setPendingScroll() {}, render() {},
  renderPanel() {}, patch() {}, emptyOverview: () => ({}), emptyTodo: () => ({}),
  setFollowLatest() {}, beginFollowWindows() {}, renderAgents() {},
}));
define('createCompactResumeHost', () => ({ state: {}, now: () => Date.now() }));

// 其余 host 工厂：本探针只要求「模块图能求值 + fw 渲染链路能跑」，这些宿主的
// 方法都在调用时点才用（真实语义由 Node 侧用例与生产链路覆盖）。
const genericHost = () => new Proxy(
  { state: {}, cache: new Map(), detailIds: new Set(), now: () => 0 },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'setTimeout') return (fn, delay) => setTimeout(fn, delay);
      return () => undefined;
    },
    has() { return true; },
  },
);
for (const name of [
  'createSessionViewCommitHost', 'createWorkspaceSessionNavigationHost',
  'createWorkspaceEntryHost', 'createViewerReadinessHost', 'createRuntimePollHost',
  'createRuntimeNotFoundHost', 'createPollMaintenanceHost', 'createPollCycleHost',
  'createPollCoordinatorHost', 'createMetadataCommitHost', 'createMessageProbeHost',
  'createCallInterruptHost', 'createApplicationStartupHost', 'createTimeFormatHost',
  'createRuntimeViewCacheHost', 'createChatLoadingHost',
]) {
  define(name, genericHost);
}
`;

/** 真实 DOM 元素：菜单与对话框要能被真实点击（生产里来自 index.html）。 */
const MENU_ELEMENTS = `
<div id="chat-container"></div>
<div id="agent-list"></div>
<div id="agent-context-menu" class="ctx"></div>
<button id="restart-agent-action" type="button"></button>
<button id="stop-agent-action" type="button"></button>
<button id="delete-agent-action" type="button"></button>
<div id="compact-context-menu" class="ctx"></div>
<button id="compact-summary-action" type="button"></button>
<button id="compact-trim-action" type="button"></button>
<button id="compact-branch-action" type="button"></button>
<div id="project-context-menu" class="ctx"></div>
<button id="delete-project-action" type="button"></button>
<div id="feature-repo-context-menu" class="ctx"></div>
<button id="delete-feature-action" type="button"></button>
<div id="ctx-menu" class="ctx"></div>
<div id="feature-panel"></div>
<div id="fw-surface"></div>
`;

const FIXTURE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>p2 w2-7 context menu + fw dialog chromium probe</title></head>
<body>
${MENU_ELEMENTS}
<script src="/__fixture__/dom-shim.js"></script>
<script src="/public/src/modules/kernel-state.js"></script>
<script src="/public/src/modules/claw-host.js"></script>
<script src="/public/src/modules/action-dispatcher.js"></script>
<script src="/public/src/i18n.js"></script>
<script src="/public/src/app-core.js"></script>
<script src="/public/src/modules/markdown-bootstrap.js"></script>
<script src="/public/src/app-ui.js"></script>
<script src="/__fixture__/classic-stubs.js"></script>
<script type="module">
  const result = { ok: false };
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 0));
  try {
    await import('${ENTRY_URL}');
    result.graphOk = true;

    // ── A. H1：classic 同名 non-configurable 全局在位，模块仍求值 ──
    const idemDescriptor = Object.getOwnPropertyDescriptor(window, 'newIdempotencyKey');
    result.idempotencyKey = {
      configurable: !!idemDescriptor && idemDescriptor.configurable,
      type: typeof (idemDescriptor && idemDescriptor.value),
      sameAsClassic: window.newIdempotencyKey === window.__classicIdem,
      generated: window.newIdempotencyKey(),
    };
    try {
      window.KernelState.defineKey('__probe__', 'newIdempotencyKey', window.newIdempotencyKey);
      result.redefine = { threw: false };
    } catch (error) {
      result.redefine = { threw: true, name: error.name, message: String(error.message) };
    }
    // 本批桥键（context-menu 4 + ctx-menu-handlers 1）
    result.bridge = ['closeAgentContextMenu', 'closeProjectContextMenu', 'closeCompactMenu', 'openCompactMenu', 'openAgentActions']
      .map((key) => {
        const des = Object.getOwnPropertyDescriptor(window, key);
        return { key, hasGetter: !!des && typeof des.get === 'function', hasSetter: !!des && typeof des.set === 'function', type: typeof window[key] };
      });

    // ── B. app-ui 的 5 个 fw 对话框渲染器：裸标识符可达（真实 app-ui 调用形态）──
    const RENDERERS = ['renderFWCreateDialog', 'renderFWConfirmDialog', 'renderFWPromptDialog', 'renderFWSwitchProjectDialog', 'renderFWFeatureImportDialog'];
    const fw = await import('/public/src/modules/fw-config-panel.js');
    result.renderers = RENDERERS.map((name) => ({ name, type: typeof window[name], sameAsExport: window[name] === fw[name] }));
    result.bridgeStats = window.KernelState.stats();
    result.dialogClosedHtml = window.renderFWConfirmDialog();

    // ── C. 真实菜单手势 → 真实确认对话框 → 真实 app-ui 渲染 → 动作门控 ──
    const store = await import('/public/src/modules/agent-store-state.js');
    store.setAllAgents([{ id: 'memo', name: 'Memo', source: 'prebuilt', connected: true, runtime_session_id: 'rt-memo' }]);
    const container = document.getElementById('chat-container');
    const card = document.createElement('div');
    card.dataset.prebuiltProjectAgentId = 'memo';
    card.dataset.prebuiltProjectId = 'proj-x';
    container.appendChild(card);
    const openProjectMenu = () => {
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
    };
    const clickDeleteProject = () => document.getElementById('delete-project-action').click();
    const renderSurface = () => {
      // 真实 app-ui 渲染器：renderFWList 末尾会调用 renderFWConfirmDialog()
      const surface = document.getElementById('fw-surface');
      surface.innerHTML = window.renderFWList(store.allAgents[0], {}, 'assembly-form');
      return surface;
    };
    const deletePosts = () => window.__fetches.filter((item) => item.url.includes('prebuilt_project/delete'));

    openProjectMenu();
    await tick(0);
    result.menuOpened = document.getElementById('project-context-menu').classList.contains('open');
    clickDeleteProject();
    await tick(0);
    let surface = renderSurface();
    const confirmBtn = surface.querySelector('[data-action="fw.handleConfirm"]');
    const cancelBtn = surface.querySelector('[data-action="fw.closeConfirmDialog"]');
    result.dialogDom = {
      present: !!confirmBtn,
      hasProjectId: surface.textContent.includes('proj-x'),
      hasCancel: !!cancelBtn,
      confirmLabel: confirmBtn ? confirmBtn.textContent.trim() : '',
      overlayCount: surface.querySelectorAll('.feature-detail-overlay').length,
    };

    // 取消：真实点击取消按钮 → 零提交、对话框收起
    if (cancelBtn) cancelBtn.click();
    await tick(20);
    result.cancel = {
      posts: deletePosts().length,
      dialogCleared: window.renderFWConfirmDialog() === '',
      rerendered: window.__renderCalls > 0,
    };

    // 确认：真实点击删除按钮 → 恰好一次提交
    openProjectMenu();
    await tick(0);
    clickDeleteProject();
    await tick(0);
    surface = renderSurface();
    const confirmBtn2 = surface.querySelector('[data-action="fw.handleConfirm"]');
    result.confirmDialogPresent = !!confirmBtn2;
    if (confirmBtn2) confirmBtn2.click();
    await tick(50);
    result.confirm = {
      posts: deletePosts().map((item) => item.body),
      dialogCleared: window.renderFWConfirmDialog() === '',
    };
    result.ok = true;
  } catch (error) {
    result.error = String(error && error.name) + ': ' + String(error && error.message);
    result.stack = String(error && error.stack || '').split('\\n').slice(0, 8).join(' | ');
  }
  window.__result = result;
</script>
</body></html>`;

const CONTENT_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (type, body) => {
      res.writeHead(200, { 'Content-Type': type });
      res.end(body);
    };
    if (url.pathname === '/__fixture__/index.html') return send(CONTENT_TYPES['.html'], FIXTURE_HTML);
    if (url.pathname === '/__fixture__/dom-shim.js') return send(CONTENT_TYPES['.js'], DOM_SHIM);
    if (url.pathname === '/__fixture__/classic-stubs.js') return send(CONTENT_TYPES['.js'], CLASSIC_STUBS);
    const filePath = path.resolve(ROOT, '.' + url.pathname);
    if (!filePath.startsWith(ROOT + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    send(CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream', fs.readFileSync(filePath));
  });
}

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;
let browser = null;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error && error.message)));
  await page.goto(`${baseUrl}/__fixture__/index.html`, { waitUntil: 'load' });
  // 回调在页面里执行：用 globalThis（Node 侧 window 不在 lint 全局白名单）。
  await page.waitForFunction(() => globalThis.__result !== undefined, null, { timeout: 20000 });
  const result = await page.evaluate(() => globalThis.__result);

  assert.deepEqual(pageErrors, [], `页面不得出现未捕获异常：${JSON.stringify(pageErrors)}`);
  assert.equal(result.error, undefined, `探针执行不得失败：${result.error}${result.stack ? ' @ ' + result.stack : ''}`);
  assert.equal(result.ok, true, '真实链路必须跑通');

  // A. H1：classic 赢家在位 + 模块求值成功 + 同名再 defineKey 必抛
  assert.equal(result.idempotencyKey.configurable, false, 'classic 顶层 function 属性必须不可配置');
  assert.equal(result.idempotencyKey.sameAsClassic, true, '模块不得改写 classic 实现');
  assert.match(result.idempotencyKey.generated, /^[0-9a-f-]{16,}$|^key-/);
  for (const entry of result.bridge) {
    assert.equal(entry.hasGetter, true, `${entry.key} 应装成访问器`);
    assert.equal(entry.hasSetter, true, `${entry.key} setter 必须成对`);
    assert.equal(entry.type, 'function', `${entry.key} 应可用`);
  }
  assert.equal(result.redefine.threw, true, '同名 defineKey 必须抛错');
  assert.equal(result.redefine.name, 'TypeError');
  assert.match(result.redefine.message, /Cannot redefine property: newIdempotencyKey/);

  // B. 5 个 fw 渲染器：classic 裸取可达，且与具名导出同源；关闭态不渲染
  assert.equal(result.renderers.length, 5);
  for (const entry of result.renderers) {
    assert.equal(entry.type, 'function', `${entry.name} 在 classic 相必须裸取可达（app-ui 依赖）`);
    assert.equal(entry.sameAsExport, true, `${entry.name} 桥与具名导出必须同一实现`);
  }
  assert.equal(result.dialogClosedHtml, '', '无对话框时不应渲染 DOM');

  // C. 真实确认对话框 DOM 可见 → 动作门控
  assert.equal(result.menuOpened, true, '项目右键应打开项目菜单');
  assert.equal(result.dialogDom.present, true, '确认对话框的确认按钮必须真实出现在 DOM 里');
  assert.equal(result.dialogDom.hasCancel, true, '取消按钮必须真实出现在 DOM 里');
  assert.equal(result.dialogDom.hasProjectId, true, '对话框文案必须带被删项目 id');
  assert.equal(result.dialogDom.overlayCount, 1, '对话框 overlay 恰好一个');
  assert.deepEqual(result.cancel, { posts: 0, dialogCleared: true, rerendered: true }, '取消：零提交、对话框收起、关闭走真实 fwRerender');
  assert.equal(result.confirmDialogPresent, true, '第二次打开仍应渲染对话框');
  assert.equal(result.confirm.posts.length, 1, `确认后应恰好一次提交，实际 ${result.confirm.posts.length}`);
  assert.equal(result.confirm.posts[0].agentId, 'memo');
  assert.equal(result.confirm.posts[0].projectId, 'proj-x');
  assert.match(String(result.confirm.posts[0].operationId || ''), /^delete-project/);
  assert.equal(result.confirm.dialogCleared, true, '提交后对话框收起');

  console.log('[chromium] p2-w2-7 context menu + fw dialog probe PASS');
  console.log('[chromium] ' + JSON.stringify({
    idempotencyKey: result.idempotencyKey,
    bridge: result.bridge.map((entry) => entry.key),
    bridgeStats: result.bridgeStats,
    renderers: result.renderers.map((entry) => entry.name),
    dialogDom: result.dialogDom,
    cancel: result.cancel,
    confirmPosts: result.confirm.posts.length,
    redefine: result.redefine,
  }));
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
