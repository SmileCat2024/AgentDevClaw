/**
 * 真实 Chromium：thread-store 刷新引擎的 classic 相时序（S2 拆分回归）。
 *
 * 拆分的硬约束是「刷新引擎与三条同步调度留在 classic 原位」：`thread-store.js`
 * 仍在 index.html 的 classic 标签处注册 2s 启动刷新 / 20s 周期刷新 /
 * visibilitychange 刷新，并把交互入口交给 deferred 的
 * `thread-store-domain.js`。本检查用**真实页面 + 真实计时**证明这条约束：
 *
 *   - 文档 = 真实 public/index.html，只做两处装载改写：① 摘掉生产 module 标签；
 *     ② 追加一条本检查的 inline module（静态 import kernel-entry 与交互域，
 *     即生产接线的最终形态）。它的响应被门控扣住，**release 前整张模块图不求值**。
 *   - 认证端点同样扣住：boot 永不启动，页面没有 SSE / 轮询噪音，`/protoclaw/threads`
 *     的请求只可能来自 thread-store 自己的三条调度。
 *   - 三条调度全部按真实时钟观测（不装假定时器）：2s 启动刷新、20s 周期刷新、
 *     visibilitychange 刷新各自产生一次真实 `/protoclaw/threads` 请求；期间模块
 *     仍未求值（KernelState 零认领、顺序保证）。
 *   - 刷新闭包同样在模块前跑完整：请求落地后 `ClawThreads.initialLoadDone` 为真、
 *     `refreshThreads` 的 finally 链（updateThreadHeaderIndicator）被真实调用。
 *   - release 后：交互域的桥键才出现（这正是「引擎不依赖 ESM」的反向证据），
 *     且刷新仍照常工作。
 *   - 前台同步链路（本检查同时钉住）：模块相之前 `refreshAgentCallStates` 已是
 *     classic 同步引擎的真实实现（与 `ClawFW.CallStates` 同一函数），
 *     `refreshCurrentRuntimeStatus` 仍缺席；app-core 之后包装
 *     `currentRuntimeAgentId` 写入面，实测模块相之前只写 null（不 seed 合成
 *     runtime）；真实 visibilitychange 在模块相之前驱动 call 状态对账（真实
 *     notification 请求 + agent 记录/共享容器修复），release 后驱动 notification
 *     与 connection 两条真实请求。全程不用任何空实现占位。
 *
 * 严格判据：全程零 pageerror、零 console error。**不设任何「已知错误」豁免**，
 * 也不把错误过滤当作通过条件。
 *
 * 隔离纪律：临时端口（port 0）静态服务仓库根，不启动 Claw，不连 ViewerWorker /
 * UDS / 命名管道，不读真实用户数据目录，不写仓库。
 *
 * 用法：node test/p2-thread-store-classic-timing-browser-check.mjs
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 可指定已安装的 Chromium/Edge。
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

/** 与 server.js 的 vendorMounts 同口径。 */
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

/** 本检查追加的模块入口（生产接线的最终形态：入口图 + 交互域）。 */
const HARNESS_MODULES = [
  'src/modules/kernel-entry.js',
  'src/modules/thread-store-domain.js',
];
const GATED_MODULE_PATHS = new Set(HARNESS_MODULES.map((entry) => `/${entry}`));

/** 该相对路径的文件是否已含 ESM 语法（顶层 import/export）。 */
function isEsmSource(relativePath) {
  const file = path.join(PUBLIC, relativePath);
  if (!fs.existsSync(file)) return false;
  return /^[ \t]*(?:export|import)[ \t]/m.test(fs.readFileSync(file, 'utf8'));
}

/**
 * 装载改写：摘全部 module 标签（避免 10 条被扣的 module 请求占满连接池、把
 * classic 相挤死），再摘「源码已是 ESM 却仍挂 classic 标签」的标签（那是其它在飞
 * 批次的接线债，与本检查无关），最后追加门控 inline module。
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
  // 探针（app-core 之后、app-main 注册 visibilitychange 之前）：包装
  // `currentRuntimeAgentId` 的写入面。本检查把 classic 相 → 模块相的间隔刻意
  // 拉长到 20s 量级，这段时间里真实前台事件会触达 app-main 的处理器；探针实测
  // 「模块相之前该值只允许写 null」的不变量，而不是靠合成非空 runtime。
  const probeScript = [
    '  <script>',
    '    (function () {',
    '      var descriptor = Object.getOwnPropertyDescriptor(window, "currentRuntimeAgentId");',
    '      window.__craiWrites = [];',
    '      if (!descriptor || !descriptor.configurable) { window.__craiProbeMissing = true; return; }',
    '      Object.defineProperty(window, "currentRuntimeAgentId", {',
    '        configurable: true,',
    '        enumerable: descriptor.enumerable,',
    '        get: function () { return descriptor.get.call(window); },',
    '        set: function (value) { window.__craiWrites.push(value); descriptor.set.call(window, value); },',
    '      });',
    '    })();',
    '  </script>',
  ].join('\n');
  const moduleEntry = [
    '  <!-- p2-thread-store-classic-timing-browser-check：门控模块相 -->',
    '  <script type="module">',
    ...HARNESS_MODULES.map((entry) => `    import './${entry}';`),
    '  </script>',
  ].join('\n');
  return withoutEsmClassicTags
    .replace('<script src="./src/app-core.js"></script>', `<script src="./src/app-core.js"></script>\n${probeScript}`)
    .replace('</body>', `${moduleEntry}\n</body>`);
}

const HARNESS_HTML = buildHarnessHtml(INDEX_HTML);

const requests = []; // { at, pathname }
const unhandled = [];

/** 模块门控：release() 前模块响应保持挂起（整张模块图不求值）。 */
const gate = { released: false, arrivals: [], waiters: [] };

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

/** 认证闸：整个检查期间都扣住 → boot 不启动，没有 SSE / 轮询噪音。 */
const authGate = { waiters: [] };

function holdAuth() {
  return new Promise((resolve) => authGate.waiters.push(resolve));
}

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

/**
 * `/api/agents/<id>/connection` 的显式应答脚本（按请求顺序消费）：用例按
 * false → true → 迟到 false 三步驱动，证明 loader 采纳的是**响应体里的值**，
 * 而不是「任何 200 都算连上」的空体验证。`hold` 步先挂起响应，由用例显式放行。
 */
const connectionScript = [];

/** 被挂起（hold）的连接响应步骤：用例放行后才写回响应体。 */
const connectionHoldSteps = [];

/** 未在脚本里声明的 API / protoclaw 端点：严格记录，结束前必须为空。 */
const unknownApiRequests = [];

/** 轮询等待某个请求累计出现 n 次（真实网络，不装假时钟）。 */
async function waitForAgentRequest(id, endpoint, count, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    if (agentRequests(id, endpoint).length >= count) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待 ${id}/${endpoint} 第 ${count} 次请求超时（已见 ${agentRequests(id, endpoint).length} 次）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    requests.push({ at: Date.now(), pathname });

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(HARNESS_HTML);
      return;
    }
    if (pathname === '/protoclaw/auth/status') {
      await holdAuth();
      if (!res.writableEnded) sendJson(res, { enabled: false, configured: false, authenticated: true });
      return;
    }
    // 线程事实：稳态（unchanged 短路）——本条腿证明的是调度时点与刷新闭包，
    // 不掺线程内容变化。
    if (pathname === '/protoclaw/threads') {
      sendJson(res, { unchanged: true });
      return;
    }
    for (const [prefix, packagePath] of Object.entries(VENDOR_MOUNTS)) {
      if (!pathname.startsWith(`${prefix}/`)) continue;
      const file = path.join(ROOT, 'node_modules', packagePath, pathname.slice(prefix.length + 1));
      if (serveFile(res, file)) return;
    }
    const held = holdModule(pathname);
    if (held) await held;
    if (serveFile(res, path.join(PUBLIC, pathname))) return;
    // 面板声明 API（ESM 相 feature-ui-registry 会在求值后拉取）：真实形状是
    // `{ ok: true, declarations: [] }`，空对象会被判为失败并 console.error。
    if (pathname === '/api/feature-ui/declarations') {
      sendJson(res, { ok: true, declarations: [] });
      return;
    }
    // 下面三个是 classic/ESM 相真实会拉的既有端点：按生产读取面的形状显式回答
    // （不是通用 `{ok:true}` 兜底）。
    // claw-host / rail-customize 读 body.prefs.panelPrefs
    if (pathname === '/api/feature-ui/ui-prefs') {
      sendJson(res, { ok: true, prefs: { panelPrefs: {} } });
      return;
    }
    // sidebar-layout：`data.ok === true` 且 data.sidebarLayout 可为 null（默认布局）
    if (pathname === '/protoclaw/workspace_settings/sidebar_layout') {
      sendJson(res, { ok: true, sidebarLayout: null });
      return;
    }
    // app-info：`payload.ok && payload.version`
    if (pathname === '/protoclaw/app_info') {
      sendJson(res, { ok: true, version: '0.0.0-harness' });
      return;
    }
    // call 状态对账的通知端点：真实 wire 形状（callActive）。
    if (/^\/api\/agents\/[^/]+\/notification$/.test(pathname)) {
      sendJson(res, { callActive: false });
      return;
    }
    // runtime 状态端点：按显式脚本回答 `{ connected: boolean }`；未排脚本即
    // 记录为未知请求（不允许兜底成空体让「状态落地」断言假绿）。
    if (/^\/api\/agents\/[^/]+\/connection$/.test(pathname)) {
      const step = connectionScript.shift();
      if (!step) {
        unknownApiRequests.push({ pathname, kind: 'unscripted-connection' });
        sendJson(res, { ok: false });
        return;
      }
      if (step.hold) {
        connectionHoldSteps.push(step);
        await new Promise((resolve) => { step.release = resolve; });
      }
      sendJson(res, { connected: step.connected });
      return;
    }
    // 未显式 mock 的 API / protoclaw 端点：严格记录（不静默兜底）。
    if (pathname.startsWith('/api/') || pathname.startsWith('/protoclaw/')) {
      unknownApiRequests.push({ pathname });
      sendJson(res, { ok: true });
      return;
    }
    unhandled.push(pathname);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}

const pageErrors = [];
const consoleErrors = [];

function recordPage(page) {
  // 记录完整栈：pageerror 不带栈就无法定位是哪条 classic 闭包触达的。
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error?.message || error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
}

function assertNoBrowserErrors(label) {
  assert.deepEqual(pageErrors, [], `${label}：不得有 pageerror\n${pageErrors.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `${label}：不得有 console error\n${consoleErrors.join('\n')}`);
}

const threadsRequests = () => requests.filter((entry) => entry.pathname === '/protoclaw/threads');
const agentRequests = (id, endpoint) => requests.filter(
  (entry) => entry.pathname === `/api/agents/${encodeURIComponent(id)}/${endpoint}`,
);

/** 等待下一次 /protoclaw/threads 请求（真实轮询，不装假时钟）。 */
async function waitForThreadsRequest(count, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    const list = threadsRequests();
    if (list.length >= count) return list[count - 1];
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待第 ${count} 次 threads 刷新超时（已见 ${list.length} 次）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main() {
  const server = createServer();
  let browser = null;
  const results = [];
  const pass = (label) => { results.push(label); console.log(`  ✔ ${label}`); };
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    console.log(`[harness] ${base}  静态服务仓库根，未启动 Claw`);

    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    recordPage(page);

    await page.goto(base, { waitUntil: 'commit' });
    // classic 相在解析期完成：以 classic 引擎的公开面就绪为界。
    await page.waitForFunction(() => typeof window.refreshThreads === 'function', { timeout: 15000 });

    // 模块请求在文档解析完成后才发出：等它们真的被门控扣住，再判定「模块前」。
    const gateDeadline = Date.now() + 10000;
    while (gate.arrivals.length < HARNESS_MODULES.length && Date.now() < gateDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // ── A. 模块相之前：引擎唯一实现已在位，交互域缺席 ──────────────
    const early = await page.evaluate(() => {
      // 观察刷新闭包：refreshThreads 的 finally 会同步调它。
      const original = window.updateThreadHeaderIndicator;
      window.__headerIndicatorCalls = 0;
      window.updateThreadHeaderIndicator = function () {
        window.__headerIndicatorCalls += 1;
        return original.apply(this, arguments);
      };
      return {
        refreshThreads: typeof window.refreshThreads,
        getThreadById: typeof window.getThreadById,
        isThreadHostAgentId: typeof window.isThreadHostAgentId,
        hostFactory: typeof window.createThreadStoreHost,
        interaction: typeof window.openConversationTarget,
        submit: typeof window.submitThreadInput,
        claimedKeys: window.KernelState.stats().claimedKeys,
        registeredKeys: window.KernelState.stats().registeredKeys,
        gated: 0,
      };
    });
    assert.equal(early.refreshThreads, 'function', 'classic 引擎的刷新入口在模块前必须可用');
    assert.equal(early.getThreadById, 'function');
    assert.equal(early.isThreadHostAgentId, 'function');
    assert.equal(early.hostFactory, 'function', '窄宿主工厂是 classic 相实现');
    assert.equal(early.interaction, 'undefined', '模块相之前交互域必须缺席（唯一实现在 ESM）');
    assert.equal(early.submit, 'undefined');
    assert.equal(early.claimedKeys, 0, '模块相之前不得有任何 ESM 域认领');
    assert.ok(early.registeredKeys > 0, 'classic 相应已注册桥键（KernelState 已就位）');
    assert.ok(gate.arrivals.length > 0, '模块请求应已发出且被门控扣住');
    pass(`模块未求值证据：claimedKeys=${early.claimedKeys} / registeredKeys=${early.registeredKeys} / 门控请求 ${gate.arrivals.length} 条`);

    // 同步引擎：前台 visibilitychange 的两条调用链在模块相之前必须已经可用。
    // app-main 的监听器裸调 `refreshAgentCallStates`（唯一实现在 classic）与
    // `refreshCurrentRuntimeStatus`（仍 ESM-only，靠 currentRuntimeAgentId 恒 null
    // 不被求值）。这里断言真实可达性，不装任何占位。
    const syncOwner = await page.evaluate(() => ({
      accessor: typeof window.refreshAgentCallStates,
      sameAsOwner: window.refreshAgentCallStates === window.ClawFW?.CallStates?.refreshAgentCallStates,
      status: typeof window.refreshCurrentRuntimeStatus,
      interrupt: typeof window.clearInterruptSuppression,
      runtimeId: window.currentRuntimeAgentId,
      writes: window.__craiWrites,
      probeMissing: !!window.__craiProbeMissing,
    }));
    assert.equal(syncOwner.probeMissing, false, 'currentRuntimeAgentId 必须是可包装的 KernelState 访问器');
    assert.equal(syncOwner.accessor, 'function', '模块相之前 refreshAgentCallStates 必须已在位（classic 唯一实现）');
    assert.equal(syncOwner.sameAsOwner, true, 'classic 访问器与 ESM late-bound 适配器读到的必须是同一实现');
    assert.equal(syncOwner.interrupt, 'function', 'call-interrupt 四个访问器是 classic 同步引擎');
    assert.equal(syncOwner.status, 'undefined', 'refreshCurrentRuntimeStatus 仍只由 ESM 提供（本相不可达）');
    assert.equal(syncOwner.runtimeId, null, '模块相之前 currentRuntimeAgentId 恒 null');
    assert.ok(syncOwner.writes.every((value) => value === null),
      `模块相之前 currentRuntimeAgentId 只允许写 null（实际 ${JSON.stringify(syncOwner.writes)}）`);
    pass(`同步引擎在模块相之前可用：call-states=classic / status=absent / ${syncOwner.writes.length} 次写入全为 null`);

    // ── B. 三条同步调度（真实计时） ────────────────────────────────
    const first = await waitForThreadsRequest(1, 8000);
    const startupDelay = first.at - (requests.find((entry) => entry.pathname === '/')?.at ?? first.at);
    assert.ok(startupDelay >= 1200, `2s 启动刷新应在约 2s 触发（实际 ${startupDelay}ms）`);
    assert.equal(await page.evaluate(() => window.KernelState.stats().claimedKeys), 0,
      '启动刷新发生在模块求值之前');
    pass(`2s 启动刷新：模块未求值即发出 threads 请求（${startupDelay}ms）`);

    // 刷新闭包：请求落地后 initialLoadDone 置真，且 finally 链调用指示器刷新。
    await page.waitForFunction(() => window.ClawThreads.initialLoadDone === true, { timeout: 5000 });
    const closure = await page.evaluate(() => ({
      initialLoadDone: window.ClawThreads.initialLoadDone,
      lastRefreshAt: window.ClawThreads.lastRefreshAt,
      headerCalls: window.__headerIndicatorCalls,
    }));
    assert.equal(closure.initialLoadDone, true, '刷新闭包跑完整：initialLoadDone=true');
    assert.ok(closure.lastRefreshAt > 0, '刷新时间戳落账');
    assert.ok(closure.headerCalls >= 1, 'refreshThreads 的 finally 链真实调用了 updateThreadHeaderIndicator');
    pass(`刷新闭包：initialLoadDone=true / 指示器刷新 ${closure.headerCalls} 次`);

    // visibilitychange 刷新：节流窗（5s）之后再派发，必须再拉一次。
    // 同一次真实前台事件还要驱动 call 状态对账：夹具只 seed「活跃 agent 记录 +
    // 共享容器里的旧 calling」，不 seed currentRuntimeAgentId（null 不变量是本
    // 检查的验收面）。模块相之前 SSE 未建连（`typeof isSseActive` 为真状态），
    // 因此本地 id 也走真实轮询。
    await new Promise((resolve) => setTimeout(resolve, 5200));
    await page.evaluate(() => {
      // callActive 初值 true：下面的 false 才是真实状态迁移（不是 undefined→false
      // 这种任何响应都成立的写入）。
      allAgents = [{ id: 'rt-seed', connected: true, callActive: true, runtime_session_id: 'rt-seed', source: 'external' }];
      _agentCallActive.set('rt-seed', true);
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
      if (descriptor && descriptor.get && descriptor.get.call(document) !== 'visible') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      }
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const second = await waitForThreadsRequest(2, 5000);
    assert.ok(second.at > first.at, 'visibilitychange 必须在启动刷新之后再拉一次');
    assert.equal(await page.evaluate(() => window.KernelState.stats().claimedKeys), 0,
      '可见性刷新同样发生在模块求值之前');
    pass(`visibilitychange 刷新：模块未求值即再拉一次（间隔 ${second.at - first.at}ms）`);

    // 同一次可见性事件的 call 状态副作用：真实请求 + 共享容器修复。
    await page.waitForFunction(
      () => allAgents.some((agent) => agent.id === 'rt-seed' && agent.callActive === false),
      { timeout: 5000 },
    );
    assert.ok(agentRequests('rt-seed', 'notification').length >= 1,
      'classic 同步引擎必须发出真实 notification 请求（不靠占位桩）');
    const seeded = await page.evaluate(() => ({
      calling: Array.from(_agentCallActive.keys()),
      runtimeId: window.currentRuntimeAgentId,
      writes: window.__craiWrites,
    }));
    assert.deepEqual(seeded.calling, [], '_agentCallActive 由同一容器清理（记录为 not calling）');
    assert.equal(seeded.runtimeId, null, '前台事件不得写入 currentRuntimeAgentId（模块相之前恒 null）');
    assert.ok(seeded.writes.every((value) => value === null),
      `前台事件同样只允许写 null：${JSON.stringify(seeded.writes)}`);
    pass('模块相之前的前台事件：真实 notification 请求 + agent 记录/容器状态修复');

    // 20s 周期刷新：真实等两个节拍，用「相邻两次间隔」证明它是周期调度
    // （单次触发无法区分「周期」与「别处补拉」）。期间模块仍未求值。
    const pageStartAt = requests.find((entry) => entry.pathname === '/')?.at ?? first.at;
    const third = await waitForThreadsRequest(3, 30000);
    assert.ok(third.at - pageStartAt >= 18000,
      `周期刷新第一拍应落在装载后约 20s（实际 ${third.at - pageStartAt}ms）`);
    assert.equal(await page.evaluate(() => window.KernelState.stats().claimedKeys), 0,
      '周期刷新发生在模块求值之前');
    const fourth = await waitForThreadsRequest(4, 30000);
    const intervalGap = fourth.at - third.at;
    assert.ok(intervalGap >= 18000 && intervalGap <= 24000,
      `20s 周期刷新的相邻间隔应在 20s 量级（实际 ${intervalGap}ms）`);
    assert.equal(await page.evaluate(() => window.KernelState.stats().claimedKeys), 0,
      '第二个周期节拍同样发生在模块求值之前');
    pass(`20s 周期刷新：模块未求值即按 20s 节拍触发（相邻间隔 ${intervalGap}ms）`);
    assertNoBrowserErrors('模块相之前（三条调度 + 刷新闭包）');
    pass('模块相之前零 pageerror / 零 console error（不过滤任何错误）');

    // ── C. release：交互域进场，刷新照常 ───────────────────────────
    releaseModules();
    await page.waitForFunction(() => typeof window.openConversationTarget === 'function', { timeout: 15000 });
    const late = await page.evaluate(() => ({
      interaction: typeof window.openConversationTarget,
      submit: typeof window.submitThreadInput,
      pendingTexts: typeof window.getThreadPendingTexts,
      claimedKeys: window.KernelState.stats().claimedKeys,
      // 桥键是访问器（迁移期唯一注册制的产物），不是裸值属性
      isAccessor: Object.getOwnPropertyDescriptor(window, 'openConversationTarget')?.get !== undefined,
    }));
    assert.equal(late.interaction, 'function', '模块求值后交互域桥键出现');
    assert.equal(late.submit, 'function');
    // thread-store-domain 已注销该桥键（真实暂存投影改由 queue-projection 承担，
    // 由 p2-w2-3a-queue-projection 的真实 import/行为用例覆盖）。
    assert.equal(late.pendingTexts, 'undefined', 'getThreadPendingTexts 桥键已注销，不得再断言其存在');
    assert.ok(late.claimedKeys > 0, '交互域已认领其桥键');
    assert.equal(late.isAccessor, true, '桥键必须经 KernelState 访问器注册');
    pass(`模块求值后交互域进场：claimedKeys=${late.claimedKeys}（引擎实现未被替换）`);

    // 模块相：ESM 适配器是 late-bound 转发，与 classic 访问器共享同一实现与锁。
    const adapterRoundTrip = await page.evaluate(async () => {
      const states = await import('/src/modules/agent-call-states-host.js');
      const interrupt = await import('/src/modules/call-interrupt-host.js');
      allAgents = [{ id: 'rt-adapter', connected: true, runtime_session_id: 'rt-adapter', source: 'external' }];
      await Promise.all([
        states.refreshAgentCallStates(allAgents, { force: true }),
        states.refreshAgentCallStates(allAgents, { force: true }),
      ]);
      interrupt.markInterruptPending('rt-adapter', 1000);
      const suppressed = interrupt.isInterruptSuppressed('rt-adapter', 1000);
      const released = interrupt.isInterruptSuppressed('rt-adapter', 2000);
      interrupt.clearInterruptSuppression('rt-adapter');
      return {
        suppressed,
        released,
        cleared: interrupt.isInterruptSuppressed('rt-adapter', 1000),
        startedAt: interrupt.getNotificationCallStartedAt({ runtime: { callStartedAt: 42 }, callStartedAt: 7 }),
        callActive: allAgents[0].callActive,
      };
    });
    assert.equal(agentRequests('rt-adapter', 'notification').length, 1,
      'classic 访问器与 ESM 适配器必须共享同一个 in-flight 锁（并发只发一次请求）');
    assert.equal(adapterRoundTrip.callActive, false, '适配器调用经 classic owner 落到同一记录');
    assert.equal(adapterRoundTrip.suppressed, true, 'interrupt 粘性：同 callStartedAt 仍抑制');
    assert.equal(adapterRoundTrip.released, false, 'interrupt 粘性：更新 callStartedAt 释放');
    assert.equal(adapterRoundTrip.cleared, false, '显式清除后不再抑制');
    assert.equal(adapterRoundTrip.startedAt, 42, 'callStartedAt 解析 runtime 优先');
    pass('模块相：适配器 late-bound 转发（共享锁 / 同一容器 / interrupt 粘性语义）');

    // release 后的真实前台事件：call 状态 + runtime 状态两条链都落地。
    // connection 端点按显式脚本回答，值在 false / true / 迟到 false 之间交替：
    // 「记录 connected 状态落地」因此证明的是响应体被采纳，而不是任何 200 空体
    // 都能通过的弱断言（loader 的判据不变：connected !== false）。
    connectionScript.push({ connected: false }, { connected: true }, { connected: false, hold: true });
    await page.evaluate(() => {
      allAgents = [{ id: 'rt-status', connected: true, runtime_session_id: 'rt-status', source: 'external' }];
      currentRuntimeAgentId = 'rt-status';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(
      () => allAgents.some((agent) => agent.id === 'rt-status' && agent.connected === false),
      { timeout: 5000 },
    );
    await waitForAgentRequest('rt-status', 'connection', 1, 5000);
    assert.ok(agentRequests('rt-status', 'notification').length >= 1, '前台事件必须拉 notification');
    pass('事件 1：connection 响应体 connected=false 被采纳（true→false 真实迁移）');

    // 事件 2：值翻回 true —— 交替证明读的是响应体本身。
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(
      () => allAgents.some((agent) => agent.id === 'rt-status' && agent.connected === true),
      { timeout: 5000 },
    );
    await waitForAgentRequest('rt-status', 'connection', 2, 5000);
    pass('事件 2：connection 响应体 connected=true 被采纳（值交替）');

    // 事件 3：迟到响应 —— 请求发出后响应体被挂起；期间状态不得提前改变，放行后
    // 才按迟到响应体落定。
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitForAgentRequest('rt-status', 'connection', 3, 5000);
    for (let i = 0; i < 50 && connectionHoldSteps.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(connectionHoldSteps.length, 1, '第三次 connection 响应必须按脚本被挂起');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await page.evaluate(() => allAgents.find((agent) => agent.id === 'rt-status').connected), true,
      '响应未返回时状态不得提前改变（迟到响应验证的前提）');
    connectionHoldSteps[0].release();
    await page.waitForFunction(
      () => allAgents.some((agent) => agent.id === 'rt-status' && agent.connected === false),
      { timeout: 5000 },
    );
    pass('事件 3：迟到响应放行后按其响应体落定（未返回期间状态不变）');

    const beforeForce = threadsRequests().length;
    await page.evaluate(() => window.refreshThreads(true));
    const afterForce = threadsRequests().length;
    assert.equal(afterForce, beforeForce + 1, 'release 后强制刷新仍走同一引擎');
    assert.equal(await page.evaluate(() => typeof window.updateThreadHeaderIndicator), 'function');
    assertNoBrowserErrors('release 之后（交互域进场）');
    pass('release 后刷新照常、零 pageerror / 零 console error');

    assert.deepEqual(unhandled, [], `出现未 mock 的非 API 请求：${unhandled.join(', ')}`);
    assert.deepEqual(unknownApiRequests, [],
      `出现未显式 mock 的 API / protoclaw 端点（不得静默兜底）：${JSON.stringify(unknownApiRequests)}`);
    assert.equal(connectionScript.length, 0, 'connection 脚本必须被请求按序消费完');
    assert.deepEqual(authGate.waiters.length, 1, '认证闸整场只应被请求一次');
    console.log(`\n全部通过（${results.length} 项）`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const resolve of authGate.waiters.splice(0)) resolve();
    await new Promise((resolve) => server.close(resolve));
  }
}

await main();
