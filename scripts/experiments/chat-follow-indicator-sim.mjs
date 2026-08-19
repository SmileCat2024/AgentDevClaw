/**
 * chat-follow-indicator-sim.mjs — 跟随最新 × 底部运行状态块 × 会话切换 的滚动协调模拟实验
 *
 * 用途：只读调查工具（不改产品行为）。加载真实前端源码：
 *   - public/src/modules/chat-viewport.js（整个文件）
 *   - public/src/modules/runtime-status.js 的 resetRuntimeStatusForSwitch ~ ensureChatRuntimeIndicator 块
 *   - public/src/app-core.js 的 runtime cache 块 + modules/session-view-state.js
 * 在自建的最小 DOM / 布局引擎 / 可控时钟上复现真实时序。
 *
 * 布局模型（对齐 public/styles/layout.css #chat-container）：
 *   scrollHeight = padTop + Σ(child 高度) + gap×(n-1) + Σ(child marginBottom) + padBottom
 *   gap=24, padTop=24, padBottom=320, clientHeight=800（可控）
 *   指示块高度 = 26(主行) + 19×详情行数 —— 负 margin 抵消后净贡献为 0
 *
 * 运行：node scripts/experiments/chat-follow-indicator-sim.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const coreSource = readSrc('public/src/app-core.js');
const sessionViewStateSource = readSrc('public/src/modules/session-view-state.js');
const chatViewportSource = readSrc('public/src/modules/chat-viewport.js');
const runtimeStatusSource = readSrc('public/src/modules/runtime-status.js');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════
// 可控时钟：vmNow 毫秒 + 定时器队列 + rAF 队列
// ═══════════════════════════════════════════════════════════════

function createClock() {
  let now = 0;
  let timerId = 0;
  const timers = new Map(); // id -> { due, fn }
  let rafId = 0;
  let rafQueue = []; // { id, fn }
  let taskSeq = 0; // 宏任务序号：每个 paint 边界递增

  const clock = {
    Date: { now: () => now },
    taskSeq: () => taskSeq,
    setTimeout(fn, ms = 0) {
      const id = ++timerId;
      timers.set(id, { due: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) {
      const id = ++rafId;
      rafQueue.push({ id, fn });
      return id;
    },
    cancelAnimationFrame(id) { rafQueue = rafQueue.filter((r) => r.id !== id); },
    nowMs: () => now,
    markTask() { taskSeq++; return taskSeq; },
    async flushTasks(ms = 1) {
      taskSeq++;
      now += ms;
      runDueTimers();
      await null; // flush microtasks（MutationObserver 派发）
      await null;
    },
    async runFrames(n) {
      for (let i = 0; i < n; i++) {
        taskSeq++;
        now += 16;
        runDueTimers();
        const cur = rafQueue;
        rafQueue = [];
        for (const { fn } of cur) fn();
        await null; // flush microtasks
        await null;
      }
    },
  };

  function runDueTimers() {
    const due = [...timers.entries()].filter(([, t]) => t.due <= now)
      .sort((a, b) => a[1].due - b[1].due);
    for (const [id, t] of due) {
      timers.delete(id);
      t.fn();
    }
  }

  return clock;
}

// ═══════════════════════════════════════════════════════════════
// 假 DOM + 布局引擎
// ═══════════════════════════════════════════════════════════════

const GAP = 24;
const PAD_TOP = 24;
const PAD_BOTTOM = 320;

function makeClassList(el) {
  return {
    add: (...names) => { sync(el); names.forEach((n) => el._classes.add(n)); },
    remove: (...names) => { sync(el); names.forEach((n) => el._classes.delete(n)); },
    toggle: (n, force) => {
      sync(el);
      const on = force === undefined ? !el._classes.has(n) : !!force;
      if (on) el._classes.add(n); else el._classes.delete(n);
      return on;
    },
    contains: (n) => { sync(el); return el._classes.has(n); },
  };
  function sync(e) { e.className = [...e._classes].join(' '); }
}

function makeElement({ id = '', className = '', height = 0 } = {}) {
  const el = {
    tagName: 'DIV',
    id,
    className,
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    _classes: new Set(className.split(/\s+/).filter(Boolean)),
    _layoutHeight: height,
    _text: '',
    _container: null, // 布局根回链，由 container 注入
    get classList() { return makeClassList(el); },
    get textContent() { return el._text; },
    set textContent(v) {
      el._text = String(v);
      emitMutation(el);
    },
    set innerHTML(v) {
      el._text = String(v);
      el.children = [];
      emitMutation(el);
    },
    get innerHTML() { return el._text; },
    get lastElementChild() { return el.children[el.children.length - 1] || null; },
    get offsetHeight() {
      if (el.id === 'runtime-indicator-row') return indicatorHeight(el);
      return el._layoutHeight;
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      emitMutation(el);
      return child;
    },
    remove() {
      const p = el.parentNode;
      if (p) {
        const i = p.children.indexOf(el);
        if (i >= 0) p.children.splice(i, 1);
        emitMutation(p);
      }
      el.parentNode = null;
    },
    contains(node) {
      if (node === el) return true;
      return el.children.some((c) => c.contains && c.contains(node));
    },
    matches(sel) { return matchesSel(el, sel); },
    querySelector(sel) { return queryAll(el, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(el, sel); },
  };
  return el;
}

function matchesSel(el, sel) {
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el._classes.has(sel.slice(1));
  return false;
}
function queryAll(root, sel) {
  const out = [];
  for (const c of root.children || []) {
    if (matchesSel(c, sel)) out.push(c);
    out.push(...queryAll(c, sel));
  }
  return out;
}
function indicatorHeight(el) {
  let h = 26; // .runtime-indicator-main（含 6px 上下 padding + 16px 行高近似）
  for (const c of el.children) {
    if (c._classes.has('runtime-indicator-detail')) h += 19;
  }
  return h + (el._extraHeight || 0);
}

// —— 全局 mutation 派发（模拟浏览器 MutationObserver 微任务派发） ——
let activeMutationObserverCb = null;
let mutationScheduled = false;
let mutationDeliveries = 0; // { at, ignored }

function emitMutation(el) {
  // 找到布局根
  let root = el;
  while (root.parentNode) root = root.parentNode;
  if (root._isChatContainer && activeMutationObserverCb && !mutationScheduled) {
    mutationScheduled = true;
    queueMicrotask(() => {
      mutationScheduled = false;
      mutationDeliveries++;
      activeMutationObserverCb([], null); // 回调内部自行判断 shouldIgnore
    });
  }
}

class FakeMutationObserver {
  constructor(cb) { this.cb = cb; }
  observe() { activeMutationObserverCb = this.cb; }
  disconnect() { activeMutationObserverCb = null; }
  takeRecords() { return []; }
}
class FakeResizeObserver {
  constructor(cb) { this.cb = cb; }
  observe() {}
  disconnect() {}
  unobserve() {}
}

function createContainer({ clientHeight = 800 } = {}) {
  const timeline = []; // { t, from, to, seq, scrollHeight, distToBottom }
  const container = makeElement({ id: 'chat-container' });
  container._isChatContainer = true;
  container._clock = null; // 由 createSim 注入
  let _scrollTop = 0;

  const layout = {
    computeScrollHeight() {
      const kids = container.children;
      let h = PAD_TOP + PAD_BOTTOM;
      if (kids.length > 0) {
        h += (kids.length - 1) * GAP;
        for (const k of kids) {
          h += k.id === 'runtime-indicator-row' ? indicatorHeight(k) : k._layoutHeight;
          const mb = parseFloat(k.style.marginBottom);
          if (Number.isFinite(mb)) h += mb;
        }
      }
      return h;
    },
    maxTop() { return Math.max(0, layout.computeScrollHeight() - clientHeight); },
  };

  Object.defineProperties(container, {
    scrollTop: {
      get() {
        _scrollTop = Math.min(_scrollTop, layout.maxTop()); // 浏览器钳制语义
        if (_scrollTop < 0) _scrollTop = 0;
        return _scrollTop;
      },
      set(v) {
        const from = container.scrollTop;
        _scrollTop = Math.max(0, Math.min(Number(v) || 0, layout.maxTop()));
        timeline.push({
          t: 'set', from, to: _scrollTop,
          seq: container._clock ? container._clock.taskSeq() : 0,
          scrollHeight: layout.computeScrollHeight(),
          distToBottom: layout.computeScrollHeight() - clientHeight - _scrollTop,
        });
      },
      configurable: true,
    },
    scrollHeight: { get: () => layout.computeScrollHeight(), configurable: true },
    clientHeight: { get: () => clientHeight, configurable: true },
    addEventListener: { value: () => {}, configurable: true },
    getBoundingClientRect: { value: () => ({ top: 0, left: 0, width: 800, height: clientHeight }), configurable: true },
  });

  container._layout = layout;
  container._timeline = timeline;
  return container;
}

// ═══════════════════════════════════════════════════════════════
// VM 上下文：加载真实源码
// ═══════════════════════════════════════════════════════════════

function createSim({ clientHeight = 800 } = {}) {
  const clock = createClock();
  const container = createContainer({ clientHeight });
  container._clock = clock;
  const statusEls = {};
  for (const id of ['notification-status', 'notification-phase', 'notification-summary', 'notification-metrics']) {
    statusEls[id] = makeElement({ id });
  }
  const followLatestButton = makeElement({ id: 'follow-latest-btn' });

  const context = {
    // —— chat-viewport 依赖的全局状态（初始值对齐 app-core.js 声明） ——
    container,
    followLatestButton,
    workspaceTabsBar: makeElement({}),
    currentMessages: [],
    followLatestEnabled: true,
    suppressFollowScrollEvent: false,
    lastManualScrollIntentAt: 0,
    _progScrollCooldownUntil: 0,
    followLatestEntryUntil: 0,
    chatViewportObserversReady: false,
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

    // —— runtime-status 指示块依赖 ——
    currentLanguage: 'zh',
    currentRuntimeConnected: true,
    _lastRenderedNotificationRuntime: null,
    formatRuntimeCompactNumber: (n) => String(n),
    getRuntimeStepElapsedLabel: (rt) => rt?.stepElapsedLabel || '',
    getPendingToolCallsFromMessages: () => context.__pendingToolCalls || [],
    getToolDisplayName: (n) => String(n || ''),

    // —— 通用桩 ——
    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    escapeHtml: (s) => String(s),
    t: (k) => String(k),
    enhanceMathInElement: () => {},
    renderMarkdown: (v) => String(v || ''),
    window: { innerWidth: 1280, lastInputRequests: [], setInterval: () => 0 },
    document: {
      createElement: (_tag) => makeElement({ className: '' }),
      getElementById: (id) =>
        id === 'chat-container' ? container
          : statusEls[id] ? statusEls[id]
            : id === 'user-input-container' ? null
              : id === 'follow-latest-btn' ? followLatestButton : null,
      body: { contains: () => true },
    },
    MutationObserver: FakeMutationObserver,
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: clock.Date,
    getComputedStyle: () => ({ gap: `${GAP}px`, paddingTop: `${PAD_TOP}px` }),
    console: { log() {}, warn() {}, debug() {}, error() {} },

    // —— cache 块依赖（对齐 test/session-ui-context.test.js 的 createCoreContext） ——
    currentAgentId: 'agent-a',
    currentRuntimeAgentId: 'runtime-a',
    currentInputRequests: [],
    currentHookInspector: {},
    currentHookInspectorSignature: '',
    currentOverviewSnapshot: {},
    currentOverviewSignature: '',
    currentTodoPlan: {},
    currentTodoPlanSignature: '',
    _switchEpoch: 0,
    toolRenderConfigs: {},
    TOOL_NAMES: {},
    allAgents: [],
    currentAgent: { id: 'agent-a', active_workspace_session_id: 'session-a', workspace_sessions: { activeSessionId: 'session-a' } },
    getCurrentAgentRecord: () => context.currentAgent,
    setCurrentHookInspector: (v) => { context.currentHookInspector = v; context.currentHookInspectorSignature = JSON.stringify(v); },
    setCurrentOverviewSnapshot: (v) => { context.currentOverviewSnapshot = v; context.currentOverviewSignature = JSON.stringify(v); },
    setCurrentTodoPlan: (v) => { context.currentTodoPlan = v; context.currentTodoPlanSignature = JSON.stringify(v); },
    activateUserCollapseStateForContext: () => {},
    _restoredScrollTop: null,
    lastNotificationStatusPayload: null,
    _agentCallActive: new Map(),
  };
  vm.createContext(context);

  // 1) session-view-state + runtime cache 块（同一脚本，保持 const 词法作用域可见性）
  const cacheBlock = sourceBetween(
    coreSource,
    'const _agentRuntimeCache = new Map();',
    '\nconst I18N =',
  );
  vm.runInContext(
    `${sessionViewStateSource}
${cacheBlock}
globalThis.__cache = {
  getRuntimeContextKey,
  setViewerSessionBinding,
  saveCurrentRuntimeToCache,
  restoreRuntimeFromCache,
};`,
    context,
  );

  // 2) chat-viewport.js 全文件（纯函数声明）
  vm.runInContext(
    `${chatViewportSource}
globalThis.__vp = {
  isNearBottom,
  setChatViewportTop,
  lockChatViewportToBottomNow,
  notifyChatViewportMutation,
  setPendingChatScrollRestore,
  consumePendingChatScrollRestore,
  cancelChatScrollSettlement,
  startFollowLatestAnimation,
  cancelFollowLatestAnimation,
  setFollowLatest,
  requestFollowLatest,
  scrollToLatest,
  beginFollowLatestCooldown,
  beginFollowLatestEntryWindow,
  isFollowLatestEntryWindowActive,
  isFollowLatestCooldownActive,
  shouldIgnoreChatViewportObserverEvent,
  runWithSuppressedChatViewportObservers,
  suppressChatViewportObservers,
  resumeChatViewportObservers,
  getChatViewportMetrics,
  getChatViewportBottomTop,
  __getSettlementContext: () => chatViewportSettlementContext,
  __isCruising: isFollowLatestAnimationCruising,
  __getQuietUntil: () => chatViewportObserverQuietUntil,
  __getSuppressDepth: () => chatViewportObserverSuppressDepth,
};`,
    context,
  );

  // 3) runtime-status 指示块（resetRuntimeStatusForSwitch ~ ensureNotificationClockTimer 前）
  const runtimeStatusBlock = sourceBetween(
    runtimeStatusSource,
    'function resetRuntimeStatusForSwitch',
    '\n// ─── 启动通知计时器',
  );
  vm.runInContext(
    `${runtimeStatusBlock}
globalThis.__rs = {
  resetRuntimeStatusForSwitch,
  ensureChatRuntimeIndicator,
  buildRuntimeIndicatorContent,
  __setRuntimeSnapshot: (snap) => { globalThis._lastRenderedNotificationRuntime = snap; },
};`,
    context,
  );

  return { context, clock, container, __cache: context.__cache, __vp: context.__vp, __rs: context.__rs };
}

// rebuildChatDom 的 DOM 替换需模拟"不触发观察者"：真实 render 的 innerHTML 写入包裹在
// runWithSuppressedChatViewportObservers 内（chat-renderer.js:706-715），此处直接同步替换，
// 观察者抑制由真实 notify 链路的 quietUntil 覆盖（render-full reason 同样延长 quiet 180ms）。
function rebuildChatDom(container, messages, heightOfMessage) {
  {
    container.children = [];
    for (let i = 0; i < messages.length; i++) {
      const row = makeElement({
        className: `message-row ${messages[i].role}`,
        height: heightOfMessage(messages[i], i),
      });
      row.parentNode = container;
      container.children.push(row);
    }
  }
}

function makeBehavior(sim, { messageHeight = 120 } = {}) {
  const { context, clock, container, __vp, __rs, __cache } = sim;
  const heightOf = typeof messageHeight === 'function' ? messageHeight : () => messageHeight;
  let lastSig = '';
  let serverMessages = [];

  const api = {
    container,
    clock,
    __vp,
    __rs,
    get followLatestEnabled() { return context.followLatestEnabled; },
    setFollowLatest: (v, opts) => __vp.setFollowLatest(v, opts),

    setMessages(list) { context.currentMessages = list; },
    setServerMessages(list) { serverMessages = list; },

    metrics() {
      const m = __vp.getChatViewportMetrics();
      return {
        ...m,
        distToBottom: container.scrollHeight - container.clientHeight - container.scrollTop,
        maxTop: container.scrollHeight - container.clientHeight,
      };
    },

    /** 忠实复刻 chat-renderer.js render() 的关键路径（空态/签名去重/notify 参数） */
    render(messages) {
      context.currentMessages = messages;
      if (messages.length === 0) {
        lastSig = '';
        container.children = [];
        return { rendered: 'empty' };
      }
      const sig = messages.map((m) => `${m.role}:${m.content}`).join('|');
      if (sig === lastSig && queryAll(container, '.message-row').length > 0) {
        return { rendered: 'dedup-skip' };
      }
      lastSig = sig;
      const shouldFollowAfterMutation = context.followLatestEnabled && context.isChatSurfaceActive();
      // 修复后接线：优先消费 switch 传递的恢复值（chat-renderer.js 同步语义）
      const savedScrollTop = __vp.consumePendingChatScrollRestore() ?? container.scrollTop;
      rebuildChatDom(container, messages, heightOf);
      __rs.ensureChatRuntimeIndicator();
      __vp.notifyChatViewportMutation({
        reason: 'render-full',
        shouldFollow: shouldFollowAfterMutation,
        preserveTop: shouldFollowAfterMutation ? null : savedScrollTop,
        forceSnap: shouldFollowAfterMutation,
        allowChase: false,
      });
      return { rendered: 'full' };
    },

    /** 忠实复刻 appendNewMessages 的 DOM 段 + notify 参数（chat-renderer.js:280-310） */
    appendMessages(newMessages) {
      context.currentMessages = [...context.currentMessages, ...newMessages];
      const shouldFollowAfterMutation = context.followLatestEnabled && context.isChatSurfaceActive();
      const chatViewportTopBefore = container.scrollTop;
      const sig = context.currentMessages.map((m) => `${m.role}:${m.content}`).join('|');
      lastSig = sig;
      __vp.runWithSuppressedChatViewportObservers(() => {
        for (const m of newMessages) {
          const row = makeElement({ className: `message-row ${m.role}`, height: heightOf(m, container.children.length) });
          container.appendChild(row);
        }
      });
      __rs.ensureChatRuntimeIndicator();
      __vp.notifyChatViewportMutation({
        reason: 'append',
        shouldFollow: shouldFollowAfterMutation,
        preserveTop: shouldFollowAfterMutation ? null : chatViewportTopBefore,
        allowChase: false,
        preferSmooth: false,
        forceSnap: false,
      });
    },

    /** 忠实复刻 app-main.js switchAgent 的同步段（616-676） */
    switchAgent({ targetRuntimeId, targetSessionId, agentRecord }) {
      const prevRuntime = context.currentRuntimeAgentId;
      if (prevRuntime && prevRuntime !== targetRuntimeId) {
        __cache.saveCurrentRuntimeToCache(prevRuntime);
      }
      context.currentAgentId = agentRecord?.id || targetRuntimeId;
      context.currentRuntimeAgentId = targetRuntimeId;
      __cache.setViewerSessionBinding(targetRuntimeId, targetSessionId);
      context.currentAgent = agentRecord || context.currentAgent;
      lastSig = ''; // switchAgent: _lastRenderedChatSig = ''
      __vp.setPendingChatScrollRestore(null); // 入口清理：pending 只在本轮切换内有效
      __rs.resetRuntimeStatusForSwitch();
      const restored = __cache.restoreRuntimeFromCache(targetRuntimeId);
      if (restored) {
        if (context.followLatestEnabled) {
          // [F3 决策] 跟随切回：清空消息走空态（render 空态分支不 notify/不锁底），
          // 等数据到达后的首次全量渲染一次性锁到新底部，避免"缓存底→新底"二次跳。
          context.currentMessages = [];
          api.render([]);
        } else {
          // [F2 修复] 阅读切回：恢复值经 pending 通道交给下一次全量渲染作为
          // preserveTop，不直接写旧 DOM（旧接线会被旧会话 DOM 钳制，见 E3b-1-legacy）
          if (context._restoredScrollTop != null) {
            __vp.setPendingChatScrollRestore(context._restoredScrollTop);
          }
          api.render(context.currentMessages);
        }
        context._restoredScrollTop = null;
      } else {
        context.currentMessages = [];
        api.render([]);
        __vp.setFollowLatest(true); // 672
      }
      __vp.beginFollowLatestCooldown();
      __vp.beginFollowLatestEntryWindow();
      return { restored };
    },

    /** poll statusTask 完成后：运行快照更新 → 指示块重建（runtime-status.js:1007/1018/1125） */
    deliverStatus(snapshot) {
      context.__pendingToolCalls = snapshot.pendingToolCalls || [];
      __rs.__setRuntimeSnapshot(snapshot.runtime);
      __rs.ensureChatRuntimeIndicator();
    },

    /** poll messages 完成后：与本地对比 → append 或 render-full */
    deliverMessages() {
      const local = context.currentMessages.map((m) => `${m.role}:${m.content}`).join('|');
      const server = serverMessages.map((m) => `${m.role}:${m.content}`).join('|');
      if (local === server) return { applied: 'same-skip' };
      // 简化：后缀增长走 append；其余走 render-full
      const localList = context.currentMessages;
      const isSuffix = serverMessages.length > localList.length
        && serverMessages.slice(0, localList.length).map((m) => `${m.role}:${m.content}`).join('|') === local;
      if (isSuffix) {
        api.appendMessages(serverMessages.slice(localList.length));
        return { applied: 'append' };
      }
      api.render(serverMessages);
      return { applied: 'render-full' };
    },
  };
  return api;
}

// ═══════════════════════════════════════════════════════════════
// 实验报告工具
// ═══════════════════════════════════════════════════════════════

const report = [];
let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function note(msg) { report.push(`      ${msg}`); }
function bigJumps(timeline, min = 50) {
  return timeline.filter((e) => e.t === 'set' && Math.abs(e.to - e.from) >= min);
}

/** paint 语义的可见跳变：按宏任务分组取末值，跨组且值变化才算用户可见 */
function visibleJumps(timeline) {
  const groups = new Map();
  for (const e of timeline) {
    if (e.t !== 'set') continue;
    groups.set(e.seq, e.to); // 同任务内后写覆盖前写（无 paint）
  }
  const seqs = [...groups.keys()].sort((a, b) => a - b);
  const jumps = [];
  let prev = null;
  for (const s of seqs) {
    const v = groups.get(s);
    if (prev !== null && v !== prev) jumps.push({ fromSeq: s - 1, seq: s, from: prev, to: v, delta: v - prev });
    prev = v;
  }
  return jumps;
}

function msgList(n, prefix = 'm') {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${prefix}${i}` }));
}

// ═══════════════════════════════════════════════════════════════
// E1：指示块负 margin 补偿不变量
// ═══════════════════════════════════════════════════════════════

async function experimentE1() {
  report.push('\n== E1 指示块负 margin 补偿不变量（创建 / 详情行 0→5→2 / 移除） ==');
  const sim = createSim();
  const bh = makeBehavior(sim, { messageHeight: 120 });
  const messages = msgList(30);
  bh.setMessages(messages);
  bh.render(messages);
  bh.setFollowLatest(true);
  await clockSettle(sim);

  const base = bh.metrics();
  note(`基线: scrollHeight=${base.height} maxTop=${base.maxTop} scrollTop=${bh.container.scrollTop}`);

  // ① 创建（thinking，无详情行）
  bh.deliverStatus({ runtime: { callActive: true, stage: 'llm_thinking', thinkingChars: 100, stepElapsedLabel: '3 秒' } });
  let m = bh.metrics();
  const ind = bh.container.querySelector('#runtime-indicator-row');
  check('E1a 创建后 scrollHeight 不变', m.height === base.height, `${base.height} → ${m.height}`);
  check('E1a 创建后仍在底部', m.distToBottom === 0, `dist=${m.distToBottom}`);
  check('E1a margin = -(offsetHeight+gap)', ind.style.marginBottom === `-${ind.offsetHeight + GAP}px`,
    `offsetHeight=${ind.offsetHeight} margin=${ind.style.marginBottom}`);

  // ② 详情行 0→5（tool_executing，5 个 pending 工具）
  bh.deliverStatus({
    runtime: { callActive: true, stage: 'tool_executing' },
    pendingToolCalls: Array.from({ length: 5 }, (_, i) => ({ name: 'bash', arguments: { command: `cmd ${i}` } })),
  });
  m = bh.metrics();
  check('E1b 详情行 0→5 后 scrollHeight 不变', m.height === base.height, `${base.height} → ${m.height}`);
  check('E1b 仍在底部', m.distToBottom === 0, `dist=${m.distToBottom}`);

  // ③ 详情行 5→2
  bh.deliverStatus({
    runtime: { callActive: true, stage: 'tool_executing' },
    pendingToolCalls: [
      { name: 'read', arguments: { filePath: 'a.ts' } },
      { name: 'edit', arguments: { filePath: 'b.ts' } },
    ],
  });
  m = bh.metrics();
  check('E1c 详情行 5→2 后 scrollHeight 不变', m.height === base.height, `${base.height} → ${m.height}`);
  check('E1c 仍在底部', m.distToBottom === 0, `dist=${m.distToBottom}`);

  // ④ 指示块被移除（reset / call 完成）
  sim.__rs.resetRuntimeStatusForSwitch();
  m = bh.metrics();
  check('E1d 移除后 scrollHeight 不变', m.height === base.height, `${base.height} → ${m.height}`);
  check('E1d 仍在底部', m.distToBottom === 0, `dist=${m.distToBottom}`);

  // ⑤ 自愈验证：绕过 ensure 直接改高度（模拟两次 ensure 之间的高度漂移），下一次 ensure 修正
  bh.deliverStatus({ runtime: { callActive: true, stage: 'llm_thinking', thinkingChars: 1 } });
  const ind2 = bh.container.querySelector('#runtime-indicator-row');
  ind2._extraHeight = 40; // 注入 +40px 未补偿高度（模拟主行换行等 ensure 间窗口）
  let m2 = bh.metrics();
  note(`E1e 注入未补偿高度 +40px: scrollHeight=${base.height}→${m2.height}, dist=${m2.distToBottom}`);
  check('E1e 未补偿窗口内确实产生漂移（反证补偿的必要性）', m2.height === base.height + 40 && m2.distToBottom === 40,
    `height +${m2.height - base.height}, dist=${m2.distToBottom}`);
  bh.deliverStatus({ runtime: { callActive: true, stage: 'llm_thinking', thinkingChars: 2 } }); // 200ms 时钟等价
  m2 = bh.metrics();
  check('E1f 下一次 ensure 自愈回底部（时钟 ≤200ms）', m2.height === base.height && m2.distToBottom === 0,
    `height=${m2.height}, dist=${m2.distToBottom}`);
}

// ═══════════════════════════════════════════════════════════════
// E2：观察者抑制语义（指示块操作不产生 dom-observer notify）
// ═══════════════════════════════════════════════════════════════

async function experimentE2() {
  report.push('\n== E2 观察者抑制：指示块 DOM 变更不触发 dom-observer settle ==');
  const sim = createSim();
  const bh = makeBehavior(sim, { messageHeight: 120 });
  const messages = msgList(30);
  bh.render(messages);
  bh.setFollowLatest(true);
  await clockSettle(sim);

  const deliveriesBefore = mutationDeliveries;
  bh.deliverStatus({ runtime: { callActive: true, stage: 'llm_thinking', thinkingChars: 1 } });
  await sim.clock.flushTasks(); // MO 微任务派发
  const deliveries = mutationDeliveries - deliveriesBefore;
  check('E2a 指示块创建产生了 MO 派发（模拟浏览器行为）', deliveries >= 1, `deliveries=${deliveries}`);
  check('E2b 派发时刻处于 quiet 窗口被忽略', sim.__vp.shouldIgnoreChatViewportObserverEvent() === true,
    `quietUntil-left=${Math.max(0, sim.__vp.__getQuietUntil() - sim.clock.nowMs())}ms`);

  // 静默期过后，一个非抑制 DOM 变更应正常触发 dom-observer notify
  sim.clock.Date.now(); // noop
  const beforeCtx = sim.__vp.__getSettlementContext();
  void beforeCtx;
  sim.__vp.runWithSuppressedChatViewportObservers(() => {
    bh.container.appendChild(makeElement({ className: 'message-row user', height: 120 }));
  }, 0); // quietMs=0：不延长 quiet，仅当次同步抑制
  await sim.clock.flushTasks(200); // 越过 quietUntil
  // 手动再派发一次（模拟真实浏览器对后续任务的派发）
  bh.container.appendChild(makeElement({ className: 'message-row user', height: 120 }));
  await sim.clock.flushTasks(1);
  const ctx = sim.__vp.__getSettlementContext();
  const sawDomObserver = ctx ? [...ctx.reasons].includes('dom-observer') : false;
  check('E2c quiet 过期后的 DOM 变更正常进入 settle（reason 含 dom-observer）', sawDomObserver,
    `reasons=${ctx ? [...ctx.reasons].join(',') : 'null'}`);
}

// ═══════════════════════════════════════════════════════════════
// E3：会话切回（follow=true）：缓存恢复 → 指示块重建 → 消息增长
// ═══════════════════════════════════════════════════════════════

async function experimentE3() {
  report.push('\n== E3 会话切回（follow=true，离开期间增长 3 条消息） ==');
  const sim = createSim();
  const bh = makeBehavior(sim, { messageHeight: 120 });

  // —— 会话 A：30 条消息，跟随中，运行中（指示块在场） ——
  const A = msgList(30, 'a');
  bh.setMessages(A);
  bh.setServerMessages(A);
  bh.render(A);
  bh.setFollowLatest(true);
  bh.deliverStatus({ runtime: { callActive: true, stage: 'llm_thinking', thinkingChars: 10, stepElapsedLabel: '5 秒' } });
  await clockSettle(sim);
  const bottomA = bh.metrics();
  note(`A 底部: scrollTop=${bottomA.top}/${bottomA.maxTop} scrollHeight=${bottomA.height}（指示块在场，已补偿）`);
  check('E3a 前置：A 位于底部', bottomA.distToBottom === 0);

  // —— 离开 A → 短会话 B（无缓存） ——
  const agentB = { id: 'agent-b', active_workspace_session_id: 'session-b', workspace_sessions: { activeSessionId: 'session-b' } };
  const r1 = bh.switchAgent({ targetRuntimeId: 'runtime-b', targetSessionId: 'session-b', agentRecord: agentB });
  await clockSettle(sim);
  check('E3b B 无缓存 → setFollowLatest(true) 路径', r1.restored === false);

  // —— 离开期间 A 增长 3 条 ——
  const Agrown = [...A, ...msgList(3, 'a-new')];

  // —— 切回 A（markTask 让切换同步块成为独立 paint 组） ——
  const tlBefore = bh.container._timeline.length;
  sim.clock.markTask();
  const agentA = { id: 'agent-a', active_workspace_session_id: 'session-a', workspace_sessions: { activeSessionId: 'session-a' } };
  const r2 = bh.switchAgent({ targetRuntimeId: 'runtime-a', targetSessionId: 'session-a', agentRecord: agentA });
  await clockSettle(sim);
  let m = bh.metrics();
  note(`切回 A（缓存命中=${r2.restored}）: scrollTop=${m.top}/${m.maxTop} dist=${m.distToBottom}`);
  check('E3c [F3] 跟随切回渲染空态等待数据（不落缓存底部）',
    queryAll(bh.container, '.message-row').length === 0 && m.top === 0,
    `rows=${queryAll(bh.container, '.message-row').length} scrollTop=${m.top}`);
  check('E3d 进入窗口激活', sim.__vp.isFollowLatestEntryWindowActive() === true);

  // —— statusTask 先到：指示块重建 ——
  // [F3] 空容器上负 margin 会多扣一个 gap（无既有行时 gap×(n-1)=0），
  // 但 scrollHeight ≪ clientHeight、无滚动区间，真实浏览器还钳制
  // scrollHeight ≥ clientHeight，视觉零影响 —— 断言滚动区间不变。
  const maxTopBeforeIndicator = bh.metrics().maxTop;
  bh.deliverStatus({ runtime: { callActive: true, stage: 'tool_executing' },
    pendingToolCalls: [{ name: 'bash', arguments: { command: 'npm test' } }] });
  m = bh.metrics();
  check('E3e 指示块重建不产生滚动区间（空态过补偿不可见）',
    maxTopBeforeIndicator <= 0 && m.maxTop <= 0,
    `maxTop ${maxTopBeforeIndicator} → ${m.maxTop}（真实浏览器钳制 scrollHeight ≥ clientHeight）`);
  check('E3f 空态保持顶部等待数据', m.top === 0, `scrollTop=${m.top}`);

  // —— messagesTask 后到：全部消息（空态 → 一步落新底部） ——
  sim.clock.markTask(); // poll 响应在独立宏任务到达
  bh.setServerMessages(Agrown);
  const r3 = bh.deliverMessages();
  await clockSettle(sim);
  m = bh.metrics();
  note(`消息增长（${r3.applied}）: scrollTop=${m.top}/${m.maxTop} dist=${m.distToBottom}`);
  check('E3g 增长后收敛到新底部（dist=0）', m.distToBottom === 0, `dist=${m.distToBottom}`);

  // —— 跳变分析（[F3] 一步到位：切回期间 scrollTop 变更应只有 0→新底这一次） ——
  // 过滤 settle 的冗余重锁（to === from 的无效 set）。
  const setEvents = bh.container._timeline.slice(tlBefore).filter((e) => e.t === 'set' && e.to !== e.from);
  note(`切回过程 scrollTop set 事件共 ${setEvents.length} 次:`);
  for (const e of setEvents) note(`   #${e.seq}: ${e.from} → ${e.to}`);
  // 期望：仅 1 次（空态 0 → 新底）；不再有"缓存底 → 新底"的二次跳。
  // 指示块重建（E3e/f 已验证）与空态渲染都不应产生 scrollTop 变更。
  check('E3h 一步到位：全程仅 1 次 scrollTop 变更（0 → 新底）',
    setEvents.length === 1 && setEvents[0].from === 0 && setEvents[0].to === m.top && m.top > 0,
    `实际 ${setEvents.length} 次: ${setEvents.map((e) => `${e.from}→${e.to}`).join(', ')}`);
  check('E3h-2 无归因于指示块的小幅抖动跳变', setEvents.every((e) => Math.abs(e.to - e.from) > 100),
    `deltas=${setEvents.map((e) => e.to - e.from).join(', ')}`);
}

// ═══════════════════════════════════════════════════════════════
// E3b：会话切回（follow=false，阅读位置保持）
// ═══════════════════════════════════════════════════════════════

async function experimentE3b() {
  report.push('\n== E3b 会话切回（follow=false，从短会话 B 切回长会话 A，阅读位置 1000px） ==');
  const sim = createSim();
  const bh = makeBehavior(sim, { messageHeight: 120 });

  const A = msgList(30, 'a');
  bh.setMessages(A);
  bh.setServerMessages(A);
  bh.render(A);
  bh.setFollowLatest(true);
  await clockSettle(sim);
  // 用户上滚离开底部 → follow 自动关闭（chat-scroll.js 语义），停在 1000px
  bh.setFollowLatest(false);
  bh.container.scrollTop = 1000;
  check('E3b-前置 follow 已关闭', bh.followLatestEnabled === false);

  const agentB = { id: 'agent-b', active_workspace_session_id: 'session-b', workspace_sessions: { activeSessionId: 'session-b' } };
  bh.switchAgent({ targetRuntimeId: 'runtime-b', targetSessionId: 'session-b', agentRecord: agentB });
  await clockSettle(sim);

  const agentA = { id: 'agent-a', active_workspace_session_id: 'session-a', workspace_sessions: { activeSessionId: 'session-a' } };
  bh.switchAgent({ targetRuntimeId: 'runtime-a', targetSessionId: 'session-a', agentRecord: agentA });
  await clockSettle(sim);
  const m = bh.metrics();
  note(`切回后: scrollTop=${m.top}（期望保持 1000） dist=${m.distToBottom}`);
  // [F2 已修复] 恢复值经 setPendingChatScrollRestore 传递、由 render-full 消费为
  // preserveTop，不再经过旧会话 DOM，因此短会话切回长会话也能保住阅读位置。
  check('[F2 修复验证] follow=false 从短会话切回：阅读位置保持（1000→1000）', m.top === 1000,
    `实际 scrollTop=${m.top}`);

  // 对照（legacy 接线）：复现修复前的销毁路径 —— 直接把恢复值写进旧 DOM。
  const sim3 = createSim();
  const bh3 = makeBehavior(sim3, { messageHeight: 120 });
  const A3 = msgList(30, 'a3');
  bh3.setMessages(A3);
  bh3.setServerMessages(A3);
  bh3.render(A3);
  bh3.setFollowLatest(false);
  await clockSettle(sim3);
  bh3.container.scrollTop = 1000;
  bh3.switchAgent({
    targetRuntimeId: 'runtime-b3', targetSessionId: 'session-b3',
    agentRecord: { id: 'agent-b3', active_workspace_session_id: 'session-b3', workspace_sessions: { activeSessionId: 'session-b3' } },
  }); // B 无缓存 → 空会话
  await clockSettle(sim3);
  // legacy：手工复刻修复前的切回接线。缓存恢复 A 的 follow=false；
  // 直接在 B 的短 DOM 上写恢复值（修复前 659 行）→ 钳制到 0；
  // render-full 读 live scrollTop（=0）作为 preserveTop 写回 → 阅读位置销毁。
  bh3.setFollowLatest(false);
  bh3.container.scrollTop = 1000;
  bh3.render(A3);
  await clockSettle(sim3);
  check('E3b-1-legacy 旧接线复现销毁（1000→0，钳制 + preserveTop 写回）', bh3.container.scrollTop === 0,
    `实际 scrollTop=${bh3.container.scrollTop}`);

  // 对照：从同样长度的会话切回（无钳制场景）
  const sim2 = createSim();
  const bh2 = makeBehavior(sim2, { messageHeight: 120 });
  const A2 = msgList(30, 'a');
  bh2.setMessages(A2);
  bh2.setServerMessages(A2);
  bh2.render(A2);
  bh2.setFollowLatest(true);
  await clockSettle(sim2);
  bh2.setFollowLatest(false);
  bh2.container.scrollTop = 1000;
  // B 也渲染 30 条长内容（离开时 B 已有内容 → 切回 A 时容器是 B 的长 DOM）
  const agentB2 = { id: 'agent-b', active_workspace_session_id: 'session-b', workspace_sessions: { activeSessionId: 'session-b' } };
  bh2.switchAgent({ targetRuntimeId: 'runtime-b', targetSessionId: 'session-b', agentRecord: agentB2 });
  bh2.setServerMessages(msgList(30, 'b'));
  bh2.deliverMessages();
  await clockSettle(sim2);
  bh2.switchAgent({ targetRuntimeId: 'runtime-a', targetSessionId: 'session-a',
    agentRecord: { id: 'agent-a', active_workspace_session_id: 'session-a', workspace_sessions: { activeSessionId: 'session-a' } } });
  await clockSettle(sim2);
  const m2 = bh2.metrics();
  note(`对照组（B 为长会话）: scrollTop=${m2.top}（期望 1000）`);
  check('E3b-2 对照：B 内容足够长时位置保持', m2.top === 1000, `实际 scrollTop=${m2.top}`);
}

// ═══════════════════════════════════════════════════════════════
// E6：点击跟随最新的行为矩阵
// ═══════════════════════════════════════════════════════════════

async function experimentE6() {
  report.push('\n== E6 点击跟随最新：距离分档 × 动画中断 ==');

  // E6c 远距离（3000px）：settle 直接硬跳（设计行为）
  {
    const sim = createSim();
    const bh = makeBehavior(sim, { messageHeight: 200 });
    const messages = msgList(40);
    bh.setMessages(messages);
    bh.setServerMessages(messages);
    bh.render(messages);
    bh.setFollowLatest(false);
    await clockSettle(sim);
    const m0 = bh.metrics();
    bh.container.scrollTop = Math.max(0, m0.maxTop - 3000);
    const startTop = bh.container.scrollTop;
    const tl = bh.container._timeline.length;
    bh.setFollowLatest(true, { scroll: true, behavior: 'smooth' }); // 真实按钮参数
    await clockSettle(sim);
    const jumps = bigJumps(bh.container._timeline.slice(tl), 500);
    note(`E6c 远距离 3000px: 起点=${startTop} 终点=${bh.container.scrollTop} 单帧最大跳=${jumps[0] ? jumps[0].to - jumps[0].from : 0}`);
    check('E6c 远距离点击 = 单帧硬跳到底（设计行为确认）', bh.metrics().distToBottom === 0 && jumps.length >= 1,
      `jumps=${jumps.length}`);
  }

  // E6a 中距离（200px）：动画推进中 append 到达 —— [F1 修复] 不打断动画，平滑追到新底部
  {
    const sim = createSim();
    const bh = makeBehavior(sim, { messageHeight: 200 });
    const messages = msgList(40);
    bh.setMessages(messages);
    bh.setServerMessages(messages);
    bh.render(messages);
    bh.setFollowLatest(false);
    await clockSettle(sim);
    const m0 = bh.metrics();
    bh.container.scrollTop = m0.maxTop - 200; // 距底 200px，落在 (64,240] 动画档
    check('E6a-前置 距底 200px', bh.metrics().distToBottom === 200);

    const tl = bh.container._timeline.length;
    bh.setFollowLatest(true, { scroll: true, behavior: 'smooth' });
    // settle 需 3 帧（metricsKey 稳定 2 帧）后才启动动画，再给 2 帧动画推进
    await sim.clock.runFrames(5);
    const mid = bh.metrics();
    const moved = 200 - mid.distToBottom;
    note(`E6a 动画推进后: scrollTop=${mid.top} 已走 ${moved}px 剩余 ${mid.distToBottom}px`);
    check('E6a-1 动画确实在推进（0 < 已走 < 200，步长 ≤84）', moved > 0 && moved < 200, `moved=${moved}`);
    check('E6a-1b 此刻动画处于 smooth 巡航', sim.__vp.__isCruising() === true);

    // poll 到达：1 条新消息 append（notify preferSmooth:false，修复前会同步硬锁底）
    bh.setServerMessages([...messages, { role: 'assistant', content: 'stream chunk' }]);
    const topBeforeAppend = bh.container.scrollTop;
    bh.deliverMessages();
    const afterAppendTop = bh.container.scrollTop;
    const teleport = Math.abs(afterAppendTop - topBeforeAppend);
    await clockSettle(sim);
    note(`E6a append 到达: ${topBeforeAppend} → ${afterAppendTop}（同步位移 ${teleport}px）`);
    check('E6a-2 [F1 修复] append 不打断动画（同步位移 = 0，无闪跳）', teleport === 0, `teleport=${teleport}px`);
    check('E6a-3 最终仍在底部', bh.metrics().distToBottom === 0);

    const vj = visibleJumps(bh.container._timeline.slice(tl));
    const maxStep = vj.reduce((acc, j) => Math.max(acc, j.delta), 0);
    note(`E6a 可见步进: ${vj.map((j) => `#${j.seq} ${j.from}→${j.to}(Δ${j.delta})`).join(', ')}`);
    check('E6a-4 全程步长 ≤84px（平滑，无单帧大跳）', maxStep <= 84 + 1e-6, `maxStep=${maxStep}`);
  }

  // E6a-burst 兜底：动画巡航中一次到达巨量内容（+2000px）→ 动画自身 distance>360 硬跳追上
  {
    const sim = createSim();
    const bh = makeBehavior(sim, { messageHeight: 200 });
    const messages = msgList(40);
    bh.setMessages(messages);
    bh.setServerMessages(messages);
    bh.render(messages);
    bh.setFollowLatest(false);
    await clockSettle(sim);
    const m0 = bh.metrics();
    bh.container.scrollTop = m0.maxTop - 200;
    bh.setFollowLatest(true, { scroll: true, behavior: 'smooth' });
    await sim.clock.runFrames(5);
    check('E6a-burst 前置 动画巡航中', sim.__vp.__isCruising() === true && bh.metrics().distToBottom > 0);

    const tl = bh.container._timeline.length;
    bh.setServerMessages([...messages, ...msgList(10, 'burst')]); // +2000px
    bh.deliverMessages();
    await clockSettle(sim);
    // 动画兜底硬跳是单帧内的 set 事件（Δ>360），paint 分组语义会把它归并掉，
    // 因此这里用原始 set 步长统计。
    const setSteps = bh.container._timeline.slice(tl).filter((e) => e.t === 'set' && e.to !== e.from);
    const maxStep = setSteps.reduce((acc, e) => Math.max(acc, Math.abs(e.to - e.from)), 0);
    note(`E6a-burst 巨量 append(+2000px): set 步数=${setSteps.length} maxStep=${maxStep} 终点 dist=${bh.metrics().distToBottom}`);
    check('E6a-burst-1 落后超 360 时动画硬跳兜底生效（不会无限追赶）', maxStep > 360 && setSteps.length <= 3, `maxStep=${maxStep} steps=${setSteps.length}`);
    check('E6a-burst-2 兜底后仍精确到底', bh.metrics().distToBottom === 0);
  }

  // E6e explicit-follow settle 挂起期（<3 帧）内 append 被吸收：不立即锁底，由旧 context 决策
  {
    const sim = createSim();
    const bh = makeBehavior(sim, { messageHeight: 200 });
    const messages = msgList(40);
    bh.setMessages(messages);
    bh.setServerMessages(messages);
    bh.render(messages);
    bh.setFollowLatest(false);
    await clockSettle(sim);
    const m0 = bh.metrics();
    const tl = bh.container._timeline.length;
    bh.container.scrollTop = m0.maxTop - 200;

    bh.setFollowLatest(true, { scroll: true, behavior: 'smooth' });
    await sim.clock.runFrames(2); // settle 未完成（仅 2 帧，stable=1）
    const topBefore = bh.container.scrollTop;
    check('E6e-前置 此刻无位移（settle 未完成）', topBefore === m0.maxTop - 200);

    bh.setServerMessages([...messages, { role: 'assistant', content: 'stream chunk' }]);
    bh.deliverMessages();
    const topRightAfter = bh.container.scrollTop;
    const immediateLock = Math.abs(topRightAfter - topBefore);
    await clockSettle(sim);
    note(`E6e append 在 settle 挂起期到达: ${topBefore} → ${topRightAfter}（同步位移 ${immediateLock}px）→ 最终 ${bh.container.scrollTop}`);
    check('E6e-1 被 pending context 吸收：append 未触发同步硬锁底', immediateLock === 0,
      `同步位移=${immediateLock}px（preferSmooth 粘性 OR）`);
    check('E6e-2 settle 最终仍收敛到底部', bh.metrics().distToBottom === 0);
    const vj = visibleJumps(bh.container._timeline.slice(tl));
    note(`E6e 可见跳变: ${vj.map((j) => `#${j.seq} ${j.from}→${j.to}(Δ${j.delta})`).join(', ')}`);
  }

  // E6b 对照：中距离无中断，动画平滑完成
  {
    const sim = createSim();
    const bh = makeBehavior(sim, { messageHeight: 200 });
    const messages = msgList(40);
    bh.setMessages(messages);
    bh.setServerMessages(messages);
    bh.render(messages);
    bh.setFollowLatest(false);
    await clockSettle(sim);
    const m0 = bh.metrics();
    bh.container.scrollTop = m0.maxTop - 200;
    const tl = bh.container._timeline.length;
    bh.setFollowLatest(true, { scroll: true, behavior: 'smooth' });
    await sim.clock.runFrames(30);
    const frames = bh.container._timeline.slice(tl).filter((e) => e.t === 'set');
    const maxStep = Math.max(...frames.map((e) => Math.abs(e.to - e.from)), 0);
    check('E6b 对照：无中断时最大步长 ≤84px（平滑）', maxStep <= 84, `maxStep=${maxStep}`);
    check('E6b 对照：最终到底', bh.metrics().distToBottom === 0);
  }

  // E6d 进入窗口内点击跟随（切回后 1.2s 内）：forceSnap 硬跳
  {
    const sim = createSim();
    const bh = makeBehavior(sim, { messageHeight: 200 });
    const A = msgList(40, 'a');
    bh.setMessages(A);
    bh.setServerMessages(A);
    bh.render(A);
    bh.setFollowLatest(false);
    await clockSettle(sim);
    bh.container.scrollTop = 1000;
    const agentB = { id: 'agent-b', active_workspace_session_id: 'session-b', workspace_sessions: { activeSessionId: 'session-b' } };
    bh.switchAgent({ targetRuntimeId: 'runtime-b', targetSessionId: 'session-b', agentRecord: agentB });
    const agentA = { id: 'agent-a', active_workspace_session_id: 'session-a', workspace_sessions: { activeSessionId: 'session-a' } };
    bh.switchAgent({ targetRuntimeId: 'runtime-a', targetSessionId: 'session-a', agentRecord: agentA });
    await clockSettle(sim);
    bh.setFollowLatest(false); // restore 恢复了 follow=false
    bh.container.scrollTop = 1000;
    check('E6d-前置 进入窗口激活', sim.__vp.isFollowLatestEntryWindowActive() === true);
    bh.setFollowLatest(true, { scroll: true, behavior: 'smooth' });
    await clockSettle(sim);
    check('E6d 进入窗口内 smooth 请求仍被 forceSnap（无动画）', bh.metrics().distToBottom === 0);
  }
}

// ═══════════════════════════════════════════════════════════════
// E7：poll 内多源交错（append + 状态块详情行膨胀同 tick）
// ═══════════════════════════════════════════════════════════════

async function experimentE7() {
  report.push('\n== E7 同一 poll tick：消息 append + 指示块详情行 0→5 交错 ==');
  const sim = createSim();
  const bh = makeBehavior(sim, { messageHeight: 120 });
  const A = msgList(30, 'a');
  bh.setMessages(A);
  bh.setServerMessages(A);
  bh.render(A);
  bh.setFollowLatest(true);
  await clockSettle(sim);

  // 模拟真实 poll 顺序：messages 先 commit（append），status 后到（详情行膨胀）
  const grown = [...A, { role: 'assistant', content: 'chunk1' }];
  bh.setServerMessages(grown);
  const tl = bh.container._timeline.length;
  bh.deliverMessages(); // append + ensure(旧快照 thinking 无详情)
  bh.deliverStatus({ runtime: { callActive: true, stage: 'tool_executing' },
    pendingToolCalls: Array.from({ length: 5 }, (_, i) => ({ name: 'bash', arguments: { command: `c${i}` } })) });
  await clockSettle(sim);
  const m = bh.metrics();
  const jumps = bigJumps(bh.container._timeline.slice(tl));
  note(`同 tick 交错后: dist=${m.distToBottom} 跳变=${jumps.length} 次 (${jumps.map((j) => `${j.from}→${j.to}`).join(', ')})`);
  check('E7a 交错后仍精确在底部', m.distToBottom === 0);
  check('E7b 只有一次跳变（append 锁底），指示块膨胀零贡献', jumps.length <= 1,
    `jumps=${jumps.map((j) => `${j.from}→${j.to}`).join(', ')}`);
}

// ═══════════════════════════════════════════════════════════════

async function clockSettle(sim) {
  // settle 协议：timer(0) + 3 个 rAF 帧（metricsKey 稳定 2 帧）
  await sim.clock.flushTasks();
  await sim.clock.runFrames(6);
}

// ═══════════════════════════════════════════════════════════════

async function main() {
  await experimentE1();
  await experimentE2();
  await experimentE3();
  await experimentE3b();
  await experimentE6();
  await experimentE7();

  console.log(report.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('SIM CRASHED:', err);
  process.exitCode = 1;
});
