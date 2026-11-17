/**
 * 真实 Chromium：debug 批次的「模块求值前 rail-logs 可用」回归检查。
 *
 * 被测的是 S-1 那一类真实事件入口，不是单元测试里的函数面：
 *   - 文档 = 真实 public/index.html（同一套 DOM / 样式 / classic 标签序），
 *     只做两处装载改写：① 摘掉生产 module 标签；② 摘掉「文件已含 ESM 语法却
 *     仍挂着 classic 标签」的标签（那是其它在飞批次的接线债，与本检查无关，
 *     留着会让 classic 相满是 SyntaxError 噪音）。改写是逐条读文件判定的，
 *     不写死文件名清单——debug-logs 一旦被误转 ESM，它的 classic 标签也会被
 *     摘掉，早期点击随即失败，检查报警。
 *   - 模块相 = 一条本检查追加的 inline module：静态 import
 *     p2-debug-small-bootstrap.js（本批）+ overview-data.js（生产由 kernel 图
 *     带入的日志写入入口）。它的 HTTP 响应被门控扣住，**release 前整张模块图
 *     不求值**，于是 classic 相与模块相严格分离。
 *   - 认证端点同样被扣住：boot 永不启动，页面没有后台轮询/SSE 噪音，检查只
 *     观测首屏那一相（S-1 的窗口）。不启动 Claw，不碰 ViewerWorker / UDS /
 *     命名管道 / 真实用户数据目录。
 *
 * 检查项：
 *   A. 模块相之前：#rail-logs 存在、可见、可命中；renderLogsPanel / loadLogs /
 *      setCurrentLogs 都是 classic 值属性（不是桥访问器）；KernelState 零认领
 *      （模块确实没求值）。
 *   B. 模块相之前点击 rail-logs：面板打开、渲染出完整日志面板 UI（统计条 /
 *      筛选器 / 空态），onOpen 的 loadLogs 全链路无异常；随后经 classic
 *      setCurrentLogs 写入日志集，面板渲染出真实条目——早期入口功能完整。
 *   C. release 后：mcp / preflight 的桥键按契约出现、loadPreflight 不挂 window；
 *      再次开合 rail-logs（无 runtime 身份 → 原语义清空并重绘）仍正常。
 *
 * 严格判据：**全程零 console error、零 pageerror**。不设任何「已知错误」豁免。
 *
 * 隔离范围（本检查的结论边界，不要外推）：这是「首屏 classic 相 + 本批模块图」
 * 的隔离装置——文档由 index.html 装载改写而来（见下），认证端点被扣住使 boot
 * 不启动，模块图只含本批入口。它**不证明生产整页可用**：生产 index.html 的
 * 接线、启动链与其它批次的联合回归由入口 owner 用
 * test/p2-production-boot-browser-check.mjs 另跑。
 *
 * 用法：node test/p2-debug-rail-early-browser-check.mjs
 *   - 环境可复用：PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指定已安装的 Chromium/Edge；
 *     未设置时用 Playwright 自带浏览器。
 *   - 资源纪律：监听与浏览器启动都在 try 内，finally 按实际获取情况逐项释放；
 *     浏览器启动失败（含无效 executablePath）以非零退出结束，不遗留监听端口。
 * 退出码 0 = 上述隔离范围内全部通过（零错误）。
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

/** 本批模块图入口（inline module 静态 import 的两个相对路径）。 */
const BATCH_MODULE = 'src/modules/p2-debug-small-bootstrap.js';
const LOG_STATE_MODULE = 'src/modules/overview-data.js';
const GATED_MODULE_PATHS = new Set([`/${BATCH_MODULE}`, `/${LOG_STATE_MODULE}`]);

/** 日志夹具：release 后经 window.setCurrentLogs 写入，验证面板能渲染真实条目。 */
const LOGS_FIXTURE = [
  {
    id: 901,
    level: 'error',
    namespace: 'agent',
    message: 'early-window log row',
    timestamp: 1700000001000,
    context: { feature: 'shell', callIndex: 3, step: 1 },
  },
];

const requests = [];
const unhandled = [];

/** 模块门控：release() 前相关 module 响应保持挂起（整张模块图不求值）。 */
const gate = { released: false, arrivals: [], waiters: [] };

function holdRequest(pathname) {
  if (!GATED_MODULE_PATHS.has(pathname)) return null;
  gate.arrivals.push(pathname);
  if (gate.released) return null;
  return new Promise((resolve) => gate.waiters.push(resolve));
}

function releaseModules() {
  gate.released = true;
  for (const resolve of gate.waiters.splice(0)) resolve();
}

/** 认证闸：整个检查期间都扣住 → boot 不启动，首屏相没有后台轮询/SSE。 */
const authGate = { arrived: false, waiters: [] };

function holdAuth() {
  authGate.arrived = true;
  return new Promise((resolve) => authGate.waiters.push(resolve));
}

/** 该相对路径的文件是否已含 ESM 语法（顶层 import/export）。 */
function isEsmSource(relativePath) {
  const file = path.join(PUBLIC, relativePath);
  if (!fs.existsSync(file)) return false;
  return /^[ \t]*(?:export|import)[ \t]/m.test(fs.readFileSync(file, 'utf8'));
}

/**
 * 装载改写：摘生产 module 标签、摘「已是 ESM 源码却仍挂 classic 标签」的标签，
 * 末尾追加本检查的门控 inline module。
 */
function buildHarnessHtml(html) {
  const withoutModuleTags = html.replace(
    /[ \t]*<script\b[^>]*\btype="module"[^>]*>\s*<\/script>[ \t]*\r?\n?/g,
    '',
  );
  const withoutEsmClassicTags = withoutModuleTags.replace(
    /[ \t]*<script\b(?![^>]*\btype="module")[^>]*\bsrc="\.\/([^"]+\.js)"[^>]*>\s*<\/script>[ \t]*\r?\n?/g,
    (match, relativePath) => (isEsmSource(relativePath) ? '' : match),
  );
  const moduleEntry = [
    '  <!-- p2-debug-rail-early-browser-check：门控模块相（release 前不求值） -->',
    '  <script type="module">',
    `    import './${BATCH_MODULE}';`,
    `    import './${LOG_STATE_MODULE}';`,
    '  </script>',
  ].join('\n');
  return withoutEsmClassicTags.replace('</body>', `${moduleEntry}\n</body>`);
}

const HARNESS_HTML = buildHarnessHtml(INDEX_HTML);

function serveFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
  return true;
}

function sendJson(res, body, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function createServer() {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, url: req.url });

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(HARNESS_HTML);
      return;
    }
    // 认证闸：整个检查期间扣住 → boot 不启动（首屏相无后台轮询/SSE 噪音）
    if (pathname === '/protoclaw/auth/status') {
      await holdAuth();
      if (!res.writableEnded) sendJson(res, { enabled: false, configured: false, authenticated: true });
      return;
    }
    // classic 相会自发请求的少量启动端点（形状按真实路由，值取空集）
    if (pathname === '/api/logs') return sendJson(res, { logs: LOGS_FIXTURE });
    if (pathname === '/api/feature-ui/ui-prefs') return sendJson(res, { ok: true, prefs: {} });
    if (pathname === '/protoclaw/threads') return sendJson(res, { ok: true, threads: [] });
    for (const [prefix, packagePath] of Object.entries(VENDOR_MOUNTS)) {
      if (!pathname.startsWith(`${prefix}/`)) continue;
      const file = path.join(ROOT, 'node_modules', packagePath, pathname.slice(prefix.length + 1));
      if (serveFile(res, file)) return;
    }
    const held = holdRequest(pathname);
    if (held) await held;
    if (serveFile(res, path.join(PUBLIC, pathname))) return;

    unhandled.push(`${req.method} ${req.url}`);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}

const pageErrors = [];
const consoleErrors = [];

function recordPage(page) {
  page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
}

/** 严格判据：控制台错误与 pageerror 必须为零，不设豁免名单。 */
function assertNoBrowserErrors(label) {
  assert.deepEqual(pageErrors, [], `${label}：不得有 pageerror\n${pageErrors.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `${label}：不得有 console error\n${consoleErrors.join('\n')}`);
}

async function main() {
  const server = createServer();
  // 资源获取（监听 / 浏览器）全部在 try 内：任一步失败都由 finally 按“实际已获取”
  // 逐项清理，成功监听后浏览器启动失败不会遗留监听中的 server。
  let browser = null;
  const results = [];
  const pass = (label) => { results.push(label); console.log(`  ✔ ${label}`); };
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    console.log(`[harness] ${base}  静态服务仓库根，未启动 Claw`);

    // 环境可复用：PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指向已安装的 Chromium/Edge；
    // 未设置时用 Playwright 自带浏览器（与仓库其它 browser-check 同一环境变量）。
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    recordPage(page);

    // 门控住的 module 响应会推迟 DOMContentLoaded（模块脚本阻塞该事件），
    // 而 classic 相首屏在解析期就已完成——以 commit 为界，靠元素等待判定就绪。
    await page.goto(base, { waitUntil: 'commit' });

    // ── A. 模块相之前的 rail 入口 ────────────────────────────────
    await page.waitForSelector('#rail-logs', { state: 'visible', timeout: 15000 });
    pass('#rail-logs 在模块求值前已可见');

    const early = await page.evaluate(() => {
      const button = document.getElementById('rail-logs');
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const descriptor = Object.getOwnPropertyDescriptor(window, 'renderLogsPanel');
      return {
        display: getComputedStyle(button).display,
        visible: rect.width > 0 && rect.height > 0,
        hitTestable: Boolean(hit && (hit === button || button.contains(hit))),
        clickedInlineDisplay: button.style.display,
        renderLogsPanelType: typeof window.renderLogsPanel,
        renderLogsPanelIsValueProperty: Boolean(descriptor && typeof descriptor.value === 'function'
          && descriptor.get === undefined),
        loadLogsType: typeof window.loadLogs,
        logWriteSeamType: typeof window.setCurrentLogs,
        logWriteSeamIsValueProperty: Boolean(
          typeof Object.getOwnPropertyDescriptor(window, 'setCurrentLogs')?.value === 'function'
          && Object.getOwnPropertyDescriptor(window, 'setCurrentLogs')?.get === undefined,
        ),
        mcpBridge: typeof window.renderMcpPanel,
        preflightBridge: typeof window.renderPreflightPanel,
        claimedKeys: window.KernelState.stats().claimedKeys,
        registeredKeys: window.KernelState.stats().registeredKeys,
      };
    });
    assert.equal(early.visible, true, 'rail-logs 必须有布局盒');
    assert.notEqual(early.display, 'none', 'rail-logs 不得被隐藏');
    assert.equal(early.hitTestable, true, 'rail-logs 必须能被命中（真实可点）');
    assert.equal(early.renderLogsPanelType, 'function', 'classic 相 renderLogsPanel 必须已可用');
    assert.equal(early.renderLogsPanelIsValueProperty, true, 'renderLogsPanel 必须是 classic 值属性，不是桥访问器');
    assert.equal(early.loadLogsType, 'function', 'classic 相 loadLogs 必须已可用（onOpen 入口）');
    assert.equal(early.logWriteSeamType, 'function', 'classic 相 setCurrentLogs 必须已可用（loadLogs 写入口）');
    assert.equal(early.logWriteSeamIsValueProperty, true, 'setCurrentLogs 必须是 classic 值属性，不是桥访问器');
    assert.equal(early.mcpBridge, 'undefined', '模块相之前 mcp 桥键必须不存在');
    assert.equal(early.preflightBridge, 'undefined', '模块相之前 preflight 桥键必须不存在');
    assert.equal(early.claimedKeys, 0, '模块相之前不得有任何 ESM 域认领');
    assert.ok(early.registeredKeys > 0, 'classic 相应已注册桥键（说明 KernelState 已就位）');
    assert.equal(gate.arrivals.length > 0, true, '模块请求应已发出且被门控扣住');
    pass(`模块未求值证据：claimedKeys=${early.claimedKeys} / registeredKeys=${early.registeredKeys} / 门控请求 ${gate.arrivals.length} 条`);

    // ── B. 模块相之前点击 rail-logs ──────────────────────────────
    await page.click('#rail-logs');
    await page.waitForSelector('#feature-panel-body .log-panel', { timeout: 5000 });
    const opened = await page.evaluate(() => {
      const panel = document.getElementById('feature-panel');
      const body = document.getElementById('feature-panel-body');
      return {
        open: panel.classList.contains('open'),
        hasStats: Boolean(body.querySelector('.logf-stats')),
        hasLevelFilter: Boolean(body.querySelector('[data-filter-key="level"]')),
        hasSearch: Boolean(body.querySelector('.logf-search')),
        hasEmpty: Boolean(body.querySelector('.feature-panel-empty')),
        title: (document.getElementById('feature-panel-title') || {}).textContent || '',
      };
    });
    assert.equal(opened.open, true, '面板应处于打开态');
    assert.equal(opened.hasStats, true, '面板体应渲染出日志统计条');
    assert.equal(opened.hasLevelFilter, true, '面板体应渲染出级别筛选器');
    assert.equal(opened.hasSearch, true, '面板体应渲染出搜索框');
    assert.equal(opened.hasEmpty, true, '空数据集应落空态（与 HEAD 同结果）');
    pass(`模块前点击渲染出完整日志面板（标题「${opened.title.trim()}」）`);
    // onOpen → loadLogs(true) 在本相已同步跑完（无 runtime 身份 → 清空 + 重绘）。
    await page.waitForTimeout(200);
    assertNoBrowserErrors('模块前点击（含 onOpen 全链路）');
    pass('模块前点击零 pageerror / 零 console error（onOpen 复位路径真实成功）');

    // 早期数据面：classic setCurrentLogs 写入 → classic renderLogsPanel 渲染真实条目。
    // 这两步都在模块求值之前，证明早期入口是「完整功能」而不只是 UI 骨架。
    await page.evaluate((logs) => {
      window.setCurrentLogs(logs);
      window.renderFeaturePanel();
    }, LOGS_FIXTURE);
    await page.waitForFunction(
      (message) => (document.getElementById('feature-panel-body') || {}).textContent?.includes(message),
      LOGS_FIXTURE[0].message,
      { timeout: 5000 },
    );
    const earlyData = await page.evaluate(() => {
      const body = document.getElementById('feature-panel-body');
      return {
        rows: body.querySelectorAll('.logf-entry').length,
        round: Boolean(body.querySelector('.logf-round')),
        claimedKeys: window.KernelState.stats().claimedKeys,
      };
    });
    assert.equal(earlyData.rows, 1, '模块前应渲染出 1 条日志条目');
    assert.equal(earlyData.round, true, '轮次徽标应进首行');
    assert.equal(earlyData.claimedKeys, 0, '渲染数据时模块仍未求值');
    assertNoBrowserErrors('模块前写入日志并渲染');
    pass('模块前经 classic setCurrentLogs 写入后 classic 面板渲染出真实条目（模块仍未求值）');

    // ── C. 放行模块相后 ─────────────────────────────────────────
    releaseModules();
    await page.waitForFunction(() => typeof window.renderMcpPanel === 'function', null, { timeout: 15000 });
    const afterModule = await page.evaluate(() => ({
      mcp: typeof window.renderMcpPanel,
      preflight: typeof window.renderPreflightPanel,
      loadPreflightInWindow: 'loadPreflight' in window,
      renderLogsPanel: typeof window.renderLogsPanel,
      renderLogsPanelIsValueProperty: Boolean(
        Object.getOwnPropertyDescriptor(window, 'renderLogsPanel')?.value,
      ),
      logWriteSeamIsValueProperty: Boolean(
        Object.getOwnPropertyDescriptor(window, 'setCurrentLogs')?.value,
      ),
    }));
    assert.equal(afterModule.mcp, 'function', '模块相后 mcp 桥键按契约出现');
    assert.equal(afterModule.preflight, 'function', '模块相后 preflight 桥键按契约出现');
    assert.equal(afterModule.loadPreflightInWindow, false, 'loadPreflight 零消费，不得挂 window');
    assert.equal(afterModule.renderLogsPanel, 'function', 'debug-logs 仍是 classic 唯一实现');
    assert.equal(afterModule.renderLogsPanelIsValueProperty, true, 'debug-logs 未经桥接管');
    assert.equal(afterModule.logWriteSeamIsValueProperty, true, 'setCurrentLogs 仍归 classic app-core');
    pass('模块相后桥键面符合契约（mcp/preflight 出现，loadPreflight 缺席，logs 仍 classic）');

    // 再次开合面板：仍是同一套 classic 入口。重开会走 onOpen → loadLogs(true)，
    // 本相没有 runtime 身份，原语义是「清空日志 + 重绘」——因此断言面板 UI 仍在、
    // 条目按语义清空，而不是断言刚才的条目还在。
    await page.click('#rail-logs');
    const closed = await page.evaluate(() => document.getElementById('feature-panel').classList.contains('open'));
    assert.equal(closed, false, '第一次点击应收起面板');
    await page.click('#rail-logs');
    await page.waitForSelector('#feature-panel-body .log-panel', { timeout: 5000 });
    await page.waitForFunction(
      () => document.querySelectorAll('#feature-panel-body .logf-entry').length === 0
        && Boolean(document.querySelector('#feature-panel-body .logf-stats')),
      null,
      { timeout: 5000 },
    );
    const reopened = await page.evaluate(() => ({
      open: document.getElementById('feature-panel').classList.contains('open'),
      hasLevelFilter: Boolean(document.querySelector('#feature-panel-body [data-filter-key="level"]')),
      logWriteSeam: typeof window.setCurrentLogs,
    }));
    assert.equal(reopened.open, true, '重开后应处于打开态');
    assert.equal(reopened.hasLevelFilter, true, '重开后应渲染出日志面板 UI');
    assert.equal(reopened.logWriteSeam, 'function', '模块相后日志写入口仍是 classic 实现');
    pass('模块相后再次开合 rail-logs 正常（无 runtime 身份 → 原语义清空并重绘）');

    await page.waitForTimeout(200);
    assertNoBrowserErrors('全流程');
    pass('全程零 pageerror / 零 console error');
    if (unhandled.length > 0) {
      // 未被 mock 的请求会以 404 出现在控制台错误里并被上面的严格判据拦住；
      // 这里只是把路径列出来便于定位（当前设计下应为空）。
      console.log(`  · 未 mock 的请求 ${unhandled.length} 条：${unhandled.slice(0, 5).join(', ')}`);
    }

    console.log(`\n结果：${results.length} 项通过，0 项失败（隔离范围：首屏 classic 相 + 本批模块图）`);
  } finally {
    // 按实际获取情况清理：浏览器启动失败时 browser 仍是 null，只收 server。
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error('关闭浏览器失败：', error && error.message ? error.message : error);
      }
    }
    if (server.listening) {
      // close 会等既有连接结束；先断开残留 keep-alive，避免失败路径挂起。
      await new Promise((resolve) => {
        server.close(resolve);
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    }
  }
}

main().catch((error) => {
  console.error('\n检查失败：', error && error.message ? error.message : error);
  if (pageErrors.length > 0) console.error('pageerror:\n' + pageErrors.join('\n'));
  if (consoleErrors.length > 0) console.error('console error:\n' + consoleErrors.join('\n'));
  if (unhandled.length > 0) console.error('未 mock 的请求:\n' + unhandled.join('\n'));
  process.exitCode = 1;
});
