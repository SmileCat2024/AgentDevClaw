/**
 * T007 场景 1/2：coder root → compact / summary / trim → coder successor
 * 的会话级身份继承（sessionType 经 handoff 材料传到 successor Session）。
 *
 * 既有测试（thread-succession / thread-identity-membership）覆盖的是 Thread
 * 控制面的提交门禁与身份校验；本文件补的是会话侧缺口：
 * successor Session 本身必须继承 coder 身份——否则新 head 被装配为 main，
 * 正是 ADR-001 记录的事故形态（线程推进正确、运行时身份错误）。
 *
 * 三层证据：
 * 1. createCompactedResumeFromHandoff：handoff.sourceRecord.sessionType=coder
 *    → createPrebuiltSession 收到 sessionType='coder'（真实 handoff 文件 +
 *    全 stub deps，不经真实 runtime）。
 * 2. handoff 材料校验失败（handoff_invalid）时不创建任何 successor Session。
 * 3. 生产路由接线源码契约：compact_and_resume 的 detached / 同步两分支都经
 *    共享提交点；三条变换路径（compact / summary / trim+summary）共享同一
 *    successor 创建入口（T002 既有源码契约在此并入回归，避免三处漂移）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HANDOFF_SCHEMA_VERSION } from '@agentdevjs/core';

import { createSessionHandoffHelpers } from '../server/routes/session-handoff-helpers.js';

// ─── fixtures ────────────────────────────────────────────────────

function makeHandoffFile(root, { sessionType = 'coder', mode = 'trim-transcript' }) {
  const handoff = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    handoffId: 'hh-t007-1',
    sourceAgentId: 'programming-helper',
    sourceSessionId: 'src-sess-1',
    sourceRecord: { title: '修复登录', goal: 'G', sessionType },
    mode,
    createdAt: '2026-08-26T00:00:00.000Z',
  };
  const handoffPath = path.join(root, 'handoff.json');
  writeFileSync(handoffPath, JSON.stringify(handoff), 'utf8');
  return { handoff, handoffPath };
}

function makeDeps({ root, sessionType = 'coder' } = {}) {
  const calls = { create: [], start: [], ready: [] };
  const deps = {
    startManagedAgent: async (agent, sessionId) => {
      calls.start.push({ agentId: agent?.id, sessionId });
      return { status: 'starting' };
    },
    waitForManagedRuntimeReady: async (agentId, _timeoutMs, sessionId) => {
      calls.ready.push({ agentId, sessionId });
      return { id: `vw-${sessionId}` }; // READY 证据
    },
    resolvePrebuiltSessionOwner: async (sessionId) => (sessionId === 'src-sess-1' ? 'programming-helper' : null),
    requirePrebuiltSessionRecord: async () => ({ id: 'src-sess-1', sessionType }),
    summarizePrebuiltSession: async () => ({ exists: true }),
    requirePrebuiltAgentForRuntime: async () => ({ id: 'programming-helper', relativeDir: 'prebuilt-agents/official/programming-helper' }),
    createPrebuiltSession: async (agentId, options) => {
      calls.create.push({ agentId, options });
      return { id: 'succ-sess-1' };
    },
    readSessionSnapshotForContinuity: async () => null,
    setSessionHasSummary: async () => {},
  };
  const helpers = createSessionHandoffHelpers(deps);
  return { deps, calls, helpers };
}

let base;
before(() => { base = mkdtempSync(path.join(os.tmpdir(), 'claw-t007-identity-')); });
after(() => rmSync(base, { recursive: true, force: true }));

// ─── S1/S2: compact 与 summary 的 successor 继承 coder 身份 ─────

describe('T007 S1/S2: successor Session 继承 coder 身份（会话侧）', () => {
  it('compact：coder handoff 的 successor 以 sessionType=coder 创建', async () => {
    const root = path.join(base, 's1-compact');
    await fs.mkdir(root, { recursive: true });
    try {
      const { handoffPath } = makeHandoffFile(root, { sessionType: 'coder', mode: 'trim-transcript' });
      const { calls, helpers } = makeDeps({ root });

      await helpers.createCompactedResumeFromHandoff({
        preferredAgentId: 'programming-helper',
        handoffPath,
        startRuntime: true,
      });

      assert.equal(calls.create.length, 1, '恰好创建一个 successor');
      assert.equal(calls.create[0].agentId, 'programming-helper');
      // 核心断言：身份继承自 handoff 材料，不丢失、不落到 main 缺省
      assert.equal(calls.create[0].options.sessionType, 'coder');
      assert.equal(calls.create[0].options.sourceSessionId, 'src-sess-1');
      // runtime 挂载到 successor 且 READY 证据被消费
      assert.deepEqual(calls.start, [{ agentId: 'programming-helper', sessionId: 'succ-sess-1' }]);
      assert.deepEqual(calls.ready, [{ agentId: 'programming-helper', sessionId: 'succ-sess-1' }]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('summary/trim：sessionType 缺失的历史 handoff 不伪造身份（successor 走缺省路径）', async () => {
    const root = path.join(base, 's2-legacy');
    await fs.mkdir(root, { recursive: true });
    try {
      // 旧 handoff 材料没有 sourceRecord.sessionType（T001 前的历史包）：
      // 身份未知时 createPrebuiltSession 收 undefined，由会话创建侧按
      // 来源 Session 回读决定——绝不在此处猜测成 coder 或 main。
      const handoff = {
        schemaVersion: HANDOFF_SCHEMA_VERSION,
        handoffId: 'hh-t007-legacy',
        sourceAgentId: 'programming-helper',
        sourceSessionId: 'src-sess-1',
        sourceRecord: { title: '旧会话' },
        mode: 'trim-transcript',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      const handoffPath = path.join(root, 'handoff.json');
      writeFileSync(handoffPath, JSON.stringify(handoff), 'utf8');
      const { calls, helpers } = makeDeps({ root });

      await helpers.createCompactedResumeFromHandoff({
        preferredAgentId: 'programming-helper',
        handoffPath,
        startRuntime: false,
      });

      assert.equal(calls.create.length, 1);
      assert.equal(calls.create[0].options.sessionType, undefined, '缺失身份不伪造');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('handoff_invalid：材料损坏时不创建任何 successor（失败先于副作用）', async () => {
    const root = path.join(base, 's2-invalid');
    await fs.mkdir(root, { recursive: true });
    try {
      const badPath = path.join(root, 'bad.json');
      writeFileSync(badPath, JSON.stringify({ schemaVersion: 999 }), 'utf8');
      const { calls, helpers } = makeDeps({ root });

      await assert.rejects(
        helpers.createCompactedResumeFromHandoff({ preferredAgentId: 'programming-helper', handoffPath: badPath }),
        (err) => err.code === 'handoff_invalid' && err.statusCode === 400,
      );
      assert.equal(calls.create.length, 0, '无 successor 副作用');
      assert.equal(calls.start.length, 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// ─── 生产路由接线契约（compact / summary / trim 共享入口）────────

describe('T007 S1/S2: 生产路由与共享入口的接线契约', () => {
  let sessionRoutes;
  let handoffHelpers;
  let rotationSrc;

  before(async () => {
    sessionRoutes = await fs.readFile(new URL('../server/routes/session.js', import.meta.url), 'utf8');
    handoffHelpers = await fs.readFile(new URL('../server/routes/session-handoff-helpers.js', import.meta.url), 'utf8');
    rotationSrc = await fs.readFile(new URL('../server/thread-control/thread-rotation.js', import.meta.url), 'utf8');
  });

  it('compact_and_resume 两分支（detached + 同步）都经共享提交点与失败收敛', () => {
    const start = sessionRoutes.indexOf("app.post('/protoclaw/context_handoffs/compact_and_resume'");
    const end = sessionRoutes.indexOf("app.post('/protoclaw/prebuilt_sessions/activate'", start);
    assert.ok(start >= 0 && end > start, 'compact_and_resume 路由存在');
    const route = sessionRoutes.slice(start, end);
    assert.ok(route.split('commitSuccession({').length - 1 >= 2, 'detached 与同步分支都经 commitSuccession');
    assert.match(route, /successorReady:\s*result\?\.agent\s*!=\s*null/);
    assert.ok(route.split('beginSessionSuccession({').length - 1 >= 1, '接力开始写入交接挡板');
  });

  it('compact / summary / trim+summary 共享同一 successor 创建入口', () => {
    const current = handoffHelpers.indexOf('async function compactAndResumeCurrentSession');
    const provided = handoffHelpers.indexOf('async function compactAndResumeFromProvidedSummary');
    const tail = handoffHelpers.indexOf('async function exportProvidedSummaryHandoff');
    assert.ok(current > 0 && provided > current && tail > provided);
    // 两条路径都收敛到 createCompactedResumeFromHandoff（身份继承单一实现）
    assert.match(handoffHelpers.slice(current, provided), /return createCompactedResumeFromHandoff\(/);
    assert.match(handoffHelpers.slice(provided, tail), /return createCompactedResumeFromHandoff\(/);
  });

  it('context guard rotation 也消费共享提交点（三条路径不各自实现继承逻辑）', () => {
    assert.match(rotationSrc, /commitSuccession/);
    assert.match(rotationSrc, /successorReady:\s*result\?\.agent\s*!=\s*null/);
  });
});
