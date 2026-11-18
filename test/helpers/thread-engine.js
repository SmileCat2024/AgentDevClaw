/**
 * thread-engine.js — 把「刷新引擎」thread-store.js 装进用例的 window（P4 T3 后是真实 ESM）。
 *
 * 为什么需要：引擎在**模块求值期**注册三条同步调度（2s 启动刷新 / 20s 周期 /
 * visibilitychange），注册用的是裸 `setTimeout` / `setInterval`——浏览器里就是
 * window 上的那两个，但对真实 import 来说解析到 `globalThis`。用例的 window 是桩
 * 对象时，这些注册会落到主 realm 的真实计时器上，回调跑到用例结束、全局已恢复之后
 * （`window` 变回 undefined → TypeError）。因此装载期间把两个计时器换成记账桩，装载
 * 完立刻恢复：只有**装载期注册**被丢弃，运行期计时器（重绑重试等）保持真实语义。
 *
 * 两条装载路线：
 *   - `loadThreadEngine()`：调用方已把 `globalThis.window` / `document` / `fetch`
 *     指向用例 window（installBrowserStubs、或 `globalThis.window = ctx` 惯用法）；
 *   - `installThreadEngine(sandbox)`：frontend-vm 沙箱路线，本函数负责挂全局并在
 *     返回的 `restore()` 里恢复——用例必须在 `finally` / `t.after()` 里调用它，
 *     因为模块运行期仍会读 `window`（不能提前还原）。
 */
import { loadModuleOnce } from './esm-module-loader.js';
import { withThreadCaseEnv } from '../p2-thread-case.js';
import { prepareEsmModules, SESSION_VIEW_DOMAIN } from '../p2-classic-hosts.js';

export const THREAD_ENGINE = 'public/src/modules/thread-store.js';

/** 真实 import 引擎；装载期的计时器注册被记账丢弃（见文件头注）。 */
export async function loadThreadEngine({ installGlobals = false } = {}) {
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const scheduled = [];
  globalThis.setTimeout = (fn, ms) => { scheduled.push({ kind: 'timeout', fn, ms }); return scheduled.length; };
  globalThis.setInterval = (fn, ms) => { scheduled.push({ kind: 'interval', fn, ms }); return -scheduled.length; };
  try {
    const loaded = await loadModuleOnce(THREAD_ENGINE, { installGlobals });
    return { ...loaded, scheduled };
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  }
}

/**
 * frontend-vm 沙箱路线：把沙箱挂成模块全局 → 真实 import 引擎 → 返回
 * `{ module, scheduled, restore }`。`fetch` 走转发包装，用例后续替换
 * `sandbox.fetch` 仍然生效。
 */
export async function installThreadEngine(sandbox) {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    hasFetch: 'fetch' in globalThis,
  };
  globalThis.window = sandbox;
  globalThis.document = sandbox.document;
  globalThis.fetch = (...args) => sandbox.fetch(...args);
  const loaded = await loadThreadEngine();
  return {
    ...loaded,
    restore() {
      if (previous.window === undefined) delete globalThis.window;
      else globalThis.window = previous.window;
      if (previous.document === undefined) delete globalThis.document;
      else globalThis.document = previous.document;
      if (previous.hasFetch) globalThis.fetch = previous.fetch;
      else delete globalThis.fetch;
    },
  };
}

/**
 * app-core 的桥键注册面（只取引擎关心的 6 个状态键）。引擎的 ESM 活绑定与沙箱
 * 属性经 KernelState 访问器互通，夹具里的初值与用例中途的写入因此同一份真相。
 */
export const THREAD_STATE_DOMAINS = {
  allAgents: 'agent-store',
  focusedAgentId: 'agent-store',
  readOnlyMode: 'agent-store',
  currentRuntimeAgentId: 'orchestration',
  _lastRenderedChatSig: 'render-entry',
  lastRenderedWorkspaceHtml: 'render-entry',
};

/**
 * 「最小 classic 夹具 + 真实 ESM 引擎」用例：不受 p2-thread-case 的先行脚本序
 * 约束（只碰引擎本身），但复用它的 case 级 ESM 图与端点/warn 守卫——每个用例
 * 一代模块实例，模块级状态不跨用例。
 *
 * @param {object} options
 * @param {object} [options.fixtures] 沙箱初值 + 宿主能力覆盖（同时作为 globals 注入）
 * @param {Function} [options.fetch] 网络夹具（线程事实等）
 * @param {Array} [options.threads] 线程事实：classic 相播种，基座在引擎求值后回放到 owner
 * @param {Function} [options.classicExtra] 额外 classic 源（`(sandbox) => void`）：用例需要
 *   真实 classic 实现切片（绑定段 / 宿主记录 / 标题兜底）时在里面执行，先于夹具覆盖
 * @param {string} [options.label]
 * @param {Function} probe `({ c, ctx, engine, requests }) => any`
 */
export async function withThreadEngineCase({ fixtures = {}, fetch: fetchImpl, threads = [], classicExtra, label = '' } = {}, probe) {
  return withThreadCaseEnv({
    label,
    fetch: fetchImpl,
    globals: fixtures,
    classic: (sandbox) => {
      // ADR-0026：会话视图提交原语（P4 T2 起是 ESM）在模块相装载；classic 相只登记，
      // 桥键在 case 图求值后可见。
      prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
      // 用例自带的 classic 实现切片（真实的宿主 / 绑定段），先于夹具覆盖执行。
      if (typeof classicExtra === 'function') classicExtra(sandbox);
      // 夹具在 classic 源之后落地：真实现的同名函数（readCurrentSessionViewState 等）
      // 不得盖掉用例给定的观测 / 替换面——与迁移前「夹具即最终 window 面」一致。
      for (const [name, value] of Object.entries(fixtures)) sandbox[name] = value;
      for (const [key, domain] of Object.entries(THREAD_STATE_DOMAINS)) {
        sandbox.KernelState.defineKey(domain, key, sandbox[key]);
      }
      // 会话视图桥键在模块相注册（访问器会顶掉 classic 相的夹具赋值）：交给
      // withThreadCaseEnv 在模块相之后原样重放一次，夹具语义（无条件覆盖）不变。
      sandbox.__caseOverrides = fixtures;
      if (!threads.length) return;
      // classic 相没有真实 ClawThreads（引擎是 ESM）：放占位对象并由
      // withThreadCaseEnv 在引擎求值后把写入整体回放到真实 owner。
      sandbox.run('window.ClawThreads = window.ClawThreads || { threads: [], byId: {}, sessionIndex: {}, activeConversation: null };'
        + ' window.__classicThreadFacts = window.ClawThreads;');
      sandbox.run(`window.ClawThreads.threads = ${JSON.stringify(threads)};`);
      sandbox.run(`(function () {
        const s = window.ClawThreads;
        s.byId = {}; s.sessionIndex = {};
        for (const t of s.threads) {
          s.byId[t.threadId] = t;
          for (const sid of (t.sessionIds || [])) s.sessionIndex[t.agentId + '::' + sid] = t;
        }
      })();`);
    },
  }, async ({ c, requests }) => {
    // 基座已求值过该模块：同一 case 图内重复 load 拿到同一实例。
    const engine = await c.load(THREAD_ENGINE);
    return probe({ c, ctx: c.window, engine, requests });
  });
}
