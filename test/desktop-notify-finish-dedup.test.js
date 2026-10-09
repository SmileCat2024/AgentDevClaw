import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * desktop-notify.js finish 通知的并发去重（frontend 沙箱）：
 *
 * 真实 payload（viewerWorker.getNotificationSnapshot）永远同时携带顶层
 * callActive 与 state，updateNotificationStatus 会在同一 payload 上同步调用
 * _tryNotifyAgentFinished 两次（callActive 分支 + UI 收尾段），SSE 事件与
 * 轮询路径也可能并发进入。dedup 标记若写在 await fetch 之后，两次并发调用
 * 都会通过 30s 检查、各发一条通知——浏览器原生 Notification 的同 tag 替换
 * 语义掩盖了这种重复，Tauri 通知插件忽略 tag（每次构造都弹独立 toast）后
 * 暴露为「通知弹两遍」。这里锁住：标记在任何 await 之前同步写入。
 *
 * 另一类重放：完成的 snapshot 是持久的（state.type 完成后保持 call.finish），
 * SSE 静默 30s 看门狗的全量对账轮（forceFullPollOnce → refreshCurrentRuntime
 * Status → GET /notification → updateNotificationStatus UI 收尾段，该分支无
 * 边沿守卫）会隔 30s+ 反复携带同一 payload 重新触发通知——30s 时间窗口过期
 * 后若无事件级幂等（finishTs 相同即跳过），每个对账周期都会再弹一条相同
 * 通知（后台 tab 节流下表现为 30s~1min 周期重弹）。这里锁住：同一 finish
 * 事件只通知一次。
 */

function loadNotifyModule({ notifications }) {
  class FakeNotification {
    constructor(title, options) {
      notifications.push({ title, options });
      this.onclick = null;
    }
    close() {}
  }
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission = async () => 'granted';

  const ctx = createFrontendSandbox({
    // 页面后台：hidden=true + 无焦点，通知资格检查全部通过
    document: {
      hidden: true,
      hasFocus: () => false,
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
    },
    Notification: FakeNotification,
    // 文件底部的 Web Worker 心跳 IIFE 顶层执行所需的 stub（不会触发回调）
    Worker: class { constructor() {} },
    Blob: class { constructor() {} },
    URL: { createObjectURL: () => 'blob:fake' },
    // desktop-notify.js 的跨文件依赖（定义在 app-main.js / app-core.js）
    normalizeAgentIdentity: (id) => String(id || ''),
    allAgents: [],
    _recentlyFinishedRuntimes: new Set(),
    fetch: async () => ({
      ok: true,
      json: async () => ({ messages: [{ role: 'assistant', content: '结果预览' }] }),
    }),
  });
  ctx.loadSource('public/src/modules/desktop-notify.js');
  return ctx;
}

const FINISH_PAYLOAD = {
  callActive: false,
  state: { type: 'call.finish', timestamp: 1791509161407, data: { status: 'completed' } },
  runtime: { callActive: false, stage: 'completed', updatedAt: 1791509161407 },
};

describe('finish notification dedup (frontend sandbox)', () => {
  it('同一 payload 的并发双调用只弹一条通知（回归锁：Tauri 下不再弹两遍）', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications });

    const call = `_tryNotifyAgentFinished('agent-1', ${JSON.stringify(FINISH_PAYLOAD)})`;
    const [a, b] = ctx.run(`[${call}, ${call}]`);

    await Promise.all([a, b]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
  });

  it('第一次通知落定后 30s 内的重复触发仍只弹一条', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications });

    const payloadExpr = JSON.stringify(FINISH_PAYLOAD);
    await ctx.run(`(async () => { await _tryNotifyAgentFinished('agent-1', ${payloadExpr}) })()`);
    await ctx.run(`(async () => { await _tryNotifyAgentFinished('agent-1', ${payloadExpr}) })()`);

    assert.equal(notifications.length, 1);
  });

  it('新一轮 call.start 清除标记后，后续完成照常通知', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications });

    const payloadExpr = JSON.stringify(FINISH_PAYLOAD);
    await ctx.run(`(async () => { await _tryNotifyAgentFinished('agent-1', ${payloadExpr}) })()`);
    ctx.run(`_markAgentCallStartedForNotify('agent-1')`);
    await ctx.run(`(async () => { await _tryNotifyAgentFinished('agent-1', ${payloadExpr}) })()`);

    assert.equal(notifications.length, 2);
  });

  it('30s 窗口过期后同一 finish 事件重放不再弹（看门狗对账回归锁）', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications });

    const finishTs = FINISH_PAYLOAD.state.timestamp;
    const payloadExpr = JSON.stringify(FINISH_PAYLOAD);
    // 冻结时钟：页面加载于完成前 60s（资格检查通过），首条通知后推进 31s
    // （30s 窗口恰好过期），模拟看门狗对账轮携带同一持久 snapshot 重放。
    await ctx.run(`(async () => {
      let now = ${finishTs - 60000};
      Date.now = () => now;
      await _tryNotifyAgentFinished('agent-1', ${payloadExpr});
      now = ${finishTs + 31000};
      await _tryNotifyAgentFinished('agent-1', ${payloadExpr});
    })()`);

    assert.equal(notifications.length, 1);
  });

  it('30s 过期后不同 finish 时间戳（新一轮完成，call.start 被错过）照常通知', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications });

    const finishTs = FINISH_PAYLOAD.state.timestamp;
    const payloadExpr = JSON.stringify(FINISH_PAYLOAD);
    const nextFinishTs = finishTs + 90000;
    await ctx.run(`(async () => {
      let now = ${finishTs - 60000};
      Date.now = () => now;
      await _tryNotifyAgentFinished('agent-1', ${payloadExpr});
      const nextPayload = JSON.parse(${JSON.stringify(payloadExpr)});
      nextPayload.state = { ...nextPayload.state, timestamp: ${nextFinishTs} };
      nextPayload.runtime = { ...nextPayload.runtime, updatedAt: ${nextFinishTs} };
      now = ${nextFinishTs + 1000};
      await _tryNotifyAgentFinished('agent-1', nextPayload);
    })()`);

    assert.equal(notifications.length, 2);
  });
});
