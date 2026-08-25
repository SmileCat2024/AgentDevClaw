/**
 * T003 — 统一目标解析与 Session 兼容入口 验收测试（node:test 纯逻辑，不依赖真实 Runtime）
 *
 * 覆盖工单验收标准：
 * 1. 对 Thread 成员调用 archive/resume/delete，实际结果是 Thread 结果；
 * 2. 对独立 main Session 调用相同动作，行为不变（standalone session）；
 * 3. 对历史 Session 调用 compact/trim/summary，返回过期目标错误（stale_session，
 *    附 Thread ID 与当前 head），Thread 不变；
 * 4. 同一目标从任一入口得到一致的对象解析结果（共享纯逻辑，memberLookup 注入）；
 * 5. 响应保留原请求目标，不会让调用方误以为「Session 成功、Thread 未变化」。
 *
 * 另覆盖「失败与边界」：
 * - classifyTarget 对缺失目标 / 非成员返回 standalone，绝不默认任何线程归属；
 * - memberLookup 抛错 / 缺失时不阻断，降级为 standalone（不猜测归属）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTarget,
  resolveLifecycleTarget,
  resolveTransformationTarget,
  isBrowseOnlyMount,
} from '../server/thread-control/target-resolution.js';

/** 构造成员归属记录（对齐 WorkThreadRecord 的归属相关字段）。 */
function threadRecord({ threadId, sessionChain, headSessionId, status = 'open' }) {
  const sessions = Array.isArray(sessionChain)
    ? sessionChain.map((s) => (typeof s === 'string' ? s : s.sessionId))
    : [];
  return {
    threadId,
    headSessionId,
    status,
    rootSessionId: sessions[0] || null,
    sessionChain: Array.isArray(sessionChain)
      ? sessionChain.map((s) => (typeof s === 'string' ? { sessionId: s } : s))
      : [],
  };
}

/** 测试成员归属查找：sessionId → thread 记录的显式映射（hermetic）。 */
function makeMemberLookup() {
  const map = new Map();
  return {
    register(sessionId, thread) { map.set(sessionId, thread); },
    memberLookup: async (_agentId, sessionId) => map.get(sessionId) || null,
  };
}

describe('T003: classifyTarget 纯分类（无副作用）', () => {
  test('non-thread / missing target classifies as standalone session', () => {
    const cls = classifyTarget(null, 'main-1');
    assert.equal(cls.membership, 'standalone');
    assert.equal(cls.type, 'session');
    assert.equal(cls.threadId, null);
    assert.equal(cls.isHead, false);

    const missing = classifyTarget(null, '');
    assert.equal(missing.membership, 'standalone');
    assert.equal(missing.type, 'session');
  });

  test('thread head classifies as thread-head', () => {
    const thread = threadRecord({ threadId: 'wt-1', headSessionId: 'head-1', sessionChain: ['root-1', 'head-1'] });
    const cls = classifyTarget(thread, 'head-1');
    assert.equal(cls.membership, 'thread-head');
    assert.equal(cls.type, 'thread');
    assert.equal(cls.threadId, 'wt-1');
    assert.equal(cls.headSessionId, 'head-1');
    assert.equal(cls.isHead, true);
  });

  test('historical thread member classifies as thread-historical (never head)', () => {
    const thread = threadRecord({ threadId: 'wt-1', headSessionId: 'head-1', sessionChain: ['root-1', 'mid-1', 'head-1'] });
    for (const hist of ['root-1', 'mid-1']) {
      const cls = classifyTarget(thread, hist);
      assert.equal(cls.membership, 'thread-historical');
      assert.equal(cls.type, 'thread');
      assert.equal(cls.threadId, 'wt-1');
      assert.equal(cls.headSessionId, 'head-1', 'historical 目标附当前 head');
      assert.equal(cls.isHead, false);
    }
  });
});

describe('T003: 生命周期解析（archive/resume/delete 共享入口）', () => {
  test('thread member (head) resolves to its thread', async () => {
    const lookup = makeMemberLookup();
    const thread = threadRecord({ threadId: 'wt-1', headSessionId: 'head-1', sessionChain: ['head-1'] });
    lookup.register('head-1', thread);

    const target = await resolveLifecycleTarget({ agentId: 'ph', sessionId: 'head-1', memberLookup: lookup.memberLookup });
    assert.equal(target.ok, true);
    assert.equal(target.actual.type, 'thread');
    assert.equal(target.actual.id, 'wt-1');
    assert.equal(target.membership, 'thread-head');
    assert.deepEqual(target.request, { agentId: 'ph', sessionId: 'head-1' });
  });

  test('historical thread member resolves to the same thread (lifecycle is thread-scoped)', async () => {
    const lookup = makeMemberLookup();
    const thread = threadRecord({ threadId: 'wt-1', headSessionId: 'head-1', sessionChain: ['root-1', 'head-1'] });
    lookup.register('root-1', thread);

    const target = await resolveLifecycleTarget({ agentId: 'ph', sessionId: 'root-1', memberLookup: lookup.memberLookup });
    assert.equal(target.ok, true);
    assert.equal(target.actual.type, 'thread');
    assert.equal(target.actual.id, 'wt-1');
    assert.equal(target.membership, 'thread-historical');
    assert.equal(target.headSessionId, 'head-1');
  });

  test('standalone main session resolves to itself (behavior unchanged)', async () => {
    const lookup = makeMemberLookup();
    const target = await resolveLifecycleTarget({ agentId: 'ph', sessionId: 'main-1', memberLookup: lookup.memberLookup });
    assert.equal(target.ok, true);
    assert.equal(target.actual.type, 'session');
    assert.equal(target.actual.id, 'main-1');
    assert.equal(target.membership, 'standalone');
  });

  test('missing target fails with invalid_target, never guesses ownership', async () => {
    const lookup = makeMemberLookup();
    const target = await resolveLifecycleTarget({ agentId: '', sessionId: '', memberLookup: lookup.memberLookup });
    assert.equal(target.ok, false);
    assert.equal(target.code, 'invalid_target');
  });

  test('memberLookup throwing degrades to standalone (no guessed thread ownership)', async () => {
    const target = await resolveLifecycleTarget({
      agentId: 'ph',
      sessionId: 's-1',
      memberLookup: async () => { throw new Error('boom'); },
    });
    assert.equal(target.ok, true);
    assert.equal(target.actual.type, 'session');
    assert.equal(target.membership, 'standalone');
  });
});

describe('T003: 上下文变换解析（trim/summary/compact 只能作用于 head）', () => {
  test('head allows transformation', async () => {
    const lookup = makeMemberLookup();
    const thread = threadRecord({ threadId: 'wt-1', headSessionId: 'head-1', sessionChain: ['root-1', 'head-1'] });
    lookup.register('head-1', thread);

    const target = await resolveTransformationTarget({ agentId: 'ph', sessionId: 'head-1', memberLookup: lookup.memberLookup });
    assert.equal(target.ok, true);
    assert.equal(target.actual.type, 'thread');
    assert.equal(target.actual.id, 'wt-1');
  });

  test('historical session returns stale_session with thread id and current head; never heads it', async () => {
    const lookup = makeMemberLookup();
    const thread = threadRecord({ threadId: 'wt-1', headSessionId: 'head-1', sessionChain: ['root-1', 'mid-1', 'head-1'] });
    lookup.register('root-1', thread);
    lookup.register('mid-1', thread);

    for (const hist of ['root-1', 'mid-1']) {
      const target = await resolveTransformationTarget({ agentId: 'ph', sessionId: hist, memberLookup: lookup.memberLookup });
      assert.equal(target.ok, false);
      assert.equal(target.code, 'stale_session');
      assert.equal(target.actual.type, 'thread');
      assert.equal(target.actual.id, 'wt-1');
      assert.equal(target.threadId, 'wt-1');
      assert.equal(target.headSessionId, 'head-1', '附 Thread ID 与当前 head');
      assert.equal(target.membership, 'thread-historical');
      // 关键：不会让调用方误以为目标被改写成 head
      assert.notEqual(target.actual.id, 'head-1');
    }
  });

  test('standalone session keeps original session semantics', async () => {
    const lookup = makeMemberLookup();
    const target = await resolveTransformationTarget({ agentId: 'ph', sessionId: 'main-1', memberLookup: lookup.memberLookup });
    assert.equal(target.ok, true);
    assert.equal(target.actual.type, 'session');
    assert.equal(target.actual.id, 'main-1');
    assert.equal(target.membership, 'standalone');
  });

  test('missing target fails with invalid_target', async () => {
    const lookup = makeMemberLookup();
    const target = await resolveTransformationTarget({ agentId: '', sessionId: '', memberLookup: lookup.memberLookup });
    assert.equal(target.ok, false);
    assert.equal(target.code, 'invalid_target');
  });
});

describe('T003: 历史 Session activate 只允许浏览 / 挂载视角', () => {
  test('historical member is browse-only mount, head and standalone are not', () => {
    const head = classifyTarget(threadRecord({ threadId: 'wt-1', headSessionId: 'head-1', sessionChain: ['head-1'] }), 'head-1');
    const hist = classifyTarget(threadRecord({ threadId: 'wt-1', headSessionId: 'head-1', sessionChain: ['root-1', 'head-1'] }), 'root-1');
    const standalone = classifyTarget(null, 'main-1');

    assert.equal(isBrowseOnlyMount(hist), true);
    assert.equal(isBrowseOnlyMount(head), false);
    assert.equal(isBrowseOnlyMount(standalone), false);
  });
});
