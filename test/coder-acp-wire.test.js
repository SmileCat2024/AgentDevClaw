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
      assert.equal(init.result.agentCapabilities.promptCapabilities.image, false);
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
      // updates 都标对了 session
      for (const n of adapter.notifications) {
        assert.equal(n.params.sessionId, created.result.sessionId);
      }

      const prompt = await promptPromise;
      assert.equal(prompt.error, undefined);
      assert.equal(prompt.result.stopReason, 'end_turn');

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
      // 取消后不再有 session/update
      assert.equal(adapter.notifications.filter((n) => n.method === 'session/update').length, 0);
    } finally {
      await adapter.end();
    }
    assert.equal(adapter.exitCode, 0);
  });
});
