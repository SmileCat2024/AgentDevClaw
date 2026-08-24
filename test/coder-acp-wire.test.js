/**
 * Wire tests for scripts/run-coder-acp.js (ticket 019, design §12)
 *
 * Spawns the real adapter process and drives it over stdio like an ACP
 * client would (requests written one at a time, stdin kept open until the
 * responses arrive — stdin EOF means "connection closed" per SDK semantics).
 *
 * Asserts:
 * - every stdout line parses as JSON-RPC (no log frames mixed in)
 * - initialize / session/new / session/prompt round-trips against a local
 *   mock Claw HTTP server (no real model, no real Claw server)
 * - session/update notifications arrive (tool_call / tool_call_update /
 *   agent_message_chunk) before the PromptResponse end_turn
 * - diagnostics go to stderr
 * - cancel: session/cancel notification returns the in-flight prompt as
 *   cancelled immediately (no terminal event ever arrives), exactly one
 *   interrupt hits the 018 route
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── mock Claw HTTP server ──────────────────────────────────────────

function startMockClawServer() {
  /** @type {{requests: Array<{method: string, url: string, body: object|null}>}} */
  const record = { requests: [] };
  /** events 端点脚本：基线空 → tool 页 → 终态页；cancel 场景恒空 */
  let eventsMode = 'idle';
  let eventsCallCount = 0;
  const eventPages = {
    script: [
      { events: [], cursor: 0 },
      {
        events: [
          { type: 'item.started', item: { id: 'call_w1', turn: 1, type: 'tool_call', tool: 'bash', arguments: { command: 'pwd' }, status: 'in_progress' }, eventId: 'w-ev-1', receivedAt: 1 },
          { type: 'item.completed', item: { id: 'call_w1', turn: 1, type: 'tool_call', tool: 'bash', status: 'completed', result: 'D:/work' }, eventId: 'w-ev-2', receivedAt: 2 },
        ],
        cursor: 2,
      },
      {
        events: [
          { type: 'item.completed', item: { id: 'msg_w1', turn: 1, type: 'agent_message', text: 'all done' }, eventId: 'w-ev-3', receivedAt: 3 },
          { type: 'turn.completed', turn: 1, eventId: 'w-ev-4', receivedAt: 4 },
        ],
        cursor: 4,
      },
    ],
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      record.requests.push({ method: req.method, url: req.url, body });
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'POST' && req.url === '/protoclaw/acp/coder/sessions') {
        if (body?.agentId === 'coder' && typeof body?.cwd === 'string') {
          send(201, { ok: true, clawSessionId: 'claw-wire-1', threadId: 'thread-wire', viewerAgentId: 'vw-1', cwd: body.cwd });
        } else {
          send(400, { ok: false, code: 'invalid_params', message: 'bad session/new body' });
        }
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/protoclaw/acp/coder/sessions')) {
        send(200, {
          ok: true,
          threads: [
            { threadId: 'thread-wire', sessionId: 'claw-wire-1', cwd: 'D:/work', title: 'wire task', updatedAt: '2026-08-24T00:00:00.000Z' },
            { threadId: 'thread-wire-2', sessionId: 'claw-wire-2', cwd: 'D:/work2', title: null, updatedAt: null },
          ],
        });
        return;
      }
      if (req.method === 'POST' && /^\/protoclaw\/acp\/coder\/sessions\/[^/]+\/resume$/.test(req.url || '')) {
        if (body?.cwd && body.cwd !== 'D:/work') {
          send(403, { ok: false, code: 'cwd_mismatch', message: `session belongs to D:/work, not ${body.cwd}` });
          return;
        }
        // 成员会话 claw-wire-old → head claw-wire-1（线程视角解析）
        send(200, { ok: true, clawSessionId: 'claw-wire-1', threadId: 'thread-wire', viewerAgentId: 'vw-1', cwd: 'D:/work' });
        return;
      }
      if (req.method === 'POST' && req.url === '/protoclaw/threads/thread-wire/commands') {
        send(201, { ok: true, duplicate: false, delivery: { delivered: true } });
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/protoclaw/threads/thread-wire/events')) {
        if (eventsMode === 'script') {
          const page = eventPages.script[Math.min(eventsCallCount, eventPages.script.length - 1)];
          eventsCallCount += 1;
          send(200, { ok: true, ...page });
          return;
        }
        send(200, { ok: true, events: [], cursor: 0 });
        return;
      }
      if (req.method === 'POST' && req.url === '/protoclaw/acp/coder/sessions/claw-wire-1/interrupt') {
        send(200, { ok: true, clawSessionId: 'claw-wire-1', viewerAgentId: 'vw-1' });
        return;
      }
      if (req.method === 'POST' && req.url === '/protoclaw/threads/thread-wire/archive') {
        send(200, { ok: true, threadId: 'thread-wire', archivedAt: 1 });
        return;
      }
      send(404, { ok: false, code: 'not_found', message: req.url });
    });
  });

  return {
    record,
    startEventsScript: () => { eventsMode = 'script'; eventsCallCount = 0; },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ── adapter 进程驱动 ────────────────────────────────────────────────

class AdapterProcess {
  constructor(baseUrl) {
    this.child = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'run-coder-acp.js')], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLAW_ACP_BASE_URL: baseUrl,
        CLAW_ACP_POLL_INTERVAL_MS: '20',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = [];
    this.notifications = [];
    this.pending = new Map();
    this.parseFailures = [];
    this.stdoutRaw = '';
    this.stderrRaw = '';
    this.exitCode = null;

    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.stdoutRaw += chunk;
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          this.parseFailures.push(line);
          continue;
        }
        if (message.id !== undefined && this.pending.has(message.id)) {
          this.pending.get(message.id)(message);
          this.pending.delete(message.id);
        } else {
          this.notifications.push(message);
        }
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderrRaw += chunk; });
    this.child.on('exit', (code) => { this.exitCode = code; });
  }

  /** 发请求并等待对应 id 的响应（stdin 保持打开）。 */
  request(payload, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for id=${payload.id}`)), timeoutMs);
      this.pending.set(payload.id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  /** 发通知（无响应）。 */
  notify(payload) {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /** 等待某类 session/update 通知到达。 */
  waitForUpdate(predicate, timeoutMs = 8000) {
    const found = () => this.notifications.find(predicate);
    const existing = found();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for session/update')), timeoutMs);
      const poll = setInterval(() => {
        const hit = found();
        if (hit) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(hit);
        }
      }, 10);
    });
  }

  end() {
    return new Promise((resolve) => {
      if (this.exitCode !== null) return resolve();
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 3000);
      this.child.on('exit', () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
    });
  }

  kill() {
    if (this.exitCode === null) this.child.kill();
  }
}

// ── tests ──────────────────────────────────────────────────────────

describe('coder ACP adapter wire protocol', () => {
  let claw;
  let port;

  before(async () => {
    claw = startMockClawServer();
    port = await claw.listen();
  });

  after(async () => {
    await claw.close();
  });

  it('initialize → session/new → session/prompt with updates and end_turn', { timeout: 15_000 }, async () => {
    claw.startEventsScript();
    const adapter = new AdapterProcess(`http://127.0.0.1:${port}`);
    try {
      const init = await adapter.request({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      });
      assert.equal(init.error, undefined);
      assert.equal(init.result.agentCapabilities.loadSession, false);
      assert.deepEqual(init.result.agentCapabilities.sessionCapabilities.resume, {});
      assert.deepEqual(init.result.agentCapabilities.sessionCapabilities.list, {});
      assert.deepEqual(init.result.agentCapabilities.sessionCapabilities.close, {});
      assert.equal(init.result.agentCapabilities.promptCapabilities.image, false);
      assert.deepEqual(init.result.agentCapabilities.close, {});
      assert.equal(init.result.agentInfo.name, 'agentdevclaw-coder-acp');
      assert.equal(typeof init.result.agentInfo.version, 'string');

      const created = await adapter.request({
        jsonrpc: '2.0', id: 2, method: 'session/new',
        params: { cwd: 'D:/work', mcpServers: [] },
      });
      assert.equal(created.error, undefined);
      assert.equal(typeof created.result.sessionId, 'string');
      assert.ok(!('threadId' in created.result), 'threadId must not leak as a protocol identifier');

      const promptPromise = adapter.request({
        jsonrpc: '2.0', id: 3, method: 'session/prompt',
        params: { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'run something' }] },
      });

      await adapter.waitForUpdate((n) => n.method === 'session/update' && n.params?.update?.sessionUpdate === 'tool_call');
      await adapter.waitForUpdate((n) => n.method === 'session/update' && n.params?.update?.sessionUpdate === 'tool_call_update');
      const messageChunk = await adapter.waitForUpdate(
        (n) => n.method === 'session/update' && n.params?.update?.sessionUpdate === 'agent_message_chunk',
      );
      assert.equal(messageChunk.params.update.content.text, 'all done');
      // 用户消息回显在最前（codex-acp 风格）
      const echo = adapter.notifications[0];
      assert.equal(echo.params.update.sessionUpdate, 'user_message_chunk');
      assert.deepEqual(echo.params.update.content, { type: 'text', text: 'run something' });
      // updates 都标对了 session
      for (const n of adapter.notifications) {
        assert.equal(n.params.sessionId, created.result.sessionId);
      }

      const prompt = await promptPromise;
      assert.equal(prompt.error, undefined);
      assert.equal(prompt.result.stopReason, 'end_turn');

      // session/close：转发 Claw 归档 thread，响应 {}
      const closed = await adapter.request({
        jsonrpc: '2.0', id: 4, method: 'session/close',
        params: { sessionId: created.result.sessionId },
      });
      assert.equal(closed.error, undefined);
      assert.deepEqual(closed.result, {});
      const closeReq = claw.record.requests.find((r) => r.url === '/protoclaw/threads/thread-wire/archive');
      assert.ok(closeReq, 'archive request missing');

      // stdout 纯度：每行都是 JSON-RPC 帧（jsonrpc === '2.0'），无日志混入
      assert.deepEqual(adapter.parseFailures, []);
      const allFrames = adapter.stdoutRaw.trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(allFrames.every((f) => f.jsonrpc === '2.0'));
      // 诊断在 stderr
      assert.ok(adapter.stderrRaw.includes('coder ACP adapter started'), 'expected startup log on stderr');

      // Claw 侧收到了正确的 command 投递
      const command = claw.record.requests.find((r) => r.url === '/protoclaw/threads/thread-wire/commands');
      assert.ok(command, 'command request missing');
      assert.equal(command.body.kind, 'user_message');
      assert.equal(command.body.source, 'acp');
      assert.match(command.body.idempotencyKey, /^acp-[0-9a-f-]{36}$/);
      assert.equal(command.body.text, 'run something');
    } finally {
      await adapter.end();
    }
    assert.equal(adapter.exitCode, 0);
  });

  it('session/cancel returns cancelled immediately, exactly one interrupt', { timeout: 15_000 }, async () => {
    const adapter = new AdapterProcess(`http://127.0.0.1:${port}`);
    try {
      await adapter.request({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      });
      const created = await adapter.request({
        jsonrpc: '2.0', id: 2, method: 'session/new',
        params: { cwd: 'D:/work', mcpServers: [] },
      });

      const startedAt = Date.now();
      const promptPromise = adapter.request({
        jsonrpc: '2.0', id: 3, method: 'session/prompt',
        params: { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'long task' }] },
      });
      // 等 prompt 真正进入轮询（基线 + 投递完成）：观察 mock 收到 command
      await new Promise((resolve) => {
        const poll = setInterval(() => {
          if (claw.record.requests.some((r) => r.url === '/protoclaw/threads/thread-wire/commands' && r.body?.text === 'long task')) {
            clearInterval(poll);
            resolve();
          }
        }, 10);
      });

      adapter.notify({
        jsonrpc: '2.0', method: 'session/cancel',
        params: { sessionId: created.result.sessionId },
      });

      const prompt = await promptPromise;
      const waitedMs = Date.now() - startedAt;
      assert.equal(prompt.error, undefined);
      assert.equal(prompt.result.stopReason, 'cancelled');
      // cancel 早于 turn.started：立即返回，不等终态事件（mock 永远不发终态）
      assert.ok(waitedMs < 3000, `cancel took ${waitedMs}ms`);
      // 恰好一次 interrupt（018 路由）
      const interrupts = claw.record.requests.filter(
        (r) => r.url === '/protoclaw/acp/coder/sessions/claw-wire-1/interrupt',
      );
      assert.equal(interrupts.length, 1);
      // 取消后除用户消息回显外无其他 session/update
      const updates = adapter.notifications.filter((n) => n.method === 'session/update');
      assert.equal(updates.length, 1);
      assert.equal(updates[0].params.update.sessionUpdate, 'user_message_chunk');
    } finally {
      await adapter.end();
    }
    assert.equal(adapter.exitCode, 0);
  });

  it('session/list returns thread-view sessions; session/resume rebinds to the thread head and prompts land on it', { timeout: 15_000 }, async () => {
    const adapter = new AdapterProcess(`http://127.0.0.1:${port}`);
    try {
      await adapter.request({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      });

      // list：返回 server 线程视角 payload，sessionId 即持久 Claw sessionId
      const listed = await adapter.request({
        jsonrpc: '2.0', id: 2, method: 'session/list',
        params: {},
      });
      assert.equal(listed.error, undefined);
      assert.equal(listed.result.sessions.length, 2);
      assert.deepEqual(
        listed.result.sessions[0],
        {
          sessionId: 'claw-wire-1',
          cwd: 'D:/work',
          title: 'wire task',
          updatedAt: '2026-08-24T00:00:00.000Z',
          _meta: { claw: { threadId: 'thread-wire' } },
        },
      );
      // 无标题 / 无更新时间的条目省略可选字段
      assert.equal(listed.result.sessions[1].sessionId, 'claw-wire-2');
      assert.ok(!('title' in listed.result.sessions[1]));
      assert.ok(!('updatedAt' in listed.result.sessions[1]));

      // resume 成员旧会话 → 协议 ID 解析为线程 head 的持久 ID
      const resumed = await adapter.request({
        jsonrpc: '2.0', id: 3, method: 'session/resume',
        params: { sessionId: 'claw-wire-old', cwd: 'D:/work' },
      });
      assert.equal(resumed.error, undefined);
      assert.deepEqual(resumed.result, { sessionId: 'claw-wire-1' });

      // resume 后 prompt 直接落在解析出的 head 上：命令投递到 thread-wire
      const promptPromise = adapter.request({
        jsonrpc: '2.0', id: 4, method: 'session/prompt',
        params: { sessionId: resumed.result.sessionId, prompt: [{ type: 'text', text: 'continue after resume' }] },
      });
      await new Promise((resolve) => {
        const poll = setInterval(() => {
          if (claw.record.requests.some((r) => r.url === '/protoclaw/threads/thread-wire/commands' && r.body?.text === 'continue after resume')) {
            clearInterval(poll);
            resolve();
          }
        }, 10);
      });
      // 用户回显标的是 resume 返回的协议 ID
      const echo = await adapter.waitForUpdate((n) => n.method === 'session/update');
      assert.equal(echo.params.sessionId, 'claw-wire-1');

      // cancel 掉这个 prompt（mock 不产终态事件），避免用例悬挂
      adapter.notify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'claw-wire-1' } });
      const prompt = await promptPromise;
      assert.equal(prompt.error, undefined);
      assert.equal(prompt.result.stopReason, 'cancelled');

      // cwd 不一致 → -32003（server 403 cwd_mismatch 透传）
      const mismatch = await adapter.request({
        jsonrpc: '2.0', id: 5, method: 'session/resume',
        params: { sessionId: 'claw-wire-1', cwd: 'D:/elsewhere' },
      });
      assert.equal(mismatch.error.code, -32003);
      assert.equal(mismatch.error.data.server.code, 'cwd_mismatch');
    } finally {
      await adapter.end();
    }
    assert.equal(adapter.exitCode, 0);
  });
});
