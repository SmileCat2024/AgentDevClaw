/**
 * dom-forwarding.js — 稳定元素句柄（测试支撑，仅服务「每 case 换容器」的夹具）。
 *
 * 使用场景：DOM 引用域（modules/dom-refs.js）在模块相**只解析一次**并冻结导出，
 * 而某些夹具每 case 新建一个容器元素来隔离监听与几何。二者直接组合会让第二个
 * 之后的 case 仍读到第一个 case 的元素。
 *
 * 这里给出与旧 `createP2BootstrapDomHost` 宿主对象等价的能力：一个固定引用，
 * 属性读/写与方法调用实时转发到「当前 case 的元素」——
 *
 *   const handle = createForwardingElement(() => activeContainer);
 *   document.getElementById = (id) => (id === 'chat-container' ? handle : ...);
 *   // 每个 case：activeContainer = case 的新容器
 *
 * 生产代码看到的仍是单个元素引用（身份稳定），行为与「元素从不替换」的生产
 * 不变量一致；测试侧照旧可以驱动真实元素上的事件与几何。
 */

/**
 * @param {() => any} getCurrent 返回当前 case 的元素；无 case 时可为 null
 * @returns {Proxy} 固定引用、逐次转发的元素句柄
 */
export function createForwardingElement(getCurrent) {
  const requireTarget = () => {
    const target = getCurrent();
    if (!target) throw new Error('dom-forwarding: 当前 case 没有元素（用例已结束或尚未开始）');
    return target;
  };
  return new Proxy({}, {
    get(_target, property) {
      const current = requireTarget();
      const value = current[property];
      return typeof value === 'function' ? value.bind(current) : value;
    },
    set(_target, property, value) {
      requireTarget()[property] = value;
      return true;
    },
    has(_target, property) {
      return property in requireTarget();
    },
  });
}
