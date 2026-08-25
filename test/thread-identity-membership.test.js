/**
 * T001 — Thread 身份归属与成员不变量 验收测试（node:test 纯逻辑，不依赖真实 Runtime）
 *
 * 覆盖工单验收标准：
 * 1. 同一 Thread 内不能加入 main/coder 身份不一致的 Session（thread_identity_mismatch，
 *    线程记录零变更）；
 * 2. Thread 的 root、head、历史成员都能查询到相同身份归属（findThreadBySession 统一
 *    成员事实，identity 单条记录取值一致）；
 * 3. 从历史 Session branch 创建的新 Thread 保持来源身份，但不复用原 Thread；
 * 4. 非 Thread Session 的创建 / 输入 / 生命周期保持原有 Session 语义（集成钩子 no-op）；
 * 5. 不出现新的全局角色注册表——身份真相源按装配注入（identitySource），
 *    host 判定与身份判定保持正交（host-agents 不持有身份词汇表）。
 *
 * 另覆盖「失败与边界」：
 * - successor 不属于同一工作空间宿主（session_workspace_mismatch）；
 * - successor 已属其它 Thread（session_already_in_thread）；
 * - 旧数据缺身份字段：读时归一为 null（未知，不静默 main），head 推进时从 root
 *   Session 事实回填，root 身份也不可得时明确失败（thread_identity_missing）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdev/core';
import { ThreadStore } from '../server/thread-control/thread-store.js';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { createThreadIntegration, isThreadHostSession } from '../server/thread-control/thread-integration.js';

function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'claw-thread-identity-test-'));
}

/**
 * 测试身份真相源：session id → 身份 的显式映射（hermetic，不读用户数据目录）。
 * 未登记 = 该宿主下无此会话（identitySource 返回 null）——同时表达
 * 「不属于该工作空间宿主」，与生产 resolveSessionIdentity 语义一致。
 */
function makeIdentitySource() {
  const sessions = new Map();
  return {
    register(sessionId, identity) { sessions.set(sessionId, identity); },
    identitySource: async (agentId, sessionId) => {
      const id = String(sessionId || '').trim();
      if (!id) return null;
      const identity = sessions.get(id);
      return identity === undefined ? null : identity;
    },
  };
}

let counter = 0;

function makeControl() {
  const root = path.join(makeTempRootSync(), `ctrl-${++counter}`);
  const identity = makeIdentitySource();
  const bridge = new WorkThreadRuntimeBridge({ enabled: false });
  const control = createThreadControl({ rootDir: root, bridge, identitySource: identity.identitySource });
  return { root, identity, control, core: control.core, integration: createThreadIntegration({ control }) };
}

function makeTempRootSync() {
  return mkdtempSync(path.join(os.tmpdir(), 'claw-thread-identity-base-'));
}

describe('T001: root 创建确定身份归属', () => {
  test('thread identity is taken from the root session (via identitySource)', async () => {
    const { identity, core } = makeControl();
    identity.register('root-c1', 'coder');
    const thread = await core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'root-c1' } });
    assert.equal(thread.identity, 'coder');

    // main 会话建线程同样记录自身身份——框架不硬编码 coder/main 词汇
    const identity2 = makeIdentitySource();
    identity2.register('root-m1', 'main');
    const control2 = createThreadControl({
      rootDir: path.join(makeTempRootSync(), `ctrl-main-${++counter}`),
      bridge: new WorkThreadRuntimeBridge({ enabled: false }),
      identitySource: identity2.identitySource,
    });
    const thread2 = await control2.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'root-m1' } });
    assert.equal(thread2.identity, 'main');
  });

  test('integration onSessionCreated attributes identity from the session record', async () => {
    const { integration } = makeControl();
    // sessionType 即身份事实，显式传入（生产路径），不再依赖 index 回读
    const thread = await integration.onSessionCreated('programming-helper', { id: 'root-c2', sessionType: 'coder', title: 'T' });
    assert.ok(thread);
    assert.equal(thread.identity, 'coder');
    assert.equal(thread.headSessionId, 'root-c2');
  });

  test('unresolvable root identity is recorded as null, never defaulted', async () => {
    const { core } = makeControl();
    // root 未登记 → 身份未知（null），绝不静默落成 main/coder
    const thread = await core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'orphan-root' } });
    assert.equal(thread.identity, null);
  });
});

describe('T001: successor 加入前的三道校验（线程不改变）', () => {
  test('identity mismatch rejects the successor and leaves the thread untouched', async () => {
    const { identity, core } = makeControl();
    identity.register('root-c1', 'coder');
    identity.register('succ-m1', 'main');
    const thread = await core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'root-c1' } });
    const before = await core.getThread(thread.threadId);

    await assert.rejects(
      () => core.advanceHead({ threadId: thread.threadId, toSessionId: 'succ-m1', fromSessionId: 'root-c1', endKind: 'trim' }),
      (err) => err.code === 'thread_identity_mismatch' && err.status === 409,
    );

    // 线程不改变：head / 链 / revision 全部保持
    const after = await core.getThread(thread.threadId);
    assert.equal(after.headSessionId, 'root-c1');
    assert.equal(after.sessionChain.length, 1);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.lifecycleEvents, before.lifecycleEvents);
  });

  test('same-identity successor is admitted and head advances', async () => {
    const { identity, core } = makeControl();
    identity.register('root-c1', 'coder');
    identity.register('succ-c1', 'coder');
    const thread = await core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'root-c1' } });

    const advanced = await core.advanceHead({ threadId: thread.threadId, toSessionId: 'succ-c1', fromSessionId: 'root-c1', endKind: 'trim' });
    assert.equal(advanced.headSessionId, 'succ-c1');
    assert.equal(advanced.identity, 'coder', 'head 推进后身份归属不变');
    assert.equal(advanced.sessionChain.length, 2);
  });

  test('successor outside the thread workspace host is rejected', async () => {
    const { identity, core } = makeControl();
    identity.register('root-c1', 'coder');
    // 'foreign-1' 未登记：该宿主下查不到此会话
    const thread = await core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'root-c1' } });

    await assert.rejects(
      () => core.advanceHead({ threadId: thread.threadId, toSessionId: 'foreign-1', fromSessionId: 'root-c1' }),
      (err) => err.code === 'session_workspace_mismatch' && err.status === 409,
    );
  });

  test('successor already a member of another thread is rejected', async () => {
    const { identity, core } = makeControl();
    identity.register('root-c1', 'coder');
    identity.register('root-c2', 'coder');
    identity.register('shared-1', 'coder');
    const threadA = await core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'root-c1' } });
    const threadB = await core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'root-c2' } });
    await core.advanceHead({ threadId: threadB.threadId, toSessionId: 'shared-1', fromSessionId: 'root-c2', endKind: 'branch' });

    await assert.rejects(
      () => core.advanceHead({ threadId: threadA.threadId, toSessionId: 'shared-1', fromSessionId: 'root-c1' }),
      (err) => err.code === 'session_already_in_thread' && err.status === 409,
    );
  });
});

describe('T001: 成员查询返回统一归属事实', () => {
  test('root, historical member and head all resolve to the same thread and identity', async () => {
    const { identity, core } = makeControl();
    identity.register('root-c1', 'coder');
    identity.register('mid-c1', 'coder');
    identity.register('head-c1', 'coder');
    const thread = await core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'root-c1' } });
    await core.advanceHead({ threadId: thread.threadId, toSessionId: 'mid-c1', fromSessionId: 'root-c1', endKind: 'trim' });
    await core.advanceHead({ threadId: thread.threadId, toSessionId: 'head-c1', fromSessionId: 'mid-c1', endKind: 'summary' });

    const byRoot = await core.findThreadBySession('programming-helper', 'root-c1');
    const byMid = await core.findThreadBySession('programming-helper', 'mid-c1');
    const byHead = await core.findThreadBySession('programming-helper', 'head-c1');

    for (const found of [byRoot, byMid, byHead]) {
      assert.equal(found.threadId, thread.threadId, '成员查询命中同一线程');
      assert.equal(found.identity, 'coder', 'root / 历史成员 / head 身份归属一致');
    }
    assert.equal((await core.getThread(thread.threadId)).headSessionId, 'head-c1');

    // 非成员会话：查询返回 null（不属于该线程）
    assert.equal(await core.findThreadBySession('programming-helper', 'nobody'), null);
  });

  test('index summary carries the identity for member/head queries without runtime scan', async () => {
    const { identity, core } = makeControl();
    identity.register('root-c1', 'coder');
    await core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'root-c1' } });
    const summary = (await core.listThreads({ agentId: 'programming-helper' }))[0];
    assert.equal(summary.identity, 'coder');
  });
});

describe('T001: branch 建新 Thread 保持来源身份、不复用原 Thread', () => {
  test('branch from a historical session creates a new thread with the same identity', async () => {
    const { identity, core, integration } = makeControl();
    identity.register('root-c1', 'coder');
    identity.register('mid-c1', 'coder');
    identity.register('branch-c1', 'coder');
    const origin = await core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'root-c1' } });
    await core.advanceHead({ threadId: origin.threadId, toSessionId: 'mid-c1', fromSessionId: 'root-c1', endKind: 'trim' });

    // 从历史棒 mid-c1 branch：新会话 branch-c1 成为新线程的 root
    // （integration.onSessionCreated 即生产 branch 路径的接线点）
    const branched = await integration.onSessionCreated('programming-helper', { id: 'branch-c1', sessionType: 'coder', title: '（分支）' });
    assert.ok(branched);
    assert.notEqual(branched.threadId, origin.threadId, '不复用原 Thread');
    assert.equal(branched.identity, 'coder', '保持来源身份');
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
  test('legacy record without identity reads as null and never as main', async () => {
    const root = await makeTempRoot();
    try {
      const store = new ThreadStore({ rootDir: root });
      await fs.mkdir(path.join(root, 'threads'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'threads', 'wt-legacy-no-identity.json'),
        JSON.stringify({
          threadId: 'wt-legacy-no-identity',
          agentId: 'programming-helper',
          workspaceId: 'programming-helper',
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
      assert.equal(record.identity, null, '缺字段 = 身份未知，不静默 main');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('advanceHead on a legacy thread re-derives identity from the root session and backfills it', async () => {
    const { identity, core } = makeControl();
    identity.register('legacy-root', 'coder');
    identity.register('legacy-succ', 'coder');
    const thread = await core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'legacy-root' } });

    // 模拟旧记录：identity 字段被剥离
    await core.store.update(thread.threadId, (draft) => {
      delete draft.identity;
      return draft;
    });
    assert.equal((await core.getThread(thread.threadId)).identity, null);

    // 推进时从 root Session 事实回填（非默认值），head 正常推进
    const advanced = await core.advanceHead({ threadId: thread.threadId, toSessionId: 'legacy-succ', fromSessionId: 'legacy-root', endKind: 'trim' });
    assert.equal(advanced.headSessionId, 'legacy-succ');
    assert.equal(advanced.identity, 'coder', '身份从 root 事实回填');
  });

  test('advanceHead fails with thread_identity_missing when the root identity is also unknown', async () => {
    const { identity, core } = makeControl();
    // successor 属于宿主（通过工作空间校验），但线程身份未知且 root 身份
    // 也未登记 → 无从推导，明确失败而非静默放行
    identity.register('unknown-succ', 'coder');
    const thread = await core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'unknown-root' } });
    await core.store.update(thread.threadId, (draft) => {
      delete draft.identity;
      return draft;
    });

    await assert.rejects(
      () => core.advanceHead({ threadId: thread.threadId, toSessionId: 'unknown-succ', fromSessionId: 'unknown-root' }),
      (err) => err.code === 'thread_identity_missing' && err.status === 409,
    );
  });
});

describe('T001: 非 Thread Session 保持原 Session 语义', () => {
  test('pure-session lifecycle hooks are no-ops and unaffected by the identity gate', async () => {
    const { identity, core, integration } = makeControl();
    identity.register('free-c1', 'coder');

    // 未接入线程的会话：succession / 删除钩子 no-op（与线程身份无关）
    const noThread = await integration.applySessionSuccession({
      agentId: 'programming-helper',
      fromSessionId: 'free-c1',
      toSessionId: 'free-c2',
      reason: 'trim',
    });
    assert.equal(noThread.applied, false);
    assert.equal(noThread.reason, 'no_thread_for_session');

    const noDelete = await integration.onSessionDeleted('programming-helper', 'free-c1');
    assert.equal(noDelete.applied, false);
    assert.equal(noDelete.reason, 'no_thread_for_session');

    // 该会话没有任何线程成员关系
    assert.equal(await core.findThreadBySession('programming-helper', 'free-c1'), null);
  });

  test('main sessions of the host workspace stay threadless (identity is not the host gate)', async () => {
    const { integration } = makeControl();
    // 身份（main/coder）与线程宿主判定是正交事实：
    // main 会话不建线程——由 isThreadHostSession 决定，不是身份注册表。
    assert.equal(isThreadHostSession('programming-helper', 'main'), false);
    assert.equal(isThreadHostSession('programming-helper', 'coder'), true);
    const outcome = await integration.onSessionCreated('programming-helper', { id: 'main-free', sessionType: 'main' });
    assert.equal(outcome, null, 'main 会话不自动建线程（会话级宿主判定不变）');
  });
});

describe('T001: 无全局角色注册表（装配注入面）', () => {
  test('identitySource is injectable per assembly; default assembly resolves from session index', async () => {
    // 生产装配（无 identitySource 注入）使用 resolveSessionIdentity（session
    // index / 会话文件解析），构造不抛错、接线完整——身份事实不来自任何
    // 全局角色注册表。
    const root = await makeTempRoot();
    try {
      const control = createThreadControl({ rootDir: root });
      assert.equal(typeof control.core, 'object');
      assert.equal(typeof control.resolveSessionViewerId, 'function');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }

    // 注入 stub 的装配与生产装配各自独立解析身份，互不污染
    const a = makeControl();
    const b = makeControl();
    a.identity.register('same-id', 'coder');
    b.identity.register('same-id', 'main');
    const ta = await a.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'same-id' } });
    const tb = await b.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'same-id' } });
    assert.equal(ta.identity, 'coder');
    assert.equal(tb.identity, 'main');
  });
});
