/**
 * Tests for scripts/coder-acp/session-manager.js (+ protocol.js request
 * validation) — ticket 019, design §12.
 *
 * Covers:
 * - ID mapping established on session/new (Claw IDs stored, not exposed)
 * - serial constraint: second prompt while one is active → -32001 with generation
 * - prompt happy path: baseline capture → command → updates in order → end_turn
 *   （受理后先回显 user_message_chunk；turn.completed 携带 usage 时随
 *   PromptResponse 返回）
 * - turn.failed → end_turn + _meta.claw.terminalFailure（codex-acp 风格，
 *   不抛 JSON-RPC error）
 * - session/close：转发 Claw 归档（archive 路由）、幂等（404）、busy 拒绝
 * - 轮询 404（thread 已不存在）→ 结构化 CLAW_THREAD_LOST 诊断
 * - stale terminal replay is caught by eventId dedup → skipped, keep waiting
 * - cancel before turn.started → immediate cancelled, exactly one interrupt,
 *   no updates sent
 * - late events after cancel are dropped (no update, no further polls)
 * - $/cancel_request (ctx.signal) funnels into the same cancel state machine
 *   (both paths together → still exactly one interrupt)
 * - prompt timeout → -32002 with waitedMs, no auto interrupt
 * - server errors: creation failure → -32003, unreachable poll → -32000
 * - dispose clears memory only (no server calls)
 * - protocol.js validation: non-text block / mcpServers / additionalDirectories
 *
 * Uses node:test per project convention; mock claw client injected directly,
 * no real model, no real server.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionManager, buildSessionReplayNotifications } from '../scripts/coder-acp/session-manager.js';
import { createClawClient, ClawUnreachableError, ClawHttpError } from '../scripts/coder-acp/claw-client.js';
import {
  validateNewSessionParams,
  validateResumeSessionParams,
  validateLoadSessionParams,
  mergePromptText,
  ERROR_CODES,
} from '../scripts/coder-acp/protocol.js';

// ── mock claw client（脚本式：pages 逐页消费） ─────────────────────

function makeMockClawClient(overrides = {}) {
  const calls = { createSessions: [], commands: [], events: [], interrupts: [], archives: [] };
  const state = {
    sessionResponse: {
      ok: true,
      clawSessionId: 'claw-s1',
      threadId: 'thread-1',
      viewerAgentId: 'viewer-1',
      cwd: 'C:/work',
    },
    createError: null,
    commandError: null,
    eventsError: null,
    interruptError: null,
    closeError: null,
    /** 每次 getThreadEvents 弹出一页；耗尽后回落 defaultPage（空轮询） */
    pages: [],
    defaultPage: { events: [], cursor: 0 },
    ...overrides,
  };
  return {
    calls,
    state,
    async createCoderSession(cwd) {
      calls.createSessions.push(cwd);
      if (state.createError) throw state.createError;
      return state.sessionResponse;
    },
    async listCoderSessions(query = {}) {
      calls.lists = calls.lists || [];
      calls.lists.push(query);
      if (state.listError) throw state.listError;
      return {
        ok: true,
        threads: [
          { threadId: 'thread-1', sessionId: 'claw-s1', cwd: 'C:/work', title: 't', updatedAt: '2026-08-24T00:00:00.000Z' },
          { threadId: 'thread-2', sessionId: 'claw-s2', cwd: 'D:/other', title: null, updatedAt: null },
        ],
      };
    },
    async resumeCoderSession(clawSessionId, body = {}) {
      calls.resumes = calls.resumes || [];
      calls.resumes.push({ clawSessionId, body });
      if (state.resumeError) throw state.resumeError;
      if (state.resumeResponse) return state.resumeResponse;
      return {
        ok: true,
        clawSessionId: 'claw-s1',
        threadId: 'thread-1',
        viewerAgentId: 'viewer-1',
        cwd: body.cwd ?? 'C:/work',
      };
    },
    async getCoderSessionHistory(clawSessionId) {
      calls.histories = calls.histories || [];
      calls.histories.push(clawSessionId);
      if (state.historyError) throw state.historyError;
      return state.historyResponse || { ok: true, sessionId: clawSessionId, messages: [] };
    },
    async appendUserMessage(threadId, payload) {
      calls.commands.push({ threadId, payload });
      if (state.commandError) throw state.commandError;
      return { ok: true, delivery: { delivered: true } };
    },
    async getThreadEvents(threadId, after) {
      calls.events.push({ threadId, after });
      if (state.eventsError) throw state.eventsError;
      return state.pages.length > 0 ? state.pages.shift() : state.defaultPage;
    },
    async interruptSession(clawSessionId) {
      calls.interrupts.push(clawSessionId);
      if (state.interruptError) throw state.interruptError;
      return { ok: true, clawSessionId };
    },
    async archiveThread(threadId) {
      calls.archives.push(threadId);
      if (state.archiveError) throw state.archiveError;
      return { ok: true, threadId, archivedAt: 1 };
    },
  };
}

function makeManager(claw, config = {}) {
  const logs = [];
  return {
    logs,
    manager: createSessionManager({
      clawClient: claw,
      log: {
        info: () => {},
        warn: (m) => logs.push(m),
        error: (m) => logs.push(m),
      },
      pollIntervalMs: 5,
      promptTimeoutMs: 0, // 默认禁用，超时用例单独配置
      ...config,
    }),
  };
}

/** 事件页构造（018 响应形状：event + eventId/receivedAt）。 */
function page(events, cursor) {
  return {
    events: events.map((event, i) => ({ ...event, eventId: `ev-${cursor}-${i}`, receivedAt: 1 })),
    cursor,
  };
}

async function makeSession(claw, config) {
  const { manager } = makeManager(claw, config);
  const { sessionId } = await manager.createSession('C:/work');
  return { manager, sessionId };
}

describe('session mapping', () => {
  it('creates a session via the 018 atomic route and stores the mapping', async () => {
    const claw = makeMockClawClient();
    const { manager } = makeManager(claw);
    const { sessionId } = await manager.createSession('C:/work');
    assert.equal(typeof sessionId, 'string');
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(claw.calls.createSessions, ['C:/work']);

    const internal = manager.getSession(sessionId);
    assert.equal(internal.clawSessionId, 'claw-s1');
    assert.equal(internal.threadId, 'thread-1');
    assert.equal(internal.viewerAgentId, 'viewer-1');
  });

  it('maps creation HTTP failure to -32003 with the server error body', async () => {
    const claw = makeMockClawClient({
      createError: new ClawHttpError(400, { ok: false, code: 'invalid_cwd', message: 'cwd does not exist' }),
    });
    const { manager } = makeManager(claw);
    await assert.rejects(manager.createSession('C:/nope'), (error) => {
      assert.equal(error.code, ERROR_CODES.CLAW_ERROR);
      assert.equal(error.data.server.code, 'invalid_cwd');
      return true;
    });
  });

  it('maps creation network failure to -32000 with the start hint', async () => {
    const claw = makeMockClawClient({ createError: new ClawUnreachableError(new Error('ECONNREFUSED')) });
    const { manager } = makeManager(claw);
    await assert.rejects(manager.createSession('C:/work'), (error) => {
      assert.equal(error.code, ERROR_CODES.CLAW_SERVER_UNREACHABLE);
      assert.equal(error.data.hint, '先启动 Claw server（npm start）');
      return true;
    });
  });
});

describe('session resume + list', () => {
  it('resumeSession uses the request sessionId as the ACP session id (stable across restarts)', async () => {
    const claw = makeMockClawClient({
      resumeResponse: { ok: true, clawSessionId: 'claw-s1', threadId: 'thread-1', viewerAgentId: 'viewer-1', cwd: 'C:/work' },
    });
    const { manager } = makeManager(claw);
    const result = await manager.resumeSession('claw-s1', { cwd: 'C:/work' });

    // 协议 ID 即请求的 Claw sessionId（Q2 决策：零回填，跨重启可恢复）
    assert.deepEqual(result, { sessionId: 'claw-s1' });
    const internal = manager.getSession('claw-s1');
    assert.equal(internal.clawSessionId, 'claw-s1');
    assert.equal(internal.threadId, 'thread-1');
    assert.equal(internal.cwd, 'C:/work');
  });

  it('resume maps HTTP errors through the standard taxonomy', async () => {
    const claw = makeMockClawClient({
      resumeError: new ClawHttpError(409, { ok: false, code: 'thread_archived', message: 'archived' }),
    });
    const { manager } = makeManager(claw);
    await assert.rejects(manager.resumeSession('claw-x', {}), (error) => {
      assert.equal(error.code, ERROR_CODES.CLAW_ERROR);
      assert.equal(error.data.server.code, 'thread_archived');
      return true;
    });
  });

  it('resume on an already-mapped session refreshes the mapping instead of duplicating', async () => {
    const claw = makeMockClawClient();
    const { manager, sessionId } = await makeSession(claw);
    // createSession 生成的随机 UUID ≠ claw-s1；对同一 Claw 会话再次 resume
    await manager.resumeSession('claw-s1', {});
    assert.equal(manager.size, 2); // 两条独立映射并存（不同协议 ID）
    assert.ok(manager.getSession(sessionId));
    assert.ok(manager.getSession('claw-s1'));
  });

  it('listSessions passes the cwd filter through and returns the server payload', async () => {
    const claw = makeMockClawClient();
    const { manager } = makeManager(claw);
    const result = await manager.listSessions({ cwd: 'C:/work' });
    assert.deepEqual(claw.calls.lists, [{ cwd: 'C:/work' }]);
    assert.equal(result.threads.length, 2);
    assert.equal(result.threads[0].sessionId, 'claw-s1');
  });

  it('listSessions maps network failure to -32000', async () => {
    const claw = makeMockClawClient({ listError: new ClawUnreachableError(new Error('ECONNREFUSED')) });
    const { manager } = makeManager(claw);
    await assert.rejects(manager.listSessions(), (error) => {
      assert.equal(error.code, ERROR_CODES.CLAW_SERVER_UNREACHABLE);
      return true;
    });
  });
});

describe('session load (history replay)', () => {
  const projectedMessages = [
    { role: 'user', content: 'fix the bug' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read', arguments: { filePath: 'a.ts' } }],
    },
    { role: 'tool', toolCallId: 'call-1', content: 'file content here' },
    { role: 'assistant', content: 'done' },
    // 孤儿 tool 结果（无对应 tool_call）：跳过
    { role: 'tool', toolCallId: 'call-orphan', content: 'stale' },
  ];

  it('buildSessionReplayNotifications maps messages to ordered ACP notifications', () => {
    const notifications = buildSessionReplayNotifications(projectedMessages);
    assert.deepEqual(notifications, [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fix the bug' } },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'read {"filePath":"a.ts"}',
        kind: 'read',
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [{ type: 'text', text: 'file content here' }],
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
    ]);
  });

  it('maps well-known tool names onto ACP tool kinds', () => {
    const notifications = buildSessionReplayNotifications([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 't1', name: 'bash', arguments: { command: 'ls' } },
          { id: 't2', name: 'write', arguments: {} },
          { id: 't3', name: 'grep', arguments: {} },
          { id: 't4', name: 'web_search', arguments: {} },
          { id: 't5', name: 'lsp_hover', arguments: {} },
        ],
      },
    ]);
    const kinds = notifications.map((n) => n.kind).filter(Boolean);
    assert.deepEqual(kinds, ['execute', 'edit', 'search', 'fetch', 'other']);
  });

  it('loadSession resumes to head, replays head history via notify, and registers the head mapping', async () => {
    const claw = makeMockClawClient({
      resumeResponse: { ok: true, clawSessionId: 'claw-head', threadId: 'thread-1', viewerAgentId: 'viewer-1', cwd: 'C:/work' },
      historyResponse: { ok: true, sessionId: 'claw-head', messages: projectedMessages },
    });
    const { manager } = makeManager(claw);
    const sent = [];
    const result = await manager.loadSession('claw-old', { cwd: 'C:/work' }, (n) => sent.push(n));

    // 历史= head 的历史（与实际上下文一致，Q3 线程语义）
    assert.deepEqual(claw.calls.resumes, [{ clawSessionId: 'claw-old', body: { cwd: 'C:/work' } }]);
    assert.deepEqual(claw.calls.histories, ['claw-head']);
    // 回放通知带协议 sessionId（= head），顺序与转换器一致
    assert.equal(sent.length, 4);
    for (const n of sent) {
      assert.equal(n.method, 'session/update');
      assert.equal(n.params.sessionId, 'claw-head');
    }
    assert.equal(sent[0].params.update.sessionUpdate, 'user_message_chunk');
    // 映射登记在 head（协议 ID = head，与 resume 一致）
    assert.equal(manager.getSession('claw-head').clawSessionId, 'claw-head');
    assert.equal(manager.getSession('claw-head').threadId, 'thread-1');
    assert.deepEqual(result, { sessionId: 'claw-head' });
  });

  it('loadSession maps resume-phase server errors through the standard taxonomy', async () => {
    const claw = makeMockClawClient({
      resumeError: new ClawHttpError(403, { ok: false, code: 'cwd_mismatch', message: 'nope' }),
    });
    const { manager } = makeManager(claw);
    await assert.rejects(manager.loadSession('claw-x', {}, () => {}), (error) => {
      assert.equal(error.code, ERROR_CODES.CLAW_ERROR);
      assert.equal(error.data.server.code, 'cwd_mismatch');
      return true;
    });
  });

  it('loadSession maps history-phase network failure to CLAW_SERVER_UNREACHABLE', async () => {
    const claw = makeMockClawClient({
      historyError: new ClawUnreachableError(new Error('ECONNREFUSED')),
    });
    const { manager } = makeManager(claw);
    await assert.rejects(manager.loadSession('claw-x', {}, () => {}), (error) => {
      assert.equal(error.code, ERROR_CODES.CLAW_SERVER_UNREACHABLE);
      return true;
    });
  });
});

describe('prompt pipeline', () => {
  it('happy path: echo + updates in event order, then end_turn with usage; command carries source+idempotencyKey', async () => {
    const claw = makeMockClawClient({
      pages: [
        { events: [], cursor: 0 }, // 基线（空）
        page([
          { type: 'turn.started', turn: 1 },
          {
            type: 'item.started',
            item: { id: 'call_1', turn: 1, type: 'tool_call', tool: 'bash', arguments: { command: 'ls' }, status: 'in_progress' },
          },
          {
            type: 'item.completed',
            item: { id: 'call_1', turn: 1, type: 'tool_call', tool: 'bash', status: 'completed', result: 'ok' },
          },
        ], 4),
        page([
          { type: 'item.completed', item: { id: 'm1', turn: 1, type: 'agent_message', text: 'done' } },
          {
            type: 'turn.completed',
            turn: 1,
            usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, cacheReadTokens: 3, reasoningTokens: 2 },
          },
        ], 6),
      ],
    });
    const { manager, sessionId } = await makeSession(claw);
    const updates = [];
    const result = await manager.runPrompt(sessionId, 'do it', {
      onUpdate: (update) => updates.push(update),
    });
    assert.deepEqual(result, {
      stopReason: 'end_turn',
      usage: { totalTokens: 18, inputTokens: 11, outputTokens: 7, cachedReadTokens: 3, thoughtTokens: 2 },
    });
    // 回显在最前（codex-acp 风格：client 转录完整性依赖 agent 侧回显）
    assert.equal(updates.length, 4);
    assert.deepEqual(updates[0], { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'do it' } });
    assert.equal(updates[1].sessionUpdate, 'tool_call');
    assert.equal(updates[2].sessionUpdate, 'tool_call_update');
    assert.equal(updates[3].sessionUpdate, 'agent_message_chunk');

    assert.equal(claw.calls.commands.length, 1);
    assert.equal(claw.calls.commands[0].threadId, 'thread-1');
    // session-manager 只传文本与幂等键；kind/source 由 claw-client HTTP 层组装
    assert.deepEqual(
      { ...claw.calls.commands[0].payload, idempotencyKey: '<uuid>' },
      { text: 'do it', idempotencyKey: '<uuid>' },
    );
    assert.match(claw.calls.commands[0].payload.idempotencyKey, /^acp-[0-9a-f-]{36}$/);
  });

  it('0-based first turn (turn=0) on an empty baseline resolves end_turn', async () => {
    // runtime turn 号是 0-based（_callIndex）：turn=0 是合法首个终态。
    // 旧实现以 turn 号比较做 stale replay 防护，曾把 turn=0 误判为旧回放
    // 导致 prompt 永挂；现行判定只认 eventId，turn 号不参与。
    const claw = makeMockClawClient({
      pages: [
        { events: [], cursor: 0 }, // 基线（空）
        page([
          { type: 'item.completed', item: { id: 'm0', turn: 0, type: 'agent_message', text: 'hi back' } },
          { type: 'turn.completed', turn: 0 },
        ], 2),
      ],
    });
    const { manager, sessionId } = await makeSession(claw);
    const updates = [];
    const result = await manager.runPrompt(sessionId, 'hi', {
      onUpdate: (update) => updates.push(update),
    });
    assert.deepEqual(result, { stopReason: 'end_turn' });
    assert.equal(updates.length, 2);
    assert.equal(updates[0].sessionUpdate, 'user_message_chunk');
    assert.equal(updates[1].sessionUpdate, 'agent_message_chunk');
  });

  it('baseline capture precedes command delivery and seeds eventId dedup', async () => {
    const claw = makeMockClawClient({
      pages: [
        { events: [], cursor: 0 }, // 基线
        page([{ type: 'turn.completed', turn: 2 }], 3), // prompt 后第一轮：新终态
      ],
    });
    const { manager, sessionId } = await makeSession(claw);
    const result = await manager.runPrompt(sessionId, 'hi', { onUpdate: () => {} });
    assert.deepEqual(result, { stopReason: 'end_turn' });
    // 第一次 events 调用 = 基线（在 commands 之前），第二次 = 轮询
    assert.equal(claw.calls.events.length, 2);
    assert.ok(claw.calls.events[0].after === 0);
  });

  it('turn.failed → end_turn + _meta.claw.terminalFailure (codex-acp style, no JSON-RPC error)', async () => {
    const claw = makeMockClawClient({
      pages: [
        { events: [], cursor: 0 }, // 基线
        page([{ type: 'turn.failed', turn: 1, error: { message: 'boom', category: 'runtime' } }], 2),
      ],
    });
    const { manager, sessionId } = await makeSession(claw);
    const updates = [];
    const result = await manager.runPrompt(sessionId, 'hi', { onUpdate: (u) => updates.push(u) });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result._meta.claw.terminalFailure.message, 'boom');
    assert.deepEqual(result._meta.claw.terminalFailure.error, { message: 'boom', category: 'runtime' });
    assert.equal(result.usage, undefined); // 无 usage 数据时省略，不构造假值
    assert.equal(updates.length, 1); // 仅用户消息回显
    assert.equal(updates[0].sessionUpdate, 'user_message_chunk');
  });

  it('serial constraint: concurrent prompt → -32001 with the active generation', async () => {
    const claw = makeMockClawClient({ defaultPage: { events: [], cursor: 1 } });
    const { manager, sessionId } = await makeSession(claw);

    const first = manager.runPrompt(sessionId, 'first', { onUpdate: () => {} });
    // 等第一轮轮询真正开始（activePrompt 已登记）
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(manager.runPrompt(sessionId, 'second', { onUpdate: () => {} }), (error) => {
      assert.equal(error.code, ERROR_CODES.SESSION_BUSY);
      assert.equal(typeof error.data.generation, 'number');
      return true;
    });
    manager.cancel(sessionId);
    assert.deepEqual(await first, { stopReason: 'cancelled' });
  });

  it('unknown sessionId → -32602', async () => {
    const claw = makeMockClawClient();
    const { manager } = makeManager(claw);
    await assert.rejects(manager.runPrompt('nope', 'hi', { onUpdate: () => {} }), (error) => {
      assert.equal(error.code, ERROR_CODES.INVALID_PARAMS);
      assert.equal(error.data.field, 'sessionId');
      return true;
    });
  });
});

describe('stale terminal replay is caught by eventId dedup (design §9.3)', () => {
  it('baseline-known eventId replayed in the increment is skipped; waits for the real terminal', async () => {
    // board 落盘事件的 eventId 固定，旧事件重放必带基线已见的 eventId：
    // mapper 去重直接跳过，终态判定只认新 eventId 的事件。
    const staleEvent = { type: 'turn.completed', turn: 2, eventId: 'evt-old', receivedAt: 1 };
    const claw = makeMockClawClient({
      pages: [
        { events: [staleEvent], cursor: 1 }, // 基线含旧终态（eventId=evt-old）
        { events: [{ ...staleEvent }], cursor: 2 }, // 增量重现同 eventId
        page([{ type: 'turn.completed', turn: 3 }], 3), // 真终态（新 eventId）
      ],
    });
    const { manager } = makeManager(claw);
    const { sessionId } = await manager.createSession('C:/work');
    const updates = [];
    const result = await manager.runPrompt(sessionId, 'hi', { onUpdate: (u) => updates.push(u) });
    assert.deepEqual(result, { stopReason: 'end_turn' });
    // 旧终态重放被去重跳过：除用户消息回显外无任何 item/terminal update
    assert.equal(updates.length, 1);
    assert.equal(updates[0].sessionUpdate, 'user_message_chunk');
  });

  it('terminal with a turn number below a previous turn still resolves (turn numbers are not monotonic across runtimes)', async () => {
    // thread 接力后新 session 的 turn 号从 0 重新计数：新 eventId 的低 turn
    // 号终态是合法新终态，不得因 turn 号比较被丢弃（曾经的第二个永挂路径）。
    const claw = makeMockClawClient({
      pages: [
        page([{ type: 'turn.completed', turn: 5 }], 2), // 基线：接力前最后一轮 turn=5
        page([{ type: 'turn.completed', turn: 0 }], 3), // 接力后新 runtime 首轮 turn=0（新 eventId）
      ],
    });
    const { logs, manager } = makeManager(claw);
    const { sessionId } = await manager.createSession('C:/work');
    const result = await manager.runPrompt(sessionId, 'hi', { onUpdate: () => {} });
    assert.deepEqual(result, { stopReason: 'end_turn' });
    assert.ok(!logs.some((m) => String(m).includes('stale replay')), 'no stale-replay misjudgement expected');
  });
});

describe('cancel semantics (design §8)', () => {
  it('cancel before turn.started returns cancelled immediately, interrupts exactly once, sends only the echo', async () => {
    const claw = makeMockClawClient({ defaultPage: { events: [], cursor: 0 } });
    const { manager, sessionId } = await makeSession(claw);
    const updates = [];
    const promptPromise = manager.runPrompt(sessionId, 'long task', {
      onUpdate: (u) => updates.push(u),
    });
    await new Promise((r) => setTimeout(r, 20)); // 进入轮询循环
    manager.cancel(sessionId);
    assert.deepEqual(await promptPromise, { stopReason: 'cancelled' });
    assert.equal(claw.calls.interrupts.length, 1);
    assert.equal(claw.calls.interrupts[0], 'claw-s1');
    // 回显已发出（用户消息确实被受理），但无任何 item/terminal update
    assert.equal(updates.length, 1);
    assert.equal(updates[0].sessionUpdate, 'user_message_chunk');
  });

  it('late events after cancel are dropped: no updates, no further polls', async () => {
    const claw = makeMockClawClient({ defaultPage: { events: [], cursor: 0 } });
    const { manager, sessionId } = await makeSession(claw);
    const updates = [];
    const promptPromise = manager.runPrompt(sessionId, 'x', { onUpdate: (u) => updates.push(u) });
    await new Promise((r) => setTimeout(r, 20));
    manager.cancel(sessionId);
    await promptPromise;
    const pollsAtCancel = claw.calls.events.length;
    // 迟到事件进入后续页——不再被消费（该代 prompt 已返回）
    claw.state.pages.push(page([
      { type: 'item.completed', item: { id: 'late', turn: 1, type: 'agent_message', text: 'late' } },
    ], 5));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(claw.calls.events.length, pollsAtCancel);
    // 回显之外无迟到 update
    assert.equal(updates.length, 1);
    assert.equal(updates[0].sessionUpdate, 'user_message_chunk');
    assert.equal(claw.calls.interrupts.length, 1);
  });

  it('ctx.signal ($/cancel_request) funnels into the same state machine: exactly one interrupt across both paths', async () => {
    const claw = makeMockClawClient({ defaultPage: { events: [], cursor: 0 } });
    const { manager, sessionId } = await makeSession(claw);
    const controller = new AbortController();
    const promptPromise = manager.runPrompt(sessionId, 'x', {
      onUpdate: () => {},
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort(); // $/cancel_request 路径
    manager.cancel(sessionId); // session/cancel 通知路径（双层汇流）
    assert.deepEqual(await promptPromise, { stopReason: 'cancelled' });
    assert.equal(claw.calls.interrupts.length, 1);
  });

  it('cancel with no active prompt is a logged no-op (no interrupt)', async () => {
    const claw = makeMockClawClient();
    const { manager, sessionId } = await makeSession(claw);
    manager.cancel(sessionId);
    manager.cancel('unknown');
    assert.deepEqual(claw.calls.interrupts, []);
  });

  it('interrupt failure does not change the cancelled outcome', async () => {
    const claw = makeMockClawClient({
      defaultPage: { events: [], cursor: 0 },
      interruptError: new ClawHttpError(404, { ok: false, code: 'runtime_not_found' }),
    });
    const { manager, sessionId } = await makeSession(claw);
    const promptPromise = manager.runPrompt(sessionId, 'x', { onUpdate: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    manager.cancel(sessionId);
    assert.deepEqual(await promptPromise, { stopReason: 'cancelled' });
    await new Promise((r) => setTimeout(r, 10)); // 等 interrupt 的异步拒绝落到日志
  });
});

describe('prompt timeout (design §6 / Q25)', () => {
  it('times out with -32002 waitedMs and never interrupts', async () => {
    const claw = makeMockClawClient({ defaultPage: { events: [], cursor: 0 } });
    const { manager, sessionId } = await makeSession(claw, { promptTimeoutMs: 40 });
    await assert.rejects(manager.runPrompt(sessionId, 'x', { onUpdate: () => {} }), (error) => {
      assert.equal(error.code, ERROR_CODES.PROMPT_TIMEOUT);
      assert.ok(error.data.waitedMs >= 40);
      return true;
    });
    assert.deepEqual(claw.calls.interrupts, []);
  });
});

describe('poll failure mapping', () => {
  it('unreachable event poll → -32000', async () => {
    const claw = makeMockClawClient();
    const { manager, sessionId } = await makeSession(claw);
    claw.state.eventsError = new ClawUnreachableError(new Error('fetch failed'));
    await assert.rejects(manager.runPrompt(sessionId, 'x', { onUpdate: () => {} }), (error) => {
      assert.equal(error.code, ERROR_CODES.CLAW_SERVER_UNREACHABLE);
      return true;
    });
  });

  it('command delivery HTTP failure → -32003', async () => {
    const claw = makeMockClawClient({
      commandError: new ClawHttpError(500, { ok: false, code: 'internal_error', message: 'nope' }),
    });
    const { manager, sessionId } = await makeSession(claw);
    await assert.rejects(manager.runPrompt(sessionId, 'x', { onUpdate: () => {} }), (error) => {
      assert.equal(error.code, ERROR_CODES.CLAW_ERROR);
      return true;
    });
  });

  it('thread gone (poll 404) → structured CLAW_THREAD_LOST diagnostic', async () => {
    const claw = makeMockClawClient({ pages: [{ events: [], cursor: 0 }] });
    const { manager, sessionId } = await makeSession(claw);
    const promptPromise = manager.runPrompt(sessionId, 'x', { onUpdate: () => {} });
    await new Promise((r) => setTimeout(r, 10)); // 基线已完成，进入轮询
    claw.state.eventsError = new ClawHttpError(404, { ok: false, code: 'thread_not_found' });
    await assert.rejects(promptPromise, (error) => {
      assert.equal(error.code, ERROR_CODES.CLAW_ERROR);
      assert.equal(error.data.code, 'CLAW_THREAD_LOST');
      assert.equal(error.data.threadId, 'thread-1');
      assert.equal(error.data.lastKnownState, 'command_accepted');
      return true;
    });
  });
});

describe('session/close', () => {
  it('forwards thread archive to Claw, removes the mapping, returns {}', async () => {
    const claw = makeMockClawClient();
    const { manager, sessionId } = await makeSession(claw);
    assert.deepEqual(await manager.closeSession(sessionId), {});
    assert.deepEqual(claw.calls.archives, ['thread-1']);
    assert.equal(manager.getSession(sessionId), null);
    assert.equal(manager.size, 0);
  });

  it('unknown sessionId → -32602; busy session → -32001', async () => {
    const claw = makeMockClawClient();
    const { manager, sessionId } = await makeSession(claw);
    await assert.rejects(manager.closeSession('nope'), (error) => {
      assert.equal(error.code, ERROR_CODES.INVALID_PARAMS);
      assert.equal(error.data.field, 'sessionId');
      return true;
    });
    const first = manager.runPrompt(sessionId, 'x', { onUpdate: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(manager.closeSession(sessionId), (error) => {
      assert.equal(error.code, ERROR_CODES.SESSION_BUSY);
      return true;
    });
    manager.cancel(sessionId);
    assert.deepEqual(await first, { stopReason: 'cancelled' });
  });

  it('already-gone thread (404) is idempotent success', async () => {
    for (const archiveError of [
      new ClawHttpError(404, { ok: false, code: 'thread_not_found' }),
    ]) {
      const claw = makeMockClawClient({ archiveError });
      const { manager, sessionId } = await makeSession(claw);
      assert.deepEqual(await manager.closeSession(sessionId), {});
      assert.equal(manager.size, 0);
    }
  });

  it('other archive failures map to -32003 and keep the mapping', async () => {
    const claw = makeMockClawClient({
      archiveError: new ClawHttpError(500, { ok: false, code: 'internal_error', message: 'x' }),
    });
    const { manager, sessionId } = await makeSession(claw);
    await assert.rejects(manager.closeSession(sessionId), (error) => error.code === ERROR_CODES.CLAW_ERROR);
    assert.equal(manager.size, 1);
  });
});

describe('dispose (design §5 / Q12)', () => {
  it('clears the in-memory map only; no server calls', async () => {
    const claw = makeMockClawClient();
    const { manager } = makeManager(claw);
    const { sessionId } = await manager.createSession('C:/work');
    assert.equal(manager.size, 1);
    const callsBefore = {
      create: claw.calls.createSessions.length,
      commands: claw.calls.commands.length,
      events: claw.calls.events.length,
      interrupts: claw.calls.interrupts.length,
    };
    manager.dispose();
    assert.equal(manager.size, 0);
    assert.equal(manager.getSession(sessionId), null);
    assert.equal(claw.calls.createSessions.length, callsBefore.create);
    assert.equal(claw.calls.commands.length, callsBefore.commands);
    assert.equal(claw.calls.events.length, callsBefore.events);
    assert.equal(claw.calls.interrupts.length, callsBefore.interrupts);
  });
});

describe('claw-client request assembly (HTTP layer)', () => {
  it('appendUserMessage assembles kind/source; createCoderSession sends agentId=coder', async () => {
    const sent = [];
    const claw = createClawClient({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async (url, init) => {
        sent.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
        return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'content-type': 'application/json' } });
      },
    });
    await claw.createCoderSession('C:/work');
    await claw.appendUserMessage('thread-1', { text: 'hi', idempotencyKey: 'acp-x' });
    await claw.archiveThread('thread-1');

    assert.deepEqual(sent[0], {
      url: 'http://127.0.0.1:1/protoclaw/acp/coder/sessions',
      method: 'POST',
      body: { agentId: 'coder', cwd: 'C:/work' },
    });
    assert.deepEqual(sent[1], {
      url: 'http://127.0.0.1:1/protoclaw/threads/thread-1/commands',
      method: 'POST',
      body: { kind: 'user_message', text: 'hi', source: 'acp', idempotencyKey: 'acp-x' },
    });
    assert.deepEqual(sent[2], {
      url: 'http://127.0.0.1:1/protoclaw/threads/thread-1/archive',
      method: 'POST',
      body: null,
    });
  });
});

describe('protocol.js request validation', () => {
  it('validateNewSessionParams accepts minimal params and returns cwd', () => {
    assert.deepEqual(validateNewSessionParams({ cwd: 'C:/work', mcpServers: [] }), { cwd: 'C:/work' });
    assert.deepEqual(validateNewSessionParams({ cwd: 'C:/work' }), { cwd: 'C:/work' });
  });

  it('validateNewSessionParams rejects bad cwd / non-empty mcpServers / additionalDirectories', () => {
    assert.throws(() => validateNewSessionParams({}), (e) => e.code === ERROR_CODES.INVALID_PARAMS && e.data.field === 'cwd');
    assert.throws(() => validateNewSessionParams({ cwd: '' }), (e) => e.data.field === 'cwd');
    assert.throws(
      () => validateNewSessionParams({ cwd: 'C:/w', mcpServers: [{ name: 'x', command: 'y', args: [], env: {} }] }),
      (e) => e.data.field === 'mcpServers',
    );
    assert.throws(
      () => validateNewSessionParams({ cwd: 'C:/w', additionalDirectories: ['C:/other'] }),
      (e) => e.data.field === 'additionalDirectories',
    );
  });

  it('validateLoadSessionParams mirrors resume validation rules', () => {
    assert.deepEqual(validateLoadSessionParams({ sessionId: 'claw-s1' }), { sessionId: 'claw-s1' });
    assert.deepEqual(
      validateLoadSessionParams({ sessionId: 'claw-s1', cwd: 'C:/work', mcpServers: [] }),
      { sessionId: 'claw-s1', cwd: 'C:/work' },
    );
    assert.throws(() => validateLoadSessionParams({}), (e) => e.data.field === 'sessionId');
    assert.throws(() => validateLoadSessionParams({ sessionId: '' }), (e) => e.data.field === 'sessionId');
    assert.throws(() => validateLoadSessionParams({ sessionId: 's', cwd: 123 }), (e) => e.data.field === 'cwd');
    assert.throws(
      () => validateLoadSessionParams({ sessionId: 's', mcpServers: [{ name: 'x', command: 'y', args: [], env: {} }] }),
      (e) => e.data.field === 'mcpServers',
    );
    assert.throws(
      () => validateLoadSessionParams({ sessionId: 's', additionalDirectories: ['C:/other'] }),
      (e) => e.data.field === 'additionalDirectories',
    );
  });

  it('mergePromptText joins text blocks with blank lines and rejects non-text', () => {
    assert.equal(mergePromptText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\n\nb');
    assert.equal(mergePromptText([{ type: 'text', text: 'solo' }]), 'solo');
    assert.throws(() => mergePromptText([{ type: 'image', data: 'x', mimeType: 'image/png' }]), (e) => e.code === ERROR_CODES.INVALID_PARAMS);
    assert.throws(() => mergePromptText([{ type: 'resource_link', uri: 'x', name: 'y' }]), (e) => e.code === ERROR_CODES.INVALID_PARAMS);
    assert.throws(() => mergePromptText([]), (e) => e.code === ERROR_CODES.INVALID_PARAMS);
    assert.throws(() => mergePromptText([{ type: 'text' }]), (e) => e.code === ERROR_CODES.INVALID_PARAMS);
  });

  it('validateResumeSessionParams accepts minimal params, rejects bad sessionId / mcpServers / additionalDirectories', () => {
    // 最小合法：仅 sessionId
    assert.deepEqual(validateResumeSessionParams({ sessionId: 'claw-s1' }), { sessionId: 'claw-s1' });
    assert.deepEqual(
      validateResumeSessionParams({ sessionId: 'claw-s1', cwd: 'C:/work', mcpServers: [] }),
      { sessionId: 'claw-s1', cwd: 'C:/work' },
    );
    // sessionId 必填非空
    assert.throws(() => validateResumeSessionParams({}), (e) => e.data.field === 'sessionId');
    assert.throws(() => validateResumeSessionParams({ sessionId: '' }), (e) => e.data.field === 'sessionId');
    // cwd 若提供必须为字符串（存在性与一致性由 server 校验）
    assert.throws(() => validateResumeSessionParams({ sessionId: 's', cwd: 123 }), (e) => e.data.field === 'cwd');
    // MCP / additionalDirectories 沿用 session/new 的拒绝语义
    assert.throws(
      () => validateResumeSessionParams({ sessionId: 's', mcpServers: [{ name: 'x', command: 'y', args: [], env: {} }] }),
      (e) => e.data.field === 'mcpServers',
    );
    assert.throws(
      () => validateResumeSessionParams({ sessionId: 's', additionalDirectories: ['C:/other'] }),
      (e) => e.data.field === 'additionalDirectories',
    );
  });
});
