/**
 * p2-classic-hosts.js — P2 用例的 classic 相装载链（测试支撑，不是产品代码）。
 *
 * 为什么需要：ESM 化后，一个域模块的静态依赖链可能触达 agent-loader-host /
 * session-view-state / sidebar-render / app-ui / app-main，这些模块在**装载期**
 * 就调用 classic 相提供的宿主工厂：
 *   - createSessionViewCommitHost      ← session-view-state.js
 *   - createAgentCallStatesHost        ← sidebar-render.js（读 runtime-status 的词法容器）
 *   - createRuntimeSwitchHost / createCompactResumeHost ← app-main.js
 *   - createWorkspaceSurfaceHost       ← app-ui.js
 * 手写同形桩会把「宿主工厂契约」复制到测试里，生产改动无法被用例发现；
 * 这里改为**执行真实的 classic 脚本**（顺序同 public/index.html 的先行脚本），
 * 宿主工厂因此就是生产实现本身。
 *
 * 唯一路线：`prepareClassicSandbox(sandbox)` 把整条链装进给定沙箱，
 * `withP2EsmCase` 的 `classic` 回调用它——沙箱就是用例 window，ESM 图与 classic
 * 相共享同一全局对象（不存在第二个 KernelState，也不存在把工厂引用搬到另一个
 * 全局对象的用法）。
 *
 * 首屏 boot 体（app-ui / app-main 顶层）挂在 `window.__clawAuthReady` 之后：
 * 这里给它一个永不 resolve 的 promise，用例不驱动首屏 DOM 渲染。周期排程
 * （通知时钟 / 轮询 / rAF）一并关掉——用例不测它们，开着会让进程留下句柄。
 */

/** index.html 的先行脚本序（classic 相在 deferred ESM 之前执行）。 */
export const CLASSIC_BOOTSTRAP = [
  'public/src/modules/action-dispatcher.js',
  'public/src/modules/claw-host.js',
  'public/src/modules/right-panel-registry.js',
  'public/src/app-core.js',
  'public/src/modules/runtime-status.js',
  'public/src/modules/session-view-state.js',
  'public/src/modules/sidebar-render.js',
  'public/src/app-ui.js',
  'public/src/app-main.js',
];

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
 * @param {{ run: Function, loadSource: Function }} sandbox
 */
export function prepareClassicSandbox(sandbox) {
  sandbox.run(BOOT_NEUTRALIZER);
  for (const file of CLASSIC_BOOTSTRAP) sandbox.loadSource(file);
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
  sandbox.loadSource('public/src/app-main.js');
}
