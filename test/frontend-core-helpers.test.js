/**
 * Example front-end module tests using the VM sandbox framework.
 *
 * Tests pure/near-pure functions from public/src/app-core.js.
 * This demonstrates the scaffold pattern for future front-end testing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * Helper: create a sandbox with app-core.js loaded.
 * app-core.js is the shared utilities module — it defines i18n, status helpers,
 * date formatters, and runtime cache functions used across the front-end.
 */
function createCoreSandbox(overrides = {}) {
  const ctx = createFrontendSandbox();
  ctx.getCurrentAgentRecord = () => null;
  ctx.loadSource('public/src/app-core.js');
  // Apply overrides AFTER loading source.
  // `let`/`const` in VM don't become context properties, so use runInContext.
  for (const [key, value] of Object.entries(overrides)) {
    ctx[key] = value;
    // Also set inside the VM context for `let`-declared globals
    ctx.run(`if (typeof ${key} !== 'undefined') ${key} = ${JSON.stringify(value)};`);
  }
  return ctx;
}

// ── getCurrentControlAgentId ──

describe('app-core: getCurrentControlAgentId', () => {
  // createCoreSandbox 的 overrides 循环用 JSON.stringify 注入值，函数值会被
  // 置为 undefined；函数替身一律直接挂 context 属性（app-core 未用 let 声明
  // 这些名字，属性不会被遮蔽）。currentRuntimeAgentId 在沙箱内有 let 绑定，
  // 必须经 ctx.run 赋值才会被脚本看到。
  function coreWithControlId() {
    return createCoreSandbox();
  }

  it('prefers the logical id of the current local agent record', () => {
    const ctx = coreWithControlId();
    ctx.getCurrentAgentRecord = () => ({ source: 'prebuilt', id: 'programming-helper' });
    assert.equal(ctx.run('getCurrentControlAgentId()'), 'programming-helper');
  });

  it('falls back to the remote catalog entry host for remote sessions', () => {
    const ctx = coreWithControlId();
    ctx.getCurrentAgentRecord = () => null;
    ctx.run('currentRuntimeAgentId = "remote:server-a:rt-1"');
    ctx.window.RemoteConnections = {
      getEntryHostAgentId: (ref) => (ref === 'remote:server-a:rt-1' ? 'programming-helper' : null),
    };
    assert.equal(ctx.run('getCurrentControlAgentId()'), 'programming-helper');
  });

  it('returns null for local ids without a record and without RemoteConnections', () => {
    const ctx = coreWithControlId();
    ctx.getCurrentAgentRecord = () => null;
    ctx.run('currentRuntimeAgentId = "plain-agent"');
    assert.equal(ctx.run('getCurrentControlAgentId()'), null);

    const noModule = coreWithControlId();
    noModule.getCurrentAgentRecord = () => null;
    noModule.run('currentRuntimeAgentId = "remote:server-a:rt-1"');
    assert.equal(noModule.run('getCurrentControlAgentId()'), null);
  });
});

// ── getFeatureStatus ──

describe('app-core: getFeatureStatus', () => {
  it('returns explicit status when present', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('getFeatureStatus({ status: "enabled" })'), 'enabled');
    assert.equal(ctx.run('getFeatureStatus({ status: "disabled" })'), 'disabled');
    assert.equal(ctx.run('getFeatureStatus({ status: "partial" })'), 'partial');
  });

  it('returns enabled when feature.enabled is true and no status', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('getFeatureStatus({ enabled: true })'), 'enabled');
  });

  it('returns partial when no status and not enabled', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('getFeatureStatus({ enabled: false })'), 'partial');
    assert.equal(ctx.run('getFeatureStatus({})'), 'partial');
  });

  it('returns partial for null/undefined feature', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('getFeatureStatus(null)'), 'partial');
    assert.equal(ctx.run('getFeatureStatus(undefined)'), 'partial');
  });
});

// ── getStatusBadgeClass ──

describe('app-core: getStatusBadgeClass', () => {
  it('builds badge class from status', () => {
    const ctx = createCoreSandbox();
    assert.equal(
      ctx.run('getStatusBadgeClass("enabled")'),
      'feature-badge status-enabled'
    );
    assert.equal(
      ctx.run('getStatusBadgeClass("disabled")'),
      'feature-badge status-disabled'
    );
  });

  it('defaults to enabled when status is falsy', () => {
    const ctx = createCoreSandbox();
    assert.equal(
      ctx.run('getStatusBadgeClass(null)'),
      'feature-badge status-enabled'
    );
    assert.equal(
      ctx.run('getStatusBadgeClass("")'),
      'feature-badge status-enabled'
    );
    assert.equal(
      ctx.run('getStatusBadgeClass(undefined)'),
      'feature-badge status-enabled'
    );
  });

  it('escapes HTML-special characters in status', () => {
    const ctx = createCoreSandbox();
    const result = ctx.run('getStatusBadgeClass("<script>")');
    assert.ok(!result.includes('<script>'));
    assert.ok(result.includes('&lt;script&gt;'));
  });
});

// ── localizeWorkspaceValue ──

describe('app-core: localizeWorkspaceValue', () => {
  it('returns string values as-is', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('localizeWorkspaceValue("hello")'), 'hello');
    assert.equal(ctx.run('localizeWorkspaceValue(42)'), '42');
    assert.equal(ctx.run('localizeWorkspaceValue(true)'), 'true');
  });

  it('returns fallback for null/undefined', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('localizeWorkspaceValue(null, "default")'), 'default');
    assert.equal(ctx.run('localizeWorkspaceValue(undefined, "default")'), 'default');
  });

  it('extracts value by currentLanguage from object', () => {
    const ctx = createCoreSandbox({ currentLanguage: 'zh' });
    const result = ctx.run('localizeWorkspaceValue({ zh: "中文", en: "English" })');
    assert.equal(result, '中文');
  });

  it('falls back to zh then en then fallback for objects', () => {
    const ctx = createCoreSandbox({ currentLanguage: 'fr' });
    assert.equal(
      ctx.run('localizeWorkspaceValue({ zh: "中文", en: "English" })'),
      '中文'
    );
    assert.equal(
      ctx.run('localizeWorkspaceValue({ en: "English" })'),
      'English'
    );
    // When currentLanguage matches a key, it takes priority
    assert.equal(
      ctx.run('localizeWorkspaceValue({ fr: "Français" })'),
      'Français'
    );
    // Fallback only when no matching language key at all
    assert.equal(
      ctx.run('localizeWorkspaceValue({ de: "Deutsch" }, "fallback")'),
      'fallback'
    );
  });
});

// ── formatWorkspaceDate ──

describe('app-core: formatWorkspaceDate', () => {
  it('returns dash for empty input', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('formatWorkspaceDate("")'), '-');
    assert.equal(ctx.run('formatWorkspaceDate(null)'), '-');
    assert.equal(ctx.run('formatWorkspaceDate(undefined)'), '-');
  });

  it('returns original string for invalid date', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('formatWorkspaceDate("not-a-date")'), 'not-a-date');
  });

  it('formats valid ISO date string', () => {
    const ctx = createCoreSandbox();
    const result = ctx.run('formatWorkspaceDate("2024-06-15T10:30:00Z")');
    assert.ok(result.includes('2024') || result.includes('6') || result.includes('15'));
    assert.ok(result !== '-');
  });
});

// ── isUiOnlyAgentId ──

describe('app-core: pending session navigation', () => {
  it('keeps a pending target scoped to the current navigation epoch and workspace', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('beginPendingSessionNavigation("programming-helper", "session-new")').sessionId, 'session-new');
    assert.equal(ctx.run('hasPendingSessionNavigation({ id: "programming-helper" })'), true);
    assert.equal(ctx.run('hasPendingSessionNavigation({ id: "other-workspace" })'), false);
    ctx.run('bumpNavigationGuard()');
    assert.equal(ctx.run('hasPendingSessionNavigation({ id: "programming-helper" })'), false);
  });

  it('updates the committed target without losing its navigation scope', () => {
    const ctx = createCoreSandbox();
    ctx.run('beginPendingSessionNavigation("programming-helper")');
    assert.equal(ctx.run('updatePendingSessionNavigation("session-new", "starting-runtime").phase'), 'starting-runtime');
    assert.equal(ctx.run('hasPendingSessionNavigation({ id: "programming-helper" })'), true);
    ctx.run('clearPendingSessionNavigation()');
    assert.equal(ctx.run('hasPendingSessionNavigation({ id: "programming-helper" })'), false);
  });
});

// ── isUiOnlyAgentId ──

describe('app-core: isUiOnlyAgentId', () => {
  it('returns true for known UI-only agent IDs', () => {
    const ctx = createCoreSandbox({
      allAgents: [
        { id: 'feature-setup', source: 'prebuilt', launchMode: 'ui-only' },
      ],
    });
    assert.equal(ctx.run('isUiOnlyAgentId("feature-setup")'), true);
  });

  it('returns true for workspace host agents (kind: workspace)', () => {
    // isUiOnlyAgentId checks isWorkspaceSurfaceUnit which includes both
    // ui-only units and workspace host units (kind: "workspace" in metadata)
    const ctx = createCoreSandbox({
      allAgents: [
        { id: 'programming-helper', source: 'prebuilt', kind: 'workspace' },
      ],
    });
    assert.equal(ctx.run('isUiOnlyAgentId("programming-helper")'), true);
  });

  it('returns false for unknown/null IDs when allAgents is empty', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('isUiOnlyAgentId("nonexistent")'), false);
    assert.equal(ctx.run('isUiOnlyAgentId(null)'), false);
  });
});

// ── getRuntimeCacheTodoPlanSignature ──

describe('app-core: getRuntimeCacheTodoPlanSignature', () => {
  it('produces stable signature for same plan', () => {
    const ctx = createCoreSandbox();
    const sig1 = ctx.run('getRuntimeCacheTodoPlanSignature([{subject:"a",status:"pending"}])');
    const sig2 = ctx.run('getRuntimeCacheTodoPlanSignature([{subject:"a",status:"pending"}])');
    assert.ok(typeof sig1 === 'string');
    assert.ok(sig1.length > 0);
    assert.equal(sig1, sig2, 'same plan should produce same signature');
  });

  it('produces different signatures for different plans', () => {
    const ctx = createCoreSandbox();
    const sig1 = ctx.run('getRuntimeCacheTodoPlanSignature([{subject:"a",status:"pending"}])');
    const sig2 = ctx.run('getRuntimeCacheTodoPlanSignature([{subject:"b",status:"pending"}])');
    assert.notEqual(sig1, sig2);
  });
});

// ── Sandbox infrastructure ──

describe('frontend-vm sandbox', () => {
  it('provides localStorage stub that persists', () => {
    const ctx = createFrontendSandbox();
    ctx.run('localStorage.setItem("key", "value")');
    assert.equal(ctx.run('localStorage.getItem("key")'), 'value');
    ctx.run('localStorage.removeItem("key")');
    assert.equal(ctx.run('localStorage.getItem("key")'), null);
  });

  it('provides document stub with createElement', () => {
    const ctx = createFrontendSandbox();
    const el = ctx.run('document.createElement("div")');
    assert.ok(el);
    assert.ok(typeof el.appendChild === 'function');
  });

  it('provides escapeHtml stub', () => {
    const ctx = createFrontendSandbox();
    assert.equal(ctx.run('escapeHtml("<b>")'), '&lt;b&gt;');
  });

  it('supports overriding currentLanguage', () => {
    const ctx = createFrontendSandbox({ currentLanguage: 'en' });
    assert.equal(ctx.run('currentLanguage'), 'en');
  });
});

// ── runtime status interrupt suppression ──

function createRuntimeStatusSandbox() {
  const elements = new Map();
  function createElementStub(id) {
    return {
      id,
      style: {},
      className: '',
      textContent: '',
      innerHTML: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    };
  }
  for (const id of ['notification-status', 'notification-phase', 'notification-summary', 'notification-metrics']) {
    elements.set(id, createElementStub(id));
  }

  const document = {
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: createElementStub,
    addEventListener() {},
    body: createElementStub('body'),
    head: createElementStub('head'),
    documentElement: createElementStub('html'),
    readyState: 'complete',
  };

  const ctx = createFrontendSandbox({
    document,
    currentRuntimeAgentId: 'runtime-1',
    _switchEpoch: 1,
    currentRuntimeConnected: true,
    captureSessionViewToken: (runtimeId) => ({ runtimeId, switchEpoch: 1 }),
    isSessionViewTokenCurrent: () => true,
    commitSessionViewState: (_token, apply) => { apply(); return true; },
    currentInputRequests: [],
    lastRenderedInputMode: 'persistent',
    currentLanguage: 'zh',
    renderAgentList() {},
    _syncPersistentActionButton() {},
    _syncPersistentInputUi() {},
    _syncQueueFromBackend() {},
    _markAgentCallStartedForNotify() {},
    _renderLastCallElapsed() {},
    _recapPendingTrigger: false,
    _maybeFetchRecap() {},
    normalizeAgentIdentity(value) {
      return String(value || '').trim();
    },
    getInputSurfaceMode() { return 'persistent'; },
    renderInputRequests() {},
    setCurrentHookInspector() {},
    setCurrentOverviewSnapshot() {},
    setCurrentTodoPlan() {},
    getEmptyOverviewSnapshot: () => ({}),
    getEmptyTodoPlan: () => ({}),
    notifyInputSurfaceChanged() {},
  });
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.run(`
    currentRuntimeAgentId = "runtime-1";
    currentRuntimeConnected = true;
    currentHookInspector = null;
    currentOverviewSnapshot = {};
    currentTodoPlan = {};
    applySessionViewPatch({ identity: { agentId: 'runtime-1', sessionId: 'session-1' } });
    currentInputRequests = [];
    lastRenderedInputMode = "persistent";
  `);
  ctx.loadSource('public/src/modules/runtime-status.js');
  return { ctx, elements };
}

describe('runtime-status: interrupt suppression', () => {
  it('keeps stale callActive notifications in sticky interrupting state', () => {
    const { ctx, elements } = createRuntimeStatusSandbox();

    ctx.run(`
      markInterruptPending("runtime-1", 1000);
      _agentCallActive.delete("runtime-1");
      updateNotificationStatus({
        callActive: true,
        runtime: {
          callActive: true,
          stage: "awaiting_runtime",
          updatedAt: Date.now(),
          callStartedAt: 1000,
          stageStartedAt: Date.now()
        },
        state: { type: "llm.char_count", data: { phase: "content", charCount: 10 }, timestamp: Date.now() }
      });
    `);

    assert.equal(elements.get('notification-status').style.display, 'flex');
    assert.equal(elements.get('notification-phase').textContent, '正在停止…');
    assert.equal(ctx.run('isRuntimeCalling("runtime-1")'), false);
    assert.equal(ctx.run('isInterruptSuppressed("runtime-1", 1000)'), true);
    ctx.run('if (typeof _notificationClockTimer !== "undefined" && _notificationClockTimer) clearInterval(_notificationClockTimer);');
  });

  it('only releases interrupting for a terminal event or a newer call identity', () => {
    const { ctx } = createRuntimeStatusSandbox();
    ctx.run(`
      markInterruptPending("runtime-1", 1000);
      updateNotificationStatus({
        callActive: true,
        runtime: { callActive: true, callStartedAt: 2000, stage: "llm_thinking" }
      });
    `);
    assert.equal(ctx.run('isInterruptSuppressed("runtime-1", 2000)'), false);
    assert.equal(ctx.run('isRuntimeCalling("runtime-1")'), true);

    ctx.run(`
      markInterruptPending("runtime-1", 2000);
      updateNotificationStatus({
        callActive: false,
        runtime: { callActive: false, callStartedAt: 2000, stage: "idle" },
        state: { type: "call.finish", timestamp: Date.now() }
      });
    `);
    assert.equal(ctx.run('isInterruptSuppressed("runtime-1", 2000)'), false);
    assert.equal(ctx.run('isRuntimeCalling("runtime-1")'), false);
    ctx.run('if (typeof _notificationClockTimer !== "undefined" && _notificationClockTimer) clearInterval(_notificationClockTimer);');
  });
});

// ── desktop notification finish visibility ──

function createDesktopNotifySandbox() {
  const notifications = [];
  const ctx = createFrontendSandbox({
    allAgents: [{ id: 'runtime-1', name: 'Runtime One' }],
    currentLanguage: 'en',
    // 页面真实环境中 app-core.js 先加载声明该全局（侧栏「刚刚完成」蓝灯状态）
    _recentlyFinishedRuntimes: new Set(),
    normalizeAgentIdentity(value) {
      return String(value || '').trim();
    },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    Notification: function TestNotification(title, options) {
      notifications.push({ title, options });
      return { close() {} };
    },
    Blob: function TestBlob() {},
    URL: { createObjectURL: () => 'blob:test' },
    Worker: function TestWorker() {},
  });
  ctx.Notification.permission = 'granted';
  ctx.window.focus = () => {};
  ctx.window.handlePrebuiltAgentClick = () => {};
  ctx.window.switchAgent = () => {};
  ctx.document.hidden = false;
  ctx.document.hasFocus = () => true;
  ctx.loadSource('public/src/modules/desktop-notify.js');
  return { ctx, notifications };
}

describe('desktop-notify: finish visibility', () => {
  it('焦点会话完成不弹（正盯着）；非焦点会话完成照常弹（含页面在前台）', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    // 页面在前台（旧语义会全静默；新语义只看会话焦点）
    ctx.run('_syncForegroundState()');
    ctx.run('allAgents = [{ id: "ph", name: "PH", runtime_session_id: "runtime-1" }, { id: "other", name: "Other", runtime_session_id: "runtime-2" }]');
    ctx.run('currentRuntimeAgentId = "runtime-1"');

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", finishTs: ' + (Date.now() - 1000) + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notifications.length, 0); // 焦点会话：正盯着，不弹

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-2", finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notifications.length, 1); // 非焦点会话：前台也照常弹
  });

  it('allows a later unseen finish notification while Claw is hidden', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    const foregroundTs = Date.now();
    ctx.run(`_syncForegroundState()`);
    ctx.run(`_lastForegroundTs = ${foregroundTs - 10000}`);
    ctx.document.hidden = true;
    ctx.document.hasFocus = () => false;
    ctx.run(`_markAgentCallStartedForNotify("runtime-1")`);

    await ctx.run(`_presentAppNotification({
      type: "finish",
      agentId: "runtime-1",
      finishTs: ${foregroundTs}
    })`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
  });

  it('页面失焦（最小化/后台/被遮挡）时当前选中会话完成也照常弹', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    ctx.run('currentRuntimeAgentId = "runtime-1"');
    ctx.run('_markAgentCallStartedForNotify("runtime-1")');
    // 页面失焦：微信盖在上面 / 最小化 / 后台标签
    ctx.document.hidden = true;
    ctx.document.hasFocus = () => false;

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", runtimeAgentId: "runtime-1", finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notifications.length, 1);
  });

  it('Tauri 壳：持久通知走原生 command，不再触发 Web Notification（避免双弹）', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    const invokes = [];
    ctx.window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => { invokes.push({ cmd, args }); },
    };
    ctx.run('currentRuntimeAgentId = "runtime-2"'); // 完成的是非焦点会话

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(invokes.length, 1);
    assert.equal(invokes[0].cmd, 'persistent_notification');
    assert.equal(notifications.length, 0); // 原生已发，Web API 不再发
  });

  it('Tauri 壳 invoke 失败：回退 Web Notification（保留 requireInteraction 语义）', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    ctx.window.__TAURI_INTERNALS__ = {
      invoke: async () => { throw new Error('denied'); },
    };
    ctx.run('currentRuntimeAgentId = "runtime-2"');

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].options.requireInteraction, true);
  });

  it('Tauri 壳：invoke 携带 navPayload（原生 toast 点击后定位会话的数据）', async () => {
    const { ctx } = createDesktopNotifySandbox();
    const invokes = [];
    ctx.window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => { invokes.push({ cmd, args }); },
    };
    ctx.run('currentRuntimeAgentId = "runtime-2"');

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(invokes.length, 1);
    const nav = JSON.parse(invokes[0].args.navPayload);
    assert.equal(nav.runtimeId, 'runtime-1');
    assert.equal(nav.agentId, 'runtime-1');
  });

  it('原生 toast 点击激活：__clawConsumeNotificationActivation 按导航意图落点', () => {
    const { ctx } = createDesktopNotifySandbox();
    const switched = [];
    const opened = [];
    ctx.window.switchAgent = (id) => { switched.push(id); };
    ctx.window.openConversationTarget = (t) => { opened.push(t); };

    // threadId 优先：精确到会话（memo 提醒等 APP 直投类）
    ctx.window.__clawConsumeNotificationActivation(JSON.stringify({ agentId: 'memo', threadId: 'th-1' }));
    // vm realm 对象与宿主原型不同，deepEqual 会误判——按字段断言
    assert.equal(opened.length, 1);
    assert.equal(opened[0].threadId, 'th-1');
    assert.equal(opened[0].agentId, 'memo');
    assert.equal(switched.length, 0);

    // 无 threadId：按 runtime id 切会话（完成通知）
    ctx.window.__clawConsumeNotificationActivation(JSON.stringify({ runtimeId: 'runtime-1' }));
    assert.deepEqual(switched, ['runtime-1']);
    assert.equal(opened.length, 1);
  });

  it('新一轮 call 开始：清除「刚刚完成」蓝灯（_recentlyFinishedRuntimes）', () => {
    const { ctx } = createDesktopNotifySandbox();
    ctx.run('_recentlyFinishedRuntimes.add("runtime-1")');
    ctx.run('_markAgentCallStartedForNotify("runtime-1")');
    assert.equal(ctx.run('_recentlyFinishedRuntimes.has("runtime-1")'), false);
  });
});

// ── desktop-notify: Worker 心跳（ADR-0030：仅前台时钟同步）─────────────
// 心跳 IIFE 闭包不可直接触达：Worker stub 捕获 onmessage，测试手动发 tick。
// 通知本体由 app-notification 帧实时驱动，心跳不再承担任何轮询/重扫职责。

function createHeartbeatSandbox() {
  const fetches = [];
  class CapturingWorker {
    constructor() { CapturingWorker.last = this; }
    set onmessage(fn) { this._onmessage = fn; }
    get onmessage() { return this._onmessage; }
  }
  const ctx = createFrontendSandbox({
    allAgents: [{ id: 'runtime-1', name: 'Runtime One' }],
    currentLanguage: 'en',
    normalizeAgentIdentity(value) { return String(value || '').trim(); },
    isSseActive() { return false; },
    fetch: async (url) => {
      fetches.push(String(url));
      return { ok: true, json: async () => ({ alerts: [] }) };
    },
    Notification: function TestNotification() { return { close() {} }; },
    Blob: function TestBlob() {},
    URL: { createObjectURL: () => 'blob:test' },
    Worker: CapturingWorker,
  });
  ctx.Notification.permission = 'granted';
  ctx.window.focus = () => {};
  ctx.document.hasFocus = () => true;
  ctx.document.hidden = false;
  ctx.loadSource('public/src/modules/desktop-notify.js');
  const tick = () => CapturingWorker.last._onmessage({ data: 'tick' });
  return { ctx, tick, fetches };
}

describe('desktop-notify: Worker 心跳（ADR-0030：仅前台时钟同步）', () => {
  it('后台 tick：只刷新前台时钟，不触发任何轮询或 fetch', () => {
    const { ctx, tick, fetches } = createHeartbeatSandbox();
    ctx.document.hidden = true;
    ctx.document.hasFocus = () => false;
    const before = ctx.run('_lastForegroundTs');
    tick();
    assert.equal(fetches.length, 0); // 通知职责已由 app-notification 帧驱动
    assert.equal(ctx.run('_lastForegroundTs'), before); // 后台不推进时钟
  });

  it('前台 tick：刷新前台时钟（宽限期判定的时间源）', () => {
    const { ctx, tick } = createHeartbeatSandbox();
    ctx.run('_lastForegroundTs = 0');
    tick();
    assert.ok(ctx.run('_lastForegroundTs') > 0);
  });
});

describe('desktop-notify: input 帧呈现（choice 通知，ADR-0030）', () => {
  it('焦点会话的 choice 不弹（正盯着卡片）；非焦点会话照常弹', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    ctx.run('_syncForegroundState()');
    ctx.run('allAgents = [{ id: "ph", name: "PH", runtime_session_id: "runtime-1" }, { id: "other", name: "Other", runtime_session_id: "runtime-2" }]');
    ctx.run('currentRuntimeAgentId = "runtime-1"');

    // 焦点会话 choice：正盯着，不弹
    ctx.run('_presentAppNotification({ type: "input", agentId: "runtime-1", requestId: "req-a" })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notifications.length, 0);

    // 非焦点会话 choice：照常弹
    ctx.run('_presentAppNotification({ type: "input", agentId: "runtime-2", requestId: "req-a2" })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notifications.length, 1);
  });

  it('后台同 requestId 30s 内重放不重复弹；新 requestId（新一轮 choice）照常弹', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    ctx.document.hidden = true;
    ctx.document.hasFocus = () => false;
    ctx.run(`_lastForegroundTs = ${Date.now() - 60000}`);
    ctx.run('_presentAppNotification({ type: "input", agentId: "runtime-1", requestId: "req-b" })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctx.run('_presentAppNotification({ type: "input", agentId: "runtime-1", requestId: "req-b" })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notifications.length, 1); // requestId 去重挡住重放

    ctx.run('_presentAppNotification({ type: "input", agentId: "runtime-1", requestId: "req-c" })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notifications.length, 2); // 新 requestId 照常弹
  });
});
