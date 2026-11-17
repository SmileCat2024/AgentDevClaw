/**
 * P2 深批（调试总览与功能深面板）真实浏览器回归 —— 模块求值前的 hooks / inspector。
 *
 * 被测缺陷面：hooks / inspector 两个 rail 按钮在 classic 相（app-main 顶层
 * applyLanguage → syncRailButtons）就已生成、可见、可点击。若把它们的 render 入口
 * 搬进 deferred ESM，模块求值前的真实点击会抛 `renderFeaturesPanel is not defined`。
 * 本检查在真实 Chromium 里走同一条点击路径并断言它可用。
 *
 * ── 隔离 harness 与生产接线的边界（本文件只做前者）──────────────────────
 *   harness（本文件负责）：
 *     1. 临时端口（port 0）静态服务仓库根，不启动 Claw，不连 ViewerWorker /
 *        UDS / 命名管道，不读真实用户数据目录，不写仓库；
 *     2. 只对 kernel-entry 这一条 module 响应做门控（hold/release），用来构造
 *        「classic 相已可交互、P2 图尚未求值」的时间窗；
 *     3. 外部 IO 全部换成文件内的 HTTP 契约 mock（形状对齐真实路由），页面里的
 *        fetch / EventSource 仍是生产实现。
 *   生产接线（本文件**不做、不替代**）：
 *     public/index.html 的标签清单与 public/src/modules/p2-entry.js 的批次 import
 *     由入口 owner 维护。本文件**原样下发真实 index.html 与真实源码**，不改写、
 *     不注入、不替换入口——因此它验收的是「接线完成后的真实页面」。
 *
 * ── 判定口径（零容忍，不做归类剔除）────────────────────────────────────
 *   - 两次 phase 结束时 `pageerror` 与 `console error` 都必须为 0；
 *   - 服务端未被显式 mock 的 HTTP 请求数必须为 0（`unknownRequests`）；
 *   - 任一不满足即 `ok:false` 且 exit 1，并把错误原文（含脚本 URL/行号）打印出来。
 *   接线未完成时（例如 index.html 仍把已转 ESM 的文件当 classic 装载）本检查会
 *   红并给出 SyntaxError 证据，这是预期行为，不是允许清单。
 *
 * 两个 phase：
 *   A. kernel-entry 被扣住：等 rail 按钮出现 → 真实点击 #rail-hooks / #rail-inspector，
 *      断言面板打开、空态卡、动作态、渲染入口已是 classic 实现、overview 桥键尚不存在。
 *   B. 放行 → DOMContentLoaded → 等真实接线带来的 overview 桥键 → 再点同样两个按钮，
 *      断言行为不变、六个桥键可用、catalog 命名空间仍在。
 *
 * 用法：node test/p2-debug-deep-browser-check.mjs
 * 退出码 0 = 全部通过；非 0 = 失败（证据见 stdout/stderr 的 JSON）。
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

/** 只扣 kernel-entry：它 import p2-entry，等于扣住整个 P2 图与 boot 依赖的宿主图。 */
const GATED_MODULE_PATHS = new Set(['/src/modules/kernel-entry.js']);

const gate = { released: false, arrivals: [], waiters: [] };
const requests = []; // { method, url }
const endpointHits = Object.create(null); // pathname → 次数（证据：命中了哪些 mock）
const unknownRequests = []; // 未显式 mock 的路径（必须为空）
const sseResponses = new Set();
const sockets = new Set();

function holdModule(pathname) {
  if (!GATED_MODULE_PATHS.has(pathname)) return null;
  gate.arrivals.push(pathname);
  if (gate.released) return null;
  return new Promise((resolve) => gate.waiters.push(resolve));
}

function releaseModules() {
  gate.released = true;
  for (const resolve of gate.waiters.splice(0)) resolve();
}

function sendJson(res, payload, status = 200) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function sendSse(res) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  sseResponses.add(res);
  res.on('close', () => sseResponses.delete(res));
}

function serveFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  if (res.writableEnded || res.destroyed) return true;
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(fs.readFileSync(file));
  return true;
}

/** 读取 JSON 请求体（POST mock 需要按真实契约校验形状）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * HTTP 契约 mock。每个分支的形状取自真实路由实现（route 文件见行尾注释）；
 * 不在这里放行「任意字符串 200」——未知路径一律落进 unknownRequests。
 */
async function handleMock(req, res, pathname) {
  // ── 认证与启动链（server/routes/*）────────────────────────────────
  if (pathname === '/protoclaw/auth/status') {
    sendJson(res, { enabled: false, configured: false, authenticated: true });
    return true;
  }
  if (pathname === '/protoclaw/get_connected_agents') {
    sendJson(res, []); // agent-lifecycle.js res.json(agents)（数组）
    return true;
  }
  if (pathname === '/api/agents') {
    sendJson(res, { agents: [] }); // Viewer 运行时列表（对象形状）
    return true;
  }
  if (pathname === '/protoclaw/agent_detail') {
    sendJson(res, { ok: true, agent: null });
    return true;
  }
  if (pathname === '/api/templates/feature') {
    sendJson(res, {});
    return true;
  }
  if (pathname === '/protoclaw/workspace_settings/sidebar_layout') {
    sendJson(res, { ok: true });
    return true;
  }
  if (pathname === '/protoclaw/threads') {
    sendJson(res, { ok: true, threads: [] });
    return true;
  }
  if (pathname === '/protoclaw/remote_catalog') {
    sendJson(res, { ok: true, sections: [] });
    return true;
  }
  if (pathname === '/protoclaw/ph_project/projects') {
    sendJson(res, { projects: [] });
    return true;
  }
  if (pathname === '/protoclaw/app_info') {
    sendJson(res, { ok: true, version: 'test', frameworkVersion: 'test', links: [] });
    return true;
  }
  if (pathname === '/protoclaw/model_config') {
    sendJson(res, { presets: [] });
    return true;
  }
  if (pathname === '/protoclaw/model_connections' || pathname === '/protoclaw/speech_model_config') {
    sendJson(res, {});
    return true;
  }
  if (pathname === '/protoclaw/choice_alerts') {
    sendJson(res, { ok: true, alerts: [] });
    return true;
  }
  if (pathname === '/api/feature-ui/declarations') {
    sendJson(res, { ok: true, declarations: [] });
    return true;
  }
  if (pathname === '/api/feature-ui/ui-prefs') {
    sendJson(res, { ok: true, prefs: {} });
    return true;
  }
  if (pathname === '/api/mcp-info') {
    sendJson(res, { ok: true, servers: [] });
    return true;
  }
  if (pathname === '/api/logs') {
    // server/shared/proxy.js → ViewerWorker 日志查询响应形状。
    sendJson(res, { scope: 'current', selectedAgentId: null, total: 0, logs: [], truncation: null });
    return true;
  }
  if (pathname === '/api/feature-catalog') {
    sendJson(res, { provenances: [], types: [], capabilities: [], features: [] });
    return true;
  }
  if (pathname === '/api/feature-store/overview') {
    sendJson(res, { mounts: {} });
    return true;
  }
  if (pathname === '/protoclaw/commands') {
    sendJson(res, { ok: true, commands: [] });
    return true;
  }

  // ── Feature 面板通信（ADR-0018）──────────────────────────────────
  if (pathname === '/protoclaw/feature-comms/channels') {
    sendJson(res, { ok: true, channels: [] });
    return true;
  }
  if (pathname === '/protoclaw/feature-comms/request') {
    sendJson(res, { ok: true, requestType: 'unknown', payload: {} });
    return true;
  }
  if (pathname === '/protoclaw/feature-comms/stream') {
    sendSse(res);
    return true;
  }
  if (pathname === '/protoclaw/events') {
    sendSse(res);
    return true;
  }

  // ── 侧栏诊断（server/routes/sidebar-diagnostics.js 的真实 wire 契约）──
  if (pathname === '/protoclaw/sidebar_diagnostics/status' && req.method === 'GET') {
    sendJson(res, {
      enabled: true,
      schemaVersion: 1,
      location: '.agentdev/AgentDevClaw/diagnostics/sidebar',
      fileName: 'sidebar-events.jsonl',
      maxFileBytes: 5 * 1024 * 1024,
      retentionDays: 7,
      maxArchivedFiles: 7,
    });
    return true;
  }
  if (pathname === '/protoclaw/sidebar_diagnostics/events' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!Array.isArray(body?.events)) {
      sendJson(res, { error: 'events must be an array' }, 400);
      return true;
    }
    const submitted = body.events.length;
    const accepted = Math.min(submitted, 50);
    sendJson(res, { ok: true, accepted, rejected: submitted - accepted });
    return true;
  }

  const uiSurfaces = pathname.match(/^\/protoclaw\/agents\/[^/]+\/ui-surfaces$/);
  if (uiSurfaces) {
    sendJson(res, { ok: true, agentId: 'runtime', revision: 1, surfaces: [] });
    return true;
  }

  return false;
}

function createStaticServer() {
  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, url: req.url });
    endpointHits[pathname] = (endpointHits[pathname] || 0) + 1;
    try {
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        res.end(INDEX_HTML); // 原样真实 index，不做任何改写
        return;
      }
      if (await handleMock(req, res, pathname)) return;

      for (const [prefix, packagePath] of Object.entries(VENDOR_MOUNTS)) {
        if (!pathname.startsWith(`${prefix}/`)) continue;
        const file = path.join(ROOT, 'node_modules', packagePath, pathname.slice(prefix.length + 1));
        if (serveFile(res, file)) return;
      }
      const held = holdModule(pathname);
      if (held) await held;
      if (serveFile(res, path.join(PUBLIC, pathname))) return;

      unknownRequests.push(`${req.method} ${req.url}`);
      sendJson(res, { error: 'not mocked', path: pathname }, 404);
    } catch (error) {
      unknownRequests.push(`${req.method} ${req.url} (handler error: ${error?.message || error})`);
      sendJson(res, { error: 'mock failure' }, 500);
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return server;
}

// ── 浏览器侧错误采集（零容忍，不做归类剔除）─────────────────────────────

const browserErrors = { pageErrors: [], consoleErrors: [] };

function collectBrowserErrors(page) {
  page.on('pageerror', (error) => {
    const stackTail = String(error?.stack || '')
      .split('\n')
      .slice(1, 3)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' | ');
    browserErrors.pageErrors.push(
      `${String(error?.name || 'Error')}: ${String(error?.message || error)}${stackTail ? ` @ ${stackTail}` : ''}`,
    );
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = typeof message.location === 'function' ? message.location() : null;
    const where = location?.url ? ` @ ${location.url}:${(location.lineNumber || 0) + 1}` : '';
    browserErrors.consoleErrors.push(`${message.text()}${where}`);
  });
}

/**
 * 错误上报收尾窗口（不是时序仲裁）：等 3 帧 + 250ms，把点击后由防抖队列
 * （如 sidebar_diagnostics 的 250ms flush）触发的异步报错收进断言面。
 */
async function settleAsyncReporting(page) {
  await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const tick = () => {
      frames += 1;
      if (frames >= 3) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  await page.waitForTimeout(250);
}

function assertNoBrowserErrors(phase) {
  assert.deepEqual(browserErrors.pageErrors, [], `${phase}：pageerror 必须为零`);
  assert.deepEqual(browserErrors.consoleErrors, [], `${phase}：console error 必须为零`);
}

function assertNoUnknownRequests() {
  assert.deepEqual(unknownRequests, [], '未知 HTTP 请求必须为零（缺 mock 直接暴露）');
}

// ── 页面操作 ────────────────────────────────────────────────────────────

function installProbe() {
  window.__deepProbe = { domContentLoaded: false };
  document.addEventListener('DOMContentLoaded', () => { window.__deepProbe.domContentLoaded = true; });
}

const RAIL_VISIBLE = () => {
  const hooks = document.getElementById('rail-hooks');
  const inspector = document.getElementById('rail-inspector');
  return Boolean(hooks && inspector)
    && getComputedStyle(hooks).display !== 'none' && hooks.getClientRects().length > 0
    && getComputedStyle(inspector).display !== 'none' && inspector.getClientRects().length > 0;
};

async function openPage(browser, port) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  collectBrowserErrors(page);
  await page.addInitScript(installProbe);
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'commit', timeout: 15000 });
  return page;
}

/** 点 rail 按钮 → 等面板正文落定（deferBody 走两帧 rAF）→ 返回面板事实。 */
async function clickRailAndRead(page, railSelector, expectedText) {
  await page.click(railSelector);
  await page.waitForFunction((text) => {
    const panel = document.getElementById('feature-panel');
    if (!panel || !panel.classList.contains('open')) return false;
    return (panel.textContent || '').includes(text);
  }, expectedText, { timeout: 5000 });
  return page.evaluate(() => ({
    open: document.getElementById('feature-panel').classList.contains('open'),
    bodyReady: document.getElementById('feature-panel').classList.contains('body-ready'),
    hasEmptyCard: Boolean(document.querySelector('#feature-panel .feature-panel-empty')),
    activePanels: Array.from(document.querySelectorAll('.rail-button.active'))
      .map((button) => button.dataset.panel),
  }));
}

// ── Phase A：classic 相（P2 图被扣住）────────────────────────────────────

async function runClassicPhase(browser, port) {
  const page = await openPage(browser, port);
  await page.waitForFunction(RAIL_VISIBLE, null, { timeout: 15000 });

  const facts = await page.evaluate(() => {
    const hidden = (id) => {
      const button = document.getElementById(id);
      if (!button) return true;
      return getComputedStyle(button).display === 'none' || button.getClientRects().length === 0;
    };
    return {
      domContentLoaded: window.__deepProbe.domContentLoaded,
      kernelGraph: typeof window.ClawFW?.SseClient,
      overviewBridge: typeof window.renderStructurePanel,
      featuresEntry: typeof window.renderFeaturesPanel,
      reverseEntry: typeof window.renderReverseHooksPanel,
      overlayEntry: typeof window.renderFeatureDetailOverlay,
      workspaceHidden: hidden('rail-workspace'),
      monitorHidden: hidden('rail-monitor'),
    };
  });
  assert.equal(facts.domContentLoaded, false, '门控期间 DOMContentLoaded 必须尚未触发（boot 未开始）');
  assert.equal(facts.kernelGraph, 'undefined', '门控期间 P2 模块图必须尚未求值');
  assert.equal(facts.overviewBridge, 'undefined', '门控期间 overview 的桥键必须尚不存在');
  assert.equal(facts.featuresEntry, 'function', 'features 早期入口必须在模块求值前就是 classic 实现');
  assert.equal(facts.reverseEntry, 'function', 'reverse hooks 早期入口必须在模块求值前就可用');
  assert.equal(facts.overlayEntry, 'function', 'detail overlay 清理入口必须在模块求值前就可用');
  assert.equal(facts.workspaceHidden, true, 'workspace 面板必须仍被 rail-customize 隐藏（无 order）');
  assert.equal(facts.monitorHidden, true, 'monitor 面板必须仍被 rail-customize 隐藏（无 order）');

  const hooksPanel = await clickRailAndRead(page, '#rail-hooks', '没有 Feature');
  assert.equal(hooksPanel.open, true);
  assert.equal(hooksPanel.bodyReady, true, '面板正文应在两帧内落定（deferBody 走 rAF）');
  assert.equal(hooksPanel.hasEmptyCard, true, 'classic 相空 inspector 应渲染空态卡');
  assert.ok(hooksPanel.activePanels.includes('hooks'), 'rail 按钮应进入动作态');

  const inspectorPanel = await clickRailAndRead(page, '#rail-inspector', '没有 Hook 数据');
  assert.equal(inspectorPanel.open, true);
  assert.equal(inspectorPanel.hasEmptyCard, true);
  assert.ok(inspectorPanel.activePanels.includes('inspector'), 'rail 按钮应切到 inspector 动作态');
  assert.ok(!inspectorPanel.activePanels.includes('hooks'), '切换后旧面板不应保持动作态');

  await settleAsyncReporting(page);
  assertNoBrowserErrors('classic 相');
  assertNoUnknownRequests();
  await page.close();
  return { facts, hooksPanel, inspectorPanel };
}

// ── Phase B：模块求值后（真实接线）──────────────────────────────────────

async function runAfterModulePhase(browser, port) {
  const page = await openPage(browser, port);
  await page.waitForFunction(() => Boolean(document.getElementById('rail-hooks')), null, { timeout: 15000 });

  releaseModules();
  await page.waitForFunction(() => window.__deepProbe.domContentLoaded === true, null, { timeout: 20000 });
  // 真实接线（入口 owner 的 index.html 删标签 + p2-entry 装批次入口）生效后，
  // debug-overview 作为 ESM 求值并提供桥键。这里不注入 import、不改写入口。
  await page.waitForFunction(() => typeof window.renderStructurePanel === 'function', null, {
    timeout: 15000,
  });

  const facts = await page.evaluate(() => ({
    overviewBridge: typeof window.renderStructurePanel,
    featureDetailsBridge: typeof window.openFeatureDetails,
    featuresEntry: typeof window.renderFeaturesPanel,
    reverseEntry: typeof window.renderReverseHooksPanel,
    catalogNamespace: typeof window.ClawFW?.featureCatalog?.resolveDisplayName,
  }));
  assert.equal(facts.overviewBridge, 'function', 'debug-overview 应经 ESM 求值提供桥键');
  assert.equal(facts.featureDetailsBridge, 'function', 'feature 详情桥键应供 classic features 动作使用');
  assert.equal(facts.featuresEntry, 'function', 'classic features 入口必须仍可用（唯一实现）');
  assert.equal(facts.reverseEntry, 'function', 'classic reverse hooks 入口必须仍可用');
  assert.equal(facts.catalogNamespace, 'function', 'feature-catalog 命名空间应仍在（classic 消费面）');

  const hooksPanel = await clickRailAndRead(page, '#rail-hooks', '没有 Feature');
  assert.equal(hooksPanel.open, true);
  const inspectorPanel = await clickRailAndRead(page, '#rail-inspector', '没有 Hook 数据');
  assert.equal(inspectorPanel.open, true);

  await settleAsyncReporting(page);
  assertNoBrowserErrors('模块求值后');
  assertNoUnknownRequests();
  await page.close();
  return { facts, hooksPanel, inspectorPanel };
}

// ── 主流程（资源一律 finally 回收；任何失败 = 非零退出）──────────────────

const server = createStaticServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let browser = null;
let result = null;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const classic = await runClassicPhase(browser, port);
  const afterModule = await runAfterModulePhase(browser, port);
  result = {
    ok: true,
    classicPhase: {
      hooksEntry: classic.facts.featuresEntry,
      reverseEntry: classic.facts.reverseEntry,
      overlayEntry: classic.facts.overlayEntry,
      overviewBridgeAbsent: classic.facts.overviewBridge === 'undefined',
      hooksEmptyCard: classic.hooksPanel.hasEmptyCard,
      inspectorEmptyCard: classic.inspectorPanel.hasEmptyCard,
      workspaceHidden: classic.facts.workspaceHidden,
      monitorHidden: classic.facts.monitorHidden,
    },
    afterModule: {
      overviewBridge: afterModule.facts.overviewBridge,
      featureDetailsBridge: afterModule.facts.featureDetailsBridge,
      featuresEntry: afterModule.facts.featuresEntry,
    },
    browserErrors,
    unknownRequests,
    requestCount: requests.length,
    sidebarDiagnosticsHits: {
      status: endpointHits['/protoclaw/sidebar_diagnostics/status'] || 0,
      events: endpointHits['/protoclaw/sidebar_diagnostics/events'] || 0,
    },
  };
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: String(error?.message || error),
    browserErrors,
    unknownRequests,
    requestCount: requests.length,
    recentRequests: requests.slice(-20),
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const res of sseResponses) {
    try { res.destroy(); } catch { /* 已关闭 */ }
  }
  sseResponses.clear();
  // 先清掉 keep-alive 连接再等 close，避免 server.close 等不到空闲连接。
  for (const socket of sockets) {
    try { socket.destroy(); } catch { /* 已关闭 */ }
  }
  sockets.clear();
  await new Promise((resolve) => server.close(resolve));
}
