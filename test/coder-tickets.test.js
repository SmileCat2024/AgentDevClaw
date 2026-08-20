/**
 * coder 工单服务测试
 *
 * 覆盖：
 * - handleContextGuard：压缩阈值命中后的混合精简接力（trim + appendSummary）、
 *   succession 调用顺序、"继续"指令注入、旧 runtime 退役与持久化阻断标志清理
 * - handleContextGuard 失败路径：工单转 blocked + 同样退役旧 runtime
 * - start()：runtime 就绪后清理残留的守卫阻断标志
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCoderTicketService } from '../server/coder-tickets.js';

function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'claw-coder-tickets-test-'));
}

function ticketFile(root, ticketId) {
  return path.join(root, 'workspaces', 'coder', 'tickets', `${ticketId}.json`);
}

async function seedTicket(root, ticket) {
  await fs.mkdir(path.dirname(ticketFile(root, ticket.id)), { recursive: true });
  await fs.writeFile(ticketFile(root, ticket.id), JSON.stringify(ticket, null, 2), 'utf8');
}

function makeHarness(root, overrides = {}) {
  const calls = { order: [] };
  const sessionIndexes = new Map();

  const sessionApi = {
    updateSessionIndex: async (agentId, fn) => {
      const index = sessionIndexes.get(agentId) || { activeSessionId: null, sessions: [] };
      const next = fn(index);
      sessionIndexes.set(agentId, next);
      return next;
    },
    createPrebuiltSession: async () => ({ id: 'fresh-session' }),
    compactAndResumeCurrentSession: overrides.compactAndResumeCurrentSession
      || (async (args) => {
        calls.order.push(['compact', args]);
        return { session: { id: 'successor-session' } };
      }),
  };

  const harness = {
    calls,
    sessionIndexes,
    service: createCoderTicketService({
      rootDir: root,
      sessionApi,
      requireAgentLight: async () => ({ id: 'coder' }),
      startManagedAgent: async () => {
        calls.order.push(['start_runtime']);
        return {};
      },
      stopManagedAgent: async (agentId, sessionId) => {
        calls.order.push(['stop_runtime', agentId, sessionId]);
        return {};
      },
      waitForManagedRuntimeReady: async () => ({ ready: true }),
      getAgentRuntime: () => ({ ready: true, selectedSessionId: 'head-session' }),
      threadIntegration: {
        onSessionCreated: async () => ({ threadId: 'thread-1' }),
        beginSessionSuccession: async (args) => {
          calls.order.push(['begin_succession', args]);
          return { applied: true };
        },
        applySessionSuccession: async (args) => {
          calls.order.push(['apply_succession', args]);
          return { applied: true };
        },
        tryDeliver: async (threadId) => {
          calls.order.push(['deliver', threadId]);
          return { attempted: 1, delivered: 1 };
        },
      },
      threadController: {
        getThread: async () => ({
          threadId: 'thread-1',
          status: 'active',
          headSessionId: 'head-session',
        }),
        appendCommand: async (args) => {
          calls.order.push(['append_command', args]);
          return { id: 'cmd-1' };
        },
      },
      stat: async () => ({ isDirectory: () => true }),
      ...overrides.deps,
    }),
  };
  return harness;
}

const RUNNING_TICKET = {
  id: 'ticket-1',
  instruction: '给 calculator 项目补一个减法函数并测试',
  projectDir: '/tmp/calculator',
  completionPolicy: 'auto',
  status: 'running',
  threadId: 'thread-1',
  createdAt: 1,
  updatedAt: 1,
};

describe('handleContextGuard — 压缩阈值命中的混合精简接力', () => {
  test('success: trim-transcript + appendSummary 混合、succession 顺序、继续指令注入、旧 runtime 退役', async () => {
    const root = await makeTempRoot();
    try {
      await seedTicket(root, RUNNING_TICKET);
      const { service, calls } = makeHarness(root);
      const summary = await service.handleContextGuard('coder', 'head-session');

      assert.ok(summary, 'should return a ticket summary');
      assert.equal(summary.status, 'running');

      const kinds = calls.order.map((entry) => entry[0]);
      assert.deepEqual(kinds, [
        'begin_succession',
        'stop_runtime',
        'compact',
        'apply_succession',
        'append_command',
        'deliver',
      ], 'call order must be succession -> retire(flush) -> compact -> succession-apply -> inject -> deliver');

      const compactArgs = calls.order.find((entry) => entry[0] === 'compact')[1];
      assert.equal(compactArgs.appendSummary, true, 'rotation must request the trim+summary hybrid');
      assert.equal(compactArgs.policy.strategy, 'trim-transcript');
      assert.notEqual(compactArgs.policy.strategy, 'summarized-nine-section');
      assert.equal(compactArgs.sessionId, 'head-session');

      const beginArgs = calls.order.find((entry) => entry[0] === 'begin_succession')[1];
      assert.equal(beginArgs.reason, 'trim');
      const applyArgs = calls.order.find((entry) => entry[0] === 'apply_succession')[1];
      assert.equal(applyArgs.fromSessionId, 'head-session');
      assert.equal(applyArgs.toSessionId, 'successor-session');
      assert.equal(applyArgs.reason, 'trim');

      const stopArgs = calls.order.find((entry) => entry[0] === 'stop_runtime');
      assert.equal(stopArgs[2], 'head-session', 'pre-rotation runtime must be retired');

      const command = calls.order.find((entry) => entry[0] === 'append_command')[1];
      assert.equal(command.kind, 'system_continuation');
      assert.match(command.idempotencyKey, /ticket-context-rotation-ticket-1-successor-session/);
      assert.match(command.text, /继续处理这张工单/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('success: 持久化的守卫阻断标志被同步清除', async () => {
    const root = await makeTempRoot();
    try {
      await seedTicket(root, RUNNING_TICKET);
      const { service, sessionIndexes } = makeHarness(root);
      sessionIndexes.set('coder', {
        activeSessionId: null,
        sessions: [{ id: 'head-session', contextGuard: { blocked: true, reason: 'threshold' } }],
      });

      await service.handleContextGuard('coder', 'head-session');

      const record = sessionIndexes.get('coder').sessions.find((s) => s.id === 'head-session');
      assert.equal(record.contextGuard, null, 'persisted blocked flag must be cleared after rotation');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('failure: compact 抛错 → 工单转 blocked，旧 runtime 仍被退役、标志仍被清除', async () => {
    const root = await makeTempRoot();
    try {
      await seedTicket(root, RUNNING_TICKET);
      const { service, calls, sessionIndexes } = makeHarness(root, {
        compactAndResumeCurrentSession: async () => {
          calls.order.push(['compact']);
          throw new Error('mirror compaction timed out');
        },
      });
      sessionIndexes.set('coder', {
        activeSessionId: null,
        sessions: [{ id: 'head-session', contextGuard: { blocked: true } }],
      });

      const summary = await service.handleContextGuard('coder', 'head-session');

      assert.equal(summary.status, 'blocked');
      assert.match(summary.blockedReason, /上下文接力失败/);
      assert.match(summary.blockedReason, /mirror compaction timed out/);
      const kinds = calls.order.map((entry) => entry[0]);
      assert.ok(kinds.includes('stop_runtime'), 'wedged runtime must be retired on failure so resume() works');
      const record = sessionIndexes.get('coder').sessions.find((s) => s.id === 'head-session');
      assert.equal(record.contextGuard, null);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('no ticket bound to the session → null，不做任何动作', async () => {
    const root = await makeTempRoot();
    try {
      await seedTicket(root, RUNNING_TICKET);
      const { service, calls } = makeHarness(root);
      const result = await service.handleContextGuard('coder', 'other-session');
      assert.equal(result, null);
      assert.equal(calls.order.length, 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('非 coder agent → null', async () => {
    const root = await makeTempRoot();
    try {
      await seedTicket(root, RUNNING_TICKET);
      const { service } = makeHarness(root);
      assert.equal(await service.handleContextGuard('programming-helper', 'head-session'), null);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('start — runtime 换代后的残留标志清理', () => {
  test('start() 在 runtime 就绪后清除 head 会话残留的 blocked 标志', async () => {
    const root = await makeTempRoot();
    try {
      await seedTicket(root, RUNNING_TICKET);
      const { service, sessionIndexes } = makeHarness(root);
      sessionIndexes.set('coder', {
        activeSessionId: 'head-session',
        sessions: [{ id: 'head-session', contextGuard: { blocked: true, reason: 'stale after crash' } }],
      });

      const summary = await service.resume('ticket-1');

      assert.equal(summary.status, 'running');
      const record = sessionIndexes.get('coder').sessions.find((s) => s.id === 'head-session');
      assert.equal(record.contextGuard, null, 'stale persisted guard flag must be cleared after runtime restart');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
