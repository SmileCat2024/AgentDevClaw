/**
 * p2-esm-case.js — classic 沙箱 + 真实 ESM 图的「用例上下文」（P2 跨批测试地基）。
 *
 * 解决的是 P2 长尾批次测试改造里反复出现的一类结构：一个用例里既要跑
 * classic script（首屏/宿主工厂/classic 消费方），又要真实 import 迁出后的
 * ESM 模块，且**用例之间必须互不残留**。三套既有路线各自缺一块：
 *   - frontend-vm 的 `ctx.loadSource`：classic 专用（export 语法直接 SyntaxError）；
 *   - esm-module-loader 的 `loadModuleOnce`：只刷新入口，静态依赖跨用例共享
 *     （状态复用、桥键重复注册，见 test/p2-esm-case.test.js 的回归用例）；
 *   - load-esm-plugin：源码变换，不是真实模块图。
 * 本套不改任何一个既有 helper，而是把「一次用例 = 一份 window + 一张 ESM 图」
 * 组合出来：
 *
 *   await withP2EsmCase({ classic: (sandbox) => sandbox.loadSource(...), globals }, async (c) => {
 *     const mod = await c.load('public/src/modules/<域>.js'); // 真实 import
 *     c.expose('NavigationCore', mod);                        // 命名导出 → 注入 classic ctx
 *     c.read('NavigationCore.waitForRuntimeReady(...)');       // classic 侧（含词法绑定）
 *   });
 *
 * 语义：
 *   - `sandbox` 是 createFrontendSandbox 产出的**真实 vm 上下文**，`loadSource`
 *     仍然只用于 classic script；ESM 一律 `c.load`。
 *   - `c.window === sandbox`（沙箱全局对象）：ESM 里的 `window.X` 与 classic 的
 *     裸 `X`/`window.X` 读写的是同一个全局对象，`KernelState` 访问器桥两端语义
 *     不变，无需任何桥的副本。
 *   - classic 顶层 `let`/`const` 是词法绑定、不是 window 属性：ESM 侧要通过
 *     真实 host seam（classic 提供的 `createXHost()` 工厂）取值，或测试用
 *     `c.read('lexicalName')` 断言。本 helper 不把词法绑定偷偷搬到 window 上。
 *   - 每个 case 在 p2-esm-graph 里持有自己的图命名空间：同 case 内所有 ESM 模块
 *     （含静态依赖、静态循环）共享一代实例，下一 case 整图重新实例化。
 *   - `globals` 同时装进沙箱与主 realm（`globalThis`），覆盖 ESM 裸引用
 *     `fetch` / `document` / `localStorage` 这类平台全局；用例结束按原属性
 *     描述符恢复（原本不存在的键直接删除）。
 *   - 计时器（setTimeout/setInterval/rAF）按 case 记账，dispose 时全部取消，
 *     防止上一个用例的回调跑进下一个用例的 window。
 *
 * 并发约束（明确）：`globalThis` 与 `window` 是进程级单例，同一时刻只允许一个
 * case 激活。并发调用 `withP2EsmCase` 会**串行排队**（不是并行、也不是报错）；
 * 用例体内嵌套调用 `withP2EsmCase` 会直接报错（会自锁，且嵌套没有语义）。
 * 用例体必须 await 自己启动的异步工作：已发出的 promise 无法取消，未 await 的
 * 续体若在 dispose 之后才执行，只能保证「拿不到本 case 的 load/expose 面」
 * （抛错），不能保证它不去读此刻已换成下一个 case 的全局对象。
 */
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import { createFrontendSandbox } from './frontend-vm.js';
import { beginCaseGraph, endCaseGraph } from './p2-esm-graph.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const caseStorage = new AsyncLocalStorage();

const hostSetTimeout = globalThis.setTimeout;
const hostClearTimeout = globalThis.clearTimeout;
const hostSetInterval = globalThis.setInterval;
const hostClearInterval = globalThis.clearInterval;

/**
 * 平台全局白名单：ESM 模块里以裸标识符出现、且浏览器里来自 window 的键。
 * 只安装沙箱中确实存在的键（沙箱没有的能力保持主 realm 原样，调用方要用
 * 就显式经 `globals` 注入）。`window` 单独处理（就是沙箱本身）。
 */
const PLATFORM_GLOBALS = [
  'document',
  'fetch',
  'localStorage',
  'location',
  'alert',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
];

let caseSeq = 0;

/** 串行闸：同一时刻只有一个 case 持有全局注入面。 */
let slotTail = Promise.resolve();
function acquireSlot() {
  const previous = slotTail;
  let release;
  slotTail = new Promise((resolve) => { release = resolve; });
  return previous.then(() => release);
}

function setGlobalDescriptor(key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (descriptor && descriptor.configurable === false) {
    throw new Error(`p2-esm-case: 无法注入全局 ${key}（属性不可配置）`);
  }
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: descriptor ? descriptor.enumerable : false,
  });
  return descriptor;
}

function restoreGlobalDescriptor(key, descriptor) {
  if (descriptor === undefined) {
    delete globalThis[key];
    return;
  }
  Object.defineProperty(globalThis, key, descriptor);
}

function resolveRepoFile(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) {
    throw new TypeError('p2-esm-case: load 需要仓库相对路径字符串');
  }
  const file = path.resolve(REPO_ROOT, relativePath);
  if (file !== REPO_ROOT && !file.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`p2-esm-case: ${relativePath} 解析后越出仓库根（${REPO_ROOT}）`);
  }
  return file;
}

/**
 * 建立一个用例上下文并执行 `fn`；用例结束（含抛错）后恢复全局、取消计时器、
 * 关闭图命名空间。
 *
 * @param {object|Function} [options]
 * @param {Function} [options.classic] `(sandbox) => void|Promise`：在沙箱里按真实
 *   加载序跑 classic script（通常调用 `sandbox.loadSource(...)`）。ESM 不走这里。
 * @param {object} [options.globals] 注入沙箱与 globalThis 的额外全局
 *   （如 `{ fetch, document, ClawFW }`）。值按引用原样注入，不深拷贝。
 * @param {string} [options.label] 用例标签（仅用于错误信息）。
 * @param {Function} fn `(p2case) => Promise<any>`；返回值原样透传。
 * @returns {Promise<any>}
 */
export async function withP2EsmCase(options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = {};
  }
  if (typeof fn !== 'function') throw new TypeError('withP2EsmCase: 需要用例函数');
  if (caseStorage.getStore()) {
    throw new Error('p2-esm-case: 不支持嵌套 withP2EsmCase（用例体内直接用当前 case 对象）');
  }

  const { classic, globals = {}, label = '' } = options || {};
  if (globals.window !== undefined) {
    throw new Error('p2-esm-case: globals.window 不可覆盖——window 就是本 case 的沙箱全局对象');
  }

  const release = await acquireSlot();
  const id = `p2c${++caseSeq}`;
  const pendingTimers = new Map(); // timer id → 'timeout' | 'interval'
  const savedGlobals = [];
  let sandbox = null;
  let disposed = false;

  const trackedSetTimeout = (callback, delay, ...args) => {
    if (typeof callback !== 'function') return hostSetTimeout(callback, delay, ...args);
    let timerId;
    timerId = hostSetTimeout(() => {
      pendingTimers.delete(timerId);
      callback(...args);
    }, delay);
    pendingTimers.set(timerId, 'timeout');
    return timerId;
  };
  const trackedClearTimeout = (timerId) => {
    pendingTimers.delete(timerId);
    hostClearTimeout(timerId);
  };
  const trackedSetInterval = (callback, delay, ...args) => {
    if (typeof callback !== 'function') return hostSetInterval(callback, delay, ...args);
    const timerId = hostSetInterval(() => callback(...args), delay);
    pendingTimers.set(timerId, 'interval');
    return timerId;
  };
  const trackedClearInterval = (timerId) => {
    pendingTimers.delete(timerId);
    hostClearInterval(timerId);
  };
  const cancelPendingTimers = () => {
    for (const [timerId, kind] of pendingTimers) {
      if (kind === 'interval') hostClearInterval(timerId); else hostClearTimeout(timerId);
    }
    pendingTimers.clear();
  };

  const moduleCache = new Map();
  let activeStore = null;

  const p2case = {
    id,
    get window() { return sandbox; },
    get document() { return sandbox.document; },
    get sandbox() { return sandbox; },

    /**
     * 在真实 classic 沙箱里求值（表达式或语句）：唯一能读到 classic 顶层
     * let/const 的入口，也可用于断言 classic 侧对注入面的可见性。
     */
    read(expression) {
      assertActive();
      return sandbox.run(expression);
    },

    /**
     * 真实 import 仓库内一个 ESM 模块（相对仓库根），返回其命名空间。
     * 同一 case 内重复调用同一路径返回同一实例（模块图身份）；不同 case 之间
     * 是不同实例。classic script 不得走这里——继续用 `sandbox.loadSource`。
     */
    async load(relativePath) {
      assertActive();
      const file = resolveRepoFile(relativePath);
      const cached = moduleCache.get(file);
      if (cached) return cached;
      const pending = import(pathToFileURL(file).href).catch((error) => {
        moduleCache.delete(file);
        throw error;
      });
      moduleCache.set(file, pending);
      return pending;
    },

    /**
     * 把 ESM 导出面注入 classic 沙箱：`window[name] = value`。
     * 生产里的兼容桥（KernelState 访问器）由模块自身建立，无需本方法；这里
     * 面向「classic 消费方经 window.X 命名空间调用」的既有协议与测试夹具。
     */
    expose(name, value) {
      assertActive();
      sandbox[name] = value;
      return value;
    },

    /** 本 case 尚未触发的计时器数量（隔离证据/诊断用）。 */
    timerCount() {
      return pendingTimers.size;
    },
  };

  function assertActive() {
    if (disposed) {
      throw new Error(`p2-esm-case ${id}${label ? `(${label})` : ''} 已结束：不能再 load/expose/read`);
    }
    if (caseStorage.getStore() !== activeStore) {
      throw new Error('p2-esm-case: case 方法必须在 withP2EsmCase 的用例体内（或其异步续体）调用');
    }
  }

  try {
    sandbox = createFrontendSandbox({
      ...globals,
      setTimeout: trackedSetTimeout,
      clearTimeout: trackedClearTimeout,
      setInterval: trackedSetInterval,
      clearInterval: trackedClearInterval,
      requestAnimationFrame: (callback) => trackedSetTimeout(() => callback(Date.now()), 0),
      cancelAnimationFrame: (timerId) => trackedClearTimeout(timerId),
    });

    if (typeof classic === 'function') await classic(sandbox);

    // 主 realm 注入：window 是沙箱本身；平台键取沙箱现值；调用方 globals 覆盖。
    const installMap = { window: sandbox };
    for (const key of PLATFORM_GLOBALS) {
      if (key in sandbox) installMap[key] = sandbox[key];
    }
    for (const [key, value] of Object.entries(globals)) installMap[key] = value;
    for (const [key, value] of Object.entries(installMap)) {
      savedGlobals.push([key, setGlobalDescriptor(key, value)]);
    }

    beginCaseGraph(id);
    activeStore = { caseId: id };
    return await caseStorage.run(activeStore, () => fn(p2case));
  } finally {
    disposed = true;
    endCaseGraph(id);
    cancelPendingTimers();
    for (const [key, descriptor] of savedGlobals.reverse()) {
      restoreGlobalDescriptor(key, descriptor);
    }
    sandbox = null;
    release();
  }
}
