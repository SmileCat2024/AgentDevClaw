/**
 * runtime-registration 路由契约（ADR-0037 决策 4）
 *
 * 被测承诺：
 *  - 机器通道（register / exited）无条件要求 internal bearer token，
 *    登录保护开关不参与判定（本测试 app 不挂全局 authMiddleware）。
 *  - register 接受声明并写入注册表（幂等 upsert）；viewerAgentId 占用
 *    运行中托管 runtime 或 prebuilt APP 身份时结构化拒绝（409）。
 *  - exited 移除注册记录（幂等）。
 *  - stop 只对已注册 runtime 受理，把停止指令转投 ViewerWorker
 *    POST /api/agents/:id/stop；viewer 报 404/409 时收敛注册记录并回 409。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { describe, it, before, after } from 'node:test';

// AGENTDEV_DATA_DIR 必须在任何 server 模块导入前设置：auth.js 在模块加载时
// 读数据根、生成并（现在）无条件持久化 serviceToken——不能落在真实用户目录。
process.env.AGENTDEV_DATA_DIR = await mkdtemp(join(tmpdir(), 'claw-reg-test-'));

const express = (await import('express')).default;
const { setupRuntimeRegistrationRoutes } = await import('../server/routes/runtime-registration.js');
const { getInternalAuthToken } = await import('../server/auth.js');
const {
  getExternalRuntime,
  listExternalRuntimes,
} = await import('../server/shared/external-runtime-registry.js');
const { managedAgents } = await import('../server/shared/agent-access.js');
const { issueManagedSpawnTicket } = await import('../server/shared/runtime-spawn-tickets.js');

const PREBUILT_IDS = ['programming-helper', 'coder'];
const MANAGED_KEY = 'spoofed-host::no-session';
const MANAGED_VIEWER_ID = 'vr-managed-1';

let app;
let server;
let baseUrl;
let token;
let authedHeaders;
let viewerStub;
let viewerPort;
let viewerStopStatus = 200;
let viewerStopCalls = [];

function post(path, body, headers = authedHeaders) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

before(async () => {
  viewerStub = createServer((req, res) => {
    viewerStopCalls.push({ method: req.method, url: req.url });
    if (req.method === 'POST' && /^\/api\/agents\/[^/]+\/stop$/.test(req.url)) {
      res.writeHead(viewerStopStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: viewerStopStatus === 200 }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => viewerStub.listen(0, '127.0.0.1', resolve));
  viewerPort = viewerStub.address().port;

  app = express();
  setupRuntimeRegistrationRoutes(app, express, {
    viewerOrigin: `http://127.0.0.1:${viewerPort}`,
    getPrebuiltAgentIds: async () => PREBUILT_IDS,
  });
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  token = getInternalAuthToken();
  authedHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
});

after(async () => {
  managedAgents.delete(MANAGED_KEY);
  // fetch 的 keep-alive 连接会让 close() 回调悬置；先强制断开再关监听。
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  viewerStub.closeAllConnections?.();
  await new Promise((resolve) => viewerStub.close(resolve));
  await rm(process.env.AGENTDEV_DATA_DIR, { recursive: true, force: true });
});

describe('runtime registration auth boundary', () => {
  it('rejects machine-channel calls without a token', async () => {
    const noToken = await post('/protoclaw/runtime/register',
      { viewerAgentId: 'vr-auth-1' }, { 'content-type': 'application/json' });
    assert.equal(noToken.status, 401);
    assert.equal((await noToken.json()).code, 'AUTH_REQUIRED');
    assert.equal(getExternalRuntime('vr-auth-1'), null);
  });

  it('rejects machine-channel calls with a wrong token', async () => {
    const wrong = await post('/protoclaw/runtime/exited',
      { viewerAgentId: 'vr-auth-2' },
      { authorization: 'Bearer not-the-token', 'content-type': 'application/json' });
    assert.equal(wrong.status, 401);
  });
});

describe('runtime registration identity rules', () => {
  it('accepts a declaration and stores it in the registry (idempotent upsert)', async () => {
    const first = await post('/protoclaw/runtime/register', {
      viewerAgentId: 'vr-ext-1',
      name: '外部实验 Agent',
      projectRoot: 'D:/code/some-project',
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, accepted: true, viewerAgentId: 'vr-ext-1' });

    const record = getExternalRuntime('vr-ext-1');
    assert.ok(record);
    assert.equal(record.name, '外部实验 Agent');
    assert.equal(record.projectRoot, 'D:/code/some-project');

    const second = await post('/protoclaw/runtime/register', { viewerAgentId: 'vr-ext-1' });
    assert.equal(second.status, 200);
    assert.equal(getExternalRuntime('vr-ext-1').name, '外部实验 Agent', 're-register keeps declared fields');
  });

  it('rejects a viewerAgentId reserved by a prebuilt agent', async () => {
    const response = await post('/protoclaw/runtime/register', { viewerAgentId: 'coder' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'VIEWER_AGENT_ID_CONFLICT');
    assert.equal(listExternalRuntimes().some((record) => record.viewerAgentId === 'coder'), false);
  });

  it('rejects a viewerAgentId claimed by a running managed runtime', async () => {
    managedAgents.set(MANAGED_KEY, { agentId: 'spoofed-host', viewerAgentId: MANAGED_VIEWER_ID });
    try {
      const response = await post('/protoclaw/runtime/register', { viewerAgentId: MANAGED_VIEWER_ID });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'VIEWER_AGENT_ID_CONFLICT');
    } finally {
      managedAgents.delete(MANAGED_KEY);
    }
  });

  it('rejects malformed viewerAgentId instead of rewriting it', async () => {
    for (const bad of ['', 'has space', 'a'.repeat(129), 'slash/id']) {
      const response = await post('/protoclaw/runtime/register', { viewerAgentId: bad });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.equal((await response.json()).code, 'INVALID_RUNTIME_IDENTITY');
    }
  });
});

describe('runtime exit reporting', () => {
  it('removes the registration record and stays idempotent', async () => {
    await post('/protoclaw/runtime/register', { viewerAgentId: 'vr-exit-1' });
    assert.ok(getExternalRuntime('vr-exit-1'));

    const exited = await post('/protoclaw/runtime/exited', { viewerAgentId: 'vr-exit-1' });
    assert.equal(exited.status, 200);
    assert.equal(getExternalRuntime('vr-exit-1'), null);

    const again = await post('/protoclaw/runtime/exited', { viewerAgentId: 'vr-exit-1' });
    assert.equal(again.status, 200);
  });
});

describe('external runtime stop channel', () => {
  it('forwards a stop request to the ViewerWorker for a registered runtime', async () => {
    await post('/protoclaw/runtime/register', { viewerAgentId: 'vr-stop-1' });
    viewerStopStatus = 200;
    viewerStopCalls = [];

    const response = await post('/protoclaw/external_runtime/stop', { runtimeId: 'vr-stop-1' });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.status, 'stop-requested');
    assert.equal(payload.viewerAgentId, 'vr-stop-1');
    assert.deepEqual(
      viewerStopCalls.map((call) => call.url),
      ['/api/agents/vr-stop-1/stop'],
      'stop must be forwarded to the viewer stop endpoint exactly once',
    );
    assert.ok(getExternalRuntime('vr-stop-1'), 'stop is a request; the record stays until exit report');
  });

  it('returns 409 and prunes the record when the viewer reports the runtime gone', async () => {
    await post('/protoclaw/runtime/register', { viewerAgentId: 'vr-stop-2' });
    viewerStopStatus = 409;
    viewerStopCalls = [];

    const response = await post('/protoclaw/external_runtime/stop', { runtimeId: 'vr-stop-2' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'runtime_not_accepting_input');
    assert.equal(getExternalRuntime('vr-stop-2'), null, 'stale record must be pruned');
    viewerStopStatus = 200;
  });

  it('returns 404 for an unregistered runtime', async () => {
    const response = await post('/protoclaw/external_runtime/stop', { runtimeId: 'vr-unknown-1' });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'RUNTIME_NOT_REGISTERED');
  });
});

describe('managed container identity handover (ticket path, ADR-0037 M6)', () => {
  it('accepts a valid ticket as managed handover: exempt from impersonation rules, no external record', async () => {
    const registered = [];
    const ticket = issueManagedSpawnTicket({
      agentId: 'coder',
      sessionId: 's-ticket-1',
      onRegister: (viewerAgentId) => registered.push(viewerAgentId),
    });
    // viewerAgentId 占用 prebuilt 保留名（无 ticket 时 409）——ticket 交接路径
    // 的承诺：归属由 ticket 证明，不受冒充规则约束，且不写外部注册表。
    const response = await post('/protoclaw/runtime/register', {
      viewerAgentId: 'coder',
      agentId: 'coder',
      sessionId: 's-ticket-1',
      ticket,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: true, viewerAgentId: 'coder' });
    assert.deepEqual(registered, ['coder'], 'onRegister receives the declared viewerAgentId');
    assert.equal(getExternalRuntime('coder'), null, 'managed handover must not create an external record');
  });

  it('rejects a mismatched ticket payload (agentId / sessionId must match issuance)', async () => {
    const ticket = issueManagedSpawnTicket({
      agentId: 'coder',
      sessionId: 's-ticket-2',
      onRegister: () => {},
    });
    const response = await post('/protoclaw/runtime/register', {
      viewerAgentId: 'agent-9-999',
      agentId: 'coder',
      sessionId: 's-other',
      ticket,
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'INVALID_RUNTIME_TICKET');
    assert.equal(getExternalRuntime('agent-9-999'), null);
  });

  it('consumes a ticket exactly once: replay is rejected', async () => {
    const ticket = issueManagedSpawnTicket({
      agentId: 'coder',
      sessionId: 's-ticket-3',
      onRegister: () => {},
    });
    const first = await post('/protoclaw/runtime/register', {
      viewerAgentId: 'agent-3-1', agentId: 'coder', sessionId: 's-ticket-3', ticket,
    });
    assert.equal(first.status, 200);
    const replay = await post('/protoclaw/runtime/register', {
      viewerAgentId: 'agent-3-1', agentId: 'coder', sessionId: 's-ticket-3', ticket,
    });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).code, 'INVALID_RUNTIME_TICKET');
  });

  it('forwards session-level exit reports to the container handle only', async () => {
    const events = [];
    const { EventEmitter } = await import('node:events');
    const containerHandle = new EventEmitter();
    containerHandle.emitHostEvent = (type, payload) => events.push({ type, payload });
    const localHandle = new EventEmitter(); // 本地 handle 无 emitHostEvent

    managedAgents.set('coder::s-fwd-1', { agentId: 'coder', viewerAgentId: 'vr-fwd-1', process: containerHandle });
    managedAgents.set('coder::s-fwd-2', { agentId: 'coder', viewerAgentId: 'vr-fwd-2', process: localHandle });
    try {
      const response = await post('/protoclaw/runtime/exited', {
        viewerAgentId: 'vr-fwd-1',
        sessionId: 's-fwd-1',
        persisted: true,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(events, [{ type: 'session-exited', payload: { sessionId: 's-fwd-1', persisted: true } }]);

      // 本地 handle（无 emitHostEvent）：不转发、不报错（幂等 exited 契约不变）
      const localResponse = await post('/protoclaw/runtime/exited', {
        viewerAgentId: 'vr-fwd-2',
        sessionId: 's-fwd-2',
        persisted: false,
      });
      assert.equal(localResponse.status, 200);
    } finally {
      managedAgents.delete('coder::s-fwd-1');
      managedAgents.delete('coder::s-fwd-2');
    }
  });
});
