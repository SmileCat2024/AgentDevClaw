/**
 * action-dispatcher.js — 统一事件委托分发器（Phase A 前端基建）
 *
 * 为什么存在：界面模板内联 `onclick="fn(...)"` 要求函数常驻全局作用域，
 * 是全局共享模式最深的锁定点（约 600 处内联处理器、百级全局函数）。本模块
 * 让处理函数经注册表按名字分发，模板改写为 `data-action="域.动作"` 声明，
 * 处理函数得以收进各模块局部作用域。存量内联处理器不强制迁移，随各域
 * 改造逐步收编（见 AGENTS.md「前端全局暴露门禁」behavior 层台账）。
 *
 * 协议：
 *   data-action="域.动作"     处理器名（点号命名空间防冲突，如 "wg.send"）
 *   data-args='[1, "a"]'      JSON 数组，按序展开为 handler 尾参（可省略）
 *   handler(el, event, ...args) 返回 false 时执行 preventDefault
 *
 * 与内联 onclick 的语义差异（迁移时注意）：内联 `return false` 隐含
 * stopPropagation；委托监听在 document 层，target 与 document 之间的其他
 * 监听器已先执行，stopPropagation 在此层无意义，故只做 preventDefault。
 * 需要阻止中间层监听的场景继续用内联或专属监听器，不强行收编。
 *
 * 接入：window.ClawFW.actions.register / registerMany / bindEventType。
 */
window.ClawFW = window.ClawFW || {};

(function () {
  const handlers = new Map();     // name -> fn（全事件类型共用一个名字空间）
  const owners = new Map();       // name -> owner（插件归属，卸载时按其精确摘除）
  const boundTypes = new Set();   // 已在 document 绑定监听的事件类型

  function parseArgs(el) {
    const raw = el.getAttribute('data-args');
    if (raw == null || raw === '') return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      return parsed;
    } catch (err) {
      console.error('[action-dispatcher] data-args 必须是 JSON 数组字符串：', raw, err);
      return null; // null 表示放弃分发（解析失败时静默调用可能造成误传参）
    }
  }

  /**
   * 在事件 target 链上解析 data-action 并调用处理器。
   * 返回 true 表示已分发（无论 handler 返回什么），false 表示无匹配。
   *
   * data-event 属性声明该元素期望的事件类型（dblclick/keydown 等）。
   * 委托监听在 document 层，同一元素可能同时收到 click 与 dblclick，
   * 因此声明了 data-event 的元素只响应匹配类型，避免双触发。
   */
  function dispatch(event) {
    let node = event.target;
    while (node && node !== document) {
      if (typeof node.getAttribute !== 'function') { node = node.parentNode; continue; }
      const name = node.getAttribute('data-action');
      if (name) {
        const declared = node.getAttribute('data-event');
        if (declared && declared !== event.type) return false;
        const handler = handlers.get(name);
        if (!handler) {
          console.error('[action-dispatcher] 未注册的 action：', name);
          return true;
        }
        const args = parseArgs(node);
        if (args === null) return true;
        // handler 返回 false ≈ 内联 return false 的可用部分（preventDefault）
        if (handler(node, event, ...args) === false) event.preventDefault();
        return true;
      }
      node = node.parentNode;
    }
    return false;
  }

  /** 绑定一种事件类型的委托分发。非冒泡事件（如 details 的 toggle）必须
   *  以 capture 绑定，document 冒泡阶段监听不到它们；capture 对冒泡事件的
   *  closest 寻址与 event.target 无影响，仅分发时机提前到捕获阶段。 */
  function bindEventType(type, { capture = false } = {}) {
    if (boundTypes.has(type)) return;
    boundTypes.add(type);
    document.addEventListener(type, dispatch, capture);
  }

  function register(name, handler, owner) {
    if (typeof handler !== 'function') {
      console.error('[action-dispatcher] register 拒绝非函数 handler：', name);
      return;
    }
    if (handlers.has(name)) {
      console.error('[action-dispatcher] action 名重复注册（拒绝覆盖）：', name);
      return;
    }
    handlers.set(name, handler);
    if (owner) owners.set(name, String(owner));
  }

  function registerMany(map, owner) {
    for (const [name, handler] of Object.entries(map || {})) register(name, handler, owner);
  }

  /** 按 owner 精确摘除该插件注册的全部 action，返回摘除数量。 */
  function unregisterOwner(owner) {
    const key = String(owner || '');
    if (!key) return 0;
    let removed = 0;
    for (const [name, nameOwner] of owners) {
      if (nameOwner === key) {
        handlers.delete(name);
        owners.delete(name);
        removed += 1;
      }
    }
    return removed;
  }

  // click/change/input 覆盖存量内联处理器的绝大多数；dblclick 与 keydown
  // 由 data-event 声明触发，分发器必须为它们绑定委托（否则永不派发）。
  bindEventType('click');
  bindEventType('change');
  bindEventType('input');
  bindEventType('dblclick');
  bindEventType('keydown');

  /** 按名触发已注册的 action（供宿主把通用动作转交给插件，不经 DOM 事件）。
   *  同步 handler 返回 true 表示已分发；async handler 的 Promise 原样透传，
   *  程序化调用方（宿主转发、测试驱动）才能 await 到动作完成。
   *  判定用 thenable 鸭子检查而非 instanceof Promise：测试沙箱（frontend-vm）
   *  会注入宿主 realm 的 Promise 遮蔽沙箱 realm 的同名全局，async 函数产生的
   *  沙箱 Promise 跨 realm instanceof 恒为 false，instanceof 写法会在沙箱里
   *  静默退化为「不等动作完成」。thenable 检查与 await 语义一致，跨 realm 安全。 */
  function invoke(name, el, event, ...args) {
    const handler = handlers.get(String(name));
    if (!handler) return false;
    const result = handler(el ?? null, event ?? null, ...args);
    return result && typeof result.then === 'function' ? result : true;
  }

  window.ClawFW.actions = {
    register,
    registerMany,
    unregisterOwner,
    bindEventType,
    dispatch,
    invoke,
    has: (name) => handlers.has(String(name)),
  };
})();
