/**
 * T001 — Thread APP 归属与成员不变量 验收测试（node:test 纯逻辑，不依赖真实 Runtime）
 *
 * ADR-0025 新模型：会话身份投影机制退役，线程归属是 APP 结构事实——
 * coder APP 的会话即线程宿主（isThreadHostSession），线程记录以 agentId /
 * workspaceId 表达归属，identitySource 注入面与 thread-identity 解析层已删除。
 *
 * 覆盖工单验收标准：
 * 1. 线程归属是 APP 结构事实：coder 会话建线程，thread.agentId=workspaceId=
 *    'coder'，identity 恒 null（无身份推导，绝不出现 main/coder 词汇分派）；
 * 2. root、head、历史成员都经 findThreadBySession 命中同一线程（sessionChain
 *    链记录是唯一成员事实）；
 * 3. 从历史 Session branch 创建的新 Thread 不复用原 Thread，原线程链零改写；
 * 4. 非线程宿主 APP（编程小助手）会话保持纯 Session 语义（创建钩子 no-op、
 *    succession / 删除钩子 no_thread_for_session）；
 * 5. advanceHead 无身份门：同 APP 会话直接放行；结构守卫（head 校验 /
 *    duplicate_session）仍在框架事务内生效，失败时线程记录零变更；
 * 6. 旧数据缺 identity 字段读时归一为 null，head 推进不回填不报错（身份门
 *    退役后 identity 是惰性遗留字段，不再是连续性判定输入）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdevjs/core';
import { ThreadStore } from '../server/thread-control/thread-store.js';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { createThreadIntegration, isThreadHostSession } from '../server/thread-control/thread-integration.js';
import { registerThreadHostAgents } from '../server/thread-control/host-agents.js';
// 宿主集合声明化（ADR-0024 可拔插）：生产由 server 启动时按 metadata
// threadHost 声明注册；测试注册 ['coder'] 模拟该事实。
registerThreadHostAgents(['coder']);

function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'claw-thread-identity-test-'));
}

let counter = 0;

function makeTempRootSync() {
  return mkdtempSync(path.join(os.tmpdir(), 'claw-thread-identity-base-'));
}

function makeControl() {
  const root = path.join(makeTempRootSync(), `ctrl-${++counter}`);
  const bridge = new WorkThreadRuntimeBridge({ enabled: false });
  const control = createThreadControl({ rootDir: root, bridge });
  return { root, control, core: control.core, integration: createThreadIntegration({ control }) };
}

describe('T001: 线程归属是 APP 结构事实', () => {
  test('thread created for a coder session carries the app as its structural identity', async () => {
    const { core } = makeControl();
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'root-c1' } });
    assert.equal(thread.agentId, 'coder');
    assert.equal(thread.workspaceId, 'coder', '框架缺省：workspaceId 取 agentId');
    // 身份投影已退役：identity 字段恒 null，绝不出现 main/coder 词汇分派
    assert.equal(thread.identity, null);
  });

  test('integration onSessionCreated creates threads for coder app sessions only', async () => {
    const { integration } = makeControl();
    const thread = await integration.onSessionCreated('coder', { id: 'root-c2', title: 'T' });
    assert.ok(thread);
    assert.equal(thread.agentId, 'coder');
    assert.equal(thread.headSessionId, 'root-c2');

    // 非线程宿主 APP：创建钩子 no-op，纯 Session 语义
    const none = await integration.onSessionCreated('programming-helper', { id: 'ph-main-1', title: 'M' });
    assert.equal(none, null);
  });

  test('host gate is app-level (isThreadHostSession decides by app id alone)', () => {
    assert.equal(isThreadHostSession('coder'), true);
    assert.equal(isThreadHostSession('programming-helper'), false);
  });
});

describe('T001: successor 加入（无身份门，结构守卫仍在）', () => {
  test('same-app successor is admitted without any identity machinery', async () => {
    const { core } = makeControl();
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'root-c1' } });

    const advanced = await core.advanceHead({ threadId: thread.threadId, toSessionId: 'succ-c1', fromSessionId: 'root-c1', endKind: 'trim' });
    assert.equal(advanced.headSessionId, 'succ-c1');
    assert.equal(advanced.workspaceId, 'coder', 'head 推进后归属不变');
    assert.equal(advanced.identity, null, '全程无身份推导');
    assert.equal(advanced.sessionChain.length, 2);
  });

  test('duplicate_session guard still rejects a session already in the chain and leaves the thread untouched', async () => {
    const { core } = makeControl();
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'root-c1' } });
    await core.advanceHead({ threadId: thread.threadId, toSessionId: 'succ-c1', fromSessionId: 'root-c1', endKind: 'trim' });
    const before = await core.getThread(thread.threadId);

    // 历史成员再入链：结构守卫拒绝（身份门不存在，但链完整性仍在框架事务内）
    await assert.rejects(
      () => core.advanceHead({ threadId: thread.threadId, toSessionId: 'root-c1', fromSessionId: 'succ-c1', endKind: 'branch' }),
      (err) => err.code === 'duplicate_session' && err.status === 409,
    );

    const after = await core.getThread(thread.threadId);
    assert.equal(after.headSessionId, 'succ-c1');
    assert.equal(after.sessionChain.length, 2);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.lifecycleEvents, before.lifecycleEvents);
  });

  test('head_mismatch guard rejects a stale fromSessionId', async () => {
    const { core } = makeControl();
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'root-c1' } });
    await core.advanceHead({ threadId: thread.threadId, toSessionId: 'succ-c1', fromSessionId: 'root-c1', endKind: 'trim' });

    await assert.rejects(
      () => core.advanceHead({ threadId: thread.threadId, toSessionId: 'succ-c2', fromSessionId: 'root-c1', endKind: 'trim' }),
      (err) => err.code === 'head_mismatch' && err.status === 409,
    );
  });
});

describe('T001: 成员查询返回统一归属事实', () => {
  test('root, historical member and head all resolve to the same thread', async () => {
    const { core } = makeControl();
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'root-c1' } });
    await core.advanceHead({ threadId: thread.threadId, toSessionId: 'mid-c1', fromSessionId: 'root-c1', endKind: 'trim' });
    await core.advanceHead({ threadId: thread.threadId, toSessionId: 'head-c1', fromSessionId: 'mid-c1', endKind: 'summary' });

    const byRoot = await core.findThreadBySession('coder', 'root-c1');
    const byMid = await core.findThreadBySession('coder', 'mid-c1');
    const byHead = await core.findThreadBySession('coder', 'head-c1');

    for (const found of [byRoot, byMid, byHead]) {
      assert.equal(found.threadId, thread.threadId, '成员查询命中同一线程');
      assert.equal(found.agentId, 'coder', 'root / 历史成员 / head 归属一致');
    }
    assert.equal((await core.getThread(thread.threadId)).headSessionId, 'head-c1');

    // 非成员会话：查询返回 null（不属于该线程）
    assert.equal(await core.findThreadBySession('coder', 'nobody'), null);
    // 其他 APP 查不到本线程（成员事实按 APP 寻址）
    assert.equal(await core.findThreadBySession('programming-helper', 'root-c1'), null);
  });

  test('index summary carries the app attribution without runtime scan', async () => {
    const { core } = makeControl();
    await core.start({ sessionRef: { agentId: 'coder', sessionId: 'root-c1' } });
    const summary = (await core.listThreads({ agentId: 'coder' }))[0];
    assert.equal(summary.agentId, 'coder');
    assert.equal(summary.identity, null, '身份投影退役：summary 不再携带身份语义');
  });
});

describe('T001: branch 建新 Thread 不复用原 Thread', () => {
  test('branch from a historical session creates a new thread of the same app', async () => {
    const { core, integration } = makeControl();
    const origin = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'root-c1' } });
    await core.advanceHead({ threadId: origin.threadId, toSessionId: 'mid-c1', fromSessionId: 'root-c1', endKind: 'trim' });

    // 从历史棒 mid-c1 branch：新会话 branch-c1 成为新线程的 root
    // （integration.onSessionCreated 即生产 branch 路径的接线点）
    const branched = await integration.onSessionCreated('coder', { id: 'branch-c1', title: '（分支）' });
    assert.ok(branched);
    assert.notEqual(branched.threadId, origin.threadId, '不复用原 Thread');
    assert.equal(branched.agentId, 'coder', '保持来源 APP 归属');
    assert.equal(branched.rootSessionId, 'branch-c1');

    // 原线程的线性链不被改写
    const originAfter = await core.getThread(origin.threadId);
    assert.deepEqual(
      originAfter.sessionChain.map((entry) => entry.sessionId),
      ['root-c1', 'mid-c1'],
    );
    assert.equal(originAfter.headSessionId, 'mid-c1');
  });
});

describe('T001: 旧数据缺身份字段的明确读取处理', () => {
  test('legacy record without identity reads as null and never as a session-type word', async () => {
    const root = await makeTempRoot();
    try {
      const store = new ThreadStore({ rootDir: root });
      await fs.mkdir(path.join(root, 'threads'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'threads', 'wt-legacy-no-identity.json'),
        JSON.stringify({
          threadId: 'wt-legacy-no-identity',
          agentId: 'coder',
          workspaceId: 'coder',
          title: '',
          status: 'open',
          rootSessionId: 'old-1',
          headSessionId: 'old-1',
          sessionChain: [{ sessionId: 'old-1', role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null }],
          commands: [],
          pendingSuccession: null,
          hold: false,
          lifecycleEvents: [],
          lastLifecycleEvent: null,
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        }),
        'utf8',
      );
      const record = await store.get('wt-legacy-no-identity');
      assert.equal(record.identity, null, '缺字段 = 惰性遗留值，不参与连续性判定');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('advanceHead on a legacy thread neither backfills identity nor fails', async () => {
    const { core } = makeControl();
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'legacy-root' } });

    // 模拟旧记录：identity 字段被剥离
    await core.store.update(thread.threadId, (draft) => {
      delete draft.identity;
      return draft;
    });
    assert.equal((await core.getThread(thread.threadId)).identity, null);

    // 身份门已退役：head 正常推进，无回填、无 thread_identity_missing
    const advanced = await core.advanceHead({ threadId: thread.threadId, toSessionId: 'legacy-succ', fromSessionId: 'legacy-root', endKind: 'trim' });
    assert.equal(advanced.headSessionId, 'legacy-succ');
    assert.equal(advanced.identity, null, '身份不再回填：连续性判定输入已移除');
  });
});

describe('T001: 非线程宿主 APP 会话保持原 Session 语义', () => {
  test('pure-session lifecycle hooks are no-ops for non-host-app sessions', async () => {
    const { core, integration } = makeControl();

    // 未接入线程的会话：succession / 删除钩子 no-op
    const noThread = await integration.applySessionSuccession({
      agentId: 'programming-helper',
      fromSessionId: 'ph-free-1',
      toSessionId: 'ph-free-2',
      reason: 'trim',
    });
    assert.equal(noThread.applied, false);
    assert.equal(noThread.reason, 'no_thread_for_session');

    const noDelete = await integration.assertSessionDeletable('programming-helper', 'ph-free-1');
    assert.equal(noDelete.applied, false);
    assert.equal(noDelete.reason, 'no_thread_for_session');

    // 该会话没有任何线程成员关系
    assert.equal(await core.findThreadBySession('programming-helper', 'ph-free-1'), null);
  });

  test('coder head session cannot be deleted individually', async () => {
    const { core, integration } = makeControl();
    const thread = await integration.onSessionCreated('coder', { id: 'coder-s1', title: 'T' });
    assert.ok(thread);

    const applied = await integration.applySessionSuccession({
      agentId: 'coder',
      fromSessionId: 'coder-s1',
      toSessionId: 'coder-s2',
      reason: 'trim',
    });
    assert.equal(applied.applied, true, '线程 head 会话的 succession 正常推进');

    await assert.rejects(
      integration.assertSessionDeletable('coder', 'coder-s2'),
      (error) => error.code === 'thread_head_session_cannot_be_deleted'
        && error.status === 409
        && error.message.includes(thread.threadId),
    );
    const unchanged = await core.getThread(thread.threadId);
    assert.equal(unchanged.status, 'open');
    assert.equal(unchanged.headSessionId, 'coder-s2');
  });
});
