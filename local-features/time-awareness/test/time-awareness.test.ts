import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TimeAwarenessFeature,
  evaluateTimeAwareness,
  renderTimeReminder,
  formatTimezone,
  REPORT_INTERVAL_MS,
  LONG_GAP_MS,
} from '../src/index.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

describe('evaluateTimeAwareness（纯决策）', () => {
  it('从未汇报过 → 汇报；没有上一轮 → 不触发长间隔', () => {
    const d = evaluateTimeAwareness({ lastReportAt: null, lastCallAt: null }, T0);
    assert.equal(d.report, true);
    assert.equal(d.longGap, false);
    assert.deepEqual(d.nextState, { lastReportAt: T0, lastCallAt: T0 });
  });

  it('距上次汇报不足 4 小时 → 不汇报', () => {
    const d = evaluateTimeAwareness(
      { lastReportAt: T0, lastCallAt: T0 + HOUR },
      T0 + HOUR + 60 * 60 * 1000, // 距上次汇报 1h
    );
    assert.equal(d.report, false);
    assert.deepEqual(d.nextState, { lastReportAt: T0, lastCallAt: T0 + 2 * HOUR });
  });

  it('距上次汇报超过 4 小时 → 汇报并顺延 lastReportAt', () => {
    const d = evaluateTimeAwareness(
      { lastReportAt: T0, lastCallAt: T0 + HOUR },
      T0 + HOUR + REPORT_INTERVAL_MS + 1,
    );
    assert.equal(d.report, true);
    assert.equal(d.nextState.lastReportAt, T0 + HOUR + REPORT_INTERVAL_MS + 1);
  });

  it('距上一轮 call 超过 24 小时 → 长间隔（必然伴随汇报：lastReportAt ≤ lastCallAt）', () => {
    const d = evaluateTimeAwareness(
      { lastReportAt: T0, lastCallAt: T0 },
      T0 + 25 * HOUR,
    );
    assert.equal(d.report, true, '>24h 未汇报必然 >4h');
    assert.equal(d.longGap, true);
  });

  it('阈值边界是严格大于：恰好 4h / 24h 都不触发', () => {
    const exact = evaluateTimeAwareness(
      { lastReportAt: T0, lastCallAt: T0 },
      T0 + REPORT_INTERVAL_MS,
    );
    assert.equal(exact.report, false);
    assert.equal(exact.longGap, false);
  });

  it('连续多天、call 间隔一直不超过 24 小时 → 长间隔永不触发', () => {
    let state: unknown = { lastReportAt: null, lastCallAt: null };
    // 模拟连续 10 天，每 12 小时一次 call
    for (let i = 0; i < 20; i++) {
      const now = T0 + i * 12 * HOUR;
      const d = evaluateTimeAwareness(state, now);
      assert.equal(d.longGap, false, `第 ${i + 1} 次 call 不应触发长间隔`);
      state = d.nextState;
    }
  });

  it('时钟回拨视为未过阈值，只顺延 lastCallAt', () => {
    const d = evaluateTimeAwareness(
      { lastReportAt: T0, lastCallAt: T0 + HOUR },
      T0 - HOUR,
    );
    assert.equal(d.report, false);
    assert.equal(d.longGap, false);
    assert.deepEqual(d.nextState, { lastReportAt: T0, lastCallAt: T0 - HOUR });
  });

  it('非对象/缺失字段状态按首次处理', () => {
    for (const state of [null, undefined, {}, 'junk', { lastReportAt: 'x', lastCallAt: null }]) {
      const d = evaluateTimeAwareness(state, T0);
      assert.equal(d.report, true, `${JSON.stringify(state)} 应视为从未汇报`);
      assert.equal(d.longGap, false);
    }
  });
});

describe('renderTimeReminder / formatTimezone', () => {
  it('时间汇报包含本地时间与时区标注', () => {
    const text = renderTimeReminder(new Date(T0), { report: true, longGap: false });
    assert.ok(text.startsWith('[时间感知] '));
    assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(text, /（时区 UTC[+-]\d{2}:\d{2}/);
    assert.match(text, /均速积累/);
    assert.ok(!text.includes('24 小时'));
  });

  it('长间隔提示包含核实提醒', () => {
    const text = renderTimeReminder(new Date(T0), { report: false, longGap: true });
    assert.ok(text.includes('超过 24 小时'));
    assert.ok(!text.includes('均速积累'));
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(text));
  });

  it('两段同时触发合并为一条', () => {
    const text = renderTimeReminder(new Date(T0), { report: true, longGap: true });
    assert.ok(text.includes('均速积累'));
    assert.ok(text.includes('超过 24 小时'));
  });

  it('时区标注含 UTC 偏移', () => {
    assert.match(formatTimezone(new Date(T0)), /^UTC[+-]\d{2}:\d{2}/);
  });
});

describe('TimeAwarenessFeature（注入与快照契约）', () => {
  function makeHarness() {
    let clock = T0;
    const feature = new TimeAwarenessFeature({ now: () => clock });
    const injected: Array<{ text: string; source: string; tag: string }> = [];
    const ctx = {
      context: {
        addSystemMessage(text: string, turn: number, source?: string, tag?: string) {
          injected.push({ text, source: source || '', tag: tag || '' });
        },
      },
      agent: { _callIndex: 3 },
    };
    return {
      feature,
      injected,
      ctx,
      setClock(value: number) { clock = value; },
      async call() { await feature.injectTimeContext(ctx as never); },
    };
  }

  it('首次 call 注入时间汇报，4 小时内不重复', async () => {
    const h = makeHarness();
    await h.call();
    assert.equal(h.injected.length, 1);
    assert.ok(h.injected[0].text.includes('时间是'));
    assert.equal(h.injected[0].source, 'time-awareness');
    assert.equal(h.injected[0].tag, 'reminder');

    h.setClock(T0 + HOUR);
    await h.call();
    h.setClock(T0 + 3 * HOUR);
    await h.call();
    assert.equal(h.injected.length, 1, '4 小时内不重复汇报');
  });

  it('超过 4 小时再次汇报；超过 24 小时附加长间隔提示', async () => {
    const h = makeHarness();
    await h.call(); // T0 汇报
    h.setClock(T0 + 4 * HOUR + 60 * 1000); // 距上次汇报 >4h，距上次 call 4h < 24h
    await h.call();
    assert.equal(h.injected.length, 2);
    assert.ok(h.injected[1].text.includes('时间是'));
    assert.ok(!h.injected[1].text.includes('24 小时'), '4 小时间隔不触发长间隔');

    h.setClock(T0 + 4 * HOUR + 60 * 1000 + LONG_GAP_MS + 1000); // 距上次 call >24h
    await h.call();
    assert.equal(h.injected.length, 3);
    assert.ok(h.injected[2].text.includes('超过 24 小时'));
    // 距上次汇报同样 >24h >4h，两段都在
    assert.ok(h.injected[2].text.includes('时间是'));
  });

  it('captureState 记录节奏，新实例 restoreState 后延续（会话恢复/重启）', async () => {
    const h = makeHarness();
    await h.call(); // T0 汇报
    h.setClock(T0 + HOUR);
    await h.call();
    const snapshot = h.feature.captureState();
    assert.deepEqual(snapshot, { lastReportAt: T0, lastCallAt: T0 + HOUR });

    // 模拟 runtime 重启：新实例 + 会话快照恢复，3 小时后（距上次汇报 4h）不重复汇报
    const revived = new TimeAwarenessFeature({ now: () => T0 + 4 * HOUR });
    revived.restoreState(snapshot);
    const injected: string[] = [];
    await revived.injectTimeContext({
      context: { addSystemMessage: (text: string) => injected.push(text) },
    } as never);
    assert.equal(injected.length, 0, '恢复后 4h 内不重复汇报');
  });

  it('restoreState 收到缺失/非法快照按首次处理', async () => {
    for (const bad of [null, undefined, {}, 'junk', { lastReportAt: 'x' }]) {
      const feature = new TimeAwarenessFeature({ now: () => T0 });
      feature.restoreState(bad as never);
      const injected: string[] = [];
      await feature.injectTimeContext({
        context: { addSystemMessage: (text: string) => injected.push(text) },
      } as never);
      assert.equal(injected.length, 1, `${JSON.stringify(bad)} 应按首次处理并汇报`);
    }
  });

  it('缺 agent 字段时 turn 兜底为 0，注入不报错', async () => {
    const feature = new TimeAwarenessFeature({ now: () => T0 });
    const seenTurns: number[] = [];
    await feature.injectTimeContext({
      context: {
        addSystemMessage(_text: string, turn: number) { seenTurns.push(turn); },
      },
    } as never);
    assert.deepEqual(seenTurns, [0]);
  });
});
