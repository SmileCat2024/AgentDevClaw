/**
 * 门户线路运行时测试（ADR-0042 决策 2/3/4）
 *
 * 声明的承诺：
 *  1. 门户按线路的 boundTarget 分发入站消息——接线员线程交门户 CallArbiter
 *     并同步返回结果；外部线程投递到线程 Inbox，回复稍后异步送达；
 *  2. 线程 Inbox 的幂等键是消息级唯一，同一对端连发不会被判重吞掉；
 *  3. 出站只服务外部线程，接线员结果不重复发送；
 *  4. 结果文本策略（截断、失败文案、空结果占位）与原 IM_REPLY_POLICY 一致。
 *
 * agent / feature / fetch 全部用桩；不碰真实网络与用户数据。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPortalLines,
  buildOutboundText,
  PORTAL_REPLY_POLICY,
} from '../prebuilt-agents/official/qqbot/portal-lines.js';

/** 最小 feature 桩：记录 gateway 启停。 */
function createFeatureStub() {
  return {
    started: false,
    sent: [],
    async startGateway() { this.started = true; },
    async stopGateway() { this.started = false; },
    async sendTextMessage(userId, text) { this.sent.push({ userId, text }); },
  };
}

/** 最小 agent 桩：features 表 + CallArbiter 记录。 */
function createAgentStub({ arbiterResult = 'ok', features = {} } = {}) {
  const enqueued = [];
  return {
    features: new Map(Object.entries(features)),
    _callArbiter: {
      enqueue(payload) {
        enqueued.push(payload);
        return { id: `entry-${enqueued.length}` };
      },
      async waitForCompletion() {
        return arbiterResult === 'fail'
          ? { status: 'failed', error: 'boom' }
          : { status: 'completed', result: arbiterResult };
      },
    },
    enqueued,
  };
}

function line(id, carrier, boundTarget) {
  return { id, label: id, carrier, boundTarget: boundTarget || null };
}

/** 装一个可断言、可还原的 fetch 桩；返回记录数组与还原函数。 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const record = { url: String(url), init };
    if (init?.body) {
      try { record.body = JSON.parse(init.body); } catch { record.body = init.body; }
    }
    calls.push(record);
    return handler(record);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe('buildOutboundText', () => {
  test('完成态返回结果原文，空结果给占位文案', () => {
    assert.equal(buildOutboundText({ status: 'completed', resultText: '你好' }), '你好');
    assert.equal(buildOutboundText({ status: 'completed', resultText: '' }), '处理完成');
    assert.equal(buildOutboundText({ status: 'completed', resultText: undefined }), '处理完成');
  });

  test('失败态带 ⚠ 前缀与错误摘要', () => {
    const text = buildOutboundText({ status: 'failed', error: '连接超时' });
    assert.match(text, /^⚠ 处理失败: /);
    assert.match(text, /连接超时/);
  });

  test('超长结果截断到上限并附提示，超长错误按错误上限截断', () => {
    const longText = buildOutboundText({ status: 'completed', resultText: 'x'.repeat(3000) });
    assert.ok(longText.startsWith('x'.repeat(PORTAL_REPLY_POLICY.MAX_RESULT_LENGTH)));
    assert.match(longText, /结果已截断/);

    const longError = buildOutboundText({ status: 'failed', error: 'e'.repeat(2000) });
    assert.ok(longError.includes('e'.repeat(PORTAL_REPLY_POLICY.MAX_ERROR_LENGTH)));
    assert.ok(!longError.includes('e'.repeat(PORTAL_REPLY_POLICY.MAX_ERROR_LENGTH + 1)));
  });
});

describe('入站分发：接线员线程走门户', () => {
  test('未绑定线路的消息交门户 CallArbiter，结果作为返回值同步回平台', async () => {
    const qq = createFeatureStub();
    const agent = createAgentStub({ arbiterResult: '门户回复', features: { qqbot: qq } });
    const portal = createPortalLines({ agent, serverOrigin: 'http://x', portalAgentId: 'qqbot' });
    const { calls, restore } = stubFetch(() => ({ ok: true, status: 200 }));

    await portal.connectLine(line('line1', 'qq', null));
    const reply = await qq.agentRef.onCall('你好', undefined, undefined, { qqbot: { senderId: 'u1' } });

    assert.equal(reply, '门户回复');
    assert.equal(agent.enqueued.length, 1);
    assert.equal(agent.enqueued[0].source, 'qq');
    assert.equal(agent.enqueued[0].sourceRef, 'u1');
    assert.equal(calls.length, 0, '门户处理不产生 HTTP 投递');
    restore();
    portal.close();
  });

  test('绑定目标是接线员线程时仍走门户 CallArbiter，不投线程 Inbox', async () => {
    const qq = createFeatureStub();
    const agent = createAgentStub({ arbiterResult: '接线员回复', features: { qqbot: qq } });
    const portal = createPortalLines({ agent, serverOrigin: 'http://x', portalAgentId: 'qqbot' });
    const { calls, restore } = stubFetch(() => ({ ok: true, status: 200 }));

    await portal.connectLine(line('line1', 'qq', { agentId: 'qqbot', threadId: 'th-operator' }));
    const reply = await qq.agentRef.onCall('你好', undefined, undefined, { qqbot: { senderId: 'u1' } });

    assert.equal(reply, '接线员回复');
    assert.equal(agent.enqueued.length, 1);
    assert.equal(calls.length, 0, '接线员线程不该走 HTTP 投递');
    restore();
    portal.close();
  });

  test('门户 CallArbiter 未就绪时回提示而不是吞掉消息', async () => {
    const qq = createFeatureStub();
    const agent = createAgentStub({ features: { qqbot: qq } });
    agent._callArbiter = null;
    const portal = createPortalLines({ agent, serverOrigin: 'http://x', portalAgentId: 'qqbot' });

    await portal.connectLine(line('line1', 'qq', null));
    const reply = await qq.agentRef.onCall('在吗', undefined, undefined, {});

    assert.match(reply, /尚未就绪/);
    portal.close();
  });
});

describe('入站分发：外部线程投线程 Inbox', () => {
  test('投递到线程 input 端点并回即时确认，不进门户 CallArbiter', async () => {
    const qq = createFeatureStub();
    const agent = createAgentStub({ features: { qqbot: qq } });
    const portal = createPortalLines({ agent, serverOrigin: 'http://127.0.0.1:1420', portalAgentId: 'qqbot' });
    const { calls, restore } = stubFetch(() => ({ ok: true, status: 200, text: async () => '' }));

    await portal.connectLine(line('line1', 'qq', { agentId: 'programming-helper', threadId: 'th-ext' }));
    const reply = await qq.agentRef.onCall('帮我看看', undefined, undefined, { qqbot: { senderId: 'u2' } });

    assert.match(reply, /已收到/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/protoclaw\/threads\/th-ext\/input$/);
    assert.equal(calls[0].body.text, '帮我看看');
    assert.equal(calls[0].body.source, 'qq');
    assert.equal(agent.enqueued.length, 0, '外部线程不该进门户 CallArbiter');
    restore();
    portal.close();
  });

  test('幂等键取消息级 ID：同一对端的连续消息不被判重', async () => {
    const qq = createFeatureStub();
    const agent = createAgentStub({ features: { qqbot: qq } });
    const portal = createPortalLines({ agent, serverOrigin: 'http://127.0.0.1:1420', portalAgentId: 'qqbot' });
    const { calls, restore } = stubFetch(() => ({ ok: true, status: 200, text: async () => '' }));

    await portal.connectLine(line('line1', 'qq', { agentId: 'programming-helper', threadId: 'th-ext' }));
    // 同一发送者连发两条不同消息，各自带不同 messageId
    await qq.agentRef.onCall('第一条', undefined, undefined, { qqbot: { senderId: 'u3', messageId: 'm-1' } });
    await qq.agentRef.onCall('第二条', undefined, undefined, { qqbot: { senderId: 'u3', messageId: 'm-2' } });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.sourceRef, 'm-1');
    assert.equal(calls[1].body.sourceRef, 'm-2');
    assert.notEqual(calls[0].body.sourceRef, calls[1].body.sourceRef);
    restore();
    portal.close();
  });

  test('缺失消息 ID 时合成键仍保证同对端连续消息互不碰撞', async () => {
    const qq = createFeatureStub();
    const agent = createAgentStub({ features: { qqbot: qq } });
    const portal = createPortalLines({ agent, serverOrigin: 'http://127.0.0.1:1420', portalAgentId: 'qqbot' });
    const { calls, restore } = stubFetch(() => ({ ok: true, status: 200, text: async () => '' }));

    await portal.connectLine(line('line1', 'qq', { agentId: 'programming-helper', threadId: 'th-ext' }));
    await qq.agentRef.onCall('甲', undefined, undefined, { qqbot: { senderId: 'u4' } });
    await qq.agentRef.onCall('乙', undefined, undefined, { qqbot: { senderId: 'u4' } });

    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].body.sourceRef, calls[1].body.sourceRef);
    restore();
    portal.close();
  });

  test('线程投递被拒时回失败提示并带上状态码', async () => {
    const qq = createFeatureStub();
    const agent = createAgentStub({ features: { qqbot: qq } });
    const portal = createPortalLines({ agent, serverOrigin: 'http://127.0.0.1:1420', portalAgentId: 'qqbot' });
    const { restore } = stubFetch(() => ({
      ok: false, status: 409, text: async () => '{"code":"thread_not_deliverable"}',
    }));

    await portal.connectLine(line('line1', 'qq', { agentId: 'programming-helper', threadId: 'th-closed' }));
    const reply = await qq.agentRef.onCall('在吗', undefined, undefined, {});

    assert.match(reply, /无法接收消息/);
    assert.match(reply, /409/);
    restore();
    portal.close();
  });
});

describe('出站：轮次结果发回线路', () => {
  /**
   * 出站由服务端线程轮次 SSE 驱动。这里用一个可控的 SSE 响应体喂真实链路：
   * 事件 → handleTurnFact → 线路对端 → 平台发送入口。
   */
  async function driveOutbound({ boundTarget, senderId, frames, portalAgentId = 'qqbot' }) {
    const qq = createFeatureStub();
    const agent = createAgentStub({ features: { qqbot: qq } });
    const portal = createPortalLines({ agent, serverOrigin: 'http://127.0.0.1:1420', portalAgentId });
    let inboundDone = false;
    let closeStream = null;
    const encoder = new TextEncoder();
    const { restore } = stubFetch((record) => {
      if (record.url.includes('/protoclaw/events')) {
        // 流保持打开：测试据此判断帧何时被读完，不靠固定时长轮询
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('event: hello\ndata: {}\n\n'));
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            closeStream = () => { try { controller.close(); } catch { /* 已关 */ } };
          },
        });
        return { ok: true, status: 200, body: stream };
      }
      // 线程投递请求
      inboundDone = true;
      return { ok: true, status: 200, text: async () => '' };
    });

    await portal.connectLine(line('line1', 'qq', boundTarget));
    // 先入站一条消息，建立该线程的对端记录。接线员线程走门户 CallArbiter
    // （不产生 HTTP 投递），外部线程才投 Inbox——按目标区分前提。
    qq._currentTurnCtx = { accountId: senderId };
    await qq.agentRef.onCall('问题', undefined, undefined, { qqbot: { senderId, messageId: 'm-in' } });
    if (boundTarget.agentId === portalAgentId) {
      assert.equal(inboundDone, false, '接线员线程不该产生 HTTP 投递');
      assert.equal(agent.enqueued.length, 1, '接线员线程应进门户 CallArbiter');
    } else {
      assert.equal(inboundDone, true, '外部线程入站应已投递到线程');
    }

    portal.startOutboundListener();
    // 等流建立并让出站循环读到帧（closeStream 就绪 = 帧已入队给 reader）
    for (let i = 0; i < 200 && !closeStream; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    closeStream?.();
    // 流关闭后让出站循环把已入队的帧处理完
    await new Promise((resolve) => setTimeout(resolve, 10));

    return { qq, portal, restore };
  }

  test('外部线程的轮次完成结果发回该线路的最近对端', async () => {
    const frame = 'id: 7\nevent: thread.turn-completed\ndata: {"threadId":"th-ext","resultText":"任务完成"}\n\n';
    const { qq, portal, restore } = await driveOutbound({
      boundTarget: { agentId: 'programming-helper', threadId: 'th-ext' },
      senderId: 'u9',
      frames: [frame],
    });

    assert.equal(qq.sent.length, 1);
    assert.equal(qq.sent[0].userId, 'u9');
    assert.equal(qq.sent[0].text, '任务完成');
    restore();
    portal.close();
  });

  test('接线员线程的轮次事件不出站（结果已由入站同步返回，避免重复发送）', async () => {
    const frame = 'id: 8\nevent: thread.turn-completed\ndata: {"threadId":"th-operator","resultText":"重复内容"}\n\n';
    const { qq, portal, restore } = await driveOutbound({
      boundTarget: { agentId: 'qqbot', threadId: 'th-operator' },
      senderId: 'u10',
      frames: [frame],
    });

    assert.equal(qq.sent.length, 0);
    restore();
    portal.close();
  });

  test('轮次失败把错误摘要发回对端', async () => {
    const frame = 'id: 9\nevent: thread.turn-failed\ndata: {"threadId":"th-ext","error":{"message":"模型超时"}}\n\n';
    const { qq, portal, restore } = await driveOutbound({
      boundTarget: { agentId: 'programming-helper', threadId: 'th-ext' },
      senderId: 'u11',
      frames: [frame],
    });

    assert.equal(qq.sent.length, 1);
    assert.match(qq.sent[0].text, /处理失败/);
    assert.match(qq.sent[0].text, /模型超时/);
    restore();
    portal.close();
  });

  test('轮次被取消不发消息（用户自己打断）', async () => {
    const frame = 'id: 10\nevent: thread.turn-cancelled\ndata: {"threadId":"th-ext"}\n\n';
    const { qq, portal, restore } = await driveOutbound({
      boundTarget: { agentId: 'programming-helper', threadId: 'th-ext' },
      senderId: 'u12',
      frames: [frame],
    });

    assert.equal(qq.sent.length, 0);
    restore();
    portal.close();
  });
});

describe('线路连接管理', () => {
  test('syncLines 连上配置里的线路，断开已移除的线路', async () => {
    const qq = createFeatureStub();
    const wx = createFeatureStub();
    const agent = createAgentStub({ features: { qqbot: qq, 'weixin-bot': wx } });
    const portal = createPortalLines({ agent, serverOrigin: 'http://x', portalAgentId: 'qqbot' });

    let result = await portal.syncLines([line('line1', 'qq', null)]);
    assert.deepEqual(result.connected.map((c) => c.carrier), ['qq']);
    assert.equal(qq.started, true);

    result = await portal.syncLines([line('line2', 'weixin', null)]);
    assert.deepEqual(result.connected.map((c) => c.carrier), ['weixin']);
    assert.equal(qq.started, false);
    assert.equal(wx.started, true);
    portal.close();
  });

  test('同一线路重复对账不重连平台连接', async () => {
    const qq = createFeatureStub();
    let startCount = 0;
    qq.startGateway = async function () { startCount += 1; this.started = true; };
    const agent = createAgentStub({ features: { qqbot: qq } });
    const portal = createPortalLines({ agent, serverOrigin: 'http://x', portalAgentId: 'qqbot' });

    await portal.syncLines([line('line1', 'qq', null)]);
    await portal.syncLines([line('line1', 'qq', null)]);
    assert.equal(startCount, 1);
    portal.close();
  });

  test('改绑目标只更新绑定，不重建平台连接', async () => {
    const qq = createFeatureStub();
    let startCount = 0;
    qq.startGateway = async function () { startCount += 1; this.started = true; };
    const agent = createAgentStub({ features: { qqbot: qq } });
    const portal = createPortalLines({ agent, serverOrigin: 'http://x', portalAgentId: 'qqbot' });

    await portal.syncLines([line('line1', 'qq', null)]);
    await portal.syncLines([line('line1', 'qq', { agentId: 'coder', threadId: 'th-1' })]);
    assert.equal(startCount, 1);
    assert.equal(portal.snapshot()[0].boundTarget.threadId, 'th-1');
    portal.close();
  });

  test('未装配 feature 的渠道跳过连接并给出原因', async () => {
    const agent = createAgentStub({ features: {} });
    const portal = createPortalLines({ agent, serverOrigin: 'http://x', portalAgentId: 'qqbot' });
    const res = await portal.connectLine(line('line1', 'qq', null));
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'feature_missing');
    portal.close();
  });

  test('多条线路并发连接：两个渠道同时在线，互不覆盖', async () => {
    const qq = createFeatureStub();
    const fs2 = createFeatureStub();
    const agent = createAgentStub({ features: { qqbot: qq, 'feishu-bot': fs2 } });
    const portal = createPortalLines({ agent, serverOrigin: 'http://x', portalAgentId: 'qqbot' });

    const { connected } = await portal.syncLines([
      line('line1', 'qq', null),
      line('line2', 'feishu', null),
    ]);
    // 这正是旧 _activeIMChannel 单值模型做不到的：两条线路同时活着
    assert.deepEqual(connected.map((c) => c.carrier).sort(), ['feishu', 'qq']);
    assert.equal(qq.started, true);
    assert.equal(fs2.started, true);
    portal.close();
  });
});
