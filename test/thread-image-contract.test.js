/**
 * 线程域图片输入契约（viewer ImageInput[] ↔ command string[]）
 *
 * 两个输入域的 images 形状不同，由 Claw 侧网关与投递桥负责适配：
 *   - viewer / user-turn 域：ImageInput[] 对象数组（{ path, mediaType, source }），
 *     前端 chat-composer、/api/agents/:id/user-turn 直投、/threads/:id/input
 *     全部是这个形状；
 *   - WorkThread command 域：string[] 路径数组（框架 appendCommand 契约，
 *     非字符串成员被过滤）。
 *
 * 回归场景（PH 线程宿主会话，ADR-0032 后日常输入走 thread 域）：
 *   - image-only（text 空白占位 ' '）对象数组若原样入 appendCommand，会被
 *     框架过滤成空数组并触发 K8 拒绝（"Command text must be non-empty"，
 *     用户看到的“文本不能为空”）；
 *   - text + images 场景图片会被静默丢弃；
 *   - 投递侧 bridge 需把 string[] 还原为 ImageInput[]（{ path }），
 *     submitUserTurn 才符合 viewer 契约。
 *
 * 网关侧用真实框架 WorkThread 走路由 → 入箱全链路（不用 stub
 * appendCommand），K8 拒绝在断言层当场炸出。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkThread, WorkThreadStore } from '@agentdevjs/core';

const { deliverUserInput } = await import('../server/thread-control/input-gateway.js');
const { managedAgents } = await import('../server/shared/agent-access.js');
const { registerThreadHostAgents } = await import('../server/thread-control/host-agents.js');
const { bridgeParamsToSubmitTurnArgs } = await import('../server/thread-control/thread-controller.js');

registerThreadHostAgents(['programming-helper']);

function registerRuntime({ viewerAgentId = 'viewer-1', agentId = 'programming-helper', sessionId = 'session-1' } = {}) {
  const runtime = {
    id: `${agentId}::${sessionId}`,
    agentId,
    viewerAgentId,
    selectedSessionId: sessionId,
    stopped: false,
    stopping: false,
    process: { exitCode: null, signalCode: null },
    startedAt: '2026-01-01T00:00:00.000Z',
  };
  managedAgents.set(runtime.id, runtime);
  return runtime;
}

async function startThreadIntegration(t) {
  registerRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), 'claw-thread-image-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const core = new WorkThread({ store: new WorkThreadStore({ rootDir }) });
  const thread = await core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'session-1' } });
  return { core, thread };
}

const mustUseDirect = async () => { throw new Error('must use the inbox'); };

let seq = 0;
beforeEach(() => { managedAgents.clear(); seq += 1; });

describe('thread gateway image contract (viewer ImageInput[] → command string[])', () => {
  it('image-only input (blank text placeholder) enters the inbox instead of tripping the empty-text rejection', async (t) => {
    const { core, thread } = await startThreadIntegration(t);

    const result = await deliverUserInput({
      viewerAgentId: 'viewer-1',
      text: ' ',
      images: [
        { path: 'C:\\uploads\\a.png', mediaType: 'image/png', source: 'a.png' },
        { path: 'C:\\uploads\\b.png', mediaType: 'image/png', source: 'b.png' },
      ],
      source: 'chat-composer',
    }, { integration: { core }, fetchImpl: mustUseDirect });

    assert.equal(result.success, true);
    assert.equal(result.delivery, 'thread_queued');
    const record = await core.getThread(thread.threadId);
    const inboxCommand = record.commands.at(-1);
    assert.ok(inboxCommand, 'command must be persisted');
    assert.deepEqual(inboxCommand.images, ['C:\\uploads\\a.png', 'C:\\uploads\\b.png']);
  });

  it('text + images input keeps both text and normalized image paths', async (t) => {
    const { core, thread } = await startThreadIntegration(t);

    await deliverUserInput({
      viewerAgentId: 'viewer-1',
      text: `看这张图 ${seq}`,
      images: [{ path: '/data/x.jpg', mediaType: 'image/jpeg', source: 'x.jpg' }],
      source: 'chat-composer',
    }, { integration: { core }, fetchImpl: mustUseDirect });

    const record = await core.getThread(thread.threadId);
    const inboxCommand = record.commands.at(-1);
    assert.equal(inboxCommand.text, `看这张图 ${seq}`);
    assert.deepEqual(inboxCommand.images, ['/data/x.jpg']);
  });

  it('string[] images pass through unchanged (command-dialect callers)', async (t) => {
    const { core, thread } = await startThreadIntegration(t);

    await deliverUserInput({
      viewerAgentId: 'viewer-1',
      text: '继续',
      images: ['/uploads/a.png'],
      source: 'thread-stream',
    }, { integration: { core }, fetchImpl: mustUseDirect });

    const record = await core.getThread(thread.threadId);
    assert.deepEqual(record.commands.at(-1).images, ['/uploads/a.png']);
  });

  it('mixed dialect entries convert per member: objects by path, strings kept, pathless objects dropped', async (t) => {
    const { core, thread } = await startThreadIntegration(t);

    await deliverUserInput({
      viewerAgentId: 'viewer-1',
      text: ' ',
      images: [{ path: '/ok/a.png' }, '/direct/b.png', { mediaType: 'image/png' }],
      source: 'chat-composer',
    }, { integration: { core }, fetchImpl: mustUseDirect });

    const record = await core.getThread(thread.threadId);
    const inboxCommand = record.commands.at(-1);
    assert.ok(inboxCommand, 'image-only input must still enter the inbox');
    // string 成员本就是 command 方言的合法路径形态（gateway 不做文件系统
    // 校验，无法也不应区分"垃圾字符串"）；无 path 的对象成员无法寻址，丢弃
    assert.deepEqual(inboxCommand.images, ['/ok/a.png', '/direct/b.png']);
  });
});

describe('bridgeParamsToSubmitTurnArgs image contract (command string[] → viewer ImageInput[])', () => {
  it('maps stored path strings back to { path } objects for submitUserTurn', () => {
    const args = bridgeParamsToSubmitTurnArgs({
      agentId: 'viewer-1',
      text: '看这张图',
      images: ['/uploads/a.png', '/uploads/b.png'],
    });
    assert.deepEqual(args.images, [{ path: '/uploads/a.png' }, { path: '/uploads/b.png' }]);
  });

  it('object entries (already ImageInput-shaped) pass through unchanged', () => {
    const shaped = [{ path: '/uploads/a.png', mediaType: 'image/png', source: 'a.png' }];
    const args = bridgeParamsToSubmitTurnArgs({ agentId: 'viewer-1', text: 'x', images: shaped });
    assert.deepEqual(args.images, shaped);
  });

  it('empty image list stays absent (no empty array sent to the viewer)', () => {
    const args = bridgeParamsToSubmitTurnArgs({ agentId: 'viewer-1', text: 'x', images: [] });
    assert.equal('images' in args, false);
  });
});
