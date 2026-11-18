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

  it('Tauri 壳：通知走原生 command，不再触发 Web Notification（避免双弹）；前台（看别的会话）非持久', async () => {
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
    assert.equal(invokes[0].args.persistent, false); // 页面聚焦：普通 toast，自动收进通知中心
    assert.equal(notifications.length, 0); // 原生已发，Web API 不再发
  });

  it('Tauri 壳：页面失焦时 persistent=true（Reminder 常驻挂起）', async () => {
    const { ctx } = createDesktopNotifySandbox();
    const invokes = [];
    ctx.window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => { invokes.push({ cmd, args }); },
    };
    ctx.run('currentRuntimeAgentId = "runtime-2"');
    ctx.run('_markAgentCallStartedForNotify("runtime-1")');
    ctx.document.hidden = true;
    ctx.document.hasFocus = () => false;

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(invokes.length, 1);
    assert.equal(invokes[0].args.persistent, true);
  });

  it('Tauri 壳 invoke 失败：回退 Web Notification（requireInteraction 随页面焦点）', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    ctx.window.__TAURI_INTERNALS__ = {
      invoke: async () => { throw new Error('denied'); },
    };
    ctx.run('currentRuntimeAgentId = "runtime-2"');

    await ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].options.requireInteraction, false); // 前台：非持久
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

  it('finish 持久性按页面焦点判定（Web 路径）：前台轻提示，失焦常驻挂起', async () => {
    // 前台 + 非焦点会话完成 → 非持久（普通 toast，自动收进通知中心）
    const fg = createDesktopNotifySandbox();
    fg.ctx.run('currentRuntimeAgentId = "runtime-2"');
    fg.ctx.run('_markAgentCallStartedForNotify("runtime-1")');
    await fg.ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fg.notifications.length, 1);
    assert.equal(fg.notifications[0].options.requireInteraction, false);

    // 页面失焦（最小化/后台/被遮挡）→ 持久挂起
    const bg = createDesktopNotifySandbox();
    bg.ctx.run('currentRuntimeAgentId = "runtime-2"');
    bg.ctx.run('_markAgentCallStartedForNotify("runtime-1")');
    bg.ctx.document.hidden = true;
    bg.ctx.document.hasFocus = () => false;
    await bg.ctx.run('_presentAppNotification({ type: "finish", agentId: "runtime-1", finishTs: ' + Date.now() + ' })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(bg.notifications.length, 1);
    assert.equal(bg.notifications[0].options.requireInteraction, true);
  });

  it('主动投递类（reminder）：持久性同样按页面焦点判定', async () => {
    const fg = createDesktopNotifySandbox();
    await fg.ctx.run('_presentAppNotification({ type: "reminder", agentId: "memo", title: "提醒", body: "喝水" })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fg.notifications[0].options.requireInteraction, false); // 前台：轻提示

    const bg = createDesktopNotifySandbox();
    bg.ctx.document.hidden = true;
    bg.ctx.document.hasFocus = () => false;
    await bg.ctx.run('_presentAppNotification({ type: "reminder", agentId: "memo", title: "提醒", body: "喝水" })');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(bg.notifications[0].options.requireInteraction, true); // 失焦：常驻
  });

  it('input（choice）类恒非持久（普通 toast，前台后台一致——现状语义）', async () => {
    const { ctx, notifications } = createDesktopNotifySandbox();
    ctx.run('currentRuntimeAgentId = "runtime-2"');
    ctx.document.hidden = true; // 后台也非持久：既有行为，不在本次持久性治理范围
    ctx.document.hasFocus = () => false;

    await ctx.run('_presentAppNotification({ type: "input", agentId: "runtime-1", requestId: "req-1" })');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].options.requireInteraction, undefined);
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
