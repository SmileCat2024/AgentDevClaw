import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { THREAD_HOST_AGENT_IDS } from '../server/thread-control/host-agents.js';
import { EmbeddedRemoteClawConnector } from '../server/remote-claw/embedded-connector.js';

/**
 * ADR-0047 阶段 4 入口收口（embedded-connector 投递路由）：
 * - localSessionId 是线程宿主 APP 会话且命中线程（含被换下的旧 head）
 *   → 转 Inbox 寻址（deliverThreadInput），旧 head 会话不被
 *     activatePrebuiltSession 激活复活；响应携带 headSessionId 对账。
 * - 无线程归属 → 照旧 direct 路径（激活会话 + submitUserTurn）。
 * - 非 thread-host APP → 不查线程归属，direct 路径不变。
 */

const HOST_AGENT = 'test-ec-host-agent';

function createConnector({ integration, deliverInput } = {}) {
  const connector = new EmbeddedRemoteClawConnector({
    log() {},
    threadIntegration: integration,
    deliverThreadInput: deliverInput,
  });
  // direct 路径桩：被调用即抛出标记错误（用例以「是否进入 direct」为
  // 断言信号，不需要真实激活/runtime 链）
  connector.requireAgentLight = async () => ({ id: HOST_AGENT });
  connector.activatePrebuiltSession = async () => {
    throw new Error('DIRECT_PATH_REACHED');
  };
  connector.resolveCommandTarget = () => ({ agentId: HOST_AGENT, localSessionId: 'sess-old-head', viewerAgentId: null });
  return connector;
}

beforeEach(() => {
  THREAD_HOST_AGENT_IDS.add(HOST_AGENT);
});
afterEach(() => {
  THREAD_HOST_AGENT_IDS.delete(HOST_AGENT);
});

test('routes a thread-member session delivery to the Inbox and never activates the retired head', async () => {
  let inboxCall = null;
  let deliverCall = 0;
  const connector = createConnector({
    integration: {
      findThreadBySession: async () => ({ threadId: 'wt-ec-1', headSessionId: 'sess-new-head' }),
      tryDeliver: async () => { deliverCall += 1; return { attempted: 1 }; },
    },
    deliverInput: async (input) => {
      inboxCall = input;
      return { delivery: 'thread_queued', threadId: input.threadId };
    },
  });

  const result = await connector.executeMessageSend({
    id: 'cmd-ec-1',
    payload: { text: 'continue the work' },
  });

  assert.equal(inboxCall.threadId, 'wt-ec-1');
  assert.equal(inboxCall.sourceRef, 'cmd-ec-1');
  assert.equal(inboxCall.source, 'remote-claw');
  assert.equal(inboxCall.text, 'continue the work');
  assert.equal(deliverCall, 1, '入箱后必须触发投递');
  assert.deepEqual(result, {
    localAccepted: true,
    delivery: 'thread_queued',
    queued: true,
    threadId: 'wt-ec-1',
    headSessionId: 'sess-new-head',
    agentId: HOST_AGENT,
    localSessionId: 'sess-old-head',
  });
});

test('fails closed when thread membership cannot be read and never activates the session directly', async () => {
  const connector = createConnector({
    integration: { findThreadBySession: async () => { throw new Error('thread store unavailable'); } },
    deliverInput: async () => { throw new Error('must not inbox without resolved membership'); },
  });
  await assert.rejects(
    connector.executeMessageSend({ id: 'cmd-ec-read-error', payload: { text: 'x' } }),
    /thread store unavailable/,
  );
});

test('falls through to the direct path when the host-agent session has no thread', async () => {
  const connector = createConnector({
    integration: {
      findThreadBySession: async () => null,
      tryDeliver: async () => { throw new Error('must not deliver'); },
    },
    deliverInput: async () => { throw new Error('must not inbox'); },
  });
  await assert.rejects(
    connector.executeMessageSend({ id: 'cmd-ec-2', payload: { text: 'x' } }),
    /DIRECT_PATH_REACHED/,
  );
});

test('skips thread resolution entirely for non-thread-host agents', async () => {
  const connector = createConnector({
    integration: {
      findThreadBySession: async () => { throw new Error('must not resolve'); },
    },
  });
  connector.resolveCommandTarget = () => ({ agentId: 'plain-agent', localSessionId: 'sess-1', viewerAgentId: null });
  connector.requireAgentLight = async () => ({ id: 'plain-agent' });
  await assert.rejects(
    connector.executeMessageSend({ id: 'cmd-ec-3', payload: { text: 'x' } }),
    /DIRECT_PATH_REACHED/,
  );
});
