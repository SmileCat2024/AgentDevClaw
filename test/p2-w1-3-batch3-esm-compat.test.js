/**
 * P2 第一波批次 3（设置覆盖层与面板）——ESM 化后的真实行为与兼容面。
 *
 * 覆盖本批 6 个原位 ESM 化的模块：
 *   app-info / workspace-settings / container-images / usage-info-overlay /
 *   annotations / remote-claw-settings
 *
 * bg-panel 不在本批迁移范围：它的首屏注册（rail 按钮由注册表派生）与交互、
 * 生命周期同处 classic 相，拆成"classic 注册 + ESM 实现"必然引入 ready 等待，
 * 与 R4"不改变首屏时点"冲突。按配方边界保留唯一 classic 实现，等注册表/面板
 * 域的联合迁移一起做；它由原 test/frontend-bg-panel.test.js（classic 装载）覆盖。
 *
 * 装载路线（withP2EsmCase，配方第三节「真实 import」）：一个用例 = 一份 classic
 * 沙箱 + 一张真实 ESM 图（test/helpers/p2-esm-case.js + p2-esm-graph.js 的 case
 * 级图隔离）。classic 相用 prepareClassicSandbox（test/p2-classic-hosts.js）按
 * index.html 的真实先行脚本序执行整条壳层链，宿主工厂因此就是生产实现本身：
 * workspace-settings 的静态依赖链（agent-snapshot-loader-host → project-data →
 * … → ctx-menu-items → runtime-switch-host / poll-coordinator-host）在 ESM 求值
 * 期取 createRuntimeSwitchHost / createPollCoordinatorHost，手写同形桩会把宿主
 * 契约复制进测试、生产改动无法被发现。首屏 boot 体与周期排程由该 helper 关掉
 * （__clawAuthReady 永不 resolve）。批内模块一律 `c.load` 真实 import，
 * 跨批依赖沿真实 import 链求值，
 * 不再用 window 桩冒充已迁模块。
 *
 * 唯一的窄 seam：app-ui 的 renderCurrentMainView 换成只记调用次数的渲染观察面
 * （本文件不模拟主视图渲染）。
 *
 * 两件必须钉住的事：
 *   1. 既有公开命名空间协议不变（window.openUsageInfo / window.ClawAnnotations /
 *      名片内联事件所需的 window 函数 / app-ui 菜单入口）；container-images 的
 *      生命周期入口另有零 window 消费方的具名导出面（本批收敛，见该用例）；
 *   2. 本批唯一新增桥键 app-info:renderBrandCard 的 claim 后双向转发语义，
 *      以及"数据未到位时调用零 DOM 写入"的初始值证据。
 *
 * 每个用例结束统一断言：无残留计时器、无非预期 console.warn / error——异步续体
 * 在 case 内结清，避免"断言先于异步落地"的假绿。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const MODULES = {
  appInfo: 'public/src/modules/app-info.js',
  workspaceSettings: 'public/src/modules/workspace-settings.js',
  containerImages: 'public/src/modules/container-images.js',
  usageInfo: 'public/src/modules/usage-info-overlay.js',
  annotations: 'public/src/modules/annotations.js',
  remoteClaw: 'public/src/modules/remote-claw-settings.js',
  markdownUtils: 'public/src/modules/markdown-utils.js',
  i18n: 'public/src/modules/i18n-environment-state.js',
  agentStore: 'public/src/modules/agent-store-state.js',
  clawSelect: 'public/src/modules/claw-select.js',
  toast: 'public/src/modules/toast-notify.js',
};

/** index.html 的 #brand-card 子节点（按生产形态预先登记）。 */
const BRAND_CARD_IDS = [
  'brand-version-chip', 'brand-card', 'brand-card-desc',
  'brand-card-version-label', 'brand-card-version',
  'brand-card-framework-label', 'brand-card-framework', 'brand-card-links',
];

// ── 最小 DOM（按 id 稳定复用元素；模块的 innerHTML 写入可直接断言）──────────

function createElementStub(id = '') {
  const classes = new Set();
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    style: {},
    dataset: {},
    children: [],
    className: '',
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
    },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((item) => item !== child); },
    insertAdjacentHTML() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {},
    blur() {},
  };
}

function createDocumentStub() {
  const byId = new Map();
  // getElementById 的调用记录：用来钉住"数据未到位时调用零 DOM 写入"
  const lookups = [];
  const documentStub = {
    lookups,
    byId,
    /** 预登记/取回一个元素桩（用例要直接断言它的写入时先拿到稳定引用）。 */
    ensure(id) {
      if (!byId.has(id)) byId.set(id, createElementStub(id));
      return byId.get(id);
    },
    // classic 首屏链（sidebar-render / app-ui / app-main）在装载期直接对
    // 元素调用 addEventListener 等；未登记 id 按「元素存在」返回稳定桩，
    // 与前端 vm 默认 document 的口径一致（查找仍逐次记账）。
    getElementById(id) {
      lookups.push(id);
      return documentStub.ensure(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag) { return createElementStub(tag); },
    createTextNode(text) { return { textContent: text }; },
    addEventListener() {},
    removeEventListener() {},
    createTreeWalker() { return { nextNode: () => null }; },
    body: createElementStub('body'),
    head: createElementStub('head'),
    documentElement: createElementStub('html'),
    activeElement: null,
    readyState: 'complete',
  };
  return documentStub;
}

/**
 * classic 相装载：按 index.html 的真实先行脚本序跑整条壳层链（p2-classic-hosts），
 * 宿主工厂因此就是生产实现本身——workspace-settings 的静态依赖链
 * （agent-snapshot-loader-host → … → ctx-menu-items → runtime-switch-host）在
 * ESM 求值期取 `createRuntimeSwitchHost` / `createPollCoordinatorHost`，
 * 手写同形桩会把宿主契约复制进测试、生产改动无法被发现。
 * 首屏 boot 体与周期排程由 prepareClassicSandbox 关掉（本文件不驱动渲染）。
 */
function loadClassicOwners(sandbox) {
  prepareClassicSandbox(sandbox);
  // app-ui（classic 渲染入口）在本文件只记录调用，不模拟渲染
  sandbox.renderMainCalls = 0;
  sandbox.renderCurrentMainView = () => { sandbox.renderMainCalls += 1; };
}

// ── 用例上下文 ──────────────────────────────────────────────────────

/** host realm 的微/宏任务让位（不进本 case 的计时器记账）。 */
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

/** 等一个断言收敛（配额轮询用 setImmediate，不制造真实 sleep）。 */
async function waitFor(predicate, label) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await flushAsync();
  }
  throw new Error(`等待超时：${label}`);
}

/** 记录 defineKey / claim 调用（桥面穷举与增量口径的证据来源）。 */
function kernelStats(c) {
  return JSON.parse(c.read('JSON.stringify(KernelState.stats())'));
}

/** 断言某键不是沙箱全局（等价 classic 顶层词法绑定不外泄的检查）。 */
function assertNotGlobal(c, key, message) {
  assert.equal(Object.prototype.hasOwnProperty.call(c.window, key), false, message);
}

/**
 * 一个用例 = 一份 classic 沙箱 + 一张真实 ESM 图。
 * 用例结束统一检查：计时器已结清、无非预期 console.warn / error。
 */
async function withBatch3Case(options, fn) {
  const { documentStub, fetch: fetchImpl, globals = {} } = options;
  const consoleErrors = [];
  const consoleWarns = [];
  const defaultFetch = async () => ({ ok: false, status: 0, json: async () => ({}) });
  return withP2EsmCase({
    globals: {
      // markdown-utils 求值期的 vendor 依赖（真实库由 index.html 的 vendor
      // 脚本提供，测试不装载）：Renderer 构造与 setOptions 是它唯一的取面。
      marked: { Renderer: class { constructor() {} }, setOptions() {} },
      hljs: { getLanguage: () => null },
      document: documentStub || createDocumentStub(),
      fetch: fetchImpl || defaultFetch,
      // annotations 的选区判定（浏览器全局）
      getSelection: () => ({ isCollapsed: true, rangeCount: 0, anchorNode: null }),
      console: {
        log: () => {},
        info: () => {},
        debug: () => {},
        warn: (...args) => { consoleWarns.push(args); },
        error: (...args) => { consoleErrors.push(args); },
      },
      ...globals,
    },
    classic: loadClassicOwners,
  }, async (c) => {
    const result = await fn(c);
    assert.equal(c.timerCount(), 0, '用例结束不应残留计时器');
    assert.deepEqual(consoleErrors, [], '用例内不应出现非预期 console.error');
    assert.deepEqual(consoleWarns, [], '用例内不应出现非预期 console.warn');
    return result;
  });
}

// ── app-info：唯一新增桥键 + 初始值证据 ────────────────────────────

test('app-info：renderBrandCard 经桥键供 classic theme-lang 裸读，claim 后双向转发', async () => {
  const documentStub = createDocumentStub();
  for (const id of BRAND_CARD_IDS) documentStub.ensure(id);
  await withBatch3Case({
    documentStub,
    // 本用例只钉桥面：app_info 以空载荷结清，_appInfo 保持 null。
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  }, async (c) => {
    // 基线：先把 escapeHtml 的 ESM 来源（markdown-utils，含 i18n 域 claim）装入，
    // 再量 app-info 的桥键增量——本批唯一新增桥键：注册数与认领数各 +1。
    const markdownUtils = await c.load(MODULES.markdownUtils);
    assert.equal(typeof markdownUtils.escapeHtml, 'function', 'markdown-utils 须提供真实 escapeHtml');
    const beforeStats = kernelStats(c);
    const mod = await c.load(MODULES.appInfo);
    const afterStats = kernelStats(c);
    assert.deepEqual({
      registered: afterStats.registeredKeys - beforeStats.registeredKeys,
      claimed: afterStats.claimedKeys - beforeStats.claimedKeys,
    }, { registered: 1, claimed: 1 });

    assert.equal(typeof mod.renderBrandCard, 'function');
    assert.equal(c.window.renderBrandCard, mod.renderBrandCard, '桥键必须指向同一实现');

    // classic 写方（theme-lang 的 window 赋值）经 setter 转发进模块桥状态
    const replacement = function replacementProbe() {};
    const original = c.window.renderBrandCard;
    try {
      c.window.renderBrandCard = replacement;
      assert.equal(c.window.renderBrandCard, replacement, 'claim 后 classic 写方必须经 impl.set 转发');
    } finally {
      c.window.renderBrandCard = original;
    }
    for (const key of ['_appInfo', '_githubIconSvg', '_externalLinkSvg', '_initAppInfo', '_brandArea', '_brandCard']) {
      assertNotGlobal(c, key, `${key} 不应再是全局键`);
    }
    await flushAsync();
  });
});

test('app-info：数据未到位时调用零 DOM 写入（初始 _appInfo=null），到位后按语言填充', async () => {
  const documentStub = createDocumentStub();
  for (const id of BRAND_CARD_IDS) documentStub.ensure(id);
  // app-info 的数据到达受测试控制：请求挂起，直到本用例显式放行。
  let releaseAppInfo;
  const appInfoPending = new Promise((resolve) => { releaseAppInfo = resolve; });
  await withBatch3Case({ documentStub, fetch: () => appInfoPending }, async (c) => {
    const i18n = await c.load(MODULES.i18n);
    const mod = await c.load(MODULES.appInfo);

    // 初始值证据：app_info 请求尚未放行 → _appInfo 仍为 null → 立即 return，不查 DOM
    assert.equal(documentStub.byId.get('brand-card-desc').textContent, '', '装载阶段尚不应写入名片');
    const lookupsBefore = documentStub.lookups.length;
    c.window.renderBrandCard();
    const lookupsDuring = documentStub.lookups.slice(lookupsBefore);
    assert.deepEqual(lookupsDuring, [], '数据未到位时调用必须零 DOM 查找/写入');

    // 放行数据：模块内 renderBrandCard 填充（zh）
    releaseAppInfo({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        version: '9.9.9',
        framework: { version: '1.2.3' },
        repos: { app: 'https://example.test/app', framework: 'https://example.test/fw' },
      }),
    });
    await waitFor(() => documentStub.byId.get('brand-version-chip').textContent === 'v9.9.9',
      'app_info 落地并填充 chip');

    assert.equal(documentStub.byId.get('brand-card-version').textContent, 'v9.9.9');
    assert.equal(documentStub.byId.get('brand-card-framework').textContent, 'AgentDev 1.2.3');
    assert.equal(documentStub.byId.get('brand-card-desc').textContent, '可视化、可扩展的 AI Agent 工作台');
    assert.match(documentStub.byId.get('brand-card-links').innerHTML, /https:\/\/example\.test\/app/);

    // theme-lang 的真实调用形态：typeof 守卫 + 裸调用，经桥键命中同一实现
    i18n.setCurrentLanguage('en');
    try {
      assert.equal(typeof c.window.renderBrandCard, 'function');
      c.window.renderBrandCard();
      assert.equal(documentStub.byId.get('brand-card-desc').textContent, 'A visual, extensible AI agent workspace');
      assert.equal(documentStub.byId.get('brand-card-version-label').textContent, 'Version');
    } finally {
      i18n.setCurrentLanguage('zh');
    }
    // 桥键读的是模块实现本身（classic 裸调用与 ESM 调用同一份）
    assert.equal(typeof mod.renderBrandCard, 'function');
  });
});

// ── workspace-settings ────────────────────────────────────────────

test('workspace-settings：window 入口与 action 注册不变，配额处理器不再散装挂 window', async () => {
  const documentStub = createDocumentStub();
  await withBatch3Case({ documentStub }, async (c) => {
    const mod = await c.load(MODULES.workspaceSettings);
    assert.equal(c.window.openWorkspaceSettings, mod.openWorkspaceSettings);
    assert.equal(typeof mod.onWorkspaceQuotaChange, 'function');
    // 零 classic 消费方（原唯一消费者是已迁移的 vm 测试）→ 收为命名导出
    assertNotGlobal(c, 'onWorkspaceQuotaChange', 'onWorkspaceQuotaChange 不应再是全局键');
    for (const key of ['ensureWorkspaceSettingsHost', 'renderWorkspaceSettingsOverlay', 'loadWorkspaceSettingsPanel']) {
      assertNotGlobal(c, key, `${key} 是私有 helper，不应上桥`);
    }
    // 动作注册走真实 action-dispatcher（不是注册表桩）：键名不变
    const actions = c.window.ClawFW.actions;
    for (const name of ['wsSettings.close', 'wsSettings.visibilityChange', 'wsSettings.quotaChange']) {
      assert.equal(actions.has(name), true, `必须仍注册 ${name}`);
    }
    // 显示依赖：下拉增强走 claw-select 的 ESM 导出（window.ClawSelect 只是它的对外挂载）
    const clawSelect = await c.load(MODULES.clawSelect);
    assert.equal(c.window.ClawSelect.enhanceAll, clawSelect.enhanceAll);
  });
});

test('workspace-settings：面板开合状态归模块私有，渲染与关停走同一状态', async () => {
  const documentStub = createDocumentStub();
  const host = documentStub.ensure('workspace-settings-overlay-host');
  const container = documentStub.ensure('workspace-settings-container');
  documentStub.ensure('workspace-settings-status');
  const fetchCalls = [];
  await withBatch3Case({
    documentStub,
    fetch: async (url) => {
      fetchCalls.push({ url: String(url) });
      if (String(url) === '/protoclaw/workspace_settings') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            workspaceVisibility: { coder: 'always' },
            resourcePolicy: { coder: { maxLiveThreads: 2 } },
            liveRuntimes: { coder: 3 },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  }, async (c) => {
    const agentStore = await c.load(MODULES.agentStore);
    agentStore.setAllAgents([
      { id: 'coder', name: 'Coder', description: 'unattended', source: 'prebuilt',
        visibility: 'on-demand', permissions: ['maxLiveThreads', 'notifications.finish'],
        permissionDefaults: { 'notifications.finish': 'auto' } },
      { id: 'programming-helper', name: 'PH', source: 'prebuilt', visibility: 'persistent' },
    ]);

    const mod = await c.load(MODULES.workspaceSettings);
    mod.openWorkspaceSettings();
    assert.match(host.innerHTML, /工作空间/, '弹层骨架立即渲染');
    assert.match(host.innerHTML, /wsSettings\.close/);
    await waitFor(() => /Coder/.test(container.innerHTML), '面板行渲染');

    assert.doesNotMatch(container.innerHTML, /PH/, 'persistent 工作空间不上策略项');
    assert.match(container.innerHTML, /线程并发上限/);
    assert.match(container.innerHTML, /已超上限 2/, '超配额提示按 liveRuntimes 计算');
    assert.match(container.innerHTML, /完成通知/, '通知权限只读审计仍在');
    assert.ok(fetchCalls.some((call) => call.url === '/protoclaw/workspace_settings'));

    // 关停走真实分发器（data-action="wsSettings.close" 的注册实现）
    await c.window.ClawFW.actions.invoke('wsSettings.close');
    assert.equal(host.innerHTML, '', '关闭后弹层内容清空');
    assert.equal(c.window.ClawFW.workspaceSettingsOpen, undefined, '开合状态不再写 window.ClawFW');
    assertNotGlobal(c, 'workspaceSettingsOpen', '开合状态归模块私有');
  });
});

// ── container-images ──────────────────────────────────────────────

test('container-images：生命周期入口只经命名导出（零 window 消费方），宿主声明驱动请求参数', async () => {
  const documentStub = createDocumentStub();
  const container = documentStub.ensure('ci-host');
  documentStub.ensure('ci-status');
  const fetchCalls = [];
  await withBatch3Case({
    documentStub,
    fetch: async (url) => {
      fetchCalls.push({ url: String(url) });
      if (String(url) === '/protoclaw/container_images/overview?host=coder') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            docker: { reachable: true, version: '27.0.0' },
            executor: { configured: 'container', source: 'env' },
            gateway: { viewerAddr: '127.0.0.1:2026', httpBind: '0.0.0.0:14200' },
            host: { devTree: true },
            agents: [{ id: 'coder', name: 'Coder', images: [] }],
            containers: [],
            buildAvailable: false,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  }, async (c) => {
    const mod = await c.load(MODULES.containerImages);
    // 唯一消费方 ph-settings 已改静态 import（全树零 window 读点）→ 散装 window
    // 赋值注销，入口只剩命名导出。
    assert.equal(typeof mod.registerContainerImagesHost, 'function');
    assert.equal(typeof mod.loadContainerImagesPanel, 'function');
    assertNotGlobal(c, 'registerContainerImagesHost', '生命周期入口不再暴露为全局键');
    assertNotGlobal(c, 'loadContainerImagesPanel', '生命周期入口不再暴露为全局键');
    assertNotGlobal(c, 'stopContainerImagesPanel', '零消费方键不再暴露');
    const actions = c.window.ClawFW.actions;
    for (const name of ['containerImages.refresh', 'containerImages.delete', 'containerImages.build']) {
      assert.equal(actions.has(name), true, `必须仍注册 ${name}`);
    }

    mod.registerContainerImagesHost('ci-host', 'coder');
    mod.loadContainerImagesPanel();
    await waitFor(() => /容器运行时/.test(container.innerHTML), '容器镜像页渲染');

    assert.ok(fetchCalls.some((call) => call.url === '/protoclaw/container_images/overview?host=coder'),
      '宿主 agentId 进入请求参数');
    assert.match(container.innerHTML, /Docker 27\.0\.0/);
    assert.match(container.innerHTML, /Coder/);
  });
});

// ── usage-info-overlay ────────────────────────────────────────────

test('usage-info-overlay：window.openUsageInfo 兼容面与状态私有化', async () => {
  const documentStub = createDocumentStub();
  await withBatch3Case({ documentStub }, async (c) => {
    const mod = await c.load(MODULES.usageInfo);
    assert.equal(c.window.openUsageInfo, mod.openUsageInfo);
    assert.equal(c.window.ClawFW.usageInfo, undefined, '覆盖层状态收敛为模块私有');
    const actions = c.window.ClawFW.actions;
    for (const name of ['usageInfo.close', 'usageInfo.setRange', 'usageInfo.search']) {
      assert.equal(actions.has(name), true, `必须仍注册 ${name}`);
    }
  });
});

// ── annotations ───────────────────────────────────────────────────

test('annotations：window.ClawAnnotations 指向命名导出，Toast 走 ESM 导入', async () => {
  const documentStub = createDocumentStub();
  await withBatch3Case({ documentStub }, async (c) => {
    const mod = await c.load(MODULES.annotations);
    assert.equal(typeof mod.scheduleReplay, 'function');
    assert.equal(c.window.ClawAnnotations.scheduleReplay, mod.scheduleReplay);
    // 显示依赖：toast-notify 是 annotations 的直接 import，window.ClawToast 只是它的对外挂载
    const toast = await c.load(MODULES.toast);
    assert.equal(c.window.ClawToast, toast.ClawToast, 'annotations 的反馈通道必须就是 toast-notify 模块本身');
    for (const key of ['annotations', 'addressing', 'sessionKey', 'boundRuntimeRef', 'stream',
      'findOccurrence', 'occurrenceFor', 'buildTextModel']) {
      assertNotGlobal(c, key, `${key} 不应再是全局键`);
    }
  });
});

// ── remote-claw-settings ──────────────────────────────────────────

test('remote-claw-settings：名片内联事件所需的 window 函数与命名导出一一对应', async () => {
  const documentStub = createDocumentStub();
  await withBatch3Case({ documentStub }, async (c) => {
    const mod = await c.load(MODULES.remoteClaw);
    const pairs = {
      openRemoteClawSettings: 'openRemoteClawSettings',
      closeRemoteClawSettings: 'closeRemoteClawSettings',
      connectRemoteClaw: 'connectRemoteClaw',
      createRemoteClawPairing: 'createRemoteClawPairing',
      disconnectRemoteClaw: 'disconnectRemoteClaw',
      unregisterRemoteClaw: 'unregisterRemoteClaw',
      remoteClawSetView: 'setView',
      remoteClawResetPairing: 'remoteClawResetPairing',
      useRemoteClawMobileUrl: 'useRemoteClawMobileUrl',
    };
    for (const [windowKey, exportName] of Object.entries(pairs)) {
      assert.equal(typeof mod[exportName], 'function', `缺少导出 ${exportName}`);
      assert.equal(c.window[windowKey], mod[exportName], `window.${windowKey} 必须指向同一实现`);
    }
    for (const key of ['state', 'render', 'renderSetup', 'ensureHost', 'el']) {
      assertNotGlobal(c, key, `${key} 不应再是全局键`);
    }
  });
});

test('remote-claw-settings：打开未连接态渲染配置表单并读取 connector 配置', async () => {
  const documentStub = createDocumentStub();
  const host = documentStub.ensure('remote-claw-overlay-host');
  await withBatch3Case({
    documentStub,
    fetch: async (url) => {
      if (String(url) === '/protoclaw/remote_claw/config') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            config: { relayUrl: 'https://relay.example.test', workspaceName: 'MyClaw' },
            runtime: { lanUrls: ['http://192.168.1.9:8080'] },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  }, async (c) => {
    const mod = await c.load(MODULES.remoteClaw);

    await mod.openRemoteClawSettings();
    assert.match(host.innerHTML, /rc-overlay/);
    assert.match(host.innerHTML, /开启远程访问/, '未连接时进入 setup 视图');
    assert.match(host.innerHTML, /https:\/\/relay\.example\.test/, '表单填入服务端返回的 relayUrl');
    assert.match(host.innerHTML, /MyClaw/);

    mod.closeRemoteClawSettings();
    assert.equal(host.innerHTML, '');
  });
});
