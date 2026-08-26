/**
 * requestRuntimeAck（swap request/reply IPC）测试
 *
 * 覆盖：
 * - 成功回执：type + requestId 匹配 → { ok: true, meta }
 * - 失败回执：runtime 回 ok:false + error → 透传错误
 * - 超时：无回执 → { ok: false, error: timeout }（短 timeoutMs）
 * - 送达失败：sendIPCToRuntime 拒绝（进程退出）→ 立即失败
 * - 回执后移除监听器（不留泄漏）；错误 requestId 的回执不被误收
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { requestRuntimeAck } from '../server/shared/ipc.js';

function makeFakeChild() {
  const emitter = new EventEmitter();
  return {
    emitter,
    exitCode: null,
    sent: [],
    send(payload) {
      this.sent.push(payload);
      // 表现为一个真实 child.send：消息进入事件循环后可被本进程 'message' 模拟
      return true;
    },
    on(event, listener) {
      emitter.on(event, listener);
    },
    removeListener(event, listener) {
      emitter.removeListener(event, listener);
    },
  };
}

function makeRuntime(child) {
  return { process: child, stopped: false, selectedSessionId: 'sess-1' };
}

describe('requestRuntimeAck', () => {
  it('resolves ok with meta on a matching ack', async () => {
    const child = makeFakeChild();
    const runtime = makeRuntime(child);

    const promise = requestRuntimeAck(runtime, { type: 'swap-model', presetName: 'glm' }, 'model-swap-result');
    assert.equal(child.sent.length, 1);
    assert.equal(child.sent[0].type, 'swap-model');
    assert.equal(child.sent[0].presetName, 'glm');
    assert.ok(child.sent[0].requestId, 'requestId must be injected');
    assert.equal(child.sent[0].__targetSessionId, 'sess-1', 'session scoping must be preserved');

    // 无关消息（错误 type / requestId）不得被误收
    child.emitter.emit('message', { type: 'model-swap-result', requestId: 'other-id', ok: true });
    child.emitter.emit('message', { type: 'unrelated', requestId: child.sent[0].requestId, ok: true });

    child.emitter.emit('message', { type: 'model-swap-result', requestId: child.sent[0].requestId, ok: true, meta: { modelName: 'glm-x' } });

    const result = await promise;
    assert.deepEqual(result, { ok: true, meta: { modelName: 'glm-x' } });
    assert.equal(child.emitter.listenerCount('message'), 0, 'listener must be removed after settle');
  });

  it('resolves failure with the runtime error message', async () => {
    const child = makeFakeChild();
    const runtime = makeRuntime(child);

    const promise = requestRuntimeAck(runtime, { type: 'swap-model', presetName: 'missing' }, 'model-swap-result');
    child.emitter.emit('message', { type: 'model-swap-result', requestId: child.sent[0].requestId, ok: false, error: 'failed to resolve preset "missing"' });

    const result = await promise;
    assert.equal(result.ok, false);
    assert.match(result.error, /failed to resolve/);
  });

  it('times out when no ack arrives', async () => {
    const child = makeFakeChild();
    const runtime = makeRuntime(child);

    const result = await requestRuntimeAck(runtime, { type: 'swap-model', presetName: 'glm' }, 'model-swap-result', { timeoutMs: 20 });
    assert.equal(result.ok, false);
    assert.match(result.error, /timeout/i);
    assert.equal(child.emitter.listenerCount('message'), 0);
  });

  it('fails immediately when the runtime process is gone', async () => {
    const child = makeFakeChild();
    child.exitCode = 1;
    const result = await requestRuntimeAck(makeRuntime(child), { type: 'swap-model' }, 'model-swap-result');
    assert.equal(result.ok, false);
    assert.match(result.error, /not connected/);

    const stopped = { process: makeFakeChild(), stopped: true };
    const result2 = await requestRuntimeAck(stopped, { type: 'swap-model' }, 'model-swap-result');
    assert.equal(result2.ok, false);
  });

  it('fails immediately when send throws', async () => {
    const child = makeFakeChild();
    child.send = () => { throw new Error('channel closed'); };
    const result = await requestRuntimeAck(makeRuntime(child), { type: 'swap-model' }, 'model-swap-result');
    assert.equal(result.ok, false);
    assert.match(result.error, /failed to deliver/);
  });
});
