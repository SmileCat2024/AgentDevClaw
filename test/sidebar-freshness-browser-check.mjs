/* global window, document, agentList, allAgents, renderSidebarChildItems, collectRuntimeEntriesForPrebuilt, renderAgentList, threadFacts, refreshThreads */
// Isolated Chromium check of real sidebar rendering, inline editing and thread commits.
// classic 首屏源（sidebar 渲染、线程承接、运行态）与迁出后的 ESM 模块（项目数据 /
// 会话 UI / 侧栏操作 / 上下文菜单动作）都以真实加载路线进场：静态目录由本地 express
// 提供，classic 走 <script src>，ESM 走 <script type="module"> 与真实 import。
// 项目数据域经 project-data 模块求值（updateAgentRecord / resolveSidebarChildProjectGroup
// 等桥键由它注册），其 import 图一并带入 assembly-data / session-ui / 会话装载宿主；
// agent-data-loader 已 ESM，两个 loader host 直接 import 它的工厂，不再有 classic 装载，
// 因此本 fixture 不做 bootstrap 入口排序。
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const ui = await fs.readFile('public/src/app-ui.js', 'utf8');
// classic 宿主切片：workspace surface 宿主的唯一实现仍在 app-ui（classic），
// 边界锚在本文件的域分隔注释。
const surfaceHost = ui.slice(ui.indexOf('function createWorkspaceSurfaceHost('), ui.indexOf('function upsertConnectedAgent('));
const main = await fs.readFile('public/src/app-main.js', 'utf8');
const switchHost = main.slice(main.indexOf('function createRuntimeSwitchHost('), main.indexOf('// ── Context menu action handlers'));
const compactHost = main.slice(main.indexOf('function createCompactResumeHost('), main.indexOf('// PH session list helpers'));

const app = express();
app.use('/vendor/marked', express.static('node_modules/marked'));
app.use(express.static('public'));
// 真实产品 DOM（classic / ESM 首屏代码按 id 取容器），脚本与样式引用由本 fixture 重排。
const index = await fs.readFile('public/index.html', 'utf8');
const shell = index.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
app.get('/fixture', (_req, res) => res.type('html').send(shell.replace('</body>', `
<script src="/vendor/marked/lib/marked.umd.js"></script>
<script src="/src/modules/kernel-state.js"></script>
<script src="/src/modules/action-dispatcher.js"></script>
<script src="/src/modules/markdown-bootstrap.js"></script>
<script src="/src/app-core.js"></script>
<script src="/src/modules/session-view-state.js"></script>
<script src="/src/modules/runtime-status.js"></script>
<script src="/src/modules/thread-store.js"></script>
<script src="/src/modules/sidebar-render.js"></script>
<script>${surfaceHost}</script>
<script>${switchHost}</script>
<script>${compactHost}</script>
<script>
  Object.assign(window, {
    currentLanguage: 'zh', focusedAgentId: null, currentRuntimeAgentId: null,
    allAgents: [], currentMessages: [],
    pendingPrebuiltAgentIds: new Set(), restartingRuntimeIds: new Set(),
    _recentlyFinishedRuntimes: new Set(), _agentCallActive: new Map(),
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    getAgentRuntimeId: (agent) => agent.runtime_session_id || '',
    getParentAgentId: (agent) => agent.parent_id,
    getActiveSessionId: (agent) => agent.active_workspace_session_id,
    toEpochMs: (value) => Date.parse(value || '') || 0,
    groupConnectedAgents: () => ({ external: [] }),
    updateCurrentAgentChrome() {}, renderCurrentMainView() {},
    isRuntimeItemActive: () => false,
    t: (key) => key,
    lastRenderedWorkspaceHtml: '',
  });
  window.ClawSidebarLayout = {
    isInteracting: () => false, signature: () => 'fixture',
    render() { agentList.innerHTML = renderSidebarChildItems(collectRuntimeEntriesForPrebuilt(allAgents[0], allAgents), allAgents[0].id); },
  };
  window.threadFacts = [];
  window.fetch = async (_url, options) => ({ ok: true, json: async () => options?.method === 'PUT'
    ? { ok: true, title: JSON.parse(options.body).title, sessionDelta: { revision: 2, upsert: [{ id: 's1', title: JSON.parse(options.body).title }] } }
    : { threads: window.threadFacts } });
</script>
<script type="module" src="/src/modules/project-data.js"></script>
<script type="module" src="/src/modules/session-ui.js"></script>
<script type="module" src="/src/modules/sidebar-operations.js"></script>
<script type="module" src="/src/modules/ctx-menu-items.js"></script>
</body>`)));

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  await page.waitForFunction(() => document.readyState === 'complete');
  await page.evaluate(async () => {
    window.allAgents = [
      { id: 'programming-helper', source: 'prebuilt', workspace_sessions: { revision: 1, sessions: [{ id: 's1', title: 'Old' }] } },
      { id: 'r1', runtime_session_id: 'r1', source: 'child', parent_id: 'programming-helper', active_workspace_session_id: 's1', active_workspace_session_title: 'Old', connected: true },
    ];
    renderAgentList();
    const { ctxRenameSession } = await import('/src/modules/ctx-menu-items.js');
    ctxRenameSession({ ns: 'programming-helper', id: 'r1', sessionId: 's1' });
  });
  const input = page.locator('.agent-name-edit-input');
  await input.fill('Saved title');
  await page.evaluate(() => { allAgents[1].connected = false; renderAgentList(); });
  assert.equal(await input.inputValue(), 'Saved title', 'background update must preserve editing DOM');
  await input.press('Enter');
  await page.waitForFunction(() => document.querySelector('.agent-name')?.textContent === 'Saved title');
  await page.evaluate(() => renderAgentList());
  assert.equal(await page.locator('.agent-name').textContent(), 'Saved title');
  console.log('PASS Enter rename and background refresh preserve the saved title in real DOM');

  await page.evaluate(async () => {
    allAgents[0].id = 'coder';
    allAgents[1].parent_id = 'coder';
    // 场景重钉（不是仅换加载路线）：线程投影的 wire 事实在 agent.sidebar_threads
    // （服务端 /api/agents 字段），而断连占位只由显式交接空窗
    // （status: 'rotating' + handoffStartedAt，head runtime 尚未上线）产生——
    // 线程板的 headRuntimeRunning 不再单独合成侧栏条目。原 fixture 的事实形状
    // （status: 'open' + headRuntimeRunning）已不对应当前投影，断言本身不变：
    // 占位 1 条 → 归档事实后 0 条。
    window.threadFacts = [{ threadId: 't1', agentId: 'coder', headSessionId: 's1', sessionIds: ['s1'], title: 'Thread', status: 'rotating', handoffStartedAt: 1, lifeState: 'executing', headRuntimeRunning: true }];
    allAgents[0].sidebar_threads = window.threadFacts;
    await refreshThreads(true);
    window.allAgents = [allAgents[0]];
    renderAgentList();
  });
  assert.equal(await page.locator('.agent-runtime-item.disconnected').count(), 1);
  await page.evaluate(async () => {
    window.threadFacts = [{ ...threadFacts[0], archivedAt: 1, lifeState: 'archived', headRuntimeRunning: false }];
    allAgents[0].sidebar_threads = window.threadFacts;
    await refreshThreads(true);
    renderAgentList();
  });
  assert.equal(await page.locator('.agent-runtime-item').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS archive fact commit removes the ghost without navigation or a page refresh');
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
