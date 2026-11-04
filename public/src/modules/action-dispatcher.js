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
   */
  function dispatch(event) {
    let node = event.target;
    while (node && node !== document) {
      if (typeof node.getAttribute !== 'function') { node = node.parentNode; continue; }
      const name = node.getAttribute('data-action');
      if (name) {
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

  function bindEventType(type) {
    if (boundTypes.has(type)) return;
    boundTypes.add(type);
    document.addEventListener(type, dispatch);
  }

  function register(name, handler) {
    if (typeof handler !== 'function') {
      console.error('[action-dispatcher] register 拒绝非函数 handler：', name);
      return;
    }
    if (handlers.has(name)) {
      console.error('[action-dispatcher] action 名重复注册（拒绝覆盖）：', name);
      return;
    }
    handlers.set(name, handler);
  }

  function registerMany(map) {
    for (const [name, handler] of Object.entries(map || {})) register(name, handler);
  }

  // click/change/input 覆盖存量内联处理器的绝大多数；keydown 等复杂快捷键
  // 场景留给消费方按需 bindEventType。
  bindEventType('click');
  bindEventType('change');
  bindEventType('input');

  window.ClawFW.actions = {
    register,
    registerMany,
    bindEventType,
    dispatch,
  };
})();
