/**
 * 真实 Chromium 生产启动回归 —— P2 生产装载接线（走真实 public/index.html）。
 *
 * 被测对象是"生产装载链"本身，不是某个模块的业务逻辑：
 *   - index.html 的真实标签清单（classic + module 入口，一字不改地由本服务下发）；
 *   - 真实 vendor 资产（marked / hljs / katex / diff2html，映射同 server.js 的
 *     vendorMounts）与真实 public/src 文件；
 *   - 真实模块图：classic 相 → DOMContentLoaded → auth-client initialize →
 *     `__clawAuthReady` → app-main boot → loadAgents / loadAgentData / SSE。
 *
 * 第一轮钉四件事：
 *   A. 模块延迟相（kernel-entry 与 boot 都扣住，解析完成、模块未求值）：P4 时序
 *      切换后首屏由 boot 在模块相触发，因此这一相里首屏**尚未渲染**；但 classic
 *      相的主题 / 语言实现仍需可用（静态按钮的 click 监听在 classic 相就已注册），
 *      不能被装载接线拖成"点了没反应"。
 *   B. 放行后模图求值、boot 真实顺序：先 auth/status，再 get_connected_agents /
 *      /api/agents 与消息加载，SSE 在认证放行之后；期间零 pageerror、零 console
 *      error（模块解析失败、桥键重复注册、classic 相调用已迁函数都会在这里暴露）。
 *   C. 侧栏工作区列表可达：真实 prebuilt 工作区条目 + 运行中会话叶子都渲染出来，
 *      列表来自 /protoclaw/get_connected_agents（数组，真实 wire 形状）。
 *   D. 聊天切换与菜单可达：点工作区条目触发真实会话加载；点会话叶子的 ⋯ 按钮
 *      走真实 getCtxMenuItems + showCtxMenu（#ctx-menu.open 且有菜单项）。
 *   E. 桥债计量（两本量纲分开并列，不相减）：静态口径按 gate 同款模式只读扫描
 *      public/src 的 defineKey / claim 文本调用点，与 .kernel-bridge-baseline.json
 *      同量纲对照；运行时口径输出真实页面的 KernelState.stats() 与实测访问器
 *      键列表/计数并互相核对（访问器是 defineKey 的唯一产物）。runtime 键数与
 *      静态基线不是同一量纲，不打印差值；不写死阈值、不在此脚本里改基线，
 *      也不用缺 classic 的沙箱读数替代。
 *
 * 第二轮（独立页面，只验延迟相事件入口）：
 *   E. 内核图延迟期真实 rail 点击：rail 面板按钮由首屏同步链生成（boot 求值 →
 *      applyLanguage → renderCurrentMainView → syncRailButtons；本轮的 boot 不扣，
 *      kernel-entry 仍扣住），这条入口**不经认证闸**——内核图尚未求值时用户点它
 *      同样会走 panel.render() / onOpen。ADR-0051 的时序规则要求审计"绕过门控的实际事件
 *      入口"，不能以缺少 import 边否认已经存在的 DOM 生命周期依赖。
 *      判据（枚举口径与断言一致，别按"能点"预筛）：枚举延迟相 DOM 里全部 rail
 *      面板按钮，`display` 非 none 即视为它该出现；逐个做中心点命中判定，并真实
 *      点击其中的可点按钮——必须打开面板、渲染出 body 内容、本次点击零
 *      pageerror / console error。可见但不可点的按钮直接判红（不当作"跳过"），
 *      同时断言核心预期面板仍在可点列表里（CORE_RAIL_PANELS）：按钮全量不可点、
 *      或核心面板从 DOM 消失，都必须失败，不会因为筛掉不可点项而静默通过。
 *      收敛条件是「渲染落定 OR 本次点击抛错」两个可观察事实，不用固定等待；
 *      不隐藏面板、不延后首屏、不为绿测试放宽任何 warn/error 面。
 *
 * 隔离纪律（不碰正式资源）：临时端口（port 0）静态服务仓库根，不启动 Claw，
 * 不连 ViewerWorker / UDS / 命名管道，不读真实用户数据目录，不写仓库；外部 IO
 * 全部是本文件内的 HTTP 契约 mock（形状按真实路由：数组 / {agents:[...]} /
 * {ok:true,...}），不替换任何被测生产函数——页面里的 fetch / EventSource 都是
 * 生产实现，只把网络对端换成本地 mock。
 *
 * 用法：node test/p2-production-boot-browser-check.mjs
 * 退出码 0 = 全部通过。
 */
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
 * A 阶段扣住的 module 响应：扣 kernel-entry（它 import p2-entry，等于扣住整个
 * P2 生产装载图与内核宿主图）与 boot（首屏渲染链入口，见 modules/boot.js）。
 *
 * 这两个入口合起来就是"首屏是否已发生"的开关：P4 时序切换后，首屏渲染链由
 * boot 在模块相触发，classic 相不再自动渲染（app-main 顶层那两行已删除）。
 * 因此 A 阶段的判据随之翻转——扣住它们时首屏**尚未渲染**，但 classic 相的主题 /
 * 语言实现仍可被点击入口调用。放行后首屏才出现。
 *
 * 为什么不是扣住全部 module 标签：HTTP/1.1 同源并发连接上限是 6，10 条 module
 * 标签同时取就会占满连接池，解析完的 classic 脚本反而发不出请求（门控本身把
 * 场景卡死，测不到"慢网络"窗口）。扣两个入口即可覆盖首屏链与内核图。
 */
/** 每轮可覆写的门控集合：主链轮扣首屏两个入口，rail 探针轮只扣内核图。 */
let gatedModulePaths = new Set(['/src/modules/kernel-entry.js', '/src/modules/boot.js']);

/**
 * 工作区快照：字段对齐 server/routes/agent-connected.js 的 prebuilt 投影
 * （sidebarSessionsPolicy / sessionOps 是服务端合流字段，缺它们侧栏菜单是空的）。
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

/**
 * 第二个会话的 runtime 叶子：服务端把同一 APP 下非 active 的会话投影成
 * `source: 'child'` + `parent_id` 的独立条目（见 agent-connected.js），
 * 用于验证真实的会话间切换（不是同会话重复加载）。
 */
const CHILD_SESSION = {
  id: 'rt-b',
  name: '会话 B',
  source: 'child',
  parent_id: 'programming-helper',
  runtime_session_id: 'rt-b',
  connected: true,
  status: 'running',
  active_workspace_session_id: 's2',
  active_workspace_session_title: '会话 B',
  workspace_sessions: {
    activeSessionId: 's2',
    sessions: [{ id: 's2', workspaceAgentId: 'main', title: '会话 B', message_count: 1 }],
  },
  message_count: 1,
  pid: 5321,
};

/** Viewer `/api/agents` 的 runtime 视图（对象形状：{agents:[...]}）。 */
const VIEWER = {
  agents: [
    { id: 'rt-a', name: '编程小助手', connected: true, messageCount: 2, pid: 4321 },
    { id: 'rt-b', name: '会话 B', connected: true, messageCount: 1, pid: 5321 },
  ],
};

const MESSAGES_BY_RUNTIME = {
  'rt-a': {
    messages: [
      { role: 'user', content: 'hello from mock' },
      { role: 'assistant', content: 'world from mock' },
    ],
    timestamps: {},
  },
  'rt-b': {
    messages: [{ role: 'user', content: 'second session message' }],
    timestamps: {},
  },
};

const requests = []; // { method, url, at }
const unhandled = []; // 未被 mock 的路径（断言为空，缺失 mock 直接暴露）
const sseConnections = new Set();
const pageFailureSets = []; // 每轮页面的错误收集器（两轮合计断言用）

/**
 * 延迟相必须出现的核心 rail 面板（chat surface 的产品默认面）：
 * plan（todo-plan）、git / session-controls（panel-plugins 懒面板声明）、
 * genui（generative-ui-panel）、hooks / inspector（debug-features-hooks）、
 * logs（debug-logs）。它们覆盖 classic 闭包持有与 ESM 批次两类入口；
 * 少一个即说明 rail 投影本身回归了，不能只看"剩下的按钮都能点"。
 */
const CORE_RAIL_PANELS = [
  'plan', 'git', 'session-controls', 'genui', 'hooks', 'inspector', 'logs',
];

/**
 * 桥债静态口径（与 test/kernel-bridge-debt-gate.test.js 同款模式）：
 * public/src 下 defineKey / claim 的文本调用点数，排除桥实现自身。
 * 这是与 .kernel-bridge-baseline.json 同量纲的口径；运行时 stats() 是实际键数，
 * 两者不能相减。
 */
function countStaticBridgeCalls() {
  const scanRoot = path.join(PUBLIC, 'src');
  const bridgeImpl = path.join(scanRoot, 'modules', 'kernel-state.js');
  const counts = { registered: 0, claimed: 0 };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        if (path.resolve(full) === bridgeImpl) continue; // 桥实现定义协议，不持有业务键
        const source = fs.readFileSync(full, 'utf8');
        counts.registered += source.match(/KernelState\.defineKey\(/g)?.length ?? 0;
        counts.claimed += source.match(/KernelState\.claim\(/g)?.length ?? 0;
      }
    }
  };
  walk(scanRoot);
  return counts;
}

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

/** 模块门控：A 阶段扣住 module 响应，release() 后放行。 */
const gate = { released: false, arrivals: [], waiters: [] };

function holdModule(pathname) {
  if (!gatedModulePaths.has(pathname)) return null;
  gate.arrivals.push(pathname);
  if (gate.released) return null;
  return new Promise((resolve) => gate.waiters.push(resolve));
}

function releaseModules() {
  gate.released = true;
  for (const resolve of gate.waiters.splice(0)) resolve();
}

/**
 * 门控复位：本文件跑两轮页面（生产主链 / 延迟相 rail 点击），每轮重新扣住入口。
 * `paths` 决定本轮扣哪些 module 响应：
 *   - 主链轮扣 kernel-entry + boot，得到"首屏尚未渲染"的窗口；
 *   - rail 探针轮只扣 kernel-entry：boot 已求值（首屏与 rail 按钮由此产生），
 *     内核图仍被扣住——这正是验证"deferred 模块未就绪时 rail 入口可用"的场景。
 */
function resetGate(paths = ['/src/modules/kernel-entry.js', '/src/modules/boot.js']) {
  gate.released = false;
  gate.arrivals.length = 0;
  gate.waiters.length = 0;
  gatedModulePaths = new Set(paths);
}

function createMockServer() {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, url: req.url, at: Date.now() });

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
      sendJson(res, [WORKSPACE, CHILD_SESSION]); // 数组形状（agent-lifecycle.js res.json(agents)）
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
      sendJson(res, {}); // 空模板映射：loadFeatureTemplateMap 返回 false 且不报错
      return;
    }
    if (pathname === '/protoclaw/workspace_settings/sidebar_layout') {
      sendJson(res, { ok: true }); // 无自定义布局 → 使用产品默认分组
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
    // /api/logs 由 server/shared/proxy.js 代理到 ViewerWorker（外部服务，隔离装置里
    // 不存在）。形状对齐 viewer-worker 的日志查询响应：{ scope, selectedAgentId,
    // total, logs, truncation }。rail 探针点开日志面板会真实请求它。
    if (pathname === '/api/logs') {
      sendJson(res, {
        scope: 'current',
        selectedAgentId: 'rt-a',
        total: 0,
        logs: [],
        truncation: null,
      });
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
    if (pathname === '/protoclaw/feature-comms/channels') {
      sendJson(res, { ok: true, channels: [] });
      return;
    }
    if (pathname === '/protoclaw/feature-comms/request') {
      sendJson(res, { ok: true, requestType: 'unknown', payload: {} });
      return;
    }
    if (pathname === '/protoclaw/feature-comms/stream') {
      sendSse(res);
      return;
    }
    if (pathname === '/protoclaw/events') {
      sendSse(res);
      return;
    }
    if (/^\/protoclaw\/agents\/[^/]+\/ui-surfaces$/.test(pathname)) {
      sendJson(res, { ok: true, agentId: 'rt-a', revision: 1, surfaces: [] });
      return;
    }

    // ── 运行时数据面（/api/agents/<runtimeId>/<endpoint>）──
    const runtimeMatch = pathname.match(/^\/api\/agents\/([^/]+)\/([^/]+)$/);
    if (runtimeMatch) {
      const [, runtimeId, endpoint] = runtimeMatch;
      if (!MESSAGES_BY_RUNTIME[runtimeId]) {
        sendJson(res, { error: 'unknown runtime' }, 404);
        return;
      }
      if (endpoint === 'messages') return sendJson(res, MESSAGES_BY_RUNTIME[runtimeId]);
      if (endpoint === 'tools') return sendJson(res, []);
      if (endpoint === 'hooks' || endpoint === 'overview') return sendJson(res, {});
      if (endpoint === 'todo') return sendJson(res, {});
      if (endpoint === 'input-requests') return sendJson(res, []);
      if (endpoint === 'queued-inputs') return sendJson(res, []);
      if (endpoint === 'notification') return sendJson(res, { ok: true });
      if (endpoint === 'connection') return sendJson(res, { ok: true, connected: true });
    }
    // ── 静态资产（real public/ + vendor mounts）──
    for (const [prefix, packagePath] of Object.entries(VENDOR_MOUNTS)) {
      if (!pathname.startsWith(`${prefix}/`)) continue;
      const file = path.join(ROOT, 'node_modules', packagePath, pathname.slice(prefix.length + 1));
      if (serveFile(res, file)) return;
    }
    const held = holdModule(pathname);
    if (held) await held;
    if (serveFile(res, path.join(PUBLIC, pathname))) return;

    unhandled.push(`${req.method} ${req.url}`);
    sendJson(res, { error: 'not mocked', path: pathname }, 404);
  });
}

function requestIndex(predicate) {
  return requests.findIndex((entry) => predicate(entry));
}

function indexes(predicate) {
  return requests.map((entry, index) => (predicate(entry) ? index : -1)).filter((index) => index >= 0);
}

function collectBrowserFailures(page) {
  const failures = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  page.on('pageerror', (error) => {
    // 附上栈首行定位来源文件（SyntaxError 的 stack 带脚本 URL），便于把失败
    // 归到具体 classic 标签，而不是只报一句 "Cannot use import statement"。
    const origin = String(error?.stack || '').split('\n')[1]?.trim() || '';
    failures.pageErrors.push(`${String(error?.message || error)}${origin ? ` @ ${origin}` : ''}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') failures.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    failures.failedRequests.push(`${request.url()} ${request.failure()?.errorText || ''}`.trim());
  });
  return failures;
}

/**
 * 打开一页真实 index.html：只装测量与错误收集，不等 DOMContentLoaded（它被
 * 扣住的 module 挡住）——`commit` 表示解析已开始即可。
 *
 * 页面内 uncaught error 副本（`window.__p2Probe.errors`）供 rail 探针在
 * 「渲染落定」与「本次点击抛错」之间确定性收敛，不用固定 sleep。它不是吞错
 * 通道：同一批错误也进 playwright 的 `failures.pageErrors`，两处都被断言。
 */
async function openPage(browser, port, { storedTheme } = {}) {
  const page = await browser.newPage();
  const failures = collectBrowserFailures(page);
  pageFailureSets.push(failures);
  if (storedTheme) {
    // 预置用户上次选择的主题：用来验证 index.html 内联主题预读（P4）——它在
    // body 解析开始时就落到 body[data-theme]，早于任何模块求值。
    await page.addInitScript((theme) => {
      try { localStorage.setItem('agentdev-theme', theme); } catch {}
    }, storedTheme);
  }
  await page.addInitScript(() => {
    // 只做测量：记录 DOMContentLoaded 是否已发生。readyState 在解析完成时就会
    // 变 'interactive'（早于 deferred/module 执行），不能用来判定 DCL 已触发。
    // 桥债实测基线：页面脚本执行前 window 上已有的平台访问器（get+set）。
    // 桥键（kernel-state 的 defineKey）在 classic 相才出现，扣掉这份初始面
    // 后剩下的就是真实页面上的桥访问器——不从缺 classic 的沙箱读数替代。
    const accessorNames = (target) => Object.getOwnPropertyNames(target).filter((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      return Boolean(descriptor) && typeof descriptor.get === 'function'
        && typeof descriptor.set === 'function';
    });
    window.__p2BootTrace = {
      domContentLoaded: false,
      initialAccessorKeys: accessorNames(window),
    };
    document.addEventListener('DOMContentLoaded', () => {
      window.__p2BootTrace.domContentLoaded = true;
    });
    window.__p2Probe = { errors: [] };
    window.addEventListener('error', (event) => {
      const detail = event?.message || (event?.error && event.error.message);
      if (detail) window.__p2Probe.errors.push(String(detail));
    });
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'commit', timeout: 15000 });
  } catch (error) {
    // 导航失败时页面已拿到句柄：就地关掉，不把清理责任留给出错后的调用方
    await page.close().catch(() => {});
    throw error;
  }
  return { page, failures };
}

/** 第一轮：生产主链（首屏 → 放行 → 认证 → 加载 / SSE → 侧栏 / 会话 / 菜单）。 */
async function runMainChain(browser, port) {
  const unhandledMark = unhandled.length;
  const { page, failures } = await openPage(browser, port, { storedTheme: 'light' });
  try {
    // ── A. 模块延迟相：首屏尚未渲染，但 classic 相的事件入口仍可用 ────────
    // 解析完成、两个首屏入口（kernel-entry / boot）都被扣住——此时 DOM 齐备、
    // classic 脚本全部执行完，只差模块求值。
    await page.waitForFunction(
      () => document.readyState === 'interactive'
        && document.querySelectorAll('#chat-container .empty-state').length > 0,
      null,
      { timeout: 15000 },
    );
    assert.deepEqual(
      [...gate.arrivals].sort(),
      ['/src/modules/boot.js', '/src/modules/kernel-entry.js'],
      '首屏入口（kernel-entry / boot）都应被门控扣住',
    );
    const preRelease = await page.evaluate(() => ({
      domContentLoaded: window.__p2BootTrace.domContentLoaded,
      sseClient: typeof window.ClawFW?.SseClient,
      workspaceAgents: typeof window.ClawFW?.workspaceAgents,
      sidebarRows: document.querySelectorAll('.agent-item').length,
      emptyStateText: (document.querySelector('#chat-container .empty-state')?.textContent || '').trim(),
      classicApplyTheme: typeof window.applyTheme,
      classicApplyLanguage: typeof window.applyLanguage,
      bodyTheme: document.body.dataset.theme,
    }));
    assert.equal(
      preRelease.domContentLoaded,
      false,
      '模块被扣住时 DOMContentLoaded 必须尚未触发（认证初始化等待该事件，plan R4/R2）',
    );
    assert.equal(preRelease.sseClient, 'undefined', 'P2 图（sse-client）在放行前不应求值');
    assert.equal(preRelease.workspaceAgents, 'undefined', 'P2 图（workspace-agents）在放行前不应求值');
    assert.equal(preRelease.sidebarRows, 0, '启动链（loadAgents）应仍被 DOMContentLoaded 挡住');
    assert.equal(
      preRelease.emptyStateText,
      '',
      'P4 时序切换后首屏渲染由 boot 在模块相触发：模块未求值时不应有首屏内容',
    );
    assert.equal(
      preRelease.bodyTheme,
      'light',
      '模块未求值时主题应已由内联预读落成 localStorage 值（applyTheme 尚未执行）',
    );
    // 首屏尚未渲染（boot 被扣住）时，主题 / 语言按钮没有监听：点击无效果，
    // 且不得抛错（P4 裁决的早期事件语义——不是半生效，也不是 ReferenceError）。
    const themeBefore = await page.evaluate(() => document.body.dataset.theme);
    const langBefore = await page.evaluate(() => ({
      stored: localStorage.getItem('agentdev-language'),
      title: document.title,
      toggle: document.getElementById('language-toggle')?.textContent,
    }));
    await page.click('#theme-toggle');
    await page.click('#language-toggle');
    const early = await page.evaluate(() => ({
      theme: document.body.dataset.theme,
      stored: localStorage.getItem('agentdev-language'),
      title: document.title,
      toggle: document.getElementById('language-toggle')?.textContent,
    }));
    assert.equal(early.theme, themeBefore, '首屏渲染前主题按钮点击应无效果');
    assert.equal(early.stored, langBefore.stored, '首屏渲染前语言按钮点击应无效果');
    assert.equal(early.title, langBefore.title, '首屏渲染前 document.title 不应被改写');
    assert.equal(early.toggle, langBefore.toggle, '首屏渲染前语言按钮文案不应变化');

    assert.deepEqual(failures.pageErrors, [], `延迟相出现 pageerror：${failures.pageErrors.join(' | ')}`);

    // ── B. 放行模块 → 认证 → 加载 / SSE 真实顺序 ─────────────────────
    releaseModules();
    // 等"图已求值"的可观察事实，而不是桥键计数：DOMContentLoaded 已触发 +
    // sse-client 的公开协议面（isSseActive）已建立。
    await page.waitForFunction(
      () => window.__p2BootTrace.domContentLoaded === true
        && typeof window.ClawFW?.SseClient?.isSseActive === 'function',
      null,
      { timeout: 20000 },
    );
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-agent-id="rt-a"]')),
      null,
      { timeout: 20000 },
    );
    await page.waitForFunction(
      () => (document.querySelectorAll('#chat-container .message-row').length || 0) >= 2,
      null,
      { timeout: 20000 },
    );

    const sessionView = await page.evaluate(() => ({
      agentName: document.getElementById('current-agent-name')?.textContent || '',
      messages: document.getElementById('chat-container')?.innerText || '',
      // 迁移图的公开协议面（模块自身挂载的命名空间，取自 P2 各批导出）：
      // 不用 KernelState 桥键计数判定——撤桥成功时计数会下降，计数阈值会把
      // 正确收敛误判成失败。
      protocols: {
        sse: typeof window.ClawFW?.SseClient?.isSseActive,
        welcome: typeof window.ClawFW?.workspaceAgents?.getWelcomeName,
        featureUi: typeof window.ClawFW?.featureUi?.refresh,
        annotations: typeof window.ClawAnnotations?.scheduleReplay,
        navigation: typeof window.NavigationCore?.waitForRuntimeReady,
        gitGraph: typeof window.GitGraph,
      },
    }));
    assert.equal(sessionView.protocols.sse, 'function', 'sse-client 模块必须已求值并建立 isSseActive');
    assert.equal(sessionView.protocols.welcome, 'function', 'workspace-agents 模块必须已求值并导出 getWelcomeName');
    assert.equal(sessionView.protocols.featureUi, 'function', 'feature-ui-registry 模块必须已求值并导出 refresh');
    assert.equal(
      sessionView.protocols.annotations,
      'function',
      'annotations 模块必须已求值（scheduleReplay 是 chat-renderer 的兼容协议面）',
    );
    assert.equal(
      sessionView.protocols.navigation,
      'function',
      'navigation-core 模块必须已求值（等待就绪的既有协议）',
    );
    assert.notEqual(sessionView.protocols.gitGraph, 'undefined', 'git-graph 模块必须已求值');
    assert.match(sessionView.messages, /hello from mock/, '接续后正文应来自真实 messages 端点');
    assert.match(sessionView.messages, /world from mock/, 'assistant 消息应同时上屏');
    assert.equal(
      await page.evaluate(() => window.__p2BootTrace.domContentLoaded),
      true,
      '放行后 DOMContentLoaded 必须已触发（boot 才可能执行）',
    );

    const authAt = requestIndex((entry) => entry.url.startsWith('/protoclaw/auth/status'));
    const connectedAt = requestIndex((entry) => entry.url.startsWith('/protoclaw/get_connected_agents'));
    const viewerAt = requestIndex((entry) => entry.url === '/api/agents');
    const messagesAt = requestIndex((entry) => entry.url === '/api/agents/rt-a/messages');
    const sseAt = requestIndex((entry) => entry.url.startsWith('/protoclaw/events'));
    assert.ok(authAt >= 0, '认证状态必须被读取（auth-client initialize）');
    assert.ok(connectedAt > authAt, '连接快照必须在认证放行之后（真实 boot 顺序）');
    assert.ok(viewerAt > authAt, 'Viewer 运行时列表必须在认证放行之后');
    assert.ok(messagesAt > authAt, '正文加载必须在认证放行之后');
    assert.ok(sseAt > authAt, 'SSE 连接必须在认证放行之后（不在登录前建流）');
    assert.ok(
      indexes((entry) => entry.url.startsWith('/api/agents/rt-a/messages')).length >= 1,
      '工作区聚焦会话应加载正文',
    );

    // ── C. 侧栏工作区列表 ────────────────────────────────────────────
    const sidebar = await page.evaluate(() => ({
      workspace: document.querySelector('[data-agent-id="programming-helper"]')?.textContent || '',
      runtime: document.querySelector('[data-agent-id="rt-a"]')?.textContent || '',
      count: document.querySelectorAll('.agent-item').length,
    }));
    assert.match(sidebar.workspace, /编程小助手/, '侧栏应有工作区条目');
    assert.match(sidebar.runtime, /会话 A/, '侧栏应有运行中会话叶子（来自 workspace_sessions）');
    assert.ok(sidebar.count >= 3, `侧栏应渲染工作区 + 两个会话叶子（实际 ${sidebar.count} 条）`);
    assert.ok(sessionView.agentName.length > 0, '顶栏标题应已由真实宿主解析出名字');

    // ── D. 聊天切换与菜单可达 ────────────────────────────────────────
    // 时序纪律：点击前先装好"可观察结果"的等待，点击后等它兑现；不用固定 sleep
    // 兜时序。计数比较保证"本次点击"确实触发了新的加载，而不是复用在先前的请求。

    // D1 会话切换：点同一 APP 下的另一个会话叶子 → 真实 switchAgent，正文换成该会话
    const messagesBeforeSwitch = indexes((entry) => entry.url === '/api/agents/rt-b/messages').length;
    const switchedToSecondSession = page.waitForFunction(
      () => (document.getElementById('chat-container')?.innerText || '').includes('second session message'),
      null,
      { timeout: 15000 },
    );
    await page.click('[data-agent-id="rt-b"]');
    await switchedToSecondSession;
    assert.ok(
      indexes((entry) => entry.url === '/api/agents/rt-b/messages').length > messagesBeforeSwitch,
      '会话切换必须新增一次目标会话正文加载',
    );

    // D2 工作区条目点击：真实 handlePrebuiltAgentClick → switchAgent(active runtime)，
    // 回到该 APP 的 active 会话。等"选中态 + 正文"同时到位（选中态是切换的直接
    // 副作用，轮询不会改它），点击无效会超时而非静默通过。
    const messagesBeforeWorkspaceClick = indexes((entry) => entry.url === '/api/agents/rt-a/messages').length;
    const returnedToWorkspaceSession = page.waitForFunction(
      () => document.querySelector('[data-agent-id="rt-a"]')?.classList.contains('active') === true
        && (document.getElementById('chat-container')?.innerText || '').includes('hello from mock'),
      null,
      { timeout: 15000 },
    );
    await page.click('[data-agent-id="programming-helper"]');
    await returnedToWorkspaceSession;
    assert.ok(
      indexes((entry) => entry.url === '/api/agents/rt-a/messages').length > messagesBeforeWorkspaceClick,
      '点击工作区条目必须触发新的会话正文加载',
    );

    // D3 菜单：会话叶子的 ⋯ 按钮（hover 才可见，保持真实交互路径）
    await page.hover('[data-agent-id="rt-b"]');
    await page.click('[data-agent-id="rt-b"] .agent-runtime-more');
    await page.waitForFunction(
      () => document.getElementById('ctx-menu')?.classList.contains('open') === true,
      null,
      { timeout: 5000 },
    );
    const menu = await page.evaluate(() => {
      const el = document.getElementById('ctx-menu');
      return { text: el?.innerText || '', display: el ? getComputedStyle(el).display : 'none' };
    });
    assert.notEqual(menu.display, 'none', '会话菜单应可见');
    assert.match(menu.text, /重命名|Rename/, '会话菜单应含真实菜单项（getCtxMenuItems 声明面）');
    await page.keyboard.press('Escape');

    // ── 全局失败面 ───────────────────────────────────────────────────
    assert.deepEqual(
      unhandled.slice(unhandledMark),
      [],
      `出现未 mock 的请求（生产路由形状未覆盖）：${unhandled.slice(unhandledMark).join(' | ')}`,
    );
    // 放行后：两个静态按钮的真实实现（i18n-environment-state 的桥键）已就绪
    const themeReleased = await page.evaluate(() => document.body.dataset.theme);
    await page.click('#theme-toggle');
    const themeFlipped = await page.evaluate(() => document.body.dataset.theme);
    assert.notEqual(themeFlipped, themeReleased, '模块就绪后主题切换必须生效（applyTheme 桥键）');
    await page.click('#theme-toggle');
    const languageReleased = await page.evaluate(() => localStorage.getItem('agentdev-language'));
    await page.click('#language-toggle');
    const languageFlipped = await page.evaluate(() => localStorage.getItem('agentdev-language'));
    assert.notEqual(languageFlipped, languageReleased, '模块就绪后语言切换必须落地（applyLanguage 桥键）');
    await page.click('#language-toggle');

    assert.deepEqual(failures.pageErrors, [], `出现 pageerror：${failures.pageErrors.join(' | ')}`);
    assert.deepEqual(failures.consoleErrors, [], `出现 console error：${failures.consoleErrors.join(' | ')}`);
    // SSE 长连接在会话切换 / 线程订阅变化时由 EventSource 主动重连，旧流以
    // ERR_ABORTED 结束是正常生命周期；只对非 SSE 的请求失败设限。
    const unexpectedFailures = failures.failedRequests.filter(
      (entry) => !/ERR_ABORTED/.test(entry)
        || !/\/protoclaw\/(events|feature-comms\/stream)/.test(entry),
    );
    assert.deepEqual(unexpectedFailures, [], `出现请求失败：${unexpectedFailures.join(' | ')}`);

    // ── 桥债实测（真实 index 页面 boot 之后，非沙箱）────────────────────
    // 两本口径对照：KernelState.stats() 的注册账本 vs 真实 window 上实测的
    // 访问器键列表（扣掉 addInitScript 记录的页面脚本执行前平台访问器；
    // kernel-state 是全仓唯一 defineProperty(window) 的地方）。
    const bridgeProbe = await page.evaluate(() => {
      const initial = new Set(window.__p2BootTrace.initialAccessorKeys || []);
      const accessorKeys = Object.getOwnPropertyNames(window)
        .filter((key) => {
          if (initial.has(key)) return false;
          const descriptor = Object.getOwnPropertyDescriptor(window, key);
          return Boolean(descriptor) && typeof descriptor.get === 'function'
            && typeof descriptor.set === 'function';
        })
        .sort();
      return { stats: window.KernelState.stats(), accessorKeys };
    });
    assert.equal(
      bridgeProbe.accessorKeys.length,
      bridgeProbe.stats.registeredKeys,
      `真实页面访问器键数（${bridgeProbe.accessorKeys.length}）必须与 KernelState `
        + `注册账本（${bridgeProbe.stats.registeredKeys}）一致：访问器是 defineKey 的唯一产物`,
    );
    // 静态口径与基线同量纲（调用点 vs 调用点）；运行时键数单独并列输出。
    const staticCalls = countStaticBridgeCalls();
    const debtBaseline = JSON.parse(
      fs.readFileSync(path.join(ROOT, '.kernel-bridge-baseline.json'), 'utf8'),
    );

    console.log('P2 production boot browser check: 主链 PASS');
    console.log(`  module entries gated then released: ${gate.arrivals.length}`);
    console.log('  bridge static call sites (info, same dimension as baseline): '
      + `registered=${staticCalls.registered} claimed=${staticCalls.claimed}`);
    console.log('  bridge debt baseline (static call sites, info, not asserted): '
      + `registered=${debtBaseline.registered} claimed=${debtBaseline.claimed}`);
    console.log('  bridge runtime keys (real page, separate dimension): '
      + `stats=${JSON.stringify(bridgeProbe.stats)}`
      + ` accessorKeys=${bridgeProbe.accessorKeys.length}`);
    console.log(`  bridge accessor keys: ${bridgeProbe.accessorKeys.join(', ')}`);
    console.log(`  boot order: auth#${authAt} → connected#${connectedAt} / viewer#${viewerAt} / messages#${messagesAt} → sse#${sseAt}`);
    console.log(`  requests observed: ${requests.length}`);
  } finally {
    await page.close();
  }
}

/** 延迟相收敛的等待：面板渲染落定（open + body-ready + 目标面板）或本次点击抛错。 */
const RAIL_SETTLED = (panelId) => {
  const panel = document.getElementById('feature-panel');
  const body = document.getElementById('feature-panel-body');
  const settled = !!panel && panel.classList.contains('open')
    && panel.classList.contains('body-ready') && body?.dataset.panel === panelId;
  return settled || window.__p2Probe.errors.length > 0;
};

/**
 * 第二轮：模块延迟相的真实 rail 点击（见文件头 E 段）。
 *
 * 用独立页面而不是第二轮点击插在主链中间：延迟相是瞬时窗口，而主链的
 * 认证 → 加载 → 会话 / 菜单断言必须在同一页里连续跑完才有意义。两轮都在
 * 真实 index.html 上跑，不模拟、不替换被测函数。
 */
async function runDeferredRailClickProbe(browser, port) {
  // P4 时序切换后，"内核图被扣住但 rail 按钮已在"的窗口不复存在：rail 按钮由
  // 首屏渲染产生，而首屏渲染本身就在模块相（boot → applyLanguage →
  // renderCurrentMainView），晚于 kernel-entry。本轮因此不扣任何模块，验证的是
  // 另一个仍然成立的契约：首屏一落定，rail 面板立即可交互（此时认证与数据链
  // 都没有完成）。
  resetGate([]);
  const unhandledMark = unhandled.length;
  const { page, failures } = await openPage(browser, port);
  try {
    await page.waitForFunction(
      () => (document.querySelector('#chat-container .empty-state')?.textContent || '').trim().length > 0,
      null,
      { timeout: 15000 },
    );
    assert.deepEqual(gate.arrivals, [], 'rail 探针轮不门控模块入口：首屏链依赖 p4-entry 的桥键');

    // 枚举延迟相 DOM 里全部 rail 面板按钮：`display` 非 none 即视为它该出现，
    // 不预先按"能不能点"过滤——预筛会让回归导致不可点的按钮从列表里静默消失。
    // 中心点命中只记录为判定，由下面的断言强制（核心面板缺失 / 可见但不可点都红）。
    const railButtons = await page.evaluate(() => [...document.querySelectorAll('.rail-button[data-panel]')]
      .filter((btn) => getComputedStyle(btn).display !== 'none')
      .map((btn) => {
        const rect = btn.getBoundingClientRect();
        const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          id: btn.dataset.panel,
          clickable: rect.width > 0 && rect.height > 0 && (center === btn || btn.contains(center)),
        };
      }));
    assert.ok(railButtons.length > 0,
      '延迟相 rail 必须已有面板按钮：它们由 classic 首屏同步链（syncRailButtons）生成，不能等 deferred 模块');
    const enumerate = () => railButtons
      .map((button) => `${button.id}(clickable=${button.clickable})`).join(', ');

    // 只对可点按钮做点击探针；可见但不可点的由下面的断言报出（先取完其余面板的
    // 证据，再判它红，避免一次不可点遮蔽整轮观察）。
    const results = [];
    for (const button of railButtons.filter((candidate) => candidate.clickable)) {
      const pageErrorMark = failures.pageErrors.length;
      const consoleErrorMark = failures.consoleErrors.length;
      await page.evaluate(() => { window.__p2Probe.errors.length = 0; });
      await page.click(`#rail-${button.id}`);
      // 收敛失败（既不落定、也没抛错）也照实取证：不吞掉，交给下面的断言报出
      // 该面板的观察态；不让一次超时遮蔽其余面板的结论。
      let settled = true;
      try {
        await page.waitForFunction(RAIL_SETTLED, button.id, { timeout: 10000 });
      } catch {
        settled = false;
      }
      const state = await page.evaluate(() => {
        const panel = document.getElementById('feature-panel');
        const body = document.getElementById('feature-panel-body');
        return {
          open: !!panel && panel.classList.contains('open'),
          // 面板身份记在 body 的 dataset.panel 上（renderFeaturePanel 写入），
          // aside 自身没有该字段
          renderedPanel: body?.dataset.panel || '',
          bodyReady: !!panel && panel.classList.contains('body-ready'),
          bodyText: (body?.innerText || '').trim().length,
          errors: window.__p2Probe.errors.slice(),
        };
      });
      results.push({
        ...button,
        ...state,
        settled,
        moduleReleased: gate.released,
        pageErrors: failures.pageErrors.slice(pageErrorMark),
        consoleErrors: failures.consoleErrors.slice(consoleErrorMark),
      });
      // 收起面板（真实的二次点击 toggle），把延迟相恢复到初始状态再测下一个
      await page.click(`#rail-${button.id}`);
      await page.waitForFunction(
        () => !document.getElementById('feature-panel')?.classList.contains('open'),
        null,
        { timeout: 5000 },
      );
    }

    const describe = (result) => `${result.id}: clickable=${result.clickable} open=${result.open}`
      + ` rendered=${result.renderedPanel} bodyReady=${result.bodyReady} settled=${result.settled}`
      + ` bodyChars=${result.bodyText}`
      + ` errors=${JSON.stringify([...result.errors, ...result.pageErrors, ...result.consoleErrors])}`;
    assert.deepEqual(
      results.filter((result) => result.moduleReleased).map((result) => result.id),
      [],
      '探针期间模块图必须仍被门控：否则测到的不是延迟相',
    );
    // 可见但不可点：不能因为"没被探针点击"就放过（这就是不按可点预筛的理由）
    assert.deepEqual(
      railButtons.filter((button) => !button.clickable).map((button) => button.id),
      [],
      `延迟相 rail 按钮必须真实可点（尺寸非 0 且中心点命中自身）：${enumerate()}`,
    );
    // 核心预期面板：全量不可点 / 面板消失都必须在列，不能只看"剩下的都能点"
    assert.deepEqual(
      CORE_RAIL_PANELS.filter((id) => !railButtons.some((button) => button.id === id && button.clickable)),
      [],
      `延迟相核心 rail 面板必须存在且可点：期望 ${CORE_RAIL_PANELS.join(', ')}；实际 ${enumerate()}`,
    );
    assert.deepEqual(
      results.filter((result) => !result.settled || !result.open || !result.bodyReady
        || result.renderedPanel !== result.id || result.bodyText === 0
        || result.errors.length > 0 || result.pageErrors.length > 0
        || result.consoleErrors.length > 0).map((result) => result.id),
      [],
      '延迟相 rail 点击必须打开面板、渲染出内容且零错误：'
        + `\n${results.map(describe).join('\n')}`,
    );
    assert.deepEqual(failures.pageErrors, [],
      `延迟相 rail 点击出现 pageerror：${failures.pageErrors.join(' | ')}`);
    assert.deepEqual(failures.consoleErrors, [],
      `延迟相 rail 点击出现 console error：${failures.consoleErrors.join(' | ')}`);
    assert.deepEqual(unhandled.slice(unhandledMark), [],
      `rail 探针轮出现未 mock 的请求：${unhandled.slice(unhandledMark).join(' | ')}`);

    console.log(`P2 production boot browser check: 延迟相 rail 点击 ${results.length} 个面板 PASS`);
    console.log(`  rail panels: ${results.map((result) => `${result.id}(${result.bodyText} chars)`).join(', ')}`);
  } finally {
    // 放行后关页：门控里挂着的 module 请求不会留下未决句柄
    releaseModules();
    await page.close();
  }
}

async function run() {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // browser 在 try 内获取：launch 失败（例如缺 chromium）时 finally 仍会关掉
  // 已 listen 的 server，不留下阻止进程退出的句柄。
  let browser = null;
  try {
    const port = server.address().port;
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    // 两轮跑在不同页面上、互不依赖：一轮失败不得遮住另一轮的失败证据（都会
    // 打印完整断言信息），汇总后仍以非零退出码失败——不是容错，是多点取证。
    const phaseFailures = [];
    const collect = async (label, phase) => {
      try {
        await phase();
      } catch (error) {
        phaseFailures.push({ label, error });
        console.error(`\n[${label}] FAILED\n${error?.stack || error}\n`);
      }
    };
    await collect('生产主链', () => runMainChain(browser, port));
    await collect('延迟相 rail 点击', () => runDeferredRailClickProbe(browser, port));
    // 两轮合计：轮内局部断言不能替代合计——某一轮把错误在轮内消化掉、或错误
    // 在轮次断言之后才到达（晚到请求 / 迟到的 console error），合计仍必须红。
    await collect('两轮错误合计', async () => {
      const pageErrors = pageFailureSets.flatMap((set) => set.pageErrors);
      const consoleErrors = pageFailureSets.flatMap((set) => set.consoleErrors);
      assert.deepEqual(pageErrors, [], `两轮合计出现 pageerror：${pageErrors.join(' | ')}`);
      assert.deepEqual(consoleErrors, [], `两轮合计出现 console error：${consoleErrors.join(' | ')}`);
      assert.deepEqual(unhandled, [], `两轮合计出现未 mock 的请求：${unhandled.join(' | ')}`);
    });
    if (phaseFailures.length > 0) {
      throw new AggregateError(
        phaseFailures.map((entry) => entry.error),
        `浏览器检查失败 ${phaseFailures.length} 轮：${phaseFailures.map((entry) => entry.label).join(' / ')}`,
      );
    }
    console.log('P2 production boot browser check: PASS');
  } finally {
    for (const res of sseConnections) res.destroy();
    if (browser) await browser.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

await run();
