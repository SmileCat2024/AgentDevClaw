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
 * Loads the real chat-viewport.js / input-helpers.js / lazy-tool-content.js /
 * chat-renderer.js / chat-row-visibility.js into a vm sandbox (harness
 * mirrors frontend-hide-process-empty-assistant.test.js，外加 render() 全量
 * 路径的 innerHTML 捕获)。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = (p) => fs.readFileSync(new URL('../public/src/' + p, import.meta.url), 'utf8');

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

function createHarness({ messages } = {}) {
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

  const sandbox = {
    console, Date, JSON, Math, Promise, Map, Set, Number, Object, Array, Boolean, String, isNaN, parseInt,
    CSS: { supports: () => true },
    window: {},
    setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({
        style: {},
        classList: makeClassList(),
        dataset: {},
        setAttribute() {},
        appendChild(c) { return c; },
        querySelector: () => null,
        querySelectorAll: () => [],
      }),
      body: { contains: () => true },
      activeElement: null,
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },

    container,
    followLatestButton: { classList: { toggle() {}, add() {}, remove() {} }, innerHTML: '' },
    currentMessages: messages || [],
    allAgents: [],
    toolRenderConfigs: {},
    _lastRenderedChatSig: '',
    _userExpandedReasoning: new Set(),
    _userExpandedMsgs: new Set(),
    _userCollapsedMsgs: new Set(),
    currentInputRequests: [],
    currentRuntimeAgentId: 'rt-1',
    chatProcessToggle: null,
    CHAT_PROCESS_VISIBILITY_KEY: 'k',
    readCurrentSessionViewState: () => ({ messages: sandbox.currentMessages, inputRequests: [] }),
    saveChatProcessVisibility() {},

    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    escapeHtml: (v) => String(v ?? ''),
    // message-timeline.js：时间分隔线包装（无时间锚场景透传行 html）
    prependTimeSeparatorHtml: (_messages, _index, rowHtml) => rowHtml,
    formatChatTimestamp: (ts) => 'T' + ts,
    t: (k) => k,
    renderMarkdown: (s) => String(s ?? ''),
    parseToolResult: (content) => ({ success: true, data: content }),
    renderJsonHighlight: (d) => '<pre>' + String(d).slice(0, 20) + '</pre>',
    applyTemplate: () => '<div>args</div>',
    enhanceMathInElement() {},
    enhanceMarkdownTables() {},
    clearTruncatedHighlightData() {},
    getToolDisplayName: (n) => n || 'Tool',
    getToolRenderTemplate: () => ({}),
    resolveToolProgressForCall: () => null,
    canRollbackMessage: () => false,
    requestRollbackEdit() {},
    switchAgent() {},
    ensureChatRuntimeIndicator() {},
    getEmptyStateHtml: () => '<div class="empty-state">empty</div>',
    renderCurrentMainView() {},

    followLatestEnabled: false,
    suppressFollowScrollEvent: false,
    lastManualScrollIntentAt: 0,
    _progScrollCooldownUntil: 0,
    followLatestEntryUntil: 0,
    chatViewportObserversReady: true,
    chatViewportObserverSuppressDepth: 0,
    chatViewportObserverQuietUntil: 0,
    chatViewportMutationObserver: null,
    chatViewportResizeObserver: null,
    chatViewportSettlementToken: 0,
    chatViewportSettlementRaf: 0,
    chatViewportSettlementTimer: null,
    chatViewportSettlementContext: null,
    chatViewportFollowRaf: 0,
    chatViewportFollowToken: 0,
    chatViewportFollowTransition: 'locked',
    assemblySideRailRevealTimer: null,
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(src('modules/chat-viewport.js'), sandbox, { filename: 'chat-viewport.js' });
  vm.runInContext(src('modules/input-helpers.js'), sandbox, { filename: 'input-helpers.js' });
  vm.runInContext(src('modules/lazy-tool-content.js'), sandbox, { filename: 'lazy-tool-content.js' });
  vm.runInContext(src('modules/chat-renderer.js'), sandbox, { filename: 'chat-renderer.js' });
  vm.runInContext(src('modules/chat-row-visibility.js'), sandbox, { filename: 'chat-row-visibility.js' });

  return {
    sandbox, container, appendedHtml,
    queueRow(row) { pendingRows.push({ row }); },
  };
}

function countMessageRows(html) {
  return (String(html).match(/<div class="message-row/g) || []).length;
}

// ── 判定单轨 ─────────────────────────────────────────────────

test('getAssistantErrorMeta: execution 优先，前缀回退，普通消息为 null', () => {
  const h = createHarness();
  const meta = h.sandbox.getAssistantErrorMeta;

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

test('render() 全量渲染错误消息为红框（此前降级为普通文本的根因回归）', () => {
  const h = createHarness({ messages: [
    { role: 'user', content: 'hi' },
    failedMsg('API 请求频率超限 (429)', 'rate_limit'),
  ] });
  h.sandbox.showChatProcess = true;
  h.sandbox.render(h.sandbox.currentMessages);
  assert.match(h.container._html, /class="tool-error"/);
  assert.match(h.container._html, /API 请求频率超限/);
});

test('红框携带机器事实 title 与 auth_required 动作链接', () => {
  const h = createHarness({ messages: [
    { role: 'user', content: 'hi' },
    failedMsg('API Key 无效', 'auth_required'),
  ] });
  h.sandbox.showChatProcess = true;
  h.sandbox.render(h.sandbox.currentMessages);
  assert.match(h.container._html, /title="auth_required/);
  assert.match(h.container._html, /error_action_reconfigure/);
  assert.match(h.container._html, /openSettings\(\)/);
});

// ── 聚合纯函数 ───────────────────────────────────────────────

test('computeAssistantErrorGroups: 连续同 category 成组，user 断组、异类断组、单条不成组', () => {
  const h = createHarness();
  const plan = h.sandbox.computeAssistantErrorGroups;

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

test('computeAssistantErrorGroups: 前缀回退消息（无 execution）不参与聚合', () => {
  const h = createHarness();
  const msgs = [
    failedMsg('e1', 'rate_limit'),
    { role: 'assistant', content: '[API Error: client_error] 旧文案' },
    failedMsg('e2', 'rate_limit'),
  ];
  const { groups } = h.sandbox.computeAssistantErrorGroups(msgs);
  assert.equal(groups.length, 0);
});

test('isErrorGroupAffected: 相邻同 category 判定', () => {
  const h = createHarness();
  const affected = h.sandbox.isErrorGroupAffected;
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

test('getErrorCategoryLabel: category → i18n 档位映射', () => {
  const h = createHarness();
  const label = h.sandbox.getErrorCategoryLabel;
  assert.equal(label('rate_limit'), 'error_cat_rate_limit');
  assert.equal(label('connection_error'), 'error_cat_network');
  assert.equal(label('connection_timeout'), 'error_cat_network');
  assert.equal(label('ssl_cert_error'), 'error_cat_network');
  assert.equal(label('auth_error'), 'error_cat_auth');
  assert.equal(label('invalid_api_key'), 'error_cat_auth');
  assert.equal(label('auth_required'), 'error_cat_auth');
  assert.equal(label('server_error'), 'error_cat_server');
  assert.equal(label('server_overload'), 'error_cat_server');
  assert.equal(label('prompt_too_long'), 'error_cat_context');
  assert.equal(label('client_error'), 'error_cat_request');
  assert.equal(label('runtime_error'), 'error_cat_request');
});

// ── 组渲染与升级路径 ─────────────────────────────────────────

test('render(): 组成员合并为单行组卡，默认折叠，含明细与时间戳', () => {
  const h = createHarness({ messages: [
    { role: 'user', content: 'q' },
    failedMsg('e1', 'rate_limit', { ts: 1000 }),
    failedMsg('e2', 'rate_limit', { ts: 2000 }),
    failedMsg('e3', 'rate_limit', { ts: 3000 }),
  ] });
  h.sandbox.showChatProcess = true;
  h.sandbox.render(h.sandbox.currentMessages);

  // user 行 + 组行 = 2（三条失败不各占一行）
  assert.equal(countMessageRows(h.container._html), 2);
  assert.match(h.container._html, /error-group-head/);
  assert.match(h.container._html, /error_group_title/);
  assert.match(h.container._html, /共 3 次|error_group_count/);
  assert.match(h.container._html, /error_cat_rate_limit/);
  // 默认折叠：head/body 无 expanded，明细仍输出（CSS 收起）
  assert.doesNotMatch(h.container._html, /error-group-head expanded/);
  assert.doesNotMatch(h.container._html, /error-group-body expanded/);
  assert.match(h.container._html, /error-group-item/);
  assert.match(h.container._html, /T1000/);
  assert.match(h.container._html, /T3000/);
});

test('appendNewMessages: 新错误并入组升级全量渲染并自动展开一次', () => {
  const h = createHarness({ messages: [
    { role: 'user', content: 'q' },
    failedMsg('e1', 'rate_limit'),
  ] });
  h.sandbox.showChatProcess = true;
  // 首次全量渲染（e1 单条，不组）
  h.sandbox.render(h.sandbox.currentMessages);
  assert.doesNotMatch(h.container._html, /error-group-head/);

  // e2 到达：与 e1 同 category 相邻 → 组升级
  h.sandbox.currentMessages.push(failedMsg('e2', 'rate_limit'));
  h.sandbox.appendNewMessages([h.sandbox.currentMessages[2]], 2);

  assert.equal(countMessageRows(h.container._html), 2);
  assert.match(h.container._html, /error-group-head expanded/);
  assert.match(h.container._html, /error-group-body expanded/);

  // reveal 只生效一次：签名去重会让同数据 render 跳过重建（DOM 保持
  // expanded 是既有语义），这里清签名强制重建验证 reveal 已被消费。
  h.sandbox._lastRenderedChatSig = '';
  h.sandbox.render(h.sandbox.currentMessages);
  assert.doesNotMatch(h.container._html, /error-group-head expanded/);
});

test('appendNewMessages: 单条错误（无相邻同类）走增量路径渲染红框', () => {
  const h = createHarness({ messages: [{ role: 'user', content: 'q' }] });
  h.sandbox.showChatProcess = true;
  h.sandbox.render(h.sandbox.currentMessages);

  const err = failedMsg('唯一错误', 'server_error');
  h.sandbox.currentMessages.push(err);
  h.sandbox.appendNewMessages([err], 1);

  assert.equal(h.appendedHtml.length, 1);
  assert.match(h.appendedHtml[0], /class="tool-error"/);
  assert.doesNotMatch(h.appendedHtml[0], /error-group-head/);
});

test('updateLastMessage: 失败终态落入组时升级全量（不 patch 单行）', () => {
  // 场景：流式行出生（普通正文）→ execution 盖戳抵达，且前一条是同类失败
  const h = createHarness({ messages: [
    { role: 'user', content: 'q' },
    failedMsg('e1', 'rate_limit'),
    { role: 'assistant', content: '流式中…' },
  ] });
  h.sandbox.showChatProcess = true;
  h.sandbox.render(h.sandbox.currentMessages);

  // 尾部消息收到失败终态（tail patch 路径）
  h.sandbox.currentMessages[2] = failedMsg('e2', 'rate_limit');
  h.sandbox.updateLastMessage(h.sandbox.currentMessages[2]);

  // 升级全量：三条中两条失败合并组行 → user + 组 = 2 行
  assert.equal(countMessageRows(h.container._html), 2);
  assert.match(h.container._html, /error-group-head expanded/);
});
