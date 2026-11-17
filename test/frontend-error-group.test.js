/**
 * API 错误消息前端显示契约（渲染层聚合投影）：
 *   - 判定单轨：execution 结构化字段优先，[Error:/[API Error: 前缀回退
 *     （旧会话兼容）；render / renderMessage / updateLastMessage 三条路径
 *     共用同一判定（历史上 render() 全量路径无错误判定 → 刷新后红框降级
 *     为普通文本）。
 *   - 连续同 category 失败消息合并为聚合组卡（组头 + 展开明细）；组结构
 *     无法增量 patch：append / updateLastMessage 遇组影响升级全量渲染。
 *   - 前缀回退消息（无 execution 字段）不参与聚合。
 *
 * 装载路线（P2）：classic 按 index.html 真实顺序执行（action-dispatcher →
 * i18n → app-core → chat-viewport → input-helpers → chat-renderer），断言直接
 * 调用它们的生产入口（顶层函数声明 = window 上的同名函数）；lazy-tool-content
 * / chat-row-visibility 已迁 ESM，经 withP2EsmCase 的 `c.load` 真实 import，
 * classic 消费面由生产兼容桥 p2-w2-1-chat-windowing-host 提供。
 *
 * 关于 i18n 桩：本文件钉的是 category → i18n key 的档位映射（getErrorCategoryLabel）
 * 与组头用例的 key/计数占位，而不是译文。真实 i18n 装载后把 `t` 显式覆写为
 * 恒等桩（见 withHarness 内注释），只为让断言落在 key 上；生产装配不变。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';
import { t as realT } from '../public/src/i18n.js';

const LAZY_TOOL_CONTENT = 'public/src/modules/lazy-tool-content.js';

const VIEW_H = 800;

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle: (name, force) => {
      const enable = force === undefined ? !set.has(name) : Boolean(force);
      if (enable) set.add(name); else set.delete(name);
      return enable;
    },
    contains: (name) => set.has(name),
  };
}

function failedMsg(content, category, { ts } = {}) {
  return {
    role: 'assistant',
    content,
    execution: { status: 'failed', reason: 'error', error: { category, message: content } },
    ...(typeof ts === 'number' ? { _ts: ts } : {}),
  };
}

function createRig() {
  const container = {
    clientHeight: VIEW_H,
    clientWidth: 1000,
    _scrollTop: 0,
    _entries: [],
    _html: '',
    scrollHeight: VIEW_H * 4,
  };
  Object.defineProperty(container, 'scrollTop', {
    get() { return container._scrollTop; },
    set(v) { container._scrollTop = Math.max(0, Number(v) || 0); },
  });
  Object.defineProperty(container, 'innerHTML', {
    get() { return container._html; },
    set(v) {
      container._html = String(v);
      // 全量渲染重建行：对齐真实 DOM 语义（render 后容器持有消息行），
      // appendNewMessages 的欢迎页边界守卫经 querySelectorAll('.message-row')
      // 判定"容器已有历史行"，entries 为空会误升级全量。
      const rowCount = (String(v).match(/<div class="message-row/g) || []).length;
      container._entries = Array.from({ length: rowCount }, () => ({
        row: {
          classList: makeClassList(), style: {}, dataset: {},
          matches: () => false,
          querySelector: () => null,
          querySelectorAll: () => [],
        },
      }));
    },
  });
  container.querySelectorAll = (sel) => (sel === '.message-row'
    ? container._entries.map((e) => e.row)
    : []);
  container.querySelector = (sel) => {
    if (sel === '.message-row') return container._entries[0] ? container._entries[0].row : null;
    if (sel === '.empty-state') return null;
    return null;
  };
  container.getElementsByTagName = () => [];
  container.getBoundingClientRect = () => ({ top: 0, left: 0, width: 1000, height: VIEW_H });
  container.addEventListener = () => {};
  container.removeEventListener = () => {};

  // append 增量路径：insertAdjacentHTML 物化 queueRow 提供的行 stub
  const pendingRows = [];
  const appendedHtml = [];
  container.insertAdjacentHTML = (_pos, html) => {
    appendedHtml.push(String(html));
    const entry = pendingRows.shift();
    if (entry) container._entries.push(entry);
  };
  Object.defineProperty(container, 'lastElementChild', {
    get() {
      const last = container._entries[container._entries.length - 1];
      return last ? last.row : null;
    },
  });

  const elements = new Map();
  const elementStub = (id) => ({
    id, innerHTML: '', textContent: '', style: {},
    classList: makeClassList(), dataset: {},
    clientHeight: 0, clientWidth: 0, scrollHeight: 0, scrollTop: 0, parentElement: null,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  });
  const document = {
    activeElement: null,
    readyState: 'complete',
    getElementById(id) {
      if (id === 'chat-container') return container;
      if (!elements.has(id)) elements.set(id, elementStub(id));
      return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: () => elementStub('created'),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {}, removeEventListener() {},
    body: elementStub('body'), head: elementStub('head'), documentElement: elementStub('html'),
  };

  const timers = new Map();
  let seq = 1;
  const fakeTimers = {
    setTimeout(callback) { const id = seq++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { const id = seq++; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
    requestAnimationFrame() { return seq++; },
    cancelAnimationFrame() {},
  };

  return {
    container, document, fakeTimers, appendedHtml,
  };
}

async function withHarness({ messages } = {}, fn) {
  const rig = createRig();
  // currentMessages 的唯一真源是 app-core 装载期注册的桥键；会话视图读取面
  // 绑定到同一 owner（不读初始数组副本）。
  const live = { readMessages: () => [] };
  const globals = {
    document: rig.document,
    // markdown-bootstrap 装载期需要 vendor 的 marked（renderer 由它自建）。
    marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: (value) => String(value ?? '') },
    // input-actions 已 import 真实 poll 模块（poll-coordinator-host）：按生产
    // 宿主 seam 提供最小面，本文件不驱动轮询、不再保留 window.poll 桩。
    createPollCoordinatorHost: () => ({
      run: () => Promise.resolve(),
      fastInterval: () => 2000,
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (id) => clearTimeout(id),
    }),
    CSS: { supports: () => true },
    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    // 以下是仍需晚绑定的 classic 宿主函数（app-core / app-ui / app-main /
    // runtime-status）。渲染依赖（markdown-utils / template-engine /
    // message-timeline / tool-progress）已由 chat-renderer 静态 import 真实模块，
    // 夹具不再为它们留桩。
    escapeHtml: (v) => String(v ?? ''),
    t: (k) => k,
    switchAgent() {},
    ensureChatRuntimeIndicator() {},
    getEmptyStateHtml: () => '<div class="empty-state">empty</div>',
    renderCurrentMainView() {},
    readCurrentSessionViewState: () => ({ messages: live.readMessages(), inputRequests: [] }),
  };
  return withP2EsmCase({
    classic: (sandbox) => {
      // chat-renderer 的 import 链触达整条装载期宿主工厂链：按生产先行脚本序整链
      // 装载（boot 体与周期排程由基座关掉），再补 markdown-bootstrap（markdown-utils
      // 求值期捕获 escapeHtml / renderer / marked）。
      prepareClassicSandbox(sandbox);
      sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
      // 夹具的确定性计时器 / rAF 必须晚于基座落位（基座会关闭 rAF 与周期排程）。
      Object.assign(sandbox, rig.fakeTimers);
    },
    globals,
  }, async (c) => {
    const renderer = await c.load('public/src/modules/chat-renderer.js');
    // 时间分隔线的真实格式化（同一 case 图内的实例）
    const timeline = await c.load('public/src/modules/message-timeline.js');
    await c.load('public/src/modules/chat-viewport.js');
    // chat-viewport 的 import 链把 markdown-utils 的真实实现带进来（并注册其桥键），
    // 会覆盖 globals 里同名桩；本文件的观测面要求桩生效，故在装载后重新落一遍。
    Object.assign(c.window, globals);
    // input-helpers 已迁 ESM（P4 T2）：真实 import 装载，桥键由模块自身注册。
    await c.load('public/src/modules/input-helpers.js');
    const surface = c.window.createP2BootstrapChatSurfaceHost();
    surface.showChatProcess = true;
    surface.followLatestEnabled = false;
    c.window.currentMessages = messages || [];
    live.readMessages = () => c.window.currentMessages;
    c.window.allAgents = [];
    c.window.toolRenderConfigs = {};
    c.window.currentInputRequests = [];
    c.window._lastRenderedChatSig = '';
    // 真实 i18n 已装载（上面的 classic 序）；本文件的断言对象是 i18n key 本身，
    // 故把 t 显式覆写为恒等桩，避免断言被译文改动牵动。这是测试观测选择，
    // 不改变生产装配。
    c.window.t = (key) => key;
    await c.load('public/src/modules/p2-w2-1-chat-windowing-host.js');
    // 输入面域（本批迁 ESM）：回退按钮可见性与过程显隐的真实实现
    await c.load('public/src/modules/input-actions.js');
    await c.load('public/src/modules/chat-process-visibility.js');
    const mod = await c.load(LAZY_TOOL_CONTENT);
    mod.setProcessWindowingDisabled(true);
    return fn(Object.assign(rig, {
      c,
      renderer,
      formatTimestamp: timeline.formatChatTimestamp,
      messages: () => c.window.currentMessages,
      resetSignature: () => { c.window._lastRenderedChatSig = ''; },
      render: () => c.read('render(currentMessages)'),
      append: (messageIndex, startIndex) => c.read(`appendNewMessages([currentMessages[${messageIndex}]], ${startIndex})`),
      updateLast: (index) => c.read(`updateLastMessage(currentMessages[${index}])`),
      html: () => rig.container._html,
    }));
  });
}

function countMessageRows(html) {
  return (String(html).match(/<div class="message-row/g) || []).length;
}

// ── 判定单轨 ─────────────────────────────────────────────────

test('getAssistantErrorMeta: execution 优先，前缀回退，普通消息为 null', async () => {
  await withHarness({}, (h) => {
    const meta = h.renderer.getAssistantErrorMeta;

    const structured = failedMsg('限流', 'rate_limit');
    structured.execution.error.statusCode = 429;
    structured.execution.error.retryable = true;
    assert.equal(meta(structured).category, 'rate_limit');
    assert.equal(meta(structured).statusCode, 429);
    assert.equal(meta(structured).retryable, true);
    assert.equal(meta(structured).message, '限流');

    // 前缀回退：旧会话无 execution 字段
    assert.ok(meta({ role: 'assistant', content: '[API Error: auth_error] 旧文案' }));
    assert.ok(meta({ role: 'assistant', content: '[Error: LLM returned empty response]' }));

    assert.equal(meta({ role: 'assistant', content: '正常回复' }), null);
    assert.equal(meta({ role: 'user', content: '[Error: x]' }), null);
  });
});

test('render() 全量渲染错误消息为红框（此前降级为普通文本的根因回归）', async () => {
  await withHarness({ messages: [
    { role: 'user', content: 'hi' },
    failedMsg('API 请求频率超限 (429)', 'rate_limit'),
  ] }, (h) => {
    h.render();
    assert.match(h.html(), /class="tool-error"/);
    assert.match(h.html(), /API 请求频率超限/);
  });
});

test('红框携带机器事实 title 与 auth_required 动作链接', async () => {
  await withHarness({ messages: [
    { role: 'user', content: 'hi' },
    failedMsg('API Key 无效', 'auth_required'),
  ] }, (h) => {
    h.render();
    assert.match(h.html(), /title="auth_required/);
    assert.match(h.html(), new RegExp(realT('error_action_reconfigure')));
    assert.match(h.html(), /data-action="chat.openSettings"/);
  });
});

// ── 聚合纯函数 ───────────────────────────────────────────────

test('computeAssistantErrorGroups: 连续同 category 成组，user 断组、异类断组、单条不成组', async () => {
  await withHarness({}, (h) => {
    const plan = h.renderer.computeAssistantErrorGroups;

    const msgs = [
      { role: 'user', content: 'q1' },
      failedMsg('e1', 'rate_limit'),
      failedMsg('e2', 'rate_limit'),
      failedMsg('e3', 'rate_limit'),
      { role: 'user', content: 'q2' },
      failedMsg('e4', 'rate_limit'), // user 断组后单条，不成组
      failedMsg('e5', 'server_error'), // 异类相邻，不成组
    ];
    const { groups, plan: p } = plan(msgs);
    assert.equal(groups.length, 1);
    assert.deepEqual(
      { startIndex: groups[0].startIndex, endIndex: groups[0].endIndex, category: groups[0].category, count: groups[0].count },
      { startIndex: 1, endIndex: 3, category: 'rate_limit', count: 3 },
    );
    assert.equal(p[1].isFirst, true);
    assert.equal(p[2].isFirst, false);
    assert.equal(p[3].isFirst, false);
    assert.equal(p[5], null); // user 断组后的单条
    assert.equal(p[6], null); // 异类
    assert.equal(p[0], null);
  });
});

test('computeAssistantErrorGroups: 前缀回退消息（无 execution）不参与聚合', async () => {
  await withHarness({}, (h) => {
    const msgs = [
      failedMsg('e1', 'rate_limit'),
      { role: 'assistant', content: '[API Error: client_error] 旧文案' },
      failedMsg('e2', 'rate_limit'),
    ];
    const { groups } = h.renderer.computeAssistantErrorGroups(msgs);
    assert.equal(groups.length, 0);
  });
});

test('isErrorGroupAffected: 相邻同 category 判定', async () => {
  await withHarness({}, (h) => {
    const affected = h.renderer.isErrorGroupAffected;
    const msgs = [
      { role: 'user', content: 'q' },
      failedMsg('e1', 'rate_limit'),
      failedMsg('e2', 'rate_limit'),
      failedMsg('e3', 'server_error'),
    ];
    assert.equal(affected(msgs, 1), true);  // 后邻同类
    assert.equal(affected(msgs, 2), true);  // 前邻同类
    assert.equal(affected(msgs, 3), false); // 前邻异类
    assert.equal(affected(msgs, 0), false); // 非错误消息
  });
});

test('getErrorCategoryLabel: category → i18n 档位映射', async () => {
  await withHarness({}, (h) => {
    const label = h.renderer.getErrorCategoryLabel;
    assert.equal(label('rate_limit'), realT('error_cat_rate_limit'));
    assert.equal(label('connection_error'), realT('error_cat_network'));
    assert.equal(label('connection_timeout'), realT('error_cat_network'));
    assert.equal(label('ssl_cert_error'), realT('error_cat_network'));
    assert.equal(label('auth_error'), realT('error_cat_auth'));
    assert.equal(label('invalid_api_key'), realT('error_cat_auth'));
    assert.equal(label('auth_required'), realT('error_cat_auth'));
    assert.equal(label('server_error'), realT('error_cat_server'));
    assert.equal(label('server_overload'), realT('error_cat_server'));
    assert.equal(label('prompt_too_long'), realT('error_cat_context'));
    assert.equal(label('client_error'), realT('error_cat_request'));
    assert.equal(label('runtime_error'), realT('error_cat_request'));
  });
});

// ── 组渲染与升级路径 ─────────────────────────────────────────

test('render(): 组成员合并为单行组卡，默认折叠，含明细与时间戳', async () => {
  await withHarness({ messages: [
    { role: 'user', content: 'q' },
    failedMsg('e1', 'rate_limit', { ts: 1000 }),
    failedMsg('e2', 'rate_limit', { ts: 2000 }),
    failedMsg('e3', 'rate_limit', { ts: 3000 }),
  ] }, (h) => {
    h.render();

    // user 行 + 组行 = 2（三条失败不各占一行）
    assert.equal(countMessageRows(h.html()), 2);
    assert.match(h.html(), /error-group-head/);
    assert.match(h.html(), new RegExp(realT('error_group_title')));
    assert.match(h.html(), new RegExp(realT('error_group_count').replace('{n}', '3')));
    assert.match(h.html(), new RegExp(realT('error_cat_rate_limit')));
    // 默认折叠：head/body 无 expanded，明细仍输出（CSS 收起）
    assert.doesNotMatch(h.html(), /error-group-head expanded/);
    assert.doesNotMatch(h.html(), /error-group-body expanded/);
    assert.match(h.html(), /error-group-item/);
    // 时间戳由真实 message-timeline 格式化（原 stub 已不参与模块内部渲染）
    assert.match(h.html(), new RegExp(h.formatTimestamp(1000)));
    assert.match(h.html(), new RegExp(h.formatTimestamp(3000)));
  });
});

test('appendNewMessages: 新错误并入组升级全量渲染并自动展开一次', async () => {
  await withHarness({ messages: [
    { role: 'user', content: 'q' },
    failedMsg('e1', 'rate_limit'),
  ] }, (h) => {
    // 首次全量渲染（e1 单条，不组）
    h.render();
    assert.doesNotMatch(h.html(), /error-group-head/);

    // e2 到达：与 e1 同 category 相邻 → 组升级
    h.messages().push(failedMsg('e2', 'rate_limit'));
    h.append(2, 2);

    assert.equal(countMessageRows(h.html()), 2);
    assert.match(h.html(), /error-group-head expanded/);
    assert.match(h.html(), /error-group-body expanded/);

    // reveal 只生效一次：签名去重会让同数据 render 跳过重建（DOM 保持
    // expanded 是既有语义），这里清签名强制重建验证 reveal 已被消费。
    h.resetSignature();
    h.render();
    assert.doesNotMatch(h.html(), /error-group-head expanded/);
  });
});

test('appendNewMessages: 单条错误（无相邻同类）走增量路径渲染红框', async () => {
  await withHarness({ messages: [{ role: 'user', content: 'q' }] }, (h) => {
    h.render();

    const err = failedMsg('唯一错误', 'server_error');
    h.messages().push(err);
    h.append(1, 1);

    assert.equal(h.appendedHtml.length, 1);
    assert.match(h.appendedHtml[0], /class="tool-error"/);
    assert.doesNotMatch(h.appendedHtml[0], /error-group-head/);
  });
});

test('updateLastMessage: 失败终态落入组时升级全量（不 patch 单行）', async () => {
  // 场景：流式行出生（普通正文）→ execution 盖戳抵达，且前一条是同类失败
  await withHarness({ messages: [
    { role: 'user', content: 'q' },
    failedMsg('e1', 'rate_limit'),
    { role: 'assistant', content: '流式中…' },
  ] }, (h) => {
    h.render();

    // 尾部消息收到失败终态（tail patch 路径）
    h.messages()[2] = failedMsg('e2', 'rate_limit');
    h.updateLast(2);

    // 升级全量：三条中两条失败合并组行 → user + 组 = 2 行
    assert.equal(countMessageRows(h.html()), 2);
    assert.match(h.html(), /error-group-head expanded/);
  });
});
