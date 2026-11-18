/**
 * 真实 Chromium 生产启动回归 —— 后台任务面板（bg）的排版与阅读位置契约。
 *
 * 为什么必须走真实 index.html：本脚本钉的全部是**布局与滚动事实**
 * （scrollTop / scrollHeight / clientHeight、计算色、横向溢出），vm 沙箱与 DOM
 * 桩里这些量没有真值；而面板实现（bg-panel）与面板宿主（debug-panel-host）在
 * P4 都是 ESM，任何"手工拼 `<script src>` 列表"的 fixture 都会把模块当 classic
 * 装载而 SyntaxError。因此装载路线与 p2-production-boot-browser-check 同路：
 * 真实 index.html 标签清单 + 真实 ESM 图 + 真实 vendor 资产与样式表；外部 IO
 * 全部是本文件内的 HTTP 契约 mock（feature-comms 通道发现 / 请求面 / SSE 流），
 * 页面里的 fetch 与 EventSource 都是生产实现，只把网络对端换成本地 mock。
 *
 * 钉五件事：
 *   A. 通道发现 → 模块求值期自注册 → rail 按钮与徽标：三个来源（bash / pwsh
 *      进程 + coder 智能体）各一张卡片；进程卡有「立即汇报 / 打断」，智能体卡
 *      没有操作按钮；徽标计数 3。
 *   B. 排版：深浅两主题下卡片不横向溢出、结果行文字色不透（真实 CSS 变量生效）。
 *   C. 进程输出的阅读位置：事件更新（轻量路径）→ 宿主重渲染 → 骨架变化触发的
 *      全量重建 → 折叠期间更新后重新展开，上翻位置全程保持。
 *   D. 智能体进度：摘要与更新时间走轻量路径，不重建输出节点；宿主刷新 / 状态
 *      切换 / 折叠展开保持位置。
 *   E. 贴底跟随：停在底部时，输出增长、骨架变化与折叠展开都不把视图拉离底部。
 *
 * 隔离纪律（不碰正式资源）：临时端口（port 0）静态服务仓库根，不启动 Claw，
 * 不连 ViewerWorker / UDS / 命名管道，不读真实用户数据目录；截图写
 * `.agentdev/temp/`（gitignore），不写仓库其它位置。
 *
 * 用法：node test/bg-panel-browser-check.mjs
 * 退出码 0 = 全部通过。
 */
/* global window, document, getComputedStyle */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

/** 与 server.js 的 vendorMounts 同口径：vendor 资产来自 node_modules。 */
const VENDOR_MOUNTS = {
  '/vendor/marked/lib': 'marked/lib',
  '/vendor/hljs': '@highlightjs/cdn-assets',
  '/vendor/github-markdown-css': 'github-markdown-css',
  '/vendor/katex/dist': 'katex/dist',
  '/vendor/diff2html/bundles': 'diff2html/bundles',
};

const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/**
 * 工作区快照：字段对齐 server/routes/agent-connected.js 的 prebuilt 投影。
 * bg 面板的 `when` 声明是 `agentIds: ['programming-helper']` + chat surface，
 * 因此当前焦点必须是该工作空间、且聚焦会话要有 runtime（面板按 runtime +
 * workspace session 拼通道寻址）。
 */
const WORKSPACE = {
  id: 'programming-helper',
  name: '编程小助手',
  source: 'prebuilt',
  status: 'running',
  connected: true,
  parent_id: null,
  runtime_session_id: 'rt-a',
  defaultAgentId: 'main',
  agents: [{ id: 'main', displayName: '编程小助手' }],
  workspace_sessions: {
    activeSessionId: 's1',
    sessions: [{
      id: 's1',
      workspaceAgentId: 'main',
      title: '会话 A',
      message_count: 2,
      updated_at: '2026-11-17T05:00:00.000Z',
    }],
  },
  workspace_state: { forms: {}, openDirectory: '', updatedAt: null },
  workspace_data: {},
  active_workspace_session_id: 's1',
  active_workspace_session_title: '会话 A',
  active_workspace_agent_name: '编程小助手',
  active_workspace_display_name: '编程小助手',
  active_workspace_session_dir: '',
  modelPresets: [],
  sidebar_threads: [],
  sidebarSessionsPolicy: 'visible',
  sessionOps: true,
  message_count: 2,
  pending_input_count: 0,
  connection_info: null,
  pid: 4321,
  created_at: null,
};

const VIEWER = {
  agents: [{ id: 'rt-a', name: '编程小助手', connected: true, messageCount: 2, pid: 4321 }],
};

const MESSAGES = {
  messages: [
    { role: 'user', content: 'hello from mock' },
    { role: 'assistant', content: 'world from mock' },
  ],
  timestamps: {},
};

const PRESENTATION = { panel: 'background', version: 1 };
const PROCESS_PROTOCOL = 'claw.background.process';
const AGENT_PROTOCOL = 'claw.background.agent';

/** 三类来源：两个进程通道 + 一个智能体通道（协议决定卡片形态与操作面）。 */
const CHANNELS = [
  { featureId: 'bash', channelId: 'jobs', title: 'Bash', presentation: { ...PRESENTATION, protocol: PROCESS_PROTOCOL } },
  { featureId: 'pwsh', channelId: 'jobs', title: 'PowerShell', presentation: { ...PRESENTATION, protocol: PROCESS_PROTOCOL } },
  { featureId: 'coder', channelId: 'runs', title: 'Coder', presentation: { ...PRESENTATION, protocol: AGENT_PROTOCOL } },
];

/** 每个来源一个稳定任务 id：滚动位置缓存按任务 id 记账，跨来源不能同名。 */
const TASK_IDS = { bash: 'job-bash', pwsh: 'job-pwsh', coder: 'run-coder' };

/** 进程任务的固定启动时刻：时钟文本参与骨架比对，跨事件必须不变。 */
const FIXTURE_STARTED_AT = Date.now() - 60_000;
const PROCESS_OUTPUT = Array.from({ length: 60 }, (_, index) => `output line ${index}`).join('\n');
const AGENT_PROGRESS = Array.from({ length: 60 }, (_, index) => `agent progress ${index}`).join('\n');
const FOLLOW_OUTPUT = Array.from({ length: 80 }, (_, index) => `follow line ${index}`).join('\n');

/** 进程任务载荷（卡片标题取 command，操作面取 status）。 */
function processTask(featureId, patch = {}) {
  return {
    id: TASK_IDS[featureId], command: `${featureId} build`, status: 'running',
    startedAt: FIXTURE_STARTED_AT, outputTail: 'fixture output', ...patch,
  };
}

/** 智能体任务载荷（suspended 与 executing 都算活跃，卡片不自动收起）。 */
function agentTask(patch = {}) {
  return {
    id: TASK_IDS.coder, agentId: 'coder', title: '验证协议面板', threadId: 'wt-fixture',
    commandId: 'cmd-fixture', status: 'executing', startedAt: 1, summary: '等待真实关联工作唤醒', ...patch,
  };
}

function initialTask(featureId) {
  return featureId === 'coder'
    ? agentTask({ status: 'suspended', revision: 1, updatedAt: Date.now() })
    : processTask(featureId);
}

const requests = [];
const unhandled = [];
const sseConnections = new Set();
/** featureId → 订阅该通道的真实 EventSource 对端响应。 */
const channelStreams = new Map();

function sendJson(res, body, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  sseConnections.add(res);
  res.on('close', () => sseConnections.delete(res));
}

function serveFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
  return true;
}

function createMockServer() {
  return http.createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, url: req.url });

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(INDEX_HTML);
      return;
    }

    // ── 认证与启动链 ──
    if (pathname === '/protoclaw/auth/status') {
      sendJson(res, { enabled: false, configured: false, authenticated: true });
      return;
    }
    if (pathname === '/protoclaw/get_connected_agents') {
      sendJson(res, [WORKSPACE]);
      return;
    }
    if (pathname === '/api/agents') {
      sendJson(res, VIEWER);
      return;
    }
    if (pathname === '/protoclaw/agent_detail') {
      sendJson(res, { ok: true, agent: WORKSPACE });
      return;
    }
    if (pathname === '/api/templates/feature') {
      sendJson(res, {});
      return;
    }
    if (pathname === '/protoclaw/workspace_settings/sidebar_layout') {
      sendJson(res, { ok: true });
      return;
    }
    if (pathname === '/protoclaw/threads') {
      sendJson(res, { ok: true, threads: [] });
      return;
    }
    if (pathname === '/protoclaw/remote_catalog') {
      sendJson(res, { ok: true, sections: [] });
      return;
    }
    if (pathname === '/protoclaw/ph_project/projects') {
      sendJson(res, { projects: [] });
      return;
    }
    if (pathname === '/protoclaw/app_info') {
      sendJson(res, { ok: true, version: '9.9.9-test', frameworkVersion: '9.9.9-test', links: [] });
      return;
    }
    if (pathname === '/api/mcp-info') {
      sendJson(res, { ok: true, servers: [] });
      return;
    }
    if (pathname === '/api/logs') {
      sendJson(res, { scope: 'current', selectedAgentId: 'rt-a', total: 0, logs: [], truncation: null });
      return;
    }
    if (pathname === '/api/feature-ui/declarations') {
      sendJson(res, { ok: true, declarations: [] });
      return;
    }
    if (pathname === '/api/feature-ui/ui-prefs') {
      sendJson(res, { ok: true, prefs: {} });
      return;
    }
    if (pathname === '/protoclaw/model_config') {
      sendJson(res, { presets: [] });
      return;
    }
    if (pathname === '/protoclaw/model_connections' || pathname === '/protoclaw/speech_model_config') {
      sendJson(res, {});
      return;
    }
    if (pathname === '/protoclaw/choice_alerts') {
      sendJson(res, { ok: true, alerts: [] });
      return;
    }
    if (/^\/protoclaw\/agents\/[^/]+\/ui-surfaces$/.test(pathname)) {
      sendJson(res, { ok: true, agentId: 'rt-a', revision: 1, surfaces: [] });
      return;
    }

    // ── feature-comms 数据面（bg 面板的唯一数据来源）──
    // 通道发现：形状对齐 feature-communication.listChannels 的消费契约。
    if (pathname === '/protoclaw/feature-comms/channels') {
      sendJson(res, { ok: true, channels: CHANNELS });
      return;
    }
    // 请求面（初始快照 / resync 对账）：按 featureId 返回该来源的基线任务。
    if (pathname === '/protoclaw/feature-comms/request') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      sendJson(res, { ok: true, result: { ok: true, tasks: [initialTask(payload.featureId)] } });
      return;
    }
    // 实时流：真实 EventSource 对端，按 featureId 记账，供 emitChannelEvent 推送。
    if (pathname === '/protoclaw/feature-comms/stream') {
      sendSse(res);
      const featureId = searchParams.get('featureId') || '';
      if (!channelStreams.has(featureId)) channelStreams.set(featureId, new Set());
      channelStreams.get(featureId).add(res);
      res.on('close', () => channelStreams.get(featureId)?.delete(res));
      return;
    }
    if (pathname === '/protoclaw/events') {
      sendSse(res);
      return;
    }

    // ── 运行时数据面（/api/agents/<runtimeId>/<endpoint>）──
    const runtimeMatch = pathname.match(/^\/api\/agents\/([^/]+)\/([^/]+)$/);
    if (runtimeMatch) {
      const [, runtimeId, endpoint] = runtimeMatch;
      if (runtimeId !== 'rt-a') {
        sendJson(res, { error: 'unknown runtime' }, 404);
        return;
      }
      if (endpoint === 'messages') return sendJson(res, MESSAGES);
      if (endpoint === 'tools') return sendJson(res, []);
      if (endpoint === 'hooks' || endpoint === 'overview') return sendJson(res, {});
      if (endpoint === 'todo') return sendJson(res, {});
      if (endpoint === 'input-requests' || endpoint === 'queued-inputs') return sendJson(res, []);
      if (endpoint === 'notification') return sendJson(res, { ok: true });
      if (endpoint === 'connection') return sendJson(res, { ok: true, connected: true });
    }

    // ── 静态资产（real public/ + vendor mounts）──
    for (const [prefix, packagePath] of Object.entries(VENDOR_MOUNTS)) {
      if (!pathname.startsWith(`${prefix}/`)) continue;
      const file = path.join(ROOT, 'node_modules', packagePath, pathname.slice(prefix.length + 1));
      if (serveFile(res, file)) return;
    }
    if (serveFile(res, path.join(PUBLIC, pathname))) return;

    unhandled.push(`${req.method} ${req.url}`);
    sendJson(res, { error: 'not mocked', path: pathname }, 404);
  });
}

/** 向订阅该通道的真实 EventSource 推送一帧（event 类型与生产镜像同形）。 */
function emitChannelEvent(featureId, type, data) {
  const frame = `event: event\ndata: ${JSON.stringify({ type, data })}\n\n`;
  for (const res of channelStreams.get(featureId) || []) {
    if (!res.writableEnded) res.write(frame);
  }
}

function collectBrowserFailures(page) {
  const failures = { pageErrors: [], consoleErrors: [] };
  page.on('pageerror', (error) => {
    const origin = String(error?.stack || '').split('\n')[1]?.trim() || '';
    failures.pageErrors.push(`${String(error?.message || error)}${origin ? ` @ ${origin}` : ''}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') failures.consoleErrors.push(message.text());
  });
  return failures;
}

/**
 * 卡片解析（页面内注入）：bg 的内部任务键是通道四元组 + 任务 id 的 JSON，不当作
 * 选择器使用；按可见身份定位——进程卡认命令行，智能体卡认标题。
 */
const CARD_RESOLVER = () => {
  window.__bgCard = (kind, key) => {
    const cards = [...document.querySelectorAll('.bgp-card')];
    return kind === 'process'
      ? cards.find((node) => node.querySelector('.bgp-cmd')?.textContent === key) || null
      : cards.find((node) => node.querySelector('.bgp-id')?.textContent.includes(key)) || null;
  };
};

function waitForTailText(page, card, text) {
  return page.waitForFunction(
    ([kind, key, expected]) => (window.__bgCard(kind, key)?.querySelector('.bgp-tail')?.textContent || '').includes(expected),
    [card.kind, card.key, text],
    { timeout: 10000 },
  );
}

function waitForResultText(page, card, text) {
  return page.waitForFunction(
    ([kind, key, expected]) => (window.__bgCard(kind, key)?.querySelector('.bgp-result')?.textContent || '').includes(expected),
    [card.kind, card.key, text],
    { timeout: 10000 },
  );
}

function waitForScrollable(page, card) {
  return page.waitForFunction(
    ([kind, key]) => {
      const tail = window.__bgCard(kind, key)?.querySelector('.bgp-tail');
      return Boolean(tail) && tail.scrollHeight > tail.clientHeight + 40;
    },
    [card.kind, card.key],
    { timeout: 10000 },
  );
}

/** 读取一支输出的滚动几何。 */
function readTail(page, card) {
  return page.evaluate(([kind, key]) => {
    const tail = window.__bgCard(kind, key)?.querySelector('.bgp-tail');
    if (!tail) return null;
    return {
      top: tail.scrollTop,
      visible: tail.clientHeight > 0,
      scrollable: tail.scrollHeight > tail.clientHeight,
      distance: tail.scrollHeight - tail.clientHeight - tail.scrollTop,
    };
  }, [card.kind, card.key]);
}

/** 把输出区置到指定绝对位置，返回真实落定后的 scrollTop。 */
function setTailTop(page, card, top) {
  return page.evaluate(([kind, key, value]) => {
    const tail = window.__bgCard(kind, key).querySelector('.bgp-tail');
    tail.scrollTop = value;
    return tail.scrollTop;
  }, [card.kind, card.key, top]);
}

/** 把输出区置到底部（跟随态）。 */
function setTailBottom(page, card) {
  return page.evaluate(([kind, key]) => {
    const tail = window.__bgCard(kind, key).querySelector('.bgp-tail');
    tail.scrollTop = tail.scrollHeight;
    return tail.scrollTop;
  }, [card.kind, card.key]);
}

/** 点头行折叠 / 展开（点 .bgp-id：运行中卡片的按钮有自己的委托，避免误点）。 */
async function toggleCollapsed(page, card) {
  const collapsed = await page.evaluate(
    ([kind, key]) => window.__bgCard(kind, key)?.classList.contains('bgp-collapsed') === true,
    [card.kind, card.key],
  );
  await page.evaluate(
    ([kind, key]) => window.__bgCard(kind, key)?.querySelector('.bgp-id')?.click(),
    [card.kind, card.key],
  );
  await page.waitForFunction(
    ([kind, key, expected]) => window.__bgCard(kind, key)?.classList.contains('bgp-collapsed') === expected,
    [card.kind, card.key, !collapsed],
    { timeout: 5000 },
  );
}

async function run() {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  let browser = null;
  try {
    const port = server.address().port;
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(CARD_RESOLVER);
    const failures = collectBrowserFailures(page);
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'commit', timeout: 15000 });

    // ── 首屏落定：侧栏工作区条目 + 会话正文（bg 的 `when` 依赖 chat surface）──
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-agent-id="rt-a"]'))
        && (document.getElementById('chat-container')?.innerText || '').includes('world from mock'),
      null,
      { timeout: 20000 },
    );

    // ── A. 真实 rail 入口打开面板：注册表可见性 → mountBody → 通道发现 ──
    await page.waitForFunction(() => Boolean(document.getElementById('rail-bg')), null, { timeout: 10000 });
    await page.click('#rail-bg');
    await page.waitForFunction(
      () => document.getElementById('feature-panel')?.classList.contains('body-ready') === true
        && document.getElementById('feature-panel-body')?.dataset.panel === 'bg',
      null,
      { timeout: 10000 },
    );
    await page.waitForFunction(() => document.querySelectorAll('.bgp-card').length === 3, null, { timeout: 20000 });

    const panel = await page.evaluate(() => ({
      cards: document.querySelectorAll('.bgp-card').length,
      roots: document.querySelectorAll('#bg-panel-root').length,
      kill: document.querySelectorAll('.bgp-kill-btn').length,
      report: document.querySelectorAll('.bgp-report-btn').length,
      agentCardButtons: document.querySelectorAll('.bgp-card button').length - document.querySelectorAll('.bgp-kill-btn').length
        - document.querySelectorAll('.bgp-report-btn').length,
      badge: document.getElementById('rail-bg-badge')?.textContent || '',
    }));
    assert.equal(panel.cards, 3, '三个来源（bash / pwsh 进程 + coder 智能体）各一张卡片');
    assert.equal(panel.roots, 1, '面板根只有一个（重绘不嵌套）');
    assert.equal(panel.kill, 2, '进程卡各一个打断按钮');
    assert.equal(panel.report, 2, '进程卡各一个立即汇报按钮');
    assert.equal(panel.agentCardButtons, 0, '智能体卡只有展示，没有操作按钮');
    assert.equal(panel.badge, '3', '徽标计数为活跃项总数');
    console.log('rail entry: three isolated cards, process-only controls, badge=3');

    // ── B. 排版：深浅两主题下无横向溢出、结果行文字色不透 ──
    for (const theme of ['dark', 'light']) {
      await page.evaluate((value) => window.applyTheme(value), theme);
      await page.waitForFunction((value) => document.body.dataset.theme === value, theme, { timeout: 5000 });
      const layout = await page.evaluate(() => {
        const root = document.getElementById('bg-panel-root');
        const body = document.getElementById('feature-panel-body');
        const rootRect = root.getBoundingClientRect();
        const cards = [...document.querySelectorAll('.bgp-card')];
        return {
          overflow: cards.filter((card) => card.getBoundingClientRect().right > rootRect.right + 1).length,
          bodyOverflow: body.scrollWidth - body.clientWidth,
          colors: cards.map((card) => getComputedStyle(card.querySelector('.bgp-result-main')).color),
        };
      });
      assert.equal(layout.overflow, 0, `${theme}: 卡片不得横向溢出面板根`);
      assert.ok(layout.bodyOverflow <= 1, `${theme}: 面板 body 不得出现横向滚动（${layout.bodyOverflow}px）`);
      assert.deepEqual(
        layout.colors.filter((color) => color === 'rgba(0, 0, 0, 0)' || color === 'transparent'),
        [],
        `${theme}: 结果行文字色必须由真实主题变量给出`,
      );
      fs.mkdirSync(path.join(ROOT, '.agentdev', 'temp'), { recursive: true });
      await page.screenshot({ path: `.agentdev/temp/bg-panel-${theme}.png`, fullPage: true });
      console.log(`${theme}: three isolated cards, process-only controls, badge=3, no overflow`);
    }

    const bashCard = { kind: 'process', key: 'bash build' };
    const pwshCard = { kind: 'process', key: 'pwsh build' };
    const agentCard = { kind: 'agent', key: '验证协议面板' };

    // ── C. 进程输出：上翻阅读位置在四类更新后保持 ──
    // C0 事件更新走轻量路径（骨架不变）
    emitChannelEvent('bash', 'output', processTask('bash', { outputTail: PROCESS_OUTPUT }));
    await waitForScrollable(page, bashCard);
    const before = await page.evaluate(([kind, key]) => {
      const tail = window.__bgCard(kind, key).querySelector('.bgp-tail');
      window.__bgBashTail = tail;
      tail.scrollTop = 80;
      return tail.scrollTop;
    }, [bashCard.kind, bashCard.key]);
    assert.ok(before > 0, 'fixture 必须产生可滚动的进程输出');

    emitChannelEvent('bash', 'output', processTask('bash', { outputTail: `${PROCESS_OUTPUT}\nnew output` }));
    await waitForTailText(page, bashCard, 'new output');
    const afterEvent = await readTail(page, bashCard);
    assert.equal(afterEvent.top, before, 'live output must retain the reading position');
    // 取证路径：输出增长且骨架未变时必须走轻量路径（同一节点），否则下一条的
    // 「骨架变化」断言就退化成了又一次同路径比较。
    assert.equal(
      await page.evaluate(([kind, key]) => window.__bgCard(kind, key).querySelector('.bgp-tail') === window.__bgBashTail,
        [bashCard.kind, bashCard.key]),
      true,
      'growing output must take the lightweight path (same output node)',
    );

    // C1 宿主重渲染（真实 renderFeaturePanel：容器面板自管刷新，宿主不得清掉面板 DOM）
    await page.evaluate(() => window.renderFeaturePanel());
    const afterHost = await readTail(page, bashCard);
    assert.equal(afterHost.top, before, 'host refresh after live output must retain the reading position');

    // C2 骨架变化（readyFired 改变结果行 → 全量重建，卡片仍活跃不自动收起）仍回贴上翻位置
    emitChannelEvent('bash', 'output', processTask('bash', {
      readyFired: true, outputTail: `${PROCESS_OUTPUT}\nnew output`,
    }));
    await waitForResultText(page, bashCard, '已就绪');
    const afterRebuild = await readTail(page, bashCard);
    assert.equal(afterRebuild.top, before, 'skeleton change must retain the reading position');
    assert.equal(
      await page.evaluate(([kind, key]) => window.__bgCard(kind, key).querySelector('.bgp-tail') === window.__bgBashTail,
        [bashCard.kind, bashCard.key]),
      false,
      'skeleton change must take the full rebuild path (new output node)',
    );

    // C3 折叠期间收到新输出，重新展开后位置仍保持
    await toggleCollapsed(page, bashCard);
    emitChannelEvent('bash', 'output', processTask('bash', {
      readyFired: true, outputTail: `${PROCESS_OUTPUT}\nnew output\nhidden output`,
    }));
    await waitForTailText(page, bashCard, 'hidden output');
    await toggleCollapsed(page, bashCard);
    const afterExpand = await readTail(page, bashCard);
    assert.equal(afterExpand.top, before, 'collapse/expand must retain the reading position');
    assert.equal(afterExpand.visible, true, '展开后输出区必须重新可见');
    console.log('process output: reading position survives event, host refresh, skeleton change and collapse/expand');

    // ── D. 智能体进度：轻量路径不重建输出节点，位置在宿主 / 状态 / 折叠后保持 ──
    emitChannelEvent('coder', 'updated', agentTask({
      status: 'executing', revision: 2, updatedAt: 1700000000000, summary: AGENT_PROGRESS,
    }));
    await waitForScrollable(page, agentCard);
    const agentBefore = await setTailTop(page, agentCard, 80);
    assert.ok(agentBefore > 0, 'fixture must produce scrollable agent progress');
    await page.evaluate(([kind, key]) => {
      window.__bgAgentTail = window.__bgCard(kind, key).querySelector('.bgp-tail');
    }, [agentCard.kind, agentCard.key]);

    // 摘要 + 更新时间只走轻量路径：节点身份不变、时钟仍更新、位置保持
    emitChannelEvent('coder', 'updated', agentTask({
      status: 'executing', revision: 3, updatedAt: 1700000061000,
      summary: `${AGENT_PROGRESS}\nnew progress`,
    }));
    await waitForTailText(page, agentCard, 'new progress');
    const agentAfterSummary = await page.evaluate(([kind, key]) => {
      const card = window.__bgCard(kind, key);
      return {
        sameNode: card.querySelector('.bgp-tail') === window.__bgAgentTail,
        top: card.querySelector('.bgp-tail').scrollTop,
        clock: card.querySelector('[data-bgp-updated]')?.textContent || '',
        expectedClock: new Date(1700000061000).toTimeString().slice(0, 8),
      };
    }, [agentCard.kind, agentCard.key]);
    assert.equal(agentAfterSummary.sameNode, true, 'summary and timestamp updates must not rebuild the output node');
    assert.equal(agentAfterSummary.clock, agentAfterSummary.expectedClock, 'timestamp must still update on the lightweight path');
    assert.equal(agentAfterSummary.top, agentBefore, 'agent summary update must retain the reading position');

    // 宿主重渲染 + 状态切换（骨架变化）保持位置
    await page.evaluate(() => window.renderFeaturePanel());
    const agentAfterHost = await readTail(page, agentCard);
    assert.equal(agentAfterHost.top, agentBefore, 'host refresh must retain the agent reading position');
    emitChannelEvent('coder', 'updated', agentTask({
      status: 'suspended', revision: 4, updatedAt: 1700000061000, summary: `${AGENT_PROGRESS}\nnew progress`,
    }));
    await waitForResultText(page, agentCard, '已挂起');
    const agentAfterStatus = await readTail(page, agentCard);
    assert.equal(agentAfterStatus.top, agentBefore, 'agent status change must retain the reading position');

    // 折叠期间更新并重新展开
    await toggleCollapsed(page, agentCard);
    emitChannelEvent('coder', 'updated', agentTask({
      status: 'suspended', revision: 5, updatedAt: 1700000061000,
      summary: `${AGENT_PROGRESS}\nnew progress\nhidden progress`,
    }));
    await waitForTailText(page, agentCard, 'hidden progress');
    await toggleCollapsed(page, agentCard);
    const agentAfterExpand = await readTail(page, agentCard);
    assert.equal(agentAfterExpand.top, agentBefore, 'agent collapse/expand must retain the reading position');
    console.log('agent progress: summary, host, status and collapse/expand retain reading position');

    // ── E. 贴底跟随：输出增长 / 骨架变化 / 折叠展开后仍停在底部 ──
    emitChannelEvent('pwsh', 'output', processTask('pwsh', { outputTail: FOLLOW_OUTPUT }));
    await waitForScrollable(page, pwshCard);
    await setTailBottom(page, pwshCard);
    emitChannelEvent('pwsh', 'output', processTask('pwsh', { outputTail: `${FOLLOW_OUTPUT}\nfollow new output` }));
    await waitForTailText(page, pwshCard, 'follow new output');
    const followAfterOutput = await readTail(page, pwshCard);
    assert.ok(Math.abs(followAfterOutput.distance) <= 1, 'output at the bottom must keep following');

    emitChannelEvent('pwsh', 'output', processTask('pwsh', {
      readyFired: true, outputTail: `${FOLLOW_OUTPUT}\nfollow new output`,
    }));
    await waitForResultText(page, pwshCard, '已就绪');
    const followAfterRebuild = await readTail(page, pwshCard);
    assert.ok(Math.abs(followAfterRebuild.distance) <= 1, 'bottom-follow must survive a skeleton change');

    await toggleCollapsed(page, pwshCard);
    emitChannelEvent('pwsh', 'output', processTask('pwsh', {
      readyFired: true, outputTail: `${FOLLOW_OUTPUT}\nfollow new output\nfollow hidden output`,
    }));
    await waitForTailText(page, pwshCard, 'follow hidden output');
    await toggleCollapsed(page, pwshCard);
    const followAfterExpand = await readTail(page, pwshCard);
    assert.ok(Math.abs(followAfterExpand.distance) <= 1, 'bottom-follow must survive collapse/expand');
    console.log('process output: bottom-follow survives output, skeleton changes and collapse/expand');

    // ── F. 全局面：一次 live 重绘后仍只有一个根、其它来源的摘要未被擦除 ──
    emitChannelEvent('bash', 'output', processTask('bash', { outputTail: 'fresh tail' }));
    await waitForTailText(page, bashCard, 'fresh tail');
    assert.equal(await page.locator('#bg-panel-root').count(), 1, 'live repaint must not nest panel roots');
    assert.match(
      await page.evaluate(([kind, key]) => window.__bgCard(kind, key)?.querySelector('.bgp-tail')?.textContent || '',
        [agentCard.kind, agentCard.key]),
      /agent progress 0/,
      'live repaint of another source must not erase the agent summary',
    );

    assert.deepEqual(unhandled, [], `出现未 mock 的请求：${unhandled.join(' | ')}`);
    assert.deepEqual(failures.pageErrors, [], `出现 pageerror：${failures.pageErrors.join(' | ')}`);
    assert.deepEqual(failures.consoleErrors, [], `出现 console error：${failures.consoleErrors.join(' | ')}`);
    console.log('live repaint: one root, agent summary retained, no page errors');
    console.log(`bg panel browser check: PASS (${requests.length} requests observed)`);
  } finally {
    for (const res of sseConnections) res.destroy();
    if (browser) await browser.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

await run();
