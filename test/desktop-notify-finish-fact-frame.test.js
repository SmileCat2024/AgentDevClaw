import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * desktop-notify.js 完成通知对线程轮次事实帧（ADR-0042）的呈现测试。
 *
 * 回归背景（2026-11-05）：线程宿主的 finish 改走轮次事实路径后，帧只带
 * 工作空间粒度 agentId + threadId + body，呈现器按 runtimeAgentId 设计的
 * 会话条目查找 / messages 预览全部落空——通知退化成「<工作空间 id> 已完成
 * / Agent 已完成运行，点击查看」，无会话标题与内容。修复后 server 补
 * runtimeAgentId / title / finishTs，呈现器以条目与消息接口为主、帧内
 * title / body 兜底，点击导航 threadId 优先。本文件锁住两层行为：
 *   1. 常态（runtimeAgentId 可解析）：标题取会话条目名，正文取会话标题 +
 *      完整最后回复（messages 接口覆盖帧内交付文本）；
 *   2. 降级（条目查找 / messages 均落空）：正文必须由帧内 title + body
 *      组装，绝不再退到「点击查看」兜底文案；点击走 threadId 导航。
 */

function loadNotifyModule({ notifications, fetchImpl, allAgents }) {
  class FakeNotification {
    constructor(title, options) {
      notifications.push({ title, options, notification: this });
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
    Worker: class { constructor() {} },
    Blob: class { constructor() {} },
    URL: { createObjectURL: () => 'blob:fake' },
    normalizeAgentIdentity: (id) => String(id || '').trim(),
    allAgents: allAgents || [],
    _recentlyFinishedRuntimes: new Set(),
    fetch: fetchImpl || (async () => ({ ok: false, status: 404, json: async () => ({}) })),
  });
  ctx.loadSource('public/src/modules/desktop-notify.js');
  return ctx;
}

const FACT_FRAME = {
  type: 'finish',
  agentId: 'programming-helper',
  threadId: 'wt-fact-1',
  title: '修复登录超时',
  body: '已完成：新增 3 条测试全部通过',
  outcomeStatus: 'completed',
  finishTs: 1791509161407,
};

describe('finish notification from thread-turn fact frames (frontend sandbox)', () => {
  it('常态：runtimeAgentId 命中会话条目，标题取条目名、正文取会话标题 + 完整回复', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({
      notifications,
      allAgents: [{
        id: 'agent-7-9000',
        source: 'child',
        parent_id: 'programming-helper',
        name: '编程小助手',
        runtime_session_id: 'agent-7-9000',
        active_workspace_session_title: '修复登录超时',
      }],
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ messages: [{ role: 'assistant', content: '这是完整回复预览' }] }),
      }),
    });
    ctx.run(`_presentAppNotification(${JSON.stringify({ ...FACT_FRAME, runtimeAgentId: 'agent-7-9000' })})`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
    assert.match(notifications[0].title, /编程小助手 已完成/);
    assert.ok(notifications[0].options.body.includes('修复登录超时'));
    assert.ok(notifications[0].options.body.includes('这是完整回复预览'), 'messages 接口的完整回复优先于帧内交付文本');
  });

  it('降级：条目查找与 messages 均落空时，正文由帧内 title + body 组装，不再退到兜底文案', async () => {
    const notifications = [];
    const ctx = loadNotifyModule({ notifications }); // allAgents 空 + fetch 404
    ctx.run(`_presentAppNotification(${JSON.stringify(FACT_FRAME)})`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
    assert.ok(notifications[0].options.body.includes('修复登录超时'), '会话标题来自帧携带的 title');
    assert.ok(notifications[0].options.body.includes('已完成：新增 3 条测试'), '内容预览来自帧携带的交付文本 body');
    assert.doesNotMatch(notifications[0].options.body, /点击查看/, '不得再退到通用兜底文案');
  });

  it('降级：点击通知经 threadId 导航到会话（openConversationTarget），原生 toast 激活同语义', async () => {
    const notifications = [];
    const navigations = [];
    const ctx = loadNotifyModule({ notifications });
    ctx.window.focus = () => {};
    // 沙箱内创建的对象跨 realm 原型不同，此处按字段归一化记录
    ctx.window.openConversationTarget = (target) => {
      navigations.push({ threadId: String(target.threadId), agentId: String(target.agentId) });
    };
    ctx.run(`_presentAppNotification(${JSON.stringify(FACT_FRAME)})`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notifications.length, 1);
    notifications[0].notification.onclick();
    assert.deepEqual(navigations, [{ threadId: 'wt-fact-1', agentId: 'programming-helper' }]);

    // 原生 toast 激活链路（navPayload 原样往返壳侧）：threadId 优先导航
    ctx.window.__clawConsumeNotificationActivation(JSON.stringify({
      threadId: 'wt-fact-1', agentId: 'programming-helper',
    }));
    assert.equal(navigations.length, 2);
    assert.deepEqual(navigations[1], { threadId: 'wt-fact-1', agentId: 'programming-helper' });
  });
});
