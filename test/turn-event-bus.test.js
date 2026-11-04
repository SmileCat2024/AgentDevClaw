/**
 * 轮次事件总线（ADR-0041 决策 3）
 *
 * 行为契约：
 * 1. 只报告事实：订阅者收到宿主广播的 turn.* 事件，总线自身不触发任何行为。
 * 2. 订阅者之间互不影响：一个订阅者抛错，其他订阅者照常收到，emit 不抛。
 * 3. 退订幂等，退订后不再收到事件。
 * 4. 终态与"已交付"是两个不同判断：挂起的回合是终态但未交付。
 * 5. 非法事件被忽略而不是广播出去。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTurnEventBus,
  isTerminalTurnEvent,
  isDeliveredTurnEvent,
  TURN_EVENT_TYPES,
} from '../server/shared/turn-event-bus.js';

const completed = (extra = {}) => ({
  type: TURN_EVENT_TYPES.COMPLETED, agentId: 'a', sessionId: 's1', turn: 0, ...extra,
});

describe('轮次事件总线：分发', () => {
  test('订阅者收到带完整身份的事件', () => {
    const bus = createTurnEventBus();
    const received = [];
    bus.subscribe((event) => received.push(event));
    bus.emit(completed());
    assert.equal(received.length, 1);
    assert.equal(received[0].agentId, 'a');
    assert.equal(received[0].sessionId, 's1');
    assert.equal(received[0].turn, 0);
  });

  test('事件按广播顺序到达', () => {
    const bus = createTurnEventBus();
    const order = [];
    bus.subscribe((event) => order.push(event.type));
    bus.emit({ type: TURN_EVENT_TYPES.STARTED, turn: 0 });
    bus.emit(completed());
    assert.deepEqual(order, [TURN_EVENT_TYPES.STARTED, TURN_EVENT_TYPES.COMPLETED]);
  });

  test('一个订阅者抛错不影响其他订阅者，也不抛回调用方', () => {
    const errors = [];
    const bus = createTurnEventBus({ onListenerError: (error) => errors.push(error.message) });
    const received = [];
    bus.subscribe(() => { throw new Error('订阅者故障'); });
    bus.subscribe((event) => received.push(event.type));

    assert.doesNotThrow(() => bus.emit(completed()),
      '回合本身不得因订阅者故障而中断');
    assert.deepEqual(received, [TURN_EVENT_TYPES.COMPLETED], '其他订阅者仍须收到事件');
    assert.deepEqual(errors, ['订阅者故障'], '故障须留痕，不能静默吞掉');
  });

  test('订阅者抛错时，留痕回调自身抛错也不再扩散', () => {
    const bus = createTurnEventBus({ onListenerError: () => { throw new Error('留痕失败'); } });
    bus.subscribe(() => { throw new Error('订阅者故障'); });
    assert.doesNotThrow(() => bus.emit(completed()));
  });

  test('非法事件被忽略，不广播给订阅者', () => {
    const bus = createTurnEventBus();
    const received = [];
    bus.subscribe((event) => received.push(event));
    bus.emit(null);
    bus.emit({});
    bus.emit({ turn: 3 });
    assert.equal(received.length, 0);
  });
});

describe('轮次事件总线：订阅生命周期', () => {
  test('退订后不再收到事件', () => {
    const bus = createTurnEventBus();
    const received = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));
    bus.emit(completed());
    unsubscribe();
    bus.emit(completed());
    assert.equal(received.length, 1);
    assert.equal(bus.size, 0);
  });

  test('重复退订是安全的', () => {
    const bus = createTurnEventBus();
    const unsubscribe = bus.subscribe(() => {});
    unsubscribe();
    assert.doesNotThrow(() => unsubscribe());
  });

  test('订阅非函数返回可安全调用的退订函数', () => {
    const bus = createTurnEventBus();
    const unsubscribe = bus.subscribe(null);
    assert.equal(typeof unsubscribe, 'function');
    assert.doesNotThrow(() => unsubscribe());
    assert.equal(bus.size, 0);
  });

  test('订阅期间退订另一个订阅者，本轮广播不受影响', () => {
    const bus = createTurnEventBus();
    const received = [];
    let unsubscribeSecond = null;
    bus.subscribe(() => { if (unsubscribeSecond) unsubscribeSecond(); });
    unsubscribeSecond = bus.subscribe((event) => received.push(event.type));

    bus.emit(completed());
    // 首个订阅者在广播过程中退订了第二个；本次广播仍应送达（快照遍历），
    // 之后才不再收到。
    assert.deepEqual(received, [TURN_EVENT_TYPES.COMPLETED]);
    bus.emit(completed());
    assert.equal(received.length, 1, '退订生效后的下一轮不应再收到');
  });
});

describe('轮次事件语义', () => {
  test('完成 / 失败 / 取消是终态，开始不是', () => {
    assert.equal(isTerminalTurnEvent({ type: TURN_EVENT_TYPES.COMPLETED }), true);
    assert.equal(isTerminalTurnEvent({ type: TURN_EVENT_TYPES.FAILED }), true);
    assert.equal(isTerminalTurnEvent({ type: TURN_EVENT_TYPES.CANCELLED }), true);
    assert.equal(isTerminalTurnEvent({ type: TURN_EVENT_TYPES.STARTED }), false);
    assert.equal(isTerminalTurnEvent(null), false);
  });

  test('挂起的回合是终态但不算已交付', () => {
    const suspended = completed({ suspended: true });
    assert.equal(isTerminalTurnEvent(suspended), true);
    assert.equal(isDeliveredTurnEvent(suspended), false,
      '挂起只表示等后台任务唤醒，工作尚未交付；按"完成即有事可做"处理会做错判断');
    assert.equal(isDeliveredTurnEvent(completed()), true);
    assert.equal(isDeliveredTurnEvent({ type: TURN_EVENT_TYPES.FAILED }), false);
  });
});
