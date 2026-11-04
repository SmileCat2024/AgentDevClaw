/**
 * 轮次事件总线（ADR-0041 决策 3）。
 *
 * 宿主把 CallArbiter 的终态映射成 `turn.*` 事件后，经本总线广播给订阅者。
 * 总线只报告事实：回合开始、完成、失败、取消、挂起，以及身份与用量。
 * **它不触发任何行为**——是否据此生成标题、发通知或记指标，由订阅者自己决定。
 *
 * 设计约束（这些约束决定了本模块的形态）：
 *
 * 1. 无依赖、无 IO。它要在 runtime 子进程里随宿主启动，不应牵入服务端资源。
 * 2. 单个订阅者抛错不得影响其他订阅者，更不得影响回合本身。回合事件的
 *    上报是观测行为，失败只留痕。
 * 3. 订阅与退订都要有确定语义：退订函数幂等，重复退订不报错。
 * 4. 不做事件缓存与重放。错过事件的订阅者需要自行从状态源（会话索引 /
 *    看板）补齐，总线不承担回填——那会让"事件已送达"与"状态已同步"
 *    两个不同保证混在一起。
 */

/** 事件类型集合。取自 turn-event-mapping.js 的产出，不另造词汇。 */
export const TURN_EVENT_TYPES = Object.freeze({
  STARTED: 'turn.started',
  COMPLETED: 'turn.completed',
  FAILED: 'turn.failed',
  CANCELLED: 'turn.cancelled',
});

const TERMINAL_TYPES = new Set([
  TURN_EVENT_TYPES.COMPLETED,
  TURN_EVENT_TYPES.FAILED,
  TURN_EVENT_TYPES.CANCELLED,
]);

/** 该事件是否表示一次回合已经落定（完成 / 失败 / 取消，含挂起完成）。 */
export function isTerminalTurnEvent(event) {
  return TERMINAL_TYPES.has(String(event?.type || ''));
}

/**
 * 回合是否取得可用交付：完成且不是挂起态。
 *
 * 挂起的回合虽然以 turn.completed 落定（ADR-0019），但工作尚未交付，只是
 * 等后台任务唤醒。订阅者若按"完成即有事可做"处理，会在挂起时做错判断，
 * 因此提供这个谓词把两种情况分开。
 */
export function isDeliveredTurnEvent(event) {
  return String(event?.type || '') === TURN_EVENT_TYPES.COMPLETED && event?.suspended !== true;
}

/**
 * 创建总线。
 *
 * @param {object} [options]
 * @param {(error: Error, event: object) => void} [options.onListenerError]
 *   订阅者抛错时的留痕回调；缺省静默（总线在生产路径上不应打日志噪音）。
 */
export function createTurnEventBus({ onListenerError } = {}) {
  const listeners = new Set();

  /**
   * 订阅。返回退订函数；重复调用退订是安全的。
   * @param {(event: object) => void} listener
   * @returns {() => void}
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
    };
  }

  /**
   * 广播一个回合事件。
   *
   * 订阅者同步调用：事件顺序即调用顺序，订阅者内部若要做异步工作应自行
   * 排队，不应指望总线等待。这与宿主既有上报链（enqueueOrderedProjection）
   * 的分工一致——顺序由宿主链保证，总线只做分发。
   *
   * @param {object} event  必须带 type；agentId / sessionId / turn 由宿主补齐
   */
  function emit(event) {
    if (!event || typeof event !== 'object' || !event.type) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        if (typeof onListenerError === 'function') {
          try { onListenerError(error, event); } catch { /* 留痕本身失败不再扩散 */ }
        }
      }
    }
  }

  return {
    subscribe,
    emit,
    /** 当前订阅者数量。仅用于诊断与测试，不作为业务判据。 */
    get size() { return listeners.size; },
  };
}
