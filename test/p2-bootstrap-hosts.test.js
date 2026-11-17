/**
 * P2 bootstrap 消费接口（classic host 工厂 + ESM 适配模块）契约测试。
 *
 * 钉住的语义（ESM 迁移配方：状态 owner 留在 classic 首屏边界，只加显式读写面）：
 * 1. classic 时点可用：app-core / sidebar-render 解析完成后即可调用工厂，
 *    初值与引用身份与 classic 声明一致；
 * 2. const 只读：DOM 引用与 Map/Set 容器无 setter，ESM strict 写入抛 TypeError；
 * 3. classic ↔ ESM 双向一致：同一份状态、同一容器引用，不产生副本；
 * 4. 初始写不丢失：适配模块装载前的 classic 写入在装载后仍可见（无重复初始化）；
 * 5. 无新增启动等待：适配器装载即同步可用，不引入 ready/promise。
 *
 * classic 侧用 frontend-vm 沙箱按真实加载序执行，ESM 侧用 esm-module-loader
 * 真实 import（唯一 query 拿全新实例），两侧共享同一 classic 状态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const FACTORY_NAMES = [
  'createP2BootstrapDomHost',
  'createP2BootstrapChatSurfaceHost',
  'createP2BootstrapCallActivityHost',
  'createP2BootstrapPhSessionHost',
  'createP2BootstrapDebugPanelHost',
  'createP2BootstrapAssemblyHost',
  'createP2BootstrapSidebarHost',
  'createP2BootstrapSidebarRenderHost',
  'createP2BootstrapSessionSwitchHost',
  'createP2BootstrapChoiceInputHost',
];

const ADAPTER_FILES = {
  dom: 'public/src/modules/p2-bootstrap-dom.js',
  chatSurface: 'public/src/modules/p2-bootstrap-chat-surface.js',
  callActivity: 'public/src/modules/p2-bootstrap-call-activity.js',
  phSessionUi: 'public/src/modules/p2-bootstrap-ph-session.js',
  debugPanel: 'public/src/modules/p2-bootstrap-debug-panel.js',
  assemblyUi: 'public/src/modules/p2-bootstrap-assembly.js',
  sidebar: 'public/src/modules/p2-bootstrap-sidebar.js',
  sessionSwitch: 'public/src/modules/p2-bootstrap-session-switch.js',
  choiceInput: 'public/src/modules/p2-bootstrap-choice-input.js',
};

/** 按真实加载序跑 classic 文件（app-core 是状态 owner，sidebar-render 提供渲染签名）。 */
function loadClassic() {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/sidebar-render.js');
  return ctx;
}

/**
 * 把 classic 工厂装到真实 import 能解析到的 window 上，再逐个真实 import 适配模块。
 * 返回 { adapters, cleanup }；调用方负责在 finally 里 cleanup。
 */
async function importAdapters(ctx, names = Object.keys(ADAPTER_FILES)) {
  const cleanup = installBrowserStubs();
  try {
    for (const factory of FACTORY_NAMES) globalThis.window[factory] = ctx[factory];
    const adapters = {};
    for (const name of names) {
      const { module } = await loadModuleOnce(ADAPTER_FILES[name], { installGlobals: false });
      Object.assign(adapters, module);
    }
    return { adapters, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

test('classic 时点可用：工厂在 classic 解析后即可调用，初值与引用与声明一致', () => {
  const ctx = loadClassic();

  assert.equal(typeof ctx.createP2BootstrapDomHost, 'function');
  assert.equal(typeof ctx.createP2BootstrapChatSurfaceHost, 'function');

  const dom = ctx.run('createP2BootstrapDomHost()');
  assert.equal(Object.isFrozen(dom), true);
  assert.equal(dom.container, ctx.run('container'));
  assert.equal(dom.featurePanelBody, ctx.run('featurePanelBody'));
  assert.equal(dom.followLatestButton, ctx.run('followLatestButton'));
  assert.equal(dom.projectDocsetSheet, ctx.run('projectDocsetSheet'));
  assert.equal(dom.ctxMenu, ctx.run('ctxMenu'));

  const chat = ctx.run('createP2BootstrapChatSurfaceHost()');
  assert.equal(chat.showChatProcess, false);
  assert.equal(chat.CHAT_PROCESS_VISIBILITY_KEY, 'agentdev-chat-show-process');
  assert.equal(chat.followLatestEnabled, true);
  assert.equal(chat.chatViewportFollowTransition, 'locked');
  assert.equal(chat.chatViewportSettlementTimer, null);
  assert.equal(chat.chatViewportObserverSuppressDepth, 0);

  const calls = ctx.run('createP2BootstrapCallActivityHost()');
  assert.equal(calls._agentCallActive, ctx.run('_agentCallActive'));
  assert.equal(calls._recentlyFinishedRuntimes, ctx.run('_recentlyFinishedRuntimes'));
  assert.equal(calls._seenChoiceAlertIds, ctx.run('_seenChoiceAlertIds'));
  assert.equal(calls._autoTitleTriggered, ctx.run('_autoTitleTriggered'));
  assert.equal(calls._lastInterruptUserActionAt, 0);

  const ph = ctx.run('createP2BootstrapPhSessionHost()');
  assert.equal(ph.phSessionSortMode, 'updatedAt');
  assert.equal(ph.phSearchQuery, '');
  assert.equal(ph._phSearchTimer, null);
  assert.equal(ph.savedPhTabState, ctx.run('savedPhTabState'));

  const debug = ctx.run('createP2BootstrapDebugPanelHost()');
  assert.equal(JSON.stringify(debug.currentLogs), '[]');
  assert.equal(debug.currentLogsSignature, '');
  assert.equal(debug.currentLogsTruncation, null);
  assert.equal(debug.logFilters, ctx.run('logFilters'));
  assert.equal(debug.currentMcpInfo, null);
  assert.equal(debug.selectedOverviewLifecycle, 'StepFinish');
  assert.equal(debug.selectedFeatureName, null);
  assert.equal(debug.selectedRepositoryPackageId, null);
  assert.equal(debug.repoSearchQuery, '');
  assert.equal(debug.repoSourceFilter, 'all');

  const assembly = ctx.run('createP2BootstrapAssemblyHost()');
  assert.equal(assembly.assemblyControlPanelOpen, false);
  assert.equal(assembly.assemblyDraftRenderTimer, null);
  assert.equal(assembly.assemblyLaunchInProgress, false);
  assert.equal(assembly.assemblySideRailRevealTimer, null);

  const sidebar = ctx.run('createP2BootstrapSidebarHost()');
  assert.equal(sidebar.restartingRuntimeIds, ctx.run('restartingRuntimeIds'));
  assert.equal(sidebar.suppressSidebarRerender, false);
  const sidebarRender = ctx.run('createP2BootstrapSidebarRenderHost()');
  assert.equal(sidebarRender.lastAgentListRenderSignature, '');

  const sessionSwitch = ctx.run('createP2BootstrapSessionSwitchHost()');
  assert.equal(sessionSwitch.templateWarmupToken, 0);
  assert.equal(sessionSwitch.prebuiltSessionSwitchInFlight, false);

  const choice = ctx.run('createP2BootstrapChoiceInputHost()');
  assert.equal(choice.state, ctx.run('choiceInputState'));
});

test('适配模块导出面就是后续工单的导入契约', async () => {
  const ctx = loadClassic();
  const cleanup = installBrowserStubs();
  try {
    for (const factory of FACTORY_NAMES) globalThis.window[factory] = ctx[factory];
    const expected = {
      dom: ['domRefs'],
      chatSurface: ['chatSurface'],
      callActivity: ['callActivity'],
      phSessionUi: ['phSessionUi'],
      debugPanel: ['debugPanel'],
      assemblyUi: ['assemblyUi'],
      sidebar: ['sidebarRender', 'sidebarUi'],
      sessionSwitch: ['sessionSwitch'],
      choiceInput: ['choiceInput'],
    };
    for (const [name, file] of Object.entries(ADAPTER_FILES)) {
      const { module } = await loadModuleOnce(file, { installGlobals: false });
      assert.deepEqual(Object.keys(module).sort(), expected[name], `${name} 导出面漂移`);
    }
  } finally {
    cleanup();
  }
});

test('const 只读语义：无可写入口的键在 ESM strict 下写入抛 TypeError', async () => {
  const ctx = loadClassic();
  const { adapters, cleanup } = await importAdapters(ctx);
  try {
    // DOM 引用（classic 顶层 const）
    assert.throws(() => { adapters.domRefs.container = null; }, TypeError);
    // const Map / Set 容器：只交出引用，不允许整体替换
    assert.throws(() => { adapters.callActivity._agentCallActive = new Map(); }, TypeError);
    assert.throws(() => { adapters.sidebarUi.restartingRuntimeIds = new Set(); }, TypeError);
    // 就地可变对象同样只给引用
    assert.throws(() => { adapters.debugPanel.logFilters = {}; }, TypeError);
    assert.throws(() => { adapters.phSessionUi.savedPhTabState = {}; }, TypeError);
    assert.throws(() => { adapters.choiceInput.state = {}; }, TypeError);
    // 常量字符串
    assert.throws(() => { adapters.chatSurface.CHAT_PROCESS_VISIBILITY_KEY = 'x'; }, TypeError);
    // 引用未被破坏
    assert.equal(adapters.domRefs.container, ctx.run('container'));
    assert.equal(adapters.callActivity._agentCallActive, ctx.run('_agentCallActive'));
  } finally {
    cleanup();
  }
});

test('classic 与 ESM 双向一致：同一状态、同一容器引用', async () => {
  const ctx = loadClassic();
  const { adapters, cleanup } = await importAdapters(ctx);
  try {
    // classic 写 → ESM 读
    ctx.run('showChatProcess = true');
    assert.equal(adapters.chatSurface.showChatProcess, true);
    ctx.run('followLatestEnabled = false');
    assert.equal(adapters.chatSurface.followLatestEnabled, false);

    // ESM 写 → classic 读（写入口就是原 classic 赋值，无附加副作用）
    adapters.chatSurface.showChatProcess = false;
    assert.equal(ctx.run('showChatProcess'), false);
    adapters.chatSurface.followLatestEnabled = true;
    assert.equal(ctx.run('followLatestEnabled'), true);

    // 视口句柄：定时器/观察器引用原样往返
    const fakeTimer = { id: 1 };
    adapters.chatSurface.chatViewportSettlementTimer = fakeTimer;
    assert.equal(ctx.run('chatViewportSettlementTimer'), fakeTimer);
    ctx.run('chatViewportSettlementTimer = null');
    assert.equal(adapters.chatSurface.chatViewportSettlementTimer, null);

    // const Map：ESM 与 classic 变更互相可见（引用身份不变）
    adapters.callActivity._agentCallActive.set('rt-esm', true);
    assert.equal(ctx.run('_agentCallActive.get("rt-esm")'), true);
    ctx.run('_agentCallActive.delete("rt-esm")');
    assert.equal(adapters.callActivity._agentCallActive.has('rt-esm'), false);

    // const Set
    ctx.run('restartingRuntimeIds.add("rt-classic")');
    assert.equal(adapters.sidebarUi.restartingRuntimeIds.has('rt-classic'), true);
    adapters.sidebarUi.restartingRuntimeIds.delete('rt-classic');
    assert.equal(ctx.run('restartingRuntimeIds.has("rt-classic")'), false);

    // 时间戳 / 标量
    adapters.callActivity._lastInterruptUserActionAt = 12345;
    assert.equal(ctx.run('_lastInterruptUserActionAt'), 12345);
    adapters.phSessionUi.phSearchQuery = 'needle';
    assert.equal(ctx.run('phSearchQuery'), 'needle');
    adapters.phSessionUi.phSessionSortMode = 'createdAt';
    assert.equal(ctx.run('phSessionSortMode'), 'createdAt');

    // 模板预热代次的 read-modify-write 形态
    adapters.sessionSwitch.templateWarmupToken = adapters.sessionSwitch.templateWarmupToken + 1;
    assert.equal(ctx.run('templateWarmupToken'), 1);

    // 就地可变对象：同一引用，键级读写双方互见
    adapters.phSessionUi.savedPhTabState.sessions = 'history';
    assert.equal(ctx.run('savedPhTabState.sessions'), 'history');
    ctx.run('logFilters.level = "warn"');
    assert.equal(adapters.debugPanel.logFilters.level, 'warn');
    adapters.debugPanel.logFilters.level = 'all';
    assert.equal(ctx.run('logFilters.level'), 'all');
    adapters.choiceInput.state.req1 = { picked: true };
    assert.equal(JSON.stringify(ctx.run('choiceInputState.req1')), JSON.stringify({ picked: true }));

    // 侧栏渲染签名：清空即强制下次重建，classic 写方与 ESM 共用同一 let
    ctx.run('lastAgentListRenderSignature = "sig-classic"');
    assert.equal(adapters.sidebarRender.lastAgentListRenderSignature, 'sig-classic');
    adapters.sidebarRender.lastAgentListRenderSignature = '';
    assert.equal(ctx.run('lastAgentListRenderSignature'), '');

    // 其余域的标量/句柄写入口（classic 读回同一状态）
    adapters.sidebarUi.suppressSidebarRerender = true;
    assert.equal(ctx.run('suppressSidebarRerender'), true);
    adapters.debugPanel.currentLogs = [{ message: 'esm' }];
    assert.equal(JSON.stringify(ctx.run('currentLogs')), JSON.stringify([{ message: 'esm' }]));
    adapters.assemblyUi.assemblyControlPanelOpen = true;
    assert.equal(ctx.run('assemblyControlPanelOpen'), true);
    const debounce = { id: 2 };
    adapters.phSessionUi._phSearchTimer = debounce;
    assert.equal(ctx.run('_phSearchTimer'), debounce);
  } finally {
    cleanup();
  }
});

test('初始写不丢失：适配模块装载前的 classic 写入装载后仍可见', async () => {
  const ctx = loadClassic();
  // 模拟 boot / 事件回调在 ESM 执行之前的经典写入（含定时器句柄与容器变异）
  ctx.run('currentLogs = [{ message: "boot" }]');
  ctx.run('repoSearchQuery = "needle"');
  ctx.run('prebuiltSessionSwitchInFlight = true');
  ctx.run('_recentlyFinishedRuntimes.add("rt-done")');
  ctx.run('assemblyLaunchInProgress = true');
  ctx.run('showChatProcess = true');

  const { adapters, cleanup } = await importAdapters(ctx);
  try {
    assert.equal(JSON.stringify(adapters.debugPanel.currentLogs), JSON.stringify([{ message: 'boot' }]));
    assert.equal(adapters.debugPanel.repoSearchQuery, 'needle');
    assert.equal(adapters.sessionSwitch.prebuiltSessionSwitchInFlight, true);
    assert.equal(adapters.callActivity._recentlyFinishedRuntimes.has('rt-done'), true);
    assert.equal(adapters.assemblyUi.assemblyLaunchInProgress, true);
    // 装载适配模块不得重跑 classic 初始化：localStorage 初值优先的 showChatProcess
    // 仍是装载前写下的 true
    assert.equal(adapters.chatSurface.showChatProcess, true);
  } finally {
    cleanup();
  }
});

test('无新增启动等待：适配器装载后同步可用，不导出 ready/promise', async () => {
  const ctx = loadClassic();
  const { adapters, cleanup } = await importAdapters(ctx);
  try {
    for (const [name, value] of Object.entries(adapters)) {
      assert.equal(/ready|wait/i.test(name), false, `不应导出等待面：${name}`);
      assert.equal(value instanceof Promise, false, `导出不得是 promise：${name}`);
      assert.equal(typeof value, 'object');
      assert.ok(value !== null);
    }
    assert.equal(typeof adapters.chatSurface.followLatestEnabled, 'boolean');
    assert.equal(typeof adapters.domRefs.container.querySelector, 'function');
  } finally {
    cleanup();
  }
});

test('适配模块不含状态副本：源码不出现 Object.assign/window 赋值式快照', () => {
  for (const [name, file] of Object.entries(ADAPTER_FILES)) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(/window\.[A-Za-z_]+\s*=/.test(source), false, `${name} 不得发布/写入 window`);
    assert.equal(/new Map\(|new Set\(/.test(source), false, `${name} 不得自建状态容器`);
    assert.equal(/^let |^const state/m.test(source), false, `${name} 不得持有模块级状态`);
  }
});
