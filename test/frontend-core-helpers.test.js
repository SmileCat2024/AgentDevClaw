/**
 * Example front-end module tests using the VM sandbox framework.
 *
 * Tests pure/near-pure functions from public/src/app-core.js.
 * This demonstrates the scaffold pattern for future front-end testing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { getRuntimeCacheTodoPlanSignature } from '../public/src/modules/runtime-view-cache.js';
import { installCallInterruptState } from './helpers/call-interrupt.js';
import { createTimeFormat } from '../public/src/modules/time-format.js';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, prepareEsmModules, prepareSidebarDomain, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

// 身份解析域（P4 T1 从 app-core 抽出）：夹具按真实源码装载该域（去 export 前缀）。
const identitySource = fs.readFileSync(new URL('../public/src/modules/identity.js', import.meta.url), 'utf8');
// 展示格式化函数族（P4 T1 从 app-core 抽出）：同样按真实源码装载。切片保留
// 生产依赖名（getCurrentLanguage / escapeHtml / t），沙箱按 classic 等价提供。
const formatSource = fs.readFileSync(new URL('../public/src/modules/format-utils.js', import.meta.url), 'utf8');
const formatBlock = formatSource
  .slice(
    formatSource.indexOf('export function formatPresetDisplayName'),
    formatSource.indexOf('// ── classic 兼容桥'),
  )
  .replace(/^export /gm, '')
  + 'function getCurrentLanguage() { return currentLanguage; }\n';
const identityBlock = identitySource
  .slice(
    identitySource.indexOf('/** app-core 的宿主记录读取器（classic，经 window 晚绑定）。 */'),
    identitySource.indexOf('// ── classic 兼容桥'),
  )
  .replace(/^export /gm, '');

/**
 * 用例基座：真实 classic 沙箱 + 真实 ESM 图（app-core 自 P4 T5 起是 ESM）。
 *
 * app-core 的桥键 / 宿主工厂在模块相注册，因此 baseline 部分（identityBlock /
 * formatBlock 的源码装载、call-interrupt owner、时间格式化面）都必须在
 * withP2EsmCase 的 classic 回调之后就绪；断言在 `body(ctx)` 里跑，仍读到同一个
 * 沙箱 window（`ctx.run` 的 classic 词法面与桥键）。
 */
async function withCore(overrides, body) {
  return withP2EsmCase({
    classic: (sandbox) => prepareEsmModules(sandbox, APP_CORE_DOMAIN),
  }, async (c) => {
    const sandbox = c.window;
    // 身份域与格式化族（真实实现，与生产模块同一份源码）
    sandbox.run(identityBlock);
    sandbox.run(formatBlock);
    sandbox.run('window.getCurrentAgentRecord = () => null;');
    Object.assign(sandbox, createTimeFormat(() => sandbox.currentLanguage));
    // call-interrupt 的四个桥键由 app-core 在模块相注册：owner 校验在图求值后。
    installCallInterruptState(sandbox);
    // Apply overrides AFTER loading source（let/const 词法绑定要经 run 赋值；
    // 状态键的桥访问器此时已注册，赋值落到 owner 的哑存储 / 域状态）。
    for (const [key, value] of Object.entries(overrides || {})) {
      sandbox[key] = value;
      sandbox.run(`if (typeof ${key} !== 'undefined') ${key} = ${JSON.stringify(value)};`);
    }
    return body(sandbox);
  });
}

// ── getCurrentControlAgentId（identity 域，P4 T1 起不再在 app-core）──

describe('identity: getCurrentControlAgentId', () => {
  // 函数替身一律直接挂 context 属性（app-core 不把这些名字声明成词法绑定，
  // 属性不会被遮蔽）；currentRuntimeAgentId 的 owner 在 orchestration-state，
  // 必须经 ctx.run 赋值才会被模块看到。
  it('prefers the logical id of the current local agent record', async () => {
    await withCore({}, (ctx) => {
      ctx.getCurrentAgentRecord = () => ({ source: 'prebuilt', id: 'programming-helper' });
      assert.equal(ctx.run('getCurrentControlAgentId()'), 'programming-helper');
    });
  });

  it('falls back to the remote catalog entry host for remote sessions', async () => {
    await withCore({}, (ctx) => {
      ctx.getCurrentAgentRecord = () => null;
      ctx.run('currentRuntimeAgentId = "remote:server-a:rt-1"');
      ctx.window.RemoteConnections = {
        getEntryHostAgentId: (ref) => (ref === 'remote:server-a:rt-1' ? 'programming-helper' : null),
      };
      assert.equal(ctx.run('getCurrentControlAgentId()'), 'programming-helper');
    });
  });

  it('returns null for local ids without a record and without RemoteConnections', async () => {
    await withCore({}, (ctx) => {
      ctx.getCurrentAgentRecord = () => null;
      ctx.run('currentRuntimeAgentId = "plain-agent"');
      assert.equal(ctx.run('getCurrentControlAgentId()'), null);
    });
    await withCore({}, (noModule) => {
      noModule.getCurrentAgentRecord = () => null;
      noModule.run('currentRuntimeAgentId = "remote:server-a:rt-1"');
      assert.equal(noModule.run('getCurrentControlAgentId()'), null);
    });
  });
});

// ── getFeatureStatus ──

describe('format-utils: getFeatureStatus', () => {
  it('returns explicit status when present', () => withCore({}, (ctx) => {
    assert.equal(ctx.run('getFeatureStatus({ status: "enabled" })'), 'enabled');
    assert.equal(ctx.run('getFeatureStatus({ status: "disabled" })'), 'disabled');
    assert.equal(ctx.run('getFeatureStatus({ status: "partial" })'), 'partial');
  }));

  it('returns enabled when feature.enabled is true and no status', () => withCore({}, (ctx) => {
    assert.equal(ctx.run('getFeatureStatus({ enabled: true })'), 'enabled');
  }));

  it('returns partial when no status and not enabled', () => withCore({}, (ctx) => {
    assert.equal(ctx.run('getFeatureStatus({ enabled: false })'), 'partial');
    assert.equal(ctx.run('getFeatureStatus({})'), 'partial');
  }));

  it('returns partial for null/undefined feature', () => withCore({}, (ctx) => {
    assert.equal(ctx.run('getFeatureStatus(null)'), 'partial');
    assert.equal(ctx.run('getFeatureStatus(undefined)'), 'partial');
  }));
});

// ── getStatusBadgeClass ──

describe('format-utils: getStatusBadgeClass', () => {
  it('builds badge class from status', () => withCore({}, (ctx) => {
    assert.equal(
      ctx.run('getStatusBadgeClass("enabled")'),
      'feature-badge status-enabled'
    );
    assert.equal(
      ctx.run('getStatusBadgeClass("disabled")'),
      'feature-badge status-disabled'
    );
  }));

  it('defaults to enabled when status is falsy', () => withCore({}, (ctx) => {
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
  }));

  it('escapes HTML-special characters in status', () => withCore({}, (ctx) => {
    const result = ctx.run('getStatusBadgeClass("<script>")');
    assert.ok(!result.includes('<script>'));
    assert.ok(result.includes('&lt;script&gt;'));
  }));
});

// ── localizeWorkspaceValue ──

describe('format-utils: localizeWorkspaceValue', () => {
  it('returns string values as-is', () => withCore({}, (ctx) => {
    assert.equal(ctx.run('localizeWorkspaceValue("hello")'), 'hello');
    assert.equal(ctx.run('localizeWorkspaceValue(42)'), '42');
    assert.equal(ctx.run('localizeWorkspaceValue(true)'), 'true');
  }));

  it('returns fallback for null/undefined', () => withCore({}, (ctx) => {
    assert.equal(ctx.run('localizeWorkspaceValue(null, "default")'), 'default');
    assert.equal(ctx.run('localizeWorkspaceValue(undefined, "default")'), 'default');
  }));

  it('extracts value by currentLanguage from object', () => withCore({ currentLanguage: 'zh' }, (ctx) => {
    const result = ctx.run('localizeWorkspaceValue({ zh: "中文", en: "English" })');
    assert.equal(result, '中文');
  }));

  it('falls back to zh then en then fallback for objects', () => withCore({ currentLanguage: 'fr' }, (ctx) => {
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
  }));
});

// ── formatWorkspaceDate ──

describe('app-core: formatWorkspaceDate', () => {
  it('returns dash for empty input', () => withCore({}, (ctx) => {
    assert.equal(ctx.run('formatWorkspaceDate("")'), '-');
    assert.equal(ctx.run('formatWorkspaceDate(null)'), '-');
    assert.equal(ctx.run('formatWorkspaceDate(undefined)'), '-');
  }));

  it('returns original string for invalid date', () => withCore({}, (ctx) => {
    assert.equal(ctx.run('formatWorkspaceDate("not-a-date")'), 'not-a-date');
  }));

  it('formats valid ISO date string', () => withCore({}, (ctx) => {
    const result = ctx.run('formatWorkspaceDate("2024-06-15T10:30:00Z")');
    assert.ok(result.includes('2024') || result.includes('6') || result.includes('15'));
    assert.ok(result !== '-');
  }));
});

// ── isUiOnlyAgentId ──

describe('app-core: pending session navigation', () => {
  it('keeps a pending target scoped to the current navigation epoch and workspace', () => withCore({}, (ctx) => {
    assert.equal(ctx.run('beginPendingSessionNavigation("programming-helper", "session-new")').sessionId, 'session-new');
    assert.equal(ctx.run('hasPendingSessionNavigation({ id: "programming-helper" })'), true);
    assert.equal(ctx.run('hasPendingSessionNavigation({ id: "other-workspace" })'), false);
    ctx.run('bumpNavigationGuard()');
    assert.equal(ctx.run('hasPendingSessionNavigation({ id: "programming-helper" })'), false);
  }));

  it('updates the committed target without losing its navigation scope', () => withCore({}, (ctx) => {
    ctx.run('beginPendingSessionNavigation("programming-helper")');
    assert.equal(ctx.run('updatePendingSessionNavigation("session-new", "starting-runtime").phase'), 'starting-runtime');
    assert.equal(ctx.run('hasPendingSessionNavigation({ id: "programming-helper" })'), true);
    ctx.run('clearPendingSessionNavigation()');
    assert.equal(ctx.run('hasPendingSessionNavigation({ id: "programming-helper" })'), false);
  }));
});

// ── isUiOnlyAgentId ──

describe('app-core: isUiOnlyAgentId', () => {
  it('returns true for known UI-only agent IDs', () => withCore({
      allAgents: [
        { id: 'feature-setup', source: 'prebuilt', launchMode: 'ui-only' },
      ],
    }, (ctx) => {
    assert.equal(ctx.run('isUiOnlyAgentId("feature-setup")'), true);
  }));

  it('returns true for workspace host agents (kind: workspace)', () => withCore({
      allAgents: [
        { id: 'programming-helper', source: 'prebuilt', kind: 'workspace' },
      ],
    }, (ctx) => {
    // isUiOnlyAgentId checks isWorkspaceSurfaceUnit which includes both
    // ui-only units and workspace host units (kind: "workspace" in metadata)
    assert.equal(ctx.run('isUiOnlyAgentId("programming-helper")'), true);
  }));

  it('returns false for unknown/null IDs when allAgents is empty', () => withCore({}, (ctx) => {
    assert.equal(ctx.run('isUiOnlyAgentId("nonexistent")'), false);
    assert.equal(ctx.run('isUiOnlyAgentId(null)'), false);
  }));
});

// ── getRuntimeCacheTodoPlanSignature ──

describe('app-core: getRuntimeCacheTodoPlanSignature', () => {
  it('produces stable signature for same plan', () => {
    const sig1 = getRuntimeCacheTodoPlanSignature([{ subject: 'a', status: 'pending' }]);
    const sig2 = getRuntimeCacheTodoPlanSignature([{ subject: 'a', status: 'pending' }]);
    assert.ok(typeof sig1 === 'string');
    assert.ok(sig1.length > 0);
    assert.equal(sig1, sig2, 'same plan should produce same signature');
  });

  it('produces different signatures for different plans', () => {
    const sig1 = getRuntimeCacheTodoPlanSignature([{ subject: 'a', status: 'pending' }]);
    const sig2 = getRuntimeCacheTodoPlanSignature([{ subject: 'b', status: 'pending' }]);
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

async function withRuntimeStatusCase(fn) {
  const elements = new Map();
  function createElementStub(id) {
    return {
      id,
      style: {},
      className: '',
      textContent: '',
      innerHTML: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      // 首屏 DOM 引用的最小面（模块求值期装委托 / 读几何）
      addEventListener() {}, removeEventListener() {},
      appendChild() {}, remove() {}, focus() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      closest() { return null; }, contains() { return false; },
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
      dataset: {}, value: '', disabled: false,
    };
  }
  for (const id of ['notification-status', 'notification-phase', 'notification-summary', 'notification-metrics']) {
    elements.set(id, createElementStub(id));
  }

  const document = {
    // 侧栏渲染域在模块求值期装事件委托（domRefs 取不到元素会直接 TypeError）：
    // 未预置的 id 一律给同形元素桩（生产页面里这些节点恒在）。
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElementStub(id));
      return elements.get(id);
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

  const globals = {
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
    // classic 宿主工厂（生产由 app-main / app-ui 提供）：侧栏装载链在求值期取用，
    // 本文件不驱动轮询与工作区表面。
    createPollCoordinatorHost: () => ({
      run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
    }),
    createWorkspaceSurfaceHost: () => ({ state: {} }),
    createRuntimeSwitchHost: () => ({ state: {} }),
    createCompactResumeHost: () => ({ state: {}, now: () => Date.now() }),
    createAgentCallStatesHost: () => ({ state: {} }),
    // 对话视口观察器抑制（生产由 chat-viewport 的桥键提供）：本文件不驱动视口。
    runWithSuppressedChatViewportObservers: (fn) => fn(),
    // 首屏几何读取（浏览器恒在）：模块求值期读一次行高。
    getComputedStyle: () => ({ getPropertyValue: () => '', gap: '0px' }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  // 运行时状态自 P4 T2 起是 ESM（runtime-status）：本夹具走真实 import 路线，
  // `updateNotificationStatus` / `isRuntimeCalling` 取模块导出，不再靠 classic
  // 顶层名字（迁出后沙箱词法面里没有它们）。
  return withP2EsmCase({
    classic: (sandbox) => {
      // action-dispatcher 是 index.html 的先行脚本（模块图的动作注册面）。
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      prepareEsmModules(sandbox, APP_CORE_DOMAIN);
      Object.assign(sandbox, createTimeFormat(() => sandbox.currentLanguage));
      prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
      prepareSidebarDomain(sandbox);
    },
    globals,
  }, async (c) => {
    // 状态初值写在模块相之后：这些键的 owner 是 ESM 域（orchestration /
    // runtime-status / session-view-storage），桥访问器此时已注册，写入落到域状态；
    // classic 相提前写会变成普通 window 属性、被注册行覆盖（与生产时序不符）。
    c.window.run(`
      currentRuntimeAgentId = "runtime-1";
      currentRuntimeConnected = true;
      currentHookInspector = null;
      currentOverviewSnapshot = {};
      currentTodoPlan = {};
      currentInputRequests = [];
      lastRenderedInputMode = "persistent";
    `);
    // call-interrupt / 会话视图 patch 都是模块相才有的桥键：在用例体前校验与设置。
    installCallInterruptState(c.window);
    c.window.run("applySessionViewPatch({ identity: { agentId: 'runtime-1', sessionId: 'session-1' } })");
    return fn(c.window, elements);
  });
}

describe('runtime-status: interrupt suppression', () => {
  it('keeps stale callActive notifications in sticky interrupting state', async () => {
    // updateNotificationStatus / isRuntimeCalling 经 runtime-status-api 桥键取用
    // （生产 classic 消费方同一通道；函数体是 ESM 唯一实现）。
    await withRuntimeStatusCase((ctx, elements) => {
      ctx.run('markInterruptPending("runtime-1", 1000)');
      ctx.run('_agentCallActive.delete("runtime-1")');
      ctx.window.updateNotificationStatus({
        callActive: true,
        runtime: {
          callActive: true,
          stage: 'awaiting_runtime',
          updatedAt: Date.now(),
          callStartedAt: 1000,
          stageStartedAt: Date.now(),
        },
        state: { type: 'llm.char_count', data: { phase: 'content', charCount: 10 }, timestamp: Date.now() },
      });

      assert.equal(elements.get('notification-status').style.display, 'flex');
      assert.equal(elements.get('notification-phase').textContent, '正在停止…');
      assert.equal(ctx.window.isRuntimeCalling('runtime-1'), false);
      assert.equal(ctx.run('isInterruptSuppressed("runtime-1", 1000)'), true);
    });
  });

  it('only releases interrupting for a terminal event or a newer call identity', async () => {
    await withRuntimeStatusCase((ctx) => {
      ctx.run('markInterruptPending("runtime-1", 1000)');
      ctx.window.updateNotificationStatus({
        callActive: true,
        runtime: { callActive: true, callStartedAt: 2000, stage: 'llm_thinking' },
      });
      assert.equal(ctx.run('isInterruptSuppressed("runtime-1", 2000)'), false);
      assert.equal(ctx.window.isRuntimeCalling('runtime-1'), true);

      ctx.run('markInterruptPending("runtime-1", 2000)');
      ctx.window.updateNotificationStatus({
        callActive: false,
        runtime: { callActive: false, callStartedAt: 2000, stage: 'idle' },
        state: { type: 'call.finish', timestamp: Date.now() },
      });
      assert.equal(ctx.run('isInterruptSuppressed("runtime-1", 2000)'), false);
      assert.equal(ctx.window.isRuntimeCalling('runtime-1'), false);
    });
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
  // PH 默认 modes 组（信息层级默认：当前对话关 / 其他内容短通知 / 后台持久）
  const PH_MODES = 'modes: { focused: "off", elsewhere: "auto", background: "persistent" }';

  it('呈现按焦点选键：当前对话（focused=off 默认）不弹；在 Claw 看其他内容（elsewhere）照常弹', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    ctx.run('allAgents = [{ id: "ph", name: "PH", runtime_session_id: "runtime-1" }, { id: "other", name: "Other", runtime_session_id: "runtime-2" }]');
    ctx.run('currentRuntimeAgentId = "runtime-1"');

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", ' + PH_MODES + ', finishTs: ' + (Date.now() - 1000) + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notifications.length, 0); // focused 键 off：正盯着，不弹

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-2", ' + PH_MODES + ', finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notifications.length, 1); // elsewhere 键 auto：前台看别处，照常弹
  });

  it('focused 键可配置为弹（用户显式选择）：正盯着也按配置呈现', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    ctx.run('currentRuntimeAgentId = "runtime-1"');
    ctx.run('_markAgentCallStartedForNotify("runtime-1")');

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", modes: { focused: "auto", elsewhere: "auto", background: "auto" }, finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notifications.length, 1); // focused=auto：免打扰从硬闸变为配置
    assert.equal(notifications[0].options.requireInteraction, false);
  });

  it('页面失焦选 background 键：默认持久挂起；显式配置 off 则不弹', async () => {
    // 默认：后台 = persistent（常驻）
    const pinned = createDesktopNotifySandbox();
    pinned.ctx.run('currentRuntimeAgentId = "runtime-1"');
    pinned.ctx.run('_markAgentCallStartedForNotify("runtime-1")');
    pinned.ctx.document.hidden = true;
    pinned.ctx.document.hasFocus = () => false;
    await pinned.ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", ' + PH_MODES + ', finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pinned.notifications.length, 1);
    assert.equal(pinned.notifications[0].options.requireInteraction, true);

    // 用户显式关闭后台提醒：失焦也不弹
    const muted = createDesktopNotifySandbox();
    muted.ctx.run('currentRuntimeAgentId = "runtime-1"');
    muted.ctx.run('_markAgentCallStartedForNotify("runtime-1")');
    muted.ctx.document.hidden = true;
    muted.ctx.document.hasFocus = () => false;
    await muted.ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", modes: { focused: "off", elsewhere: "auto", background: "off" }, finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(muted.notifications.length, 0);
  });

  it('旧帧兼容：无 modes 字段兜底轻提示（mode 单值仍被识别）', async () => {
    // 无任何 mode 字段：兜底 auto（finish 同会话有 30s 去重，两个分支用独立 sandbox）
    const bare = createDesktopNotifySandbox();
    bare.ctx.run('currentRuntimeAgentId = "runtime-2"');
    bare.ctx.run('_markAgentCallStartedForNotify("runtime-1")');
    await bare.ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(bare.notifications.length, 1);
    assert.equal(bare.notifications[0].options.requireInteraction, false); // 兜底 auto

    // 旧 mode 单值（上一轮契约）：persistent 仍被识别
    const legacy = createDesktopNotifySandbox();
    legacy.ctx.run('currentRuntimeAgentId = "runtime-2"');
    legacy.ctx.run('_markAgentCallStartedForNotify("runtime-1")');
    await legacy.ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", mode: "persistent", finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(legacy.notifications.length, 1);
    assert.equal(legacy.notifications[0].options.requireInteraction, true);
  });

  it('Tauri 壳：通知走原生 command，不再触发 Web Notification（避免双弹）；elsewhere 键 auto 非持久', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    const invokes = [];
    ctx.window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => { invokes.push({ cmd, args }); },
    };
    ctx.run('currentRuntimeAgentId = "runtime-2"'); // 完成的是非焦点会话，页面聚焦

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", ' + PH_MODES + ', finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(invokes.length, 1);
    assert.equal(invokes[0].cmd, 'persistent_notification');
    assert.equal(invokes[0].args.persistent, false); // elsewhere 键 auto：普通 toast
    assert.equal(notifications.length, 0); // 原生已发，Web API 不再发
  });

  it('Tauri 壳：background 键 persistent → Reminder 常驻挂起（页面失焦时选键）', async () => {
    const { ctx } = createDesktopNotifySandbox();
    const invokes = [];
    ctx.window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => { invokes.push({ cmd, args }); },
    };
    ctx.run('currentRuntimeAgentId = "runtime-2"');
    ctx.run('_markAgentCallStartedForNotify("runtime-1")');
    ctx.document.hidden = true;
    ctx.document.hasFocus = () => false;

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", ' + PH_MODES + ', finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(invokes.length, 1);
    assert.equal(invokes[0].args.persistent, true);
  });

  it('Tauri 壳 invoke 失败：回退 Web Notification（requireInteraction 随选键结果）', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    ctx.window.__TAURI_INTERNALS__ = {
      invoke: async () => { throw new Error('denied'); },
    };
    ctx.run('currentRuntimeAgentId = "runtime-2"');

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", modes: { focused: "off", elsewhere: "persistent", background: "persistent" }, finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].options.requireInteraction, true); // elsewhere=persistent：常驻
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

  it('Web 路径持久性按选键结果：elsewhere 键 auto 轻提示，persistent 常驻', async () => {
    // 页面聚焦 + 非焦点会话 + elsewhere=auto → 轻提示
    const light = createDesktopNotifySandbox();
    light.ctx.run('currentRuntimeAgentId = "runtime-2"');
    light.ctx.run('_markAgentCallStartedForNotify("runtime-1")');
    await light.ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", modes: { focused: "off", elsewhere: "auto", background: "persistent" }, finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(light.notifications.length, 1);
    assert.equal(light.notifications[0].options.requireInteraction, false);

    // 同焦点态 + elsewhere=persistent → 常驻（键值压过焦点态直觉）
    const pinned = createDesktopNotifySandbox();
    pinned.ctx.run('currentRuntimeAgentId = "runtime-2"');
    pinned.ctx.run('_markAgentCallStartedForNotify("runtime-1")');
    await pinned.ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", modes: { focused: "off", elsewhere: "persistent", background: "auto" }, finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pinned.notifications.length, 1);
    assert.equal(pinned.notifications[0].options.requireInteraction, true);
  });

  it('主动投递类（reminder）：三键同值（server 单值复制），按焦点选键结果一致', async () => {
    const light = createDesktopNotifySandbox();
    await light.ctx.run('_presentAppNotification({ type: "reminder", agentId: "memo", modes: { focused: "auto", elsewhere: "auto", background: "auto" }, title: "提醒", body: "喝水" })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(light.notifications[0].options.requireInteraction, false); // auto：轻提示

    const pinned = createDesktopNotifySandbox();
    pinned.ctx.document.hidden = true;
    pinned.ctx.document.hasFocus = () => false;
    await pinned.ctx.run('_presentAppNotification({ type: "reminder", agentId: "memo", modes: { focused: "persistent", elsewhere: "persistent", background: "persistent" }, title: "提醒", body: "喝水" })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pinned.notifications[0].options.requireInteraction, true); // persistent：常驻
  });

  it('input（choice）类：免打扰硬闸（正盯着卡片不弹）；持久性按选键；无 modes 帧兜底 auto', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    ctx.run('allAgents = [{ id: "ph", name: "PH", runtime_session_id: "runtime-1" }]');
    ctx.run('currentRuntimeAgentId = "runtime-1"');

    // 焦点会话 choice：卡片已可见，免打扰硬闸（不可配置——与 finish 的
    // focused 键区分：choice 是模态请求，正盯着时弹通知纯打扰）
    ctx.run('_presentAppNotification({ type: "input", agentId: "runtime-1", modes: { focused: "persistent", elsewhere: "persistent", background: "persistent" }, requestId: "req-focus" })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notifications.length, 0);

    // 非焦点会话 + persistent 三键 → 常驻
    ctx.run('currentRuntimeAgentId = "runtime-2"');
    await ctx.run('_presentAppNotification({ type: "input", agentId: "runtime-1", modes: { focused: "persistent", elsewhere: "persistent", background: "persistent" }, requestId: "req-1p" })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].options.requireInteraction, true);

    // 无 modes 帧（旧帧兼容）：兜底 auto
    await ctx.run('_presentAppNotification({ type: "input", agentId: "runtime-1", requestId: "req-1b" })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notifications.length, 2);
    assert.equal(notifications[1].options.requireInteraction, false);
  });

  it('新一轮 call 开始：清除「刚刚完成」蓝灯（_recentlyFinishedRuntimes）', () => {
    const { ctx } = createDesktopNotifySandbox();
    ctx.run('_recentlyFinishedRuntimes.add("runtime-1")');
    ctx.run('_markAgentCallStartedForNotify("runtime-1")');
    assert.equal(ctx.run('_recentlyFinishedRuntimes.has("runtime-1")'), false);
  });
});

// ── desktop-notify: input 帧呈现（choice 通知，ADR-0030）───────────────
// Worker 心跳已随三态模式配置退役：前台时钟同步（_lastForegroundTs）不再
// 存在，通知呈现完全由 app-notification 帧实时驱动。

describe('desktop-notify: input 帧呈现（choice 通知，ADR-0030）', () => {
  it('焦点会话的 choice 不弹（正盯着卡片）；非焦点会话照常弹', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
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
