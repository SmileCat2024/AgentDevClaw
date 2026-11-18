/**
 * p2-classic-hosts.js — P2 用例的 classic 相装载链（测试支撑，不是产品代码）。
 *
 * 为什么需要：ESM 化后，一个域模块的静态依赖链可能触达 agent-loader-host /
 * sidebar-render，这些模块在**装载期**就调用 classic 相提供的宿主工厂：
 *   - createAgentCallStatesHost        ← sidebar-render.js（读 runtime-status 的词法容器）
 *   - agent-loader-host 起的数据装载链在求值期取 poll-coordinator / runtime-switch
 *     等宿主工厂 ← app-main.js（P4 T3 收尾迁 ESM 后由 APP_MAIN_DOMAIN 在模块相
 *     最先装载，等价于生产侧 index.html 的标签序）
 * （app-ui 在 P4 T2 末件迁 ESM 后不再属于这条 classic 链：它的宿主工厂
 * createWorkspaceSurfaceHost 由 workspace-surface-host 具名 import，见
 * APP_UI_DOMAIN。）
 * （session-view-state 在 P4 T2 批次迁 ESM 后不再取 classic 工厂：提交策略宿主
 * 由 session-view-commit-host 具名 import，见 SESSION_VIEW_DOMAIN 的注释。）
 * 手写同形桩会把「宿主工厂契约」复制到测试里，生产改动无法被用例发现；
 * 这里改为**执行真实的 classic 脚本**（顺序同 public/index.html 的先行脚本），
 * 宿主工厂因此就是生产实现本身。
 *
 * 唯一路线：`prepareClassicSandbox(sandbox)` 把整条链装进给定沙箱，
 * `withP2EsmCase` 的 `classic` 回调用它——沙箱就是用例 window，ESM 图与 classic
 * 相共享同一全局对象（不存在第二个 KernelState，也不存在把工厂引用搬到另一个
 * 全局对象的用法）。
 *
 * 首屏 boot 体（app-main 的 async IIFE）与模块相的 app-ui 求值挂在 `window.__clawAuthReady` 之后：
 * 这里给它一个永不 resolve 的 promise，用例不驱动首屏 DOM 渲染。周期排程
 * （通知时钟 / 轮询 / rAF）一并关掉——用例不测它们，开着会让进程留下句柄。
 */

import { createAgentSnapshotLoader } from '../public/src/modules/agent-snapshot-loader.js';

/**
 * index.html 的先行脚本序（classic 相在 deferred ESM 之前执行）。
 *
 * P4 T2 收尾批次起 runtime-status / sidebar-render 已迁 ESM，不再出现在这条
 * classic 链里；它们按真实加载序在 classic 链之后由 `SIDEBAR_DOMAIN` 装载
 * （模块相，与浏览器的「classic 先、module 后」一致）。
 */
export const CLASSIC_BOOTSTRAP = [
  'public/src/modules/action-dispatcher.js',
  'public/src/modules/claw-host.js',
  'public/src/modules/right-panel-registry.js',
  'public/src/app-core.js',
  // session-view-state 在 P4 T2 批次进模块相（原 classic 标签已从 index.html 删除）：
  // 它在 SESSION_VIEW_DOMAIN 里、排在 SIDEBAR_DOMAIN 之前装载——classic 消费方
  // （app-ui / app-core）按桥键晚绑定取用，不需要 classic 相实现。
  // app-main 在 P4 T3 收尾迁 ESM（原 classic 标签已删除）：本体由 APP_MAIN_DOMAIN
  // 在模块相装载，且**必须最先**（见该常量与 consumePendingClassicPrep）。
];

/**
 * 编排域（P4 T3 收尾：app-main 迁 ESM）。
 *
 * 为什么必须先装载：本域提供 12 个 createXHost 宿主工厂，kernel-entry 图的宿主
 * 模块在**求值期**取用它们（生产侧由 index.html 的 module 标签序保证：app-main
 * 入口早于 kernel-entry）。夹具里的等价物就是「本域排在 ESM 装载清单最前」——
 * 见 `consumePendingClassicPrep`（登记了本域时总是先装载它）。
 *
 * 后续域（runAgentList / 输入面 / 数据装载等）会经静态 import 触达那些宿主模块，
 * 因此顺序颠倒会让它们在窗口上取到 undefined 的宿主工厂并整图求值失败。
 */
export const APP_MAIN_DOMAIN = ['public/src/app-main.js'];

/**
 * 首屏 DOM 引用域（P4 T1：从 app-core 抽出）。owner 是模块相，classic 相只有
 * 两个桥键（container / currentAgentTitle）。凡静态依赖链触达 p2-bootstrap-dom
 * 的域模块，装载期就要取到 domRefs——因此排在 P4_DOMAINS 的最前面；app-core
 * 的 createRuntimeViewCacheHost 也按桥键读 container。
 */
export const DOM_REFS_DOMAIN = ['public/src/modules/dom-refs.js'];

/**
 * 身份解析域（P4 T1：从 app-core 抽出）。会话 / 运行身份函数与 viewer 会话绑定
 * 的 owner 在模块相；桥键（domain identity）服务 app-core / app-main /
 * desktop-notify 的 classic 调用。夹具里凡跑真实侧栏 / 会话链的都要它。
 */
export const IDENTITY_DOMAIN = ['public/src/modules/identity.js'];

/**
 * 传输域（P4 T1：从 app-core 抽出）：fetch 分流补丁 + invoke + Viewer 就绪宿主。
 * invoke 的桥键吸收 classic 相已写入的实现（夹具替换 IPC 缝后仍生效）。
 */
export const TRANSPORT_DOMAIN = ['public/src/modules/transport.js'];

/**
 * 会话视图提交边界（P4 T2 批次）。必须先于 SIDEBAR_DOMAIN：sidebar-render /
 * runtime-status 的桥接期调用点在函数体内晚绑定，但它们的用例常在同一 case 里
 * 同步读 `readCurrentSessionViewState()` 的结果，桥键注册要在此之前完成。
 *
 * commit-host 一并登记：迁移前夹具装载 classic `session-view-state.js` 时，
 * frontend-vm 的 installSessionViewCommit 钩子会把真实 `commitSessionViewPatch` /
 * `isSessionViewTokenCurrent` 装进沙箱；该钩子随 classic 装载路线一并退役，等价面
 * 改由 session-view-commit-host 在模块相注册的桥键提供（同一份 ESM 策略实例）。
 */
export const SESSION_VIEW_DOMAIN = [
  'public/src/modules/session-view-state.js',
  'public/src/modules/session-view-commit-host.js',
];

/**
 * 侧栏渲染 / 运行时状态 / call 状态引擎（P4 T2 收尾批次迁入 ESM 的域）。
 * 顺序即 import 边：runtime-status ← sidebar-render ← agent-call-states-engine。
 */
export const SIDEBAR_DOMAIN = [
  'public/src/modules/runtime-status.js',
  'public/src/modules/sidebar-render.js',
  'public/src/modules/agent-call-states-engine.js',
];

/**
 * 工作空间主视图渲染域（P4 T2 末件）。装载期消费方 workspace-surface-host 是本
 * 模块具名 import 的依赖（求值期取 createWorkspaceSurfaceHost），随本域一起进图。
 */
export const APP_UI_DOMAIN = ['public/src/app-ui.js'];

/**
 * 全部 P4 域模块（装载序：会话视图边界 → 侧栏 / 运行时状态 / call 引擎）。
 *
 * app-ui 有意**不**进默认清单：它的静态依赖覆盖 workspace-blocks / assembly-* /
 * fw-config-panel / debug-* 等整片域，逐 case 实例化约 50ms，默认装载会把每个
 * P2 用例的墙钟推高一个量级。需要它的用例显式
 * `prepareEsmModules(sandbox, [...P4_DOMAINS, ...APP_UI_DOMAIN])`。
 */
export const P4_DOMAINS = [...APP_MAIN_DOMAIN, ...DOM_REFS_DOMAIN, ...IDENTITY_DOMAIN, ...TRANSPORT_DOMAIN, ...SESSION_VIEW_DOMAIN, ...SIDEBAR_DOMAIN];

/**
 * classic 链夹具「顺手」发起的 ESM 域装载（pending prep）。
 *
 * 为什么需要这一层：夹具在 `withP2EsmCase({ classic })` 的回调里以**语句**形态
 * 调用（历史写法返回 void），ESM 装载无法在回调内同步完成。于是夹具只在这里
 * **登记待装载项**；withP2EsmCase 在 classic 回调返回、主 realm 注入面就绪之后
 * 调 `consumePendingClassicPrep()` 启动并 await 它（真实 import 必须晚于
 * globalThis.window 注入，否则模块求值期读 `window` 直接 ReferenceError）。
 *
 * 约束：同一时刻只有一个 case 激活（p2-esm-case 的互斥闸），因此单槽安全；
 * 同沙箱重复登记是幂等的（prepareClassicSandbox 与 installForegroundSyncOwner
 * 常先后调用）。
 */
const APP_MAIN_PATH = 'public/src/app-main.js';
let pendingClassicPrep = null;   // { sandbox, modules }
const domainBySandbox = new WeakMap(); // sandbox → 已启动的装载 promise

export function consumePendingClassicPrep() {
  const entry = pendingClassicPrep;
  pendingClassicPrep = null;
  if (!entry) return null;
  // 夹具覆盖快照（见 replayAppMainOverrides）：在 classic 链与夹具赋值都已落定、
  // 模块图尚未求值之前拍下沙箱自有数据属性。
  const overrides = snapshotOwnDataProps(entry.sandbox);
  const promise = (async () => {
    const loaded = new Map();
    // 编排域（app-main）总是最先求值：它的 createXHost 工厂是其余域静态 import
    // 触达的宿主模块在求值期取用的对象（生产侧由 index.html 标签序表达）。
    const ordered = [...entry.modules].sort((a, b) => Number(b === APP_MAIN_PATH) - Number(a === APP_MAIN_PATH));
    for (const modulePath of ordered) {
      loaded.set(modulePath, await entry.sandbox.loadEsm(modulePath));
      // 编排域求值完、其余域尚未装载时回放夹具覆盖：迁移前 app-main 是 classic
      // 顶层 function，夹具在 classic 链之后的 `sandbox.X = 替身` 会被随后装载的
      // 消费方（poll-coordinator-host 等宿主模块）读到；迁 ESM 后这些名字成了
      // 桥键，注册时以模块实现为初值，classic 相的同名普通属性会被覆盖。
      if (modulePath === APP_MAIN_PATH) replayAppMainOverrides(entry.sandbox, loaded.get(modulePath), overrides);
    }
    return applyEsmDomain(entry.sandbox, loaded);
  })().catch((error) => {
    domainBySandbox.delete(entry.sandbox);
    throw error;
  });
  domainBySandbox.set(entry.sandbox, promise);
  return promise;
}

/** 沙箱自有数据属性快照（夹具覆盖面；访问器与 harness 方法不在内）。 */
function snapshotOwnDataProps(sandbox) {
  const snapshot = new Map();
  for (const name of Object.getOwnPropertyNames(sandbox)) {
    const descriptor = Object.getOwnPropertyDescriptor(sandbox, name);
    if (!descriptor || descriptor.get || descriptor.set) continue;
    if (!('value' in descriptor)) continue;
    if (typeof descriptor.value === 'function' && ['run', 'loadSource', 'loadEsm', 'expose'].includes(name)) continue;
    if (name === 'window' || name === 'globalThis') continue;
    snapshot.set(name, descriptor.value);
  }
  return snapshot;
}

/**
 * 回放夹具对编排域（app-main）对外符号的覆盖。
 *
 * 为什么需要：迁移前 app-main 是 classic script，它的顶层 function 直接是 window
 * 上的同名属性；夹具在 classic 链之后 `sandbox.X = 替身` 就是**覆盖生产实现**，
 * 随后装载的消费者（poll-coordinator-host / runtime-switch-host 等宿主模块在求值
 * 期取宿主工厂）看到的就是替身。迁 ESM（P4 T3 收尾）后这些名字是桥键：注册时以
 * 模块实现为初值，classic 相写入的普通属性会在模块求值期被覆盖掉——覆盖失效。
 *
 * 因此本支撑面在「编排域求值完、其余域尚未装载」的那一刻把夹具写过的同名值经
 * 桥 setter 写回，恢复迁移前的可观察语义（窗口面 = 夹具替身，消费方读到的同一份）。
 * 只回放 app-main 的对外符号；其余名字保持原样（它们的 owner 没变）。
 *
 * 边界（如实记录）：模块**内部**对自身函数的调用走模块实现，不读桥键——迁移前
 * 那种"覆盖连内部调用一起改"的效果不再成立。依赖该效果的用例须改为自带替身宿主
 * （`APP_MAIN_DOMAIN` 之外的显式 stub），不要反过来放宽断言。
 */
function replayAppMainOverrides(sandbox, appMainModule, overrides) {
  const bridged = appMainModule?.bridgeApi;
  if (!bridged || !overrides) return;
  for (const [name, value] of overrides) {
    if (!(name in bridged)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(sandbox, name);
    if (!descriptor || typeof descriptor.set !== 'function') continue;
    if (descriptor.get && descriptor.get() === value) continue;
    sandbox[name] = value;
  }
}

/**
 * 把已装载的域模块挂到沙箱上（投影 + `__esmDomain` 出口）。两条装载路线共用：
 *   - withP2EsmCase 用例 → `consumePendingClassicPrep()`（模块经 `sandbox.loadEsm` 装；
 *     对已在装载时机的 classic 回调用「登记 → 消费」两步）；
 *   - 手动注入 globalThis.window 的夹具（`prepareClassicSandbox(ctx, {deferEsmDomain:false})`
 *     + `loadEsmDomain`）→ 自己 `await`，因为它本来就在 async 体里。
 */
function applyEsmDomain(sandbox, loaded) {
  const sidebarRender = loaded.get('public/src/modules/sidebar-render.js');
  // 侧栏装载器：原 frontend-vm 的 loadSource('sidebar-render.js') 钩子在这里
  // 等价重建（宿主工厂现为 sidebar-render 的命名导出，装载器实现不变）。只在
  // 夹具自己没有 loadAgents 时补，免得把用例装的替身顶掉。
  if (sidebarRender && typeof sandbox.loadAgents !== 'function') {
    Object.assign(sandbox, createAgentSnapshotLoader(sidebarRender.createAgentSnapshotLoaderHost()));
  }
  // 域命名空间出口（测试支撑）：迁出 classic 词法面的状态（如 runtime-status 的
  // `_agentSuspended`、引擎实例）在 classic 沙箱里没有 window 形态，用例经
  // `__esmDomain.<域>` 取真实模块实例——与 `c.load(...)` 同一实例，不建第二份状态。
  const appUi = loaded.get('public/src/app-ui.js');
  sandbox.__esmDomain = Object.freeze({
    appMain: loaded.get('public/src/app-main.js'),
    domRefs: loaded.get('public/src/modules/dom-refs.js'),
    identity: loaded.get('public/src/modules/identity.js'),
    transport: loaded.get('public/src/modules/transport.js'),
    sessionViewState: loaded.get('public/src/modules/session-view-state.js'),
    runtimeStatus: loaded.get('public/src/modules/runtime-status.js'),
    sidebarRender,
    agentCallStatesEngine: loaded.get('public/src/modules/agent-call-states-engine.js'),
    appUi,
  });
  // 夹具投影（**测试支撑面，生产没有这些全局**）：迁移前这些名字是 classic 顶层
  // 函数，夹具有大量 `sandbox.run('renderSidebarChildItems(...)')` 式的经典字符串
  // 直接按裸名调用真实实现。投影的是同一份模块导出（不是副本、不是另一套实现）。
  // 只投影本次登记清单里实际装载的域：裁剪链夹具（只登记 SESSION_VIEW_DOMAIN）不
  // 装侧栏 / 运行时状态，不必为它们补这一层。
  const projection = {
    renderSidebarChildItems: sidebarRender?.renderSidebarChildItems,
    resolveFocusedAgentAfterRefresh: sidebarRender?.resolveFocusedAgentAfterRefresh,
    createAgentCallStatesHost: sidebarRender?.createAgentCallStatesHost,
    createAgentSnapshotLoaderHost: sidebarRender?.createAgentSnapshotLoaderHost,
    createP2BootstrapSidebarRenderHost: sidebarRender?.createP2BootstrapSidebarRenderHost,
    collectRuntimeEntriesForPrebuilt: sandbox.__esmDomain.runtimeStatus?.collectRuntimeEntriesForPrebuilt,
    isRuntimeCalling: sandbox.__esmDomain.runtimeStatus?.isRuntimeCalling,
    isRuntimeSuspended: sandbox.__esmDomain.runtimeStatus?.isRuntimeSuspended,
    isSidebarRuntimeDisconnected: sandbox.__esmDomain.runtimeStatus?.isSidebarRuntimeDisconnected,
    isSuspendedNotificationPayload: sandbox.__esmDomain.runtimeStatus?.isSuspendedNotificationPayload,
    resolveNotificationCallingState: sandbox.__esmDomain.runtimeStatus?.resolveNotificationCallingState,
    // app-ui（P4 T2 末件）：桥面之外的测试支撑面——单元模式判定与布局适配的
    // 纯函数 / 常量投影（生产里只有桥键那几个，这些名字的消费方全在测试）。
    // 桥键（renderCurrentMainView / isChatSurfaceActive / …）由模块自身注册到
    // 沙箱 window，不经本投影。
    createWorkspaceSurfaceHost: appUi?.createWorkspaceSurfaceHost,
    getUnitPreferenceKey: appUi?.getUnitPreferenceKey,
    getDefaultUnitMode: appUi?.getDefaultUnitMode,
    getPassiveWorkspaceSurfaceMode: appUi?.getPassiveWorkspaceSurfaceMode,
    getUnitTabs: appUi?.getUnitTabs,
    getWorkspaceSurfaceScrollKey: appUi?.getWorkspaceSurfaceScrollKey,
    _isNarrowScreen: appUi?._isNarrowScreen,
    _getSidebarOccupiedWidth: appUi?._getSidebarOccupiedWidth,
    _getPanelOccupiedWidth: appUi?._getPanelOccupiedWidth,
    _sidebarDragCeiling: appUi?._sidebarDragCeiling,
    _panelDragCeiling: appUi?._panelDragCeiling,
    renderWorkspaceBlock: appUi?.renderWorkspaceBlock,
  };
  for (const [name, value] of Object.entries(projection)) {
    if (typeof value === 'function' && typeof sandbox[name] !== 'function') sandbox[name] = value;
  }
  // 状态容器同款投影：`_agentSuspended`（B4 具名导出的同一 Map 引用）。
  if (sandbox.__esmDomain.runtimeStatus && sandbox._agentSuspended === undefined) {
    sandbox._agentSuspended = sandbox.__esmDomain.runtimeStatus._agentSuspended;
  }
  // 布局适配常量（app-ui 的模块级 const，非桥）：测试按原顶层 const 的读法取值。
  for (const key of ['CENTRAL_MIN_WIDTH', 'SIDEBAR_MAX_WIDTH']) {
    if (appUi?.[key] !== undefined && sandbox[key] === undefined) sandbox[key] = appUi[key];
  }
  ensureSidebarRenderHostSeam(sandbox);
  return sandbox.__esmDomain;
}

/**
 * 侧栏渲染的 classic 协作面（app-ui / app-main 的实现；本批 sidebar-render 进
 * 模块相后它改经 `window.X` 晚绑定）。裁剪链没装这两个 classic 文件时，真实
 * `renderAgentList` 一旦被触发（操作失效 / calling 边沿 / 远程目录刷新）就会
 * TypeError；按生产宿主面给最小实现——这些夹具的断言都不落在侧栏 DOM 上。
 *
 * 只补缺失项：夹具自己装了的（含真实 app-ui / app-main）原样保留。
 */
export function ensureSidebarRenderHostSeam(sandbox) {
  if (typeof sandbox.groupConnectedAgents !== 'function') {
    sandbox.groupConnectedAgents = (agents) => ({ external: Array.isArray(agents) ? agents : [], groups: [] });
  }
  if (typeof sandbox.updateCurrentAgentChrome !== 'function') sandbox.updateCurrentAgentChrome = () => {};
  if (!sandbox.ClawSidebarLayout) {
    sandbox.ClawSidebarLayout = {
      load: async () => {}, signature: () => '', isInteracting: () => false, render() {},
    };
  }
  // 条目高亮谓词（app-main 的 classic 函数）：真实 `renderAgentList` 逐条目调用。
  // 裁剪链缺它们时按「无 runtime 选中」的分支给最小实现——落在这条路径上的夹具
  // 断言都不看高亮态，装了真实 app-main 的夹具不会被覆盖。
  if (typeof sandbox.isAgentActive !== 'function') sandbox.isAgentActive = () => false;
  if (typeof sandbox.isRuntimeItemActive !== 'function') sandbox.isRuntimeItemActive = () => false;
  return sandbox;
}

/**
 * 手动注入 `globalThis.window` 的夹具（不需要 withP2EsmCase 的「登记 → 消费」两步）
 * 直接 await 这条：按给定 loader 装载域模块并投影到沙箱。
 *
 * 为什么需要第二条装载路线：这类夹具的 window 注入发生在自己的 async 体里（
 * `globalThis.window = ctx`），classic 链之后马上就能 `await`，没有「classic 回调
 * 必须同步返回」的约束。模块实例由 loader 决定（这类夹具用无 query 的图，与它们
 * 自己的 `import()` 共用实例，不另开一份）。
 *
 * @param {object} sandbox 已注入为 globalThis.window 的 classic 沙箱
 * @param {(modulePath: string) => Promise<object>} loadModule 相对仓库根的模块装载器
 * @param {string[]} [modules] 默认 P4_DOMAINS（会话视图边界 + 侧栏域）
 */
export async function loadEsmDomain(sandbox, loadModule, modules = P4_DOMAINS) {
  const loaded = new Map();
  for (const modulePath of modules) loaded.set(modulePath, await loadModule(modulePath));
  return applyEsmDomain(sandbox, loaded);
}

/**
 * 登记「classic 相之后装载 SIDEBAR_DOMAIN」。返回 null（真正启动由
 * withP2EsmCase 在注入面就绪后调用 consumePendingClassicPrep）。
 */
export function prepareSidebarDomain(sandbox) {
  return scheduleEsmDomain(sandbox, SIDEBAR_DOMAIN);
}

/**
 * 登记「classic 相之后装载 P4_DOMAINS」。裁剪链夹具只缺会话视图边界时用它，
 * 比 prepareClassicSandbox 少装首屏链；与同沙箱的其它登记合并，不互相顶掉。
 */
export function prepareEsmModules(sandbox, modules) {
  return scheduleEsmDomain(sandbox, modules);
}

function scheduleEsmDomain(sandbox, modules) {
  if (domainBySandbox.has(sandbox)) return domainBySandbox.get(sandbox);
  if (typeof sandbox?.loadEsm !== 'function') {
    throw new Error('p2-classic-hosts: 该沙箱不在 withP2EsmCase 用例内（缺少 sandbox.loadEsm）');
  }
  if (pendingClassicPrep && pendingClassicPrep.sandbox !== sandbox) {
    throw new Error('p2-classic-hosts: 上一个 classic 链的 ESM 域装载尚未被消费（用例串行契约被破坏）');
  }
  // 同一沙箱的多处登记（典型：夹具自己 prepareEsmModules + 随后 prepareClassicSandbox）
  // 合并成一个待装载清单，保持「先登记的模块先装载」。
  if (!pendingClassicPrep) {
    pendingClassicPrep = { sandbox, modules: [...modules] };
  } else {
    for (const modulePath of modules) {
      if (!pendingClassicPrep.modules.includes(modulePath)) pendingClassicPrep.modules.push(modulePath);
    }
  }
  return null;
}

/** boot 体不运行 + 周期排程不启动（用例只取 classic 相的宿主工厂）。 */
const BOOT_NEUTRALIZER = [
  'window.__clawAuthReady = new Promise(() => {});',
  'applyTheme = () => {};',
  'applyLanguage = () => {};',
  'ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };',
  'setInterval = () => 0;',
  'clearInterval = () => {};',
  'requestAnimationFrame = () => 0;',
].join(' ');

/**
 * 在给定沙箱里按真实顺序装载整条 classic 链。
 *
 * `deferEsmDomain: false` 给手动注入 window 的夹具用：它自己 `await loadEsmDomain(...)`，
 * 因此这里只装 classic 链（模块相求值必须晚于 `globalThis.window` 注入）。
 *
 * @param {{ run: Function, loadSource: Function }} sandbox
 * @param {{ deferEsmDomain?: boolean }} [options]
 */
export function prepareClassicSandbox(sandbox, { deferEsmDomain = true } = {}) {
  sandbox.run(BOOT_NEUTRALIZER);
  for (const file of CLASSIC_BOOTSTRAP) sandbox.loadSource(file);
  // 侧栏渲染的协作面在 classic 相就补齐：既有「classic 链之后直接跑夹具」的路径
  // （不消费 pending prep 的用例）也需要它，否则真实 renderAgentList 触发时
  // `window.ClawSidebarLayout` 缺席。
  ensureSidebarRenderHostSeam(sandbox);
  return deferEsmDomain ? prepareEsmModules(sandbox, P4_DOMAINS) : null;
}

/**
 * 只装 app-main（classic 前台同步引擎的唯一 owner）——用于已有裁剪链（典型是
 * 只装 app-core / runtime-status / sidebar-render 的侧栏夹具）需要
 * `refreshAgentCallStates` / `collectActiveCallRuntimeIds` 两个桥键，但不需要
 * 整条首屏链的情况。
 *
 * 调用前置：app-core、runtime-status、sidebar-render 已按先行脚本序装载
 * （引擎在装载期组合 `createAgentCallStatesHost()`，缺 `_agentSuspended` 会
 * 直接 ReferenceError）。boot 体挂在永不 resolve 的 `__clawAuthReady` 上；
 * app-main 末尾的主题/语言应用在缺 theme-lang 时由本地空实现兜住（不改语义，
 * 只避免装载期 ReferenceError）。
 */
export function installForegroundSyncOwner(sandbox) {
  if (typeof sandbox.applyTheme !== 'function') sandbox.applyTheme = () => {};
  if (typeof sandbox.applyLanguage !== 'function') sandbox.applyLanguage = () => {};
  sandbox.run('window.__clawAuthReady = window.__clawAuthReady || new Promise(() => {});');
  // app-main 迁 ESM（P4 T3 收尾）后本体在模块相：可见性监听器、call 状态宿主的
  // 协作面（allAgents / _agentCallActive 等）都由它装载时建立。登记到 ESM 清单
  // 最前（consumePendingClassicPrep 保证），侧栏域随之装载。
  prepareEsmModules(sandbox, APP_MAIN_DOMAIN);
  return prepareSidebarDomain(sandbox);
}
