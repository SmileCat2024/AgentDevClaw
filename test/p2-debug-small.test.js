/**
 * P2「debug」批次 —— debug-logs 保留 classic 唯一实现 / debug-preflight、
 * debug-mcp 迁 ESM 的真实装载面与兼容面。
 *
 * 保留边界（R4，S-1 返修）：debug-logs 整文件保持 classic，因为日志面板的
 * render 入口（renderLogsPanel）与 onOpen 入口（loadLogs）由 app-ui.js 的
 * registerFeaturePanel('logs') 闭包持有，而 rail-logs 在首屏同步链
 * （app-main 顶层 applyLanguage → renderCurrentMainView → syncRailButtons）
 * 就生成并可点——该点击不受认证闸保护，早于 deferred ESM 求值。迁入模块后
 * classic 相点击必抛 ReferenceError（面板空开），故按 todo-plan 先例整文件
 * 保留 classic，等 app-ui 面板注册与 rail 时序联合迁移。
 *
 * 装载路线（withP2EsmCase，每用例一张独立模块图）：
 *   - debug-logs 走**真实 classic 执行**（sandbox.loadSource，与生产
 *     index.html 的标签序一致）——它就是生产里的同步实现，不 import；
 *   - debug-preflight / debug-mcp 走**真实 ESM import**（c.load），落到同一个
 *     window / 同一个 KernelState 上。
 *
 * 钉住五件事：
 *   1. 早期入口（S-1 回归）：classic 链跑完、任何 debug ESM 模块求值之前，
 *      renderLogsPanel 已可调用并渲染出完整面板体，loadLogs 已是 classic 函数
 *      ——「点击早于模块 → ReferenceError」的窗口不存在。
 *   2. 接口面：debug-logs 的入口收敛在 classic 全局（值属性，不经桥）；
 *      mcp / preflight 的命名导出与仍服务 classic 消费方的桥键；零消费的
 *      loadPreflight 不上 window。
 *   3. 桥语义：claim 后 classic 写方经 impl.set 转发，不反向改写 ESM 导出。
 *   4. 原行为：日志全量渲染 / 筛选 / JSON 展开 / 渲染上限截断 / 增量 prepend /
 *      DOM 条目封顶 / 网络失败清空；MCP 面板与取数三态；预检状态生命周期
 *      （装载不取数 → 首渲染触发 → 失败展示错误 → 动作重试成功）。
 *   5. 时相（R4）：debug-logs 的 .logf-list scroll 监听在 **classic 加载相**
 *      安装（原时点，不推迟到模块相），幂等标记保留。
 *
 * 断言口径（如实）：
 *   - 日志状态是 app-core 顶层 let（classic 绑定），用例经 c.read 读写真实绑定
 *     （生产同名路径），不复制状态、不另造 host。
 *   - 日志加载路径的写入口是 app-core 的 classic 同步函数 setCurrentLogs（唯一
 *     实现，currentLogs / currentLogsSignature 的物理 owner）。它不进 ESM 域、不
 *     上桥：日志面板 onOpen 在首屏 classic 相就可点，写入口必须同步可用。因此
 *     loadLogs 的调用方用例无需任何模块装载前置，早期入口用例直接覆盖这条路径。
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

/** vendor 桩：markdown-bootstrap 只在装载期需要 Renderer 与 setOptions。 */
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
    querySelector(selector) {
      if (selector === '.logf-list') return this.listNode;
      if (selector === '.logf-stats') return this.statsNode;
      return null;
    },
    fireScroll(target) {
      for (const { handler } of scrollListeners) handler({ target });
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

// ── classic 相：真实加载序（debug-logs 是其中之一，走真实 classic 执行）──────

/**
 * classic 链：action-dispatcher → i18n → app-core → session-view-state →
 * markdown-bootstrap → debug-logs。与生产 index.html 的顺序一致（debug-logs
 * 紧随 app-core 之后的模块段）。
 */
function loadClassicChain(sandbox, { beforeLogs } = {}) {
  sandbox.marked = markedStub;
  sandbox.window.marked = markedStub;
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  sandbox.loadSource('public/src/app-core.js');
  sandbox.loadSource('public/src/modules/session-view-state.js');
  sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
  if (typeof beforeLogs === 'function') beforeLogs(sandbox);
  sandbox.loadSource(DEBUG_LOGS);
}

/** classic 侧的面板重绘替身（生产由 debug-panel-host 提供）：只记账。 */
function installRenderFeaturePanelStub(sandbox, calls) {
  sandbox.window.renderFeaturePanel = () => { calls.push('render'); };
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
        installRenderFeaturePanelStub(sandbox, renderCalls);
      },
      globals: { document, fetch: fetchStub, URLSearchParams },
    },
  };
}

/** classic 侧状态写入（生产同名路径：app-core 顶层 let / 面板自身渲染管线）。 */
function seedLogs(c, logs, truncation = null) {
  c.read(`currentLogs = ${JSON.stringify(logs)}; currentLogsTruncation = ${JSON.stringify(truncation)};`);
}

// ── 1. 早期入口（S-1 回归）─────────────────────────────────────────────

describe('debug 批次：classic 相早期入口（rail-logs 可点的那一相）', () => {
  it('classic 链完成后、debug ESM 模块求值前：render / load 入口已可用且面板可渲染', async () => {
    await withNoiseClean('早期入口', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        // 这一相就是 app-main 顶层 applyLanguage → syncRailButtons 之后的时点：
        // debug 的 ESM 模块一个都还没求值（桥键缺席）。
        assert.equal(c.read('typeof window.renderMcpPanel'), 'undefined', 'mcp 桥键在模块前不存在');
        assert.equal(c.read('typeof window.renderPreflightPanel'), 'undefined', 'preflight 桥键在模块前不存在');

        // 面板注册闭包（app-ui registerFeaturePanel('logs').render）此时被点击调用：
        // 裸标识符必须是 classic 顶层函数，不是「尚未 defineKey 的 window 键」。
        assert.equal(c.read('typeof renderLogsPanel'), 'function');
        assert.equal(c.read('typeof loadLogs'), 'function');
        const html = c.read('renderLogsPanel()');
        assert.match(html, /class="log-panel"/);
        assert.match(html, /data-filter-key="level"/);
        assert.match(html, /feature-panel-empty/, '空数据集落空态（与 HEAD 同结果）');
        assert.match(html, /debugLogs\.search/, '动作接线在 classic 相已注册');

        // 面板 onOpen 入口同源：函数已就位（不再是 `loadLogs is not defined`）。
        assert.equal(c.read('typeof loadLogs'), 'function');
      });
    });
  });

  it('早期入口的封装目标全部 classic 可达（不依赖模块相桥）', async () => {
    await withNoiseClean('早期入口依赖', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        // renderLogsPanel 的闭合依赖：逐个断言 classic 相已可用。
        for (const name of [
          'getLevelWeight', 'formatLogTimestamp', 'safePrettyJson', 'getFilteredLogs',
          'escapeHtml', 't', 'renderFeaturePanel', 'getRuntimeId', 'logFilters', 'currentLogs',
        ]) {
          assert.equal(c.read(`typeof ${name}`), name === 'logFilters' || name === 'currentLogs' ? 'object' : 'function',
            `早期入口依赖 ${name} 必须在 classic 相已可用`);
        }
        // 日志写入入口（setCurrentLogs）也在 classic 相可用，且是 classic 顶层
        // 函数（值属性），不是模块相才注册的桥访问器。
        const seam = Object.getOwnPropertyDescriptor(c.window, 'setCurrentLogs');
        assert.equal(typeof seam.value, 'function', 'setCurrentLogs 必须在 classic 相已可用');
        assert.equal(seam.get, undefined, 'setCurrentLogs 不得是桥访问器');

        // 状态键（app-core 顶层 let / classic 相注册的访问器）同样已可读写。
        assert.equal(c.read('activeFeaturePanel'), null);
        assert.equal(c.read('logFilters.level'), 'all');
      });
    });
  });

  it('早期 onOpen 全链路成功：面板前台 + 无 runtime 身份 → 清空日志并重绘，零错误', async () => {
    await withNoiseClean('早期 onOpen', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        // 复刻真实早期点击后的状态：面板已在前台、还没有 runtime 身份。
        c.window.activeFeaturePanel = 'logs';
        seedLogs(c, LOGS_FIXTURE, { truncated: true, returnedCount: 3, availableCount: 9 });

        // app-ui 的 onOpen 入口就是这一句（classic 裸标识符 → 自身顶层函数）。
        await c.read('loadLogs(true)');

        assert.equal(c.read('currentLogs.length'), 0, '无 runtime 身份 → 清空日志');
        assert.equal(c.read('currentLogsTruncation'), null);
        assert.equal(c.read('currentLogsSignature'), JSON.stringify({ count: 0, last: null }));
        assert.deepEqual(env.renderCalls, ['render'], '清空后重绘一次（原语义）');
        assert.deepEqual(env.fetchStub.calls, [], '无身份不发请求');
      });
    });
  });
});

// ── 2. 接口面与桥 ─────────────────────────────────────────────────────

describe('debug 批次：接口面与兼容桥', () => {
  it('debug-logs 入口是 classic 值属性；mcp/preflight 命名导出 + 仅剩的桥键；私有键不上 window', async () => {
    await withNoiseClean('接口面', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        const mcp = await c.load(DEBUG_MCP);
        const preflight = await c.load(DEBUG_PREFLIGHT);

        for (const name of ['renderMcpPanel', 'loadMcpInfo']) {
          assert.equal(typeof mcp[name], 'function', `debug-mcp 缺少导出 ${name}`);
        }
        for (const name of ['renderPreflightPanel', 'loadPreflight']) {
          assert.equal(typeof preflight[name], 'function', `debug-preflight 缺少导出 ${name}`);
        }

        // debug-logs 的入口是 classic 顶层函数（window 值属性，不经 KernelState 桥）。
        for (const name of ['renderLogsPanel', 'loadLogs', 'safePrettyJson']) {
          const descriptor = Object.getOwnPropertyDescriptor(c.window, name);
          assert.equal(typeof descriptor.value, 'function', `${name} 必须是 classic 值属性`);
          assert.equal(descriptor.get, undefined, `${name} 不得是桥访问器`);
          assert.equal(c.read(`typeof ${name}`), 'function');
        }
        // safePrettyJson 单份实现：classic 定义方即 debug-mcp 的取用出处。
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
        const mcp = await c.load(DEBUG_MCP);
        const original = mcp.loadMcpInfo;
        const replacement = () => 'replaced';
        c.window.loadMcpInfo = replacement;              // classic 写方 → setter
        assert.equal(c.read('loadMcpInfo'), replacement); // 读回写入值（双向转发）
        assert.equal(c.window.loadMcpInfo(), 'replaced');
        assert.equal(mcp.loadMcpInfo, original, 'ESM 导出不被 classic 写方改写');
        c.window.loadMcpInfo = original;                  // 还原后读回原引用
        assert.equal(c.read('loadMcpInfo'), original);
      });
    });
  });
});

// ── 3. 时相：scroll 监听的原时点（classic 加载相）───────────────────────

describe('debug 批次：debug-logs 的 scroll 监听时相（R4）', () => {
  it('classic 加载相即安装（原时点，不推迟到模块相），滚动 → rAF → scrollable 翻转', async () => {
    await withNoiseClean('scroll 监听', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        const panelBody = env.panelBody;
        // classic 链跑完即已安装：只有一次，passive/capture 语义不变
        assert.equal(panelBody.scrollListeners.length, 1, 'classic 加载相安装监听（HEAD 原时点）');
        assert.equal(panelBody.scrollListeners[0].kind, 'scroll');
        assert.equal(panelBody.scrollListeners[0].capture, true);
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
      // 模拟此前已由同一面板绑定过：classic 加载相读到的就是幂等标记。
      const env = createCaseEnv({ beforeLogs: (sandbox) => { sandbox.window.document.getElementById('feature-panel-body').dataset.logScrollBound = '1'; } });
      await withP2EsmCase(env.options, async () => {
        assert.equal(env.panelBody.scrollListeners.length, 0);
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

describe('debug 批次：debug-logs 渲染与加载语义（classic 实现）', () => {
  it('全量渲染：统计徽标、筛选选项、条目转义、轮次徽标与截断横幅', async () => {
    await withNoiseClean('debug-logs 全量渲染', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        seedLogs(c, LOGS_FIXTURE, { truncated: true, returnedCount: 3, availableCount: 9 });
        const html = c.read('renderLogsPanel()');

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
        seedLogs(c, LOGS_FIXTURE);

        c.read("logFilters.level = 'error'");
        assert.equal(c.read('renderLogsPanel()').includes('boom'), true);
        assert.equal(c.read('renderLogsPanel()').includes('careful'), false, 'warn 低于 error 阈值');

        c.read("logFilters.level = 'all'; logFilters.feature = 'todo'");
        assert.equal(c.read('renderLogsPanel()').includes('careful'), true);
        assert.equal(c.read('renderLogsPanel()').includes('boom'), false);

        c.read("logFilters.feature = 'all'; logFilters.call = '2'");
        assert.equal(c.read('renderLogsPanel()').includes('boom'), true);
        assert.equal(c.read('renderLogsPanel()').includes('first'), false);

        c.read("logFilters.call = 'all'; logFilters.search = 'VIEWER'");
        const searched = c.read('renderLogsPanel()');
        assert.equal(searched.includes('careful'), true, '搜索跨 namespace 命中且大小写不敏感');
        assert.equal(searched.includes('boom'), false);

        // 筛选后无命中 → 空态
        c.read("logFilters.search = 'no-such-log'");
        assert.match(c.read('renderLogsPanel()'), /feature-panel-empty/);
      });
    });
  });

  it('JSON 展开状态、渲染上限截断、增量 prepend 与 DOM 条目封顶', async () => {
    await withNoiseClean('debug-logs JSON 与封顶', async () => {
      const env = createCaseEnv();
      await withP2EsmCase(env.options, async (c) => {
        // 日志写入入口是 classic app-core 的 setCurrentLogs（唯一实现），
        // 与生产 loadLogs / 面板渲染同一条路径，不需要模块装载前置。
        const { debugPanel } = await c.load(DEBUG_PANEL_HOST);
        const { setActiveFeaturePanel } = await c.load(RENDER_ENTRY_STATE);
        const orchestration = await c.load(ORCHESTRATION_STATE);

        const bigPayload = 'x'.repeat(5000);
        setActiveFeaturePanel('logs');
        orchestration.setCurrentRuntimeAgentId({ id: 'runtime-head', source: 'child' });
        c.read(`setCurrentLogs(${JSON.stringify([
          { id: 7, level: 'info', namespace: 'agent', message: 'with data', timestamp: 1700000000000, data: { payload: bigPayload } },
        ])})`);

        const html = c.read('renderLogsPanel()');
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
        assert.match(c.read('renderLogsPanel()'), /class="logf-entry has-data json-open/);
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
        await c.read('loadLogs(true)');
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
        const { debugPanel } = await c.load(DEBUG_PANEL_HOST);
        const { setActiveFeaturePanel } = await c.load(RENDER_ENTRY_STATE);
        const orchestration = await c.load(ORCHESTRATION_STATE);

        // 无 runtime 身份：不发请求，前台面板直接清空重绘
        setActiveFeaturePanel('logs');
        seedLogs(c, LOGS_FIXTURE, { truncated: true, returnedCount: 1, availableCount: 2 });
        orchestration.setCurrentRuntimeAgentId(null);
        await c.read('loadLogs(true)');
        assert.deepEqual(env.fetchStub.calls, []);
        assert.equal(c.read('currentLogs.length'), 0);
        assert.equal(debugPanel.currentLogsTruncation, null);
        assert.deepEqual(env.renderCalls, ['render']);

        // 有身份但请求失败（HTTP 500）：原语义抛错并在前台清空重绘
        orchestration.setCurrentRuntimeAgentId({ id: 'runtime-head', source: 'child' });
        seedLogs(c, LOGS_FIXTURE);
        env.renderCalls.length = 0;
        env.fetchStub.setResponder(() => ({ ok: false, status: 500, json: async () => ({}) }));
        await c.read('loadLogs(true)');
        assert.equal(env.fetchStub.calls.length, 1);
        assert.equal(c.read('currentLogs.length'), 0);
        assert.deepEqual(env.renderCalls, ['render']);

        // 非 forceRender 的失败不清空（静默失败交给下一轮轮询）
        seedLogs(c, LOGS_FIXTURE);
        env.renderCalls.length = 0;
        await c.read('loadLogs(false)');
        assert.equal(c.read('currentLogs.length'), LOGS_FIXTURE.length);
        assert.deepEqual(env.renderCalls, []);

        // 面板不在前台：失败同样不清空（原语义只服务当前视图）
        setActiveFeaturePanel(null);
        seedLogs(c, LOGS_FIXTURE);
        await c.read('loadLogs(true)');
        assert.equal(c.read('currentLogs.length'), LOGS_FIXTURE.length);
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
