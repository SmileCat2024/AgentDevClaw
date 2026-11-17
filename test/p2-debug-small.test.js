/**
 * P2「debug」批次 —— debug-logs 与 debug-preflight / debug-mcp 的真实装载面与兼容面。
 *
 * P4 T2 渲染层批次把 debug-logs 转为 ESM（首屏渲染已在模块相由 boot.js 触发，
 * rail 按钮与它也同相或更晚，classic 相同步可用性不再是转换阻碍）：
 *   - debug-logs 走**真实 ESM import**（c.load）：入口收敛为命名导出，仍有
 *     classic 消费方的三个入口（renderLogsPanel / loadLogs / safePrettyJson）
 *     经 KernelState 访问器服务 classic 裸标识符；
 *   - debug-preflight / debug-mcp 走**真实 ESM import**（c.load），落到同一个
 *     window / 同一个 KernelState 上（debug-mcp 的 safePrettyJson 取用面即
 *     debug-logs 的桥键）。
 *
 * 钉住五件事：
 *   1. 接口面：debug-logs 的三个跨文件入口是命名导出 + 桥键（classic 裸标识符
 *      经访问器解析到同一实现）；零跨文件消费的 helper 一律模块私有。
 *   2. 桥语义：claim 后 classic 写方经 impl.set 转发，不反向改写 ESM 导出。
 *   3. 原行为：日志全量渲染 / 筛选 / JSON 展开 / 渲染上限截断 / 增量 prepend /
 *      DOM 条目封顶 / 网络失败清空；MCP 面板与取数三态；预检状态生命周期
 *      （装载不取数 → 首渲染触发 → 失败展示错误 → 动作重试成功）。
 *   4. 状态所有权：日志快照仍由 app-core 的 classic setCurrentLogs 写入（唯一
 *      实现）；用例经 debugPanel（生产宿主工厂）读写同一份状态，不复制状态。
 *   5. 时相（R4）：debug-logs 的 .logf-list scroll 监听在模块求值期安装（原
 *      classic 加载相），幂等标记保留；监听器只在用户滚动时触发，两相等价。
 *
 * 断言口径（如实）：
 *   - 日志状态是 app-core 顶层 let，经 debugPanel 成对读写（生产同名路径）；
 *     用例不另造状态、不复制 host。
 *   - 面板重绘计数来自 ClawPanels 注册表中的假 'logs' 面板：renderFeaturePanel
 *     走真实编排实现，每个用例按需读计数（与迁移前 installRenderFeaturePanelStub
 *     的观测口径一致，但不再替换生产函数）。
 *   - debug-preflight 的 PREFLIGHT_STATE 等是模块私有，预检的「装载后未取数 /
 *     loading 已结束 / data 为空 / 失败后展示错误」经公开渲染面 + 网络观测点验证。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const DEBUG_LOGS = 'public/src/modules/debug-logs.js';
const DEBUG_MCP = 'public/src/modules/debug-mcp.js';
const DEBUG_PREFLIGHT = 'public/src/modules/debug-preflight.js';
const DEBUG_PANEL_HOST = 'public/src/modules/p2-bootstrap-debug-panel.js';
const ORCHESTRATION_STATE = 'public/src/modules/orchestration-state.js';
const RENDER_ENTRY_STATE = 'public/src/modules/render-entry-state.js';

/** vendor 桩：markdown-utils 在求值期需要 Renderer 与 setOptions。 */
const markedStub = { Renderer, setOptions() {} };

// ── 受控 DOM：stable 节点 + 可观测的 scroll 绑定与面板挂载模型 ──────────────

function createNode(extra = {}) {
  const classes = new Set();
  return {
    dataset: {},
    style: {},
    innerHTML: '',
    textContent: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    insertAdjacentHTML() {},
    addEventListener() {},
    removeEventListener() {},
    remove() {},
    ...extra,
  };
}

/** 日志列表节点：记录增量插入并模拟 DOM 条目封顶。 */
function createListNode(entryCount = 0) {
  const entries = Array.from({ length: entryCount }, () => ({
    remove() {
      const index = entries.indexOf(this);
      if (index >= 0) entries.splice(index, 1);
    },
  }));
  return createNode({
    inserted: [],
    insertAdjacentHTML(position, html) { this.inserted.push({ position, html }); },
    querySelectorAll() { return entries; },
    entryCount() { return entries.length; },
  });
}

/** 面板容器节点（scroll 监听在 rAF 里按 .feature-panel 找它）。 */
function createPanelShell() {
  return createNode();
}

/**
 * feature-panel-body 的可控替身：`mount(html)` 模拟 debug-panel-host 把面板
 * HTML 写入 body 之后内部查询能命中 .logf-list / .logf-stats；
 * `fireScroll(target)` 把捕获到的 capture 监听还原成一次真实 scroll 事件。
 */
function createPanelBody() {
  const scrollListeners = [];
  const body = createNode({
    scrollListeners,
    listNode: null,
    statsNode: null,
    mount(html) {
      this.innerHTML = html;
      this.listNode = html.includes('logf-list') ? createListNode(0) : null;
      this.statsNode = { innerHTML: '' };
      return html;
    },
    children: [],
    querySelector(selector) {
      if (selector === '.logf-list') return this.listNode;
      if (selector === '.logf-stats') return this.statsNode;
      return null;
    },
    fireScroll(target) {
      // 只驱动 capture 相（logs 的 .logf-list 监听）；debug-panel-host 的
      // 冒泡相监听读的是 body 自身 scrollTop，与本用例无关。
      for (const { handler, capture } of scrollListeners) {
        if (capture === true) handler({ target });
      }
    },
  });
  body.addEventListener = (kind, handler, capture) => { scrollListeners.push({ kind, handler, capture }); };
  return body;
}

/**
 * 最小 document：getElementById 返回 stable 节点（DOM 引用在 app-core 装载期
 * 被捕获，必须跨查询同一对象），`feature-panel-body` 交给调用方控制。
 */
function createDocumentStub(panelBody) {
  const nodes = new Map();
  return {
    body: createNode(),
    head: createNode(),
    documentElement: createNode(),
    readyState: 'complete',
    getElementById(id) {
      if (id === 'feature-panel-body' && panelBody) return panelBody;
      if (!nodes.has(id)) nodes.set(id, createNode({ id }));
      return nodes.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return createNode(); },
    createTextNode(text) { return { textContent: text }; },
    addEventListener() {},
    removeEventListener() {},
  };
}

// ── classic 相：真实加载序（debug-logs 已迁 ESM，不在其中）─────────────────

/**
 * classic 链：action-dispatcher → i18n → app-core → session-view-state →
 * 右栏注册表。与生产 index.html 的顺序一致；debug-logs
 * 及同批面板宿主在 ESM 图里装载（见 loadDebugBatch）。
 */
function loadClassicChain(sandbox, { beforeLogs } = {}) {
  sandbox.marked = markedStub;
  sandbox.window.marked = markedStub;
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  sandbox.loadSource('public/src/app-core.js');
  sandbox.loadSource('public/src/modules/session-view-state.js');
  sandbox.loadSource('public/src/modules/right-panel-registry.js');
  // 插件宿主最小面（生产实现是 classic claw-host）：debug-panel-host 只在存在时
  // 订阅面板摘除 / 插件落定，这里给出可调用的宿主以免订阅路径落空。
  sandbox.window.ClawHost = {
    panels: {
      map: new Map(),
      register(id, panel) { this.map.set(id, panel); },
      get(id) { return this.map.get(id) ?? null; },
      getAll() { return [...this.map.values()]; },
      getAvailable() { return [...this.map.values()]; },
      has(id) { return this.map.has(id); },
      unregister(id) { this.map.delete(id); },
    },
    setPanelTeardownHook() {},
    onPluginLoadSettled() {},
    getPluginLoadState() { return 'loaded'; },
    ensurePlugin() {},
  };
  if (typeof beforeLogs === 'function') beforeLogs(sandbox);
}

/**
 * 面板重绘观测：注册一个假 'logs' 面板，renderFeaturePanel（真实编排实现）
 * 每次渲染都经它记账。与迁移前替换 renderFeaturePanel 的观测口径等价。
 */
function installLogsPanelProbe(sandbox, calls) {
  sandbox.ClawHost.panels.register('logs', {
    id: 'logs',
    render: () => {
      calls.push('render');
      return '<div class="log-panel-probe"></div>';
    },
  });
  return () => sandbox.ClawHost.panels.unregister('logs');
}

/**
 * 面板重绘观测点（mcp / preflight 用例）：这两条路径经 window.renderFeaturePanel
 * 转调，桥访问器的 setter 落回域状态，故窗口写方即可记账——与迁移前替换生产
 * 函数的观测口径一致。
 */
function installRenderFeaturePanelProbe(c, calls) {
  c.window.renderFeaturePanel = () => { calls.push('render'); };
}

/** debug 面板族的 ESM 装载：debug-logs 及其同批宿主（面板重绘走真实实现）。 */
async function loadDebugBatch(c) {
  return c.load(DEBUG_LOGS);
}

function createFetchStub() {
  const calls = [];
  let responder = () => ({ ok: true, status: 200, json: async () => ({}) });
  const stub = async (url, options) => {
    calls.push({ url: String(url), options });
    return responder(String(url), options);
  };
  stub.calls = calls;
  stub.setResponder = (fn) => { responder = fn; };
  return stub;
}

/** 控制台噪音捕获：装载链的意义是"顶层无未定义引用"，非预期输出即失败。 */
function captureConsoleNoise(allowed = []) {
  const entries = [];
  const original = { warn: console.warn, error: console.error };
  const record = (level) => (...args) => {
    entries.push(`${level}: ${args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ')}`);
  };
  console.warn = record('warn');
  console.error = record('error');
  return {
    entries,
    restore() {
      console.warn = original.warn;
      console.error = original.error;
    },
    assertClean(label) {
      const unexpected = entries.filter((line) => !allowed.some((pattern) => pattern.test(line)));
      assert.deepEqual(unexpected, [], `${label} 不得出现非预期 warn/error 输出：\n${unexpected.join('\n')}`);
    },
  };
}

async function withNoiseClean(label, fn, allowed = []) {
  const noise = captureConsoleNoise(allowed);
  try {
    const result = await fn(noise);
    noise.assertClean(label);
    return result;
  } finally {
    noise.restore();
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 一套 case 环境：受控面板 + 受控 document + 网络桩。
 * classic 链（含 debug-logs）在 ESM 图之前同步跑完——这就是生产 classic 相。
 */
function createCaseEnv({ beforeLogs } = {}) {
  const panelBody = createPanelBody();
  const document = createDocumentStub(panelBody);
  const fetchStub = createFetchStub();
  const renderCalls = [];
  return {
    panelBody,
    fetchStub,
    renderCalls,
    options: {
      classic: (sandbox) => {
        loadClassicChain(sandbox, { beforeLogs });
        installLogsPanelProbe(sandbox, renderCalls);
      },
      globals: { document, fetch: fetchStub, URLSearchParams },
    },
  };
}

/** 日志快照写入（生产同名路径：app-core 的 classic let，经 debugPanel 成对读写）。 */
function seedLogs(debugPanel, logs, truncation = null) {
  debugPanel.currentLogs = logs;
  debugPanel.currentLogsTruncation = truncation;
}

// ── 1. 早期入口（S-1 回归）─────────────────────────────────────────────

describe('debug 批次：模块求值相与 classic 消费方可达性', () => {
  it('模块求值后：命名导出与桥键同源，classic 裸标识符解析到同一实现', async () => {
    await withNoiseClean('模块相入口', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        // 模块求值前：debug 桥键一律不存在（deferred ESM 相才有）。
        for (const name of ['renderLogsPanel', 'loadLogs', 'safePrettyJson',
          'renderMcpPanel', 'renderPreflightPanel']) {
          assert.equal(c.read(`typeof window.${name}`), 'undefined', `${name} 在模块求值前不存在`);
        }

        const logs = await loadDebugBatch(c);

        // 三个跨文件入口：命名导出是调用方入口，classic 消费方经访问器读同一实现。
        for (const name of ['renderLogsPanel', 'loadLogs', 'safePrettyJson']) {
          assert.equal(typeof logs[name], 'function', `必须导出 ${name}`);
          const descriptor = Object.getOwnPropertyDescriptor(c.window, name);
          assert.equal(descriptor?.get !== undefined, true, `${name} 必须经 KernelState 访问器提供`);
          assert.equal(c.read(`typeof ${name}`), 'function');
          assert.equal(c.window[name], logs[name], `${name} 的窗口面与命名导出同一实现`);
        }

        // 面板注册闭包（app-ui registerFeaturePanel('logs').render）在浏览器里就是
        // 这条路径：裸标识符 → 访问器 → 同一个渲染实现。
        const html = c.read('renderLogsPanel()');
        assert.match(html, /class="log-panel"/);
        assert.match(html, /data-filter-key="level"/);
        assert.match(html, /feature-panel-empty/, '空数据集落空态（与迁移前同结果）');
        assert.match(html, /debugLogs\.search/, '动作接线在模块求值期已注册');
      });
    });
  });

  it('闭合依赖可达：classic 侧函数与状态键仍在，零跨文件消费的 helper 不上窗口', async () => {
    await withNoiseClean('依赖可达', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        await loadDebugBatch(c);
        // 日志状态 owner 仍是 classic app-core：写入面是 classic 值属性，不是桥。
        const seam = Object.getOwnPropertyDescriptor(c.window, 'setCurrentLogs');
        assert.equal(typeof seam.value, 'function', 'setCurrentLogs 仍是 classic 同步实现');
        assert.equal(seam.get, undefined, 'setCurrentLogs 不得是桥访问器');
        assert.equal(c.read('activeFeaturePanel'), null);
        assert.equal(c.read('logFilters.level'), 'all');

        // 本文件私有化：零跨文件消费的 helper 不再暴露到窗口。
        for (const name of [
          'getLevelWeight', 'formatLogTimestamp', 'getFilteredLogs',
          'buildLogEntryHtml', 'logEntryMatchesFilters', 'markLogsSeen',
        ]) {
          assert.equal(c.read(`typeof ${name}`), 'undefined', `${name} 应保持模块私有`);
        }
      });
    });
  });

  it('面板 onOpen 全链路成功：面板前台 + 无 runtime 身份 → 清空日志并重绘，零错误', async () => {
    await withNoiseClean('onOpen 入口', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        const logs = await loadDebugBatch(c);
        const { debugPanel } = await c.load(DEBUG_PANEL_HOST);
        // 复刻真实点击后的状态：面板已在前台、还没有 runtime 身份。
        c.window.activeFeaturePanel = 'logs';
        seedLogs(debugPanel, LOGS_FIXTURE, { truncated: true, returnedCount: 3, availableCount: 9 });

        // app-ui 的 onOpen 入口就是这一句（classic 裸标识符 → 桥键 → 本模块实现）。
        await c.read('loadLogs(true)');

        assert.equal(debugPanel.currentLogs.length, 0, '无 runtime 身份 → 清空日志');
        assert.equal(debugPanel.currentLogsTruncation, null);
        assert.equal(debugPanel.currentLogsSignature, JSON.stringify({ count: 0, last: null }));
        assert.deepEqual(env.renderCalls, ['render'], '清空后重绘一次（原语义）');
        assert.deepEqual(env.fetchStub.calls, [], '无身份不发请求');
        assert.equal(typeof logs.loadLogs, 'function');
      });
    });
  });
});

// ── 2. 接口面与桥 ─────────────────────────────────────────────────────

describe('debug 批次：接口面与兼容桥', () => {
  it('debug-logs 三入口为命名导出 + 桥键；mcp/preflight 命名导出与其桥键；私有键不上 window', async () => {
    await withNoiseClean('接口面', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        const logs = await loadDebugBatch(c);
        const mcp = await c.load(DEBUG_MCP);
        const preflight = await c.load(DEBUG_PREFLIGHT);

        for (const name of ['renderMcpPanel', 'loadMcpInfo']) {
          assert.equal(typeof mcp[name], 'function', `debug-mcp 缺少导出 ${name}`);
        }
        for (const name of ['renderPreflightPanel', 'loadPreflight']) {
          assert.equal(typeof preflight[name], 'function', `debug-preflight 缺少导出 ${name}`);
        }

        // debug-logs 的三个跨文件入口：命名导出 + KernelState 访问器（同一实现）。
        for (const name of ['renderLogsPanel', 'loadLogs', 'safePrettyJson']) {
          assert.equal(typeof logs[name], 'function', `debug-logs 缺少导出 ${name}`);
          const descriptor = Object.getOwnPropertyDescriptor(c.window, name);
          assert.equal(typeof descriptor?.get, 'function', `${name} 必须经 KernelState 访问器提供`);
          assert.equal(c.window[name], logs[name], `${name} 的窗口面与命名导出同一实现`);
          assert.equal(c.read(`typeof ${name}`), 'function');
        }
        // safePrettyJson 单份实现：debug-logs 即 debug-mcp 的取用出处。
        assert.equal(c.window.safePrettyJson({ a: 1 }), '{\n  "a": 1\n}');
        assert.equal(c.window.safePrettyJson(undefined), undefined);
        const cyclic = {};
        cyclic.self = cyclic;
        assert.equal(c.window.safePrettyJson(cyclic), '[object Object]', '不可序列化时回落 String(value)');

        // mcp / preflight 仍服务 classic 消费方的桥键：访问器 → claim → 模块导出。
        assert.equal(c.window.renderMcpPanel, mcp.renderMcpPanel);
        assert.equal(c.window.loadMcpInfo, mcp.loadMcpInfo);
        assert.equal(c.window.renderPreflightPanel, preflight.renderPreflightPanel);
        assert.equal(c.read('renderMcpPanel') === mcp.renderMcpPanel, true);
        // loadPreflight 零消费 → 不上桥（不为测试保留生产桥）。
        assert.equal('loadPreflight' in c.window, false, 'loadPreflight 不得挂 window');
        assert.equal(c.read('typeof loadPreflight'), 'undefined');

        // 零跨文件消费的 helper 与状态收敛为模块私有。
        for (const key of [
          'setCurrentMcpInfo', 'renderMcpItems',
          'renderPreflightStatusPill', 'PREFLIGHT_STATE', 'CHECK_LABELS',
          'getLevelWeight', 'formatLogTimestamp', 'getFilteredLogs', 'logEntryMatchesFilters',
        ]) {
          assert.equal(key in c.window, false, `${key} 不应再挂在 window 上`);
        }
      });
    });
  });

  it('claim 后 classic 写方经 impl.set 转发，且不反向改写 ESM 导出', async () => {
    await withNoiseClean('桥语义', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        const logs = await loadDebugBatch(c);
        const mcp = await c.load(DEBUG_MCP);
        const original = mcp.loadMcpInfo;
        const replacement = () => 'replaced';
        c.window.loadMcpInfo = replacement;              // classic 写方 → setter
        assert.equal(c.read('loadMcpInfo'), replacement); // 读回写入值（双向转发）
        assert.equal(c.window.loadMcpInfo(), 'replaced');
        assert.equal(mcp.loadMcpInfo, original, 'ESM 导出不被 classic 写方改写');
        c.window.loadMcpInfo = original;                  // 还原后读回原引用
        assert.equal(c.read('loadMcpInfo'), original);

        // debug-logs 的同一语义：窗口写方落回域状态，命名导出不变。
        const logsReplacement = () => '<div>replaced</div>';
        c.window.renderLogsPanel = logsReplacement;
        assert.equal(c.read('renderLogsPanel()'), '<div>replaced</div>');
        assert.equal(logs.renderLogsPanel !== logsReplacement, true, '命名导出保持自身实现');
        c.window.renderLogsPanel = logs.renderLogsPanel;
        assert.equal(c.read('renderLogsPanel()'), logs.renderLogsPanel());
      });
    });
  });
});

// ── 3. 时相：scroll 监听随模块求值安装（原 classic 加载相）─────────────

describe('debug 批次：debug-logs 的 scroll 监听时相（R4）', () => {
  it('模块求值期安装（原 classic 加载相），滚动 → rAF → scrollable 翻转', async () => {
    await withNoiseClean('scroll 监听', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        const panelBody = env.panelBody;
        assert.equal(panelBody.scrollListeners.length, 0, '模块求值前未安装');
        await loadDebugBatch(c);
        // 模块求值即安装：logs 用 capture 捕获相（.logf-list 内部滚动），只有一次；
        // 同批 debug-panel-host 另有一条冒泡相监听（顶部渐隐），按 capture 区分。
        const logsListeners = panelBody.scrollListeners.filter((entry) => entry.capture === true);
        assert.equal(logsListeners.length, 1, '模块求值期安装 logs 的 capture 监听');
        assert.equal(logsListeners[0].kind, 'scroll');
        assert.equal(panelBody.dataset.logScrollBound, '1', '幂等标记保留');

        // 非 .logf-list 的滚动目标被忽略
        const panel = createPanelShell();
        panel.classList.add('feature-panel');
        panelBody.fireScroll(createNode());
        await tick();
        assert.equal(panel.classList.contains('scrollable'), false);

        // .logf-list 滚动：距底超过 48px → scrollable（底部渐隐）
        const list = createNode({
          scrollTop: 0,
          clientHeight: 100,
          scrollHeight: 1000,
          closest(selector) { return selector === '.feature-panel' ? panel : null; },
        });
        list.classList.add('logf-list');
        panelBody.fireScroll(list);
        await tick();
        assert.equal(panel.classList.contains('scrollable'), true);

        // 回到近底 → 取消 scrollable
        list.scrollTop = 950;
        panelBody.fireScroll(list);
        await tick();
        assert.equal(panel.classList.contains('scrollable'), false);
      });
    });
  });

  it('重复装载语义：已绑定的面板不再装第二个监听', async () => {
    await withNoiseClean('scroll 监听幂等', async () => {
      // 模拟此前已由同一面板绑定过：模块求值期读到的就是幂等标记。
      const env = createCaseEnv({ beforeLogs: (sandbox) => { sandbox.window.document.getElementById('feature-panel-body').dataset.logScrollBound = '1'; } });
      await withP2EsmCase(env.options, async (c) => {
        await loadDebugBatch(c);
        assert.equal(env.panelBody.scrollListeners.filter((entry) => entry.capture === true).length, 0);
      });
    });
  });
});

// ── 4. debug-logs 原行为 ──────────────────────────────────────────────

const LOGS_FIXTURE = [
  { id: 1, level: 'info', namespace: 'agent', message: 'first', timestamp: 1700000000000, context: { feature: 'shell' } },
  { id: 2, level: 'error', namespace: 'agent', message: 'boom & <x>', timestamp: 1700000001000, context: { feature: 'shell', callIndex: 2, step: 1 } },
  { id: 3, level: 'warn', namespace: 'viewer', message: 'careful', timestamp: 1700000002000, context: { feature: 'todo', lifecycle: 'onCall' } },
];

describe('debug 批次：debug-logs 渲染与加载语义', () => {
  it('全量渲染：统计徽标、筛选选项、条目转义、轮次徽标与截断横幅', async () => {
    await withNoiseClean('debug-logs 全量渲染', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        const logs = await loadDebugBatch(c);
        const { debugPanel } = await c.load(DEBUG_PANEL_HOST);
        seedLogs(debugPanel, LOGS_FIXTURE, { truncated: true, returnedCount: 3, availableCount: 9 });
        const html = logs.renderLogsPanel();

        assert.match(html, /class="logf-count">3 /);
        assert.match(html, /1 error/);
        assert.match(html, /1 warn/);
        // 条目按时间倒序（最新在前）
        assert.ok(html.indexOf('careful') < html.indexOf('boom &amp; &lt;x&gt;'));
        // 转义真实生效（生产 escapeHtml），轮次徽标进首行
        assert.equal(html.includes('boom & <x>'), false);
        assert.match(html, /class="logf-round"[^>]*>R2\.1</);
        // 筛选项来自当前数据集
        assert.match(html, /data-filter-key="feature"/);
        assert.match(html, /<option value="shell"/);
        assert.match(html, /<option value="todo"/);
        assert.match(html, /data-filter-key="lifecycle"/);
        assert.match(html, /<option value="onCall"/);
        assert.match(html, /data-filter-key="call"/);
        assert.match(html, /<option value="2"/);
        // 截断横幅
        assert.match(html, /class="logf-truncated"/);
      });
    });
  });

  it('筛选语义：level 阈值 / feature / call / 搜索命中与空态', async () => {
    await withNoiseClean('debug-logs 筛选', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        const logs = await loadDebugBatch(c);
        const { debugPanel } = await c.load(DEBUG_PANEL_HOST);
        seedLogs(debugPanel, LOGS_FIXTURE);

        // logFilters 是 app-core 的 classic 对象（app-ui 的 updateLogFilter 就按字段赋值）。
        c.read("logFilters.level = 'error'");
        assert.equal(logs.renderLogsPanel().includes('boom'), true);
        assert.equal(logs.renderLogsPanel().includes('careful'), false, 'warn 低于 error 阈值');

        c.read("logFilters.level = 'all'; logFilters.feature = 'todo'");
        assert.equal(logs.renderLogsPanel().includes('careful'), true);
        assert.equal(logs.renderLogsPanel().includes('boom'), false);

        c.read("logFilters.feature = 'all'; logFilters.call = '2'");
        assert.equal(logs.renderLogsPanel().includes('boom'), true);
        assert.equal(logs.renderLogsPanel().includes('first'), false);

        c.read("logFilters.call = 'all'; logFilters.search = 'VIEWER'");
        const searched = logs.renderLogsPanel();
        assert.equal(searched.includes('careful'), true, '搜索跨 namespace 命中且大小写不敏感');
        assert.equal(searched.includes('boom'), false);

        // 筛选后无命中 → 空态
        c.read("logFilters.search = 'no-such-log'");
        assert.match(logs.renderLogsPanel(), /feature-panel-empty/);
      });
    });
  });

  it('JSON 展开状态、渲染上限截断、增量 prepend 与 DOM 条目封顶', async () => {
    await withNoiseClean('debug-logs JSON 与封顶', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        const logs = await loadDebugBatch(c);
        // 日志写入入口是 classic app-core 的 setCurrentLogs（唯一实现），
        // 与生产 loadLogs / 面板渲染同一条路径。
        const { debugPanel } = await c.load(DEBUG_PANEL_HOST);
        const { setActiveFeaturePanel } = await c.load(RENDER_ENTRY_STATE);
        const orchestration = await c.load(ORCHESTRATION_STATE);

        const bigPayload = 'x'.repeat(5000);
        setActiveFeaturePanel('logs');
        orchestration.setCurrentRuntimeAgentId({ id: 'runtime-head', source: 'child' });
        c.read(`setCurrentLogs(${JSON.stringify([
          { id: 7, level: 'info', namespace: 'agent', message: 'with data', timestamp: 1700000000000, data: { payload: bigPayload } },
        ])})`);

        const html = logs.renderLogsPanel();
        // 单条结构化数据渲染上限：截断并给出原始长度提示
        assert.match(html, /… /);
        assert.equal(html.includes(bigPayload), false, '超限 JSON 不得整段落进 DOM');
        assert.match(html, /class="logf-entry has-data/);
        assert.match(html, /data-action="debugLogs.toggleJson" data-entry-id="7"/);

        // 展开状态按日志 id 保持：动作 → class 切换 → 重渲染仍是 json-open
        const entry = createNode();
        const actionEl = { dataset: { entryId: '7' }, closest: () => entry };
        c.window.ClawFW.actions.invoke('debugLogs.toggleJson', actionEl);
        assert.equal(entry.classList.contains('json-open'), true);
        assert.match(logs.renderLogsPanel(), /class="logf-entry has-data json-open/);
        c.window.ClawFW.actions.invoke('debugLogs.toggleJson', actionEl);
        assert.equal(entry.classList.contains('json-open'), false);

        // 增量 prepend：全量渲染标记已见 → 面板已挂载 → 新条目只 prepend，老条目不动
        env.panelBody.mount(html);
        env.panelBody.listNode = createListNode(262); // 已积累超过 LOG_DOM_CAP 的条目
        const nextLogs = [
          ...debugPanel.currentLogs,
          { id: 8, level: 'info', namespace: 'agent', message: 'streamed', timestamp: 1700000001000 },
        ];
        env.fetchStub.setResponder(() => ({ ok: true, status: 200, json: async () => ({ logs: nextLogs }) }));
        await logs.loadLogs(true);
        assert.equal(env.fetchStub.calls.length, 1);
        assert.equal(env.fetchStub.calls[0].url, '/api/logs?scope=current&agentId=runtime-head');
        assert.equal(env.panelBody.listNode.inserted.length, 1, '只有新条目被 prepend');
        assert.equal(env.panelBody.listNode.inserted[0].position, 'afterbegin');
        assert.match(env.panelBody.listNode.inserted[0].html, /streamed/);
        assert.equal(env.panelBody.listNode.entryCount(), 260, 'DOM 条目数按 LOG_DOM_CAP 封顶');
        assert.deepEqual(env.renderCalls, [], '增量路径不触发全量重绘');
        assert.match(env.panelBody.statsNode.innerHTML, /class="logf-count">2 /);
      });
    });
  });

  it('网络失败语义：forceRender 且面板在前台时清空并重绘；无 runtime 身份时不发请求', async () => {
    await withNoiseClean('debug-logs 网络失败', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        const logs = await loadDebugBatch(c);
        const { debugPanel } = await c.load(DEBUG_PANEL_HOST);
        const { setActiveFeaturePanel } = await c.load(RENDER_ENTRY_STATE);
        const orchestration = await c.load(ORCHESTRATION_STATE);

        // 无 runtime 身份：不发请求，前台面板直接清空重绘
        setActiveFeaturePanel('logs');
        seedLogs(debugPanel, LOGS_FIXTURE, { truncated: true, returnedCount: 1, availableCount: 2 });
        orchestration.setCurrentRuntimeAgentId(null);
        await logs.loadLogs(true);
        assert.deepEqual(env.fetchStub.calls, []);
        assert.equal(debugPanel.currentLogs.length, 0);
        assert.equal(debugPanel.currentLogsTruncation, null);
        assert.deepEqual(env.renderCalls, ['render']);

        // 有身份但请求失败（HTTP 500）：原语义抛错并在前台清空重绘
        orchestration.setCurrentRuntimeAgentId({ id: 'runtime-head', source: 'child' });
        seedLogs(debugPanel, LOGS_FIXTURE);
        env.renderCalls.length = 0;
        env.fetchStub.setResponder(() => ({ ok: false, status: 500, json: async () => ({}) }));
        await logs.loadLogs(true);
        assert.equal(env.fetchStub.calls.length, 1);
        assert.equal(debugPanel.currentLogs.length, 0);
        assert.deepEqual(env.renderCalls, ['render']);

        // 非 forceRender 的失败不清空（静默失败交给下一轮轮询）
        seedLogs(debugPanel, LOGS_FIXTURE);
        env.renderCalls.length = 0;
        await logs.loadLogs(false);
        assert.equal(debugPanel.currentLogs.length, LOGS_FIXTURE.length);
        assert.deepEqual(env.renderCalls, []);

        // 面板不在前台：失败同样不清空（原语义只服务当前视图）
        setActiveFeaturePanel(null);
        seedLogs(debugPanel, LOGS_FIXTURE);
        await logs.loadLogs(true);
        assert.equal(debugPanel.currentLogs.length, LOGS_FIXTURE.length);
      });
    });
  });
});

// ── 5. debug-mcp 原行为 ───────────────────────────────────────────────

describe('debug 批次：debug-mcp 渲染与取数语义', () => {
  it('空态、转义、配置 JSON 与三态取数（成功 / 非 2xx / 抛错）', async () => {
    await withNoiseClean('debug-mcp', async (noise) => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        await loadDebugBatch(c); // debug-mcp 的 safePrettyJson 取用面来自 debug-logs 桥键
        installRenderFeaturePanelProbe(c, env.renderCalls);
        const mcp = await c.load(DEBUG_MCP);
        const { debugPanel } = await c.load(DEBUG_PANEL_HOST);
        const { setActiveFeaturePanel } = await c.load(RENDER_ENTRY_STATE);
        const orchestration = await c.load(ORCHESTRATION_STATE);
        orchestration.setCurrentRuntimeAgentId({ id: 'runtime-head', source: 'child' });

        // 未取到信息 → 空态
        assert.match(mcp.renderMcpPanel(), /feature-panel-empty/);

        env.fetchStub.setResponder(() => ({
          ok: true,
          status: 200,
          json: async () => ({
            enabled: true,
            endpoint: 'http://127.0.0.1:9/mcp<x>',
            transport: 'sse',
            tools: [{ name: 'tool_a', description: 'desc & more' }],
            resources: [{ uri: 'res://a' }],
            prompts: [],
            commands: { claudeDesktop: { json: { mcpServers: {} } }, codex: { json: {} }, curlInitialize: 'curl ...' },
          }),
        }));
        await mcp.loadMcpInfo(false);
        assert.equal(env.fetchStub.calls[0].url, '/api/mcp-info?agentId=runtime-head');
        const html = mcp.renderMcpPanel();
        assert.match(html, /mcp-status-pill/);
        assert.equal(html.includes('mcp<x>'), false, 'endpoint 必须转义');
        assert.match(html, /http:\/\/127\.0\.0\.1:9\/mcp&lt;x&gt;/);
        assert.match(html, /desc &amp; more/);
        assert.match(html, /mcpServers/, '配置 JSON 经 classic debug-logs 的 safePrettyJson 渲染');
        assert.match(html, /tool:tool_a|tool_a/);

        // 非 2xx → 清空信息（原语义：不重绘，除非调用方自己触发）
        env.fetchStub.setResponder(() => ({ ok: false, status: 503, json: async () => ({}) }));
        setActiveFeaturePanel('mcp');
        env.renderCalls.length = 0;
        await mcp.loadMcpInfo(true);
        assert.equal(debugPanel.currentMcpInfo, null);
        assert.deepEqual(env.renderCalls, []);
        assert.match(mcp.renderMcpPanel(), /feature-panel-empty/);

        // 网络抛错 → production 诊断 console.error 保留 + forceRender 重绘
        env.fetchStub.setResponder(() => { throw new Error('network down'); });
        env.renderCalls.length = 0;
        await mcp.loadMcpInfo(true);
        assert.deepEqual(env.renderCalls, ['render']);
        assert.equal(
          noise.entries.some((line) => /^error: Failed to load MCP info: network down/.test(line)),
          true,
          '原诊断输出保留',
        );
      });
    }, [/^error: Failed to load MCP info:/]);
  });
});

// ── 6. debug-preflight 状态生命周期 ───────────────────────────────────

describe('debug 批次：debug-preflight 状态生命周期', () => {
  it('装载不取数 → 首渲染落空态并触发取数 → 失败展示错误 → 动作重试成功出结果', async () => {
    await withNoiseClean('debug-preflight', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        await loadDebugBatch(c);
        installRenderFeaturePanelProbe(c, env.renderCalls);
        const preflight = await c.load(DEBUG_PREFLIGHT);
        assert.deepEqual(env.fetchStub.calls, [], '装载模块不得发起预检请求');

        // 首渲染走 classic 消费方的那条路（app-ui registerFeaturePanel 闭包的
        // 裸标识符 → 桥访问器），而不是只调模块导出自证。
        env.fetchStub.setResponder(() => ({ ok: false, status: 0, json: async () => ({}) }));
        const emptyHtml = c.read('renderPreflightPanel()');
        assert.match(emptyHtml, /data-action="debugPreflight\.reload"/);
        assert.match(emptyHtml, /feature-panel-empty/);
        assert.equal(env.fetchStub.calls.length, 1);
        assert.equal(env.fetchStub.calls[0].url, '/protoclaw/preflight');
        assert.equal(env.fetchStub.calls[0].options.method, 'POST');
        assert.equal(env.fetchStub.calls[0].options.headers['content-type'], 'application/json');
        await tick();

        // 失败：错误消息转义后渲染；错误态不再自动重取
        const errorHtml = preflight.renderPreflightPanel();
        assert.match(errorHtml, /preflight 请求失败: HTTP 0/);
        assert.equal(env.fetchStub.calls.length, 1, '错误态渲染不再自动取数');

        // 动作入口（data-action="debugPreflight.reload"）→ forceRender 取数
        env.fetchStub.setResponder(() => ({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            issues: [{ check: 'inject-graph', severity: 'warning', message: 'loop <bad>', features: ['a'] }],
            assembly: {
              order: ['a', 'b'],
              tools: [{ name: 'tool_a', feature: 'a' }],
              hooks: [{ lifecycle: 'onCall', feature: 'a', methodName: 'm', kind: 'hook' }],
            },
          }),
        }));
        env.renderCalls.length = 0;
        const reload = c.window.ClawFW.actions.invoke('debugPreflight.reload');
        assert.equal(typeof reload?.then, 'function', 'async handler 的 promise 原样透传');
        await reload;
        await tick();
        assert.equal(env.fetchStub.calls.length, 2);
        assert.deepEqual(env.renderCalls, ['render', 'render'], 'forceRender 前后各重绘一次');

        const okHtml = preflight.renderPreflightPanel();
        assert.match(okHtml, /项警告/);
        assert.match(okHtml, /loop &lt;bad&gt;/);
        assert.match(okHtml, /dry-run 装配清单/);
        assert.match(okHtml, /tool:tool_a/);
        assert.match(okHtml, /hook:onCall/);
        assert.match(okHtml, /装配序/);
        assert.equal(env.fetchStub.calls.length, 2, '有数据后渲染不再取数');
      });
    });
  });
});
