import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * desktop-notify.js app-notification 帧呈现的并发去重（frontend 沙箱）：
 *
 * ADR-0030 拆层后触发判定在 server（权限 + 事件级去重），本模块经
 * _presentAppNotification 消费 SSE 帧。呈现级去重的并发防线：SSE
 * 重连的 Last-Event-ID 重放、事件路径多入口并发，都可能让同一帧两次
 * 进入——dedup 标记若写在 await 之后，两次并发调用都会通过检查、各发
 * 一条通知（Tauri 通知插件忽略 tag，每次构造都弹独立 toast）。锁住：
 * 标记在任何 await 之前同步写入。
 *
 * 事件级幂等：同一 finish 帧（finishTs 相同）无论隔多久重放都只弹一次；
 * 新一轮 call.start（_markAgentCallStartedForNotify）清空记录后，以及
 * 不同 finishTs 的新完成帧，照常通知。
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

const FINISH_FRAME = {
  type: 'finish',
  agentId: 'agent-1',
  finishTs: 1791509161407,
};

describe('finish notification dedup (frontend sandbox)', () => {
  it('成功终态通知仍显示已完成', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications });
    ctx.run(`_presentAppNotification(${JSON.stringify({ ...FINISH_FRAME, outcomeStatus: 'completed' })})`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
    assert.match(notifications[0].title, /已完成|finished/);
  });

  it('取消终态通知明确显示已取消', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications });
    ctx.run(`_presentAppNotification(${JSON.stringify({ ...FINISH_FRAME, outcomeStatus: 'cancelled' })})`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
    assert.match(notifications[0].title, /已取消|cancelled/);
    assert.doesNotMatch(notifications[0].title, /已完成|finished/);
  });

  it('失败终态通知显示失败而不是已完成，并暴露结构化错误信息', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications });
    const frame = {
      ...FINISH_FRAME,
      outcomeStatus: 'failed',
      outcomeReason: 'error',
      errorMessage: 'provider disconnected',
    };
    ctx.run(`_presentAppNotification(${JSON.stringify(frame)})`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
    assert.match(notifications[0].title, /执行失败|failed/);
    assert.doesNotMatch(notifications[0].title, /已完成|finished/);
    assert.match(notifications[0].options.body, /provider disconnected/);
  });

  it('同一帧的并发双投递只弹一条通知（回归锁：Tauri 下不再弹两遍）', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications });

    const frameExpr = JSON.stringify(FINISH_FRAME);
    ctx.run(`_presentAppNotification(${frameExpr})`);
    ctx.run(`_presentAppNotification(${frameExpr})`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
  });

  it('第一次通知落定后 30s 内的重复投递仍只弹一条', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications });

    const frameExpr = JSON.stringify(FINISH_FRAME);
    ctx.run(`_presentAppNotification(${frameExpr})`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctx.run(`_presentAppNotification(${frameExpr})`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
  });

  it('新一轮 call.start 清除标记后，后续完成帧照常通知', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications });

    const frameExpr = JSON.stringify(FINISH_FRAME);
    ctx.run(`_presentAppNotification(${frameExpr})`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctx.run(`_markAgentCallStartedForNotify('agent-1')`);
    ctx.run(`_presentAppNotification(${frameExpr})`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 2);
  });

  it('30s 窗口过期后同一 finish 帧重放不再弹（SSE 重放回归锁）', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications });

    const finishTs = FINISH_FRAME.finishTs;
    const frameExpr = JSON.stringify(FINISH_FRAME);
    // 冻结时钟：页面加载于完成前 60s（资格检查通过），首条通知后推进 31s
    // （30s 窗口恰好过期），模拟 SSE 重连按 Last-Event-ID 重放同一帧。
    await ctx.run(`(async () => {
      let now = ${finishTs - 60000};
      Date.now = () => now;
      _presentAppNotification(${frameExpr});
      await new Promise((resolve) => setTimeout(resolve, 0));
      now = ${finishTs + 31000};
      _presentAppNotification(${frameExpr});
      await new Promise((resolve) => setTimeout(resolve, 0));
    })()`);

    assert.equal(notifications.length, 1);
  });

  it('30s 过期后不同 finishTs（新一轮完成，call.start 帧被错过）照常通知', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications });

    const finishTs = FINISH_FRAME.finishTs;
    const nextFinishTs = finishTs + 90000;
    await ctx.run(`(async () => {
      let now = ${finishTs - 60000};
      Date.now = () => now;
      _presentAppNotification(${JSON.stringify(FINISH_FRAME)});
      await new Promise((resolve) => setTimeout(resolve, 0));
      now = ${nextFinishTs + 1000};
      const nextFrame = { ...${JSON.stringify(FINISH_FRAME)}, finishTs: ${nextFinishTs} };
      _presentAppNotification(nextFrame);
      await new Promise((resolve) => setTimeout(resolve, 0));
    })()`);

    assert.equal(notifications.length, 2);
  });
});
