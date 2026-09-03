/**
 * R2-06 — git 路由族远程转发测试（ADR-0011 路由内命名空间分支套路）。
 *
 * 覆盖工单最低测试集：
 *   1. 转发形状：远程命名空间身份 → 隧道 origin + 远程同名路由
 *   2. dir 原样转发（远程机本地路径，远程端自己 validateDir/resolveGitRoot）
 *   3. 身份剥壳：agentId bareId 展开（remote:<connId>:<id> → <id>）
 *   4. 幂等闸：六个写端点远程分支无键 400（idempotency_key_required）且请求
 *      不过隧道；读端点（status/graph/branches/commit_files）不强制；
 *      幂等键 body / x-idempotency-key 头两形态等价
 *   5. 契约失败三分类：未知连接 target_not_found 404、停用连接
 *      transport_unavailable 503 retryable、网络层失败、远程错误响应原文透传
 *   6. 本地分支零网络：本地身份（含携带 agentId 的本地请求）走既有路径，
 *      请求体不被改写、不发起转发、写端点不要求幂等键
 *   7. 前端 git-panel（frontend-vm 沙箱）：请求体身份字段 / 远程 dir 来源 /
 *      写操作幂等键头 / capability write 门控降级禁写
 *
 * 测试不依赖真实远程服务器：fetch 全程 mock，连接表注入替身。
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import http from 'node:http';
import express from 'express';
import { promises as fs } from 'node:fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

import { setupGitRoutes } from '../server/routes/git.js';
import { setProxyConnectionLookup } from '../server/shared/proxy.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const CONNECTIONS = [
  { id: 'server-a', name: 'Server A', enabled: true, mode: 'manual', localPort: 22101 },
  { id: 'server-off', name: 'Server Off', enabled: false, mode: 'manual', localPort: 22102 },
];
const FIND_CONNECTION = (() => {
  const byId = new Map(CONNECTIONS.map((connection) => [connection.id, connection]));
  return (connectionId) => byId.get(connectionId) || null;
})();
const REMOTE_ORIGIN = 'http://127.0.0.1:22101';
const HOST_NS = 'remote:server-a:programming-helper';
const BARE_HOST = 'programming-helper';
const REMOTE_DIR = '/srv/projects/demo'; // 远程机本地路径，本地无此目录

// ── shared helpers（对齐 remote-write.test.js 的 mock 形态）──────────────

function mockFetch(handler) {
  const state = { calls: [], handler };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    state.calls.push({ url: String(url), init });
    const result = state.handler ? state.handler(String(url), init, state.calls.length) : { status: 200, body: '{}' };
    return {
      status: result.status,
      headers: new Headers(result.headers || { 'content-type': 'application/json; charset=utf-8' }),
      arrayBuffer: async () => Buffer.from(result.body ?? ''),
      json: async () => JSON.parse(result.body ?? 'null'),
    };
  };
  return {
    calls: state.calls,
    set handler(next) { state.handler = next; },
    restore() { globalThis.fetch = originalFetch; },
  };
}

// ═════════════════════════════════════════════════════════════════════════
// server：全部十个 git 端点共享同一远程分支套路
// ═════════════════════════════════════════════════════════════════════════

describe('git route remote namespace branches (R2-06)', () => {
  let server;
  let port;
  let fetchMock;

  before(async () => {
    const app = express();
    setupGitRoutes(app, express);
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    port = server.address().port;
    setProxyConnectionLookup(FIND_CONNECTION);
    fetchMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ok: true, source: 'remote' }) }));
  });

  after(() => {
    fetchMock.restore();
    setProxyConnectionLookup(null);
    server.close();
  });

  function request(method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: body ? { 'content-type': 'application/json', ...headers } : headers,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, body: JSON.parse(text || 'null') });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('test request timeout')));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // 端点清点（工单表：以 server/routes/git.js 实际注册为准，逐个接入）
  const READ_OPS = ['status', 'graph', 'branches', 'commit_files'];
  const WRITE_OPS = ['stage', 'unstage', 'commit', 'discard', 'branch', 'stash'];

  const baseBody = (extra = {}) => ({ dir: REMOTE_DIR, agentId: HOST_NS, ...extra });

  it('forwards read endpoints with the body as-is (dir untouched) and bare agentId', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => ({ status: 200, body: JSON.stringify({ ok: true, isRepo: true, root: REMOTE_DIR }) });
    const cases = [
      { op: 'status', body: { dir: REMOTE_DIR } },
      { op: 'graph', body: { dir: REMOTE_DIR, limit: 50, branch: 'main' } },
      { op: 'branches', body: { dir: REMOTE_DIR } },
      { op: 'commit_files', body: { dir: REMOTE_DIR, hash: 'abc123' } },
    ];
    for (const { op, body } of cases) {
      const res = await request('POST', `/protoclaw/git/${op}`, baseBody(body));
      assert.equal(res.status, 200, `POST /protoclaw/git/${op} status`);
      // 远程响应原文返回（本地不复刻 / 不改写远程响应形态）
      assert.deepEqual(res.body, { ok: true, isRepo: true, root: REMOTE_DIR });
      assert.equal(fetchMock.calls.at(-1).url, `${REMOTE_ORIGIN}/protoclaw/git/${op}`);
      const forwarded = JSON.parse(fetchMock.calls.at(-1).init.body);
      assert.equal(forwarded.dir, REMOTE_DIR, `POST /protoclaw/git/${op} dir byte-identical`);
      assert.equal(forwarded.agentId, BARE_HOST, `POST /protoclaw/git/${op} bare agentId`);
      assert.deepEqual(forwarded, { dir: REMOTE_DIR, agentId: BARE_HOST, ...body });
    }
    assert.equal(fetchMock.calls.length, READ_OPS.length);
    fetchMock.handler = null;
  });

  it('forwards write endpoints with the key present and the body verbatim apart from the bare id', async () => {
    for (const op of WRITE_OPS) {
      fetchMock.calls.length = 0;
      const body = baseBody({
        ...(op === 'commit' ? { message: 'msg' } : {}),
        ...(op === 'discard' ? { files: ['a.txt'] } : {}),
        ...(op === 'branch' ? { op: 'switch', name: 'main' } : {}),
        ...(op === 'stash' ? { op: 'save', message: 'wip' } : {}),
        idempotencyKey: `idem-${op}`,
      });
      const res = await request('POST', `/protoclaw/git/${op}`, body);
      assert.equal(res.status, 200, `POST /protoclaw/git/${op} forwarded`);
      assert.equal(fetchMock.calls.length, 1, `POST /protoclaw/git/${op} exactly one forward`);
      assert.equal(fetchMock.calls.at(-1).url, `${REMOTE_ORIGIN}/protoclaw/git/${op}`);
      const forwarded = JSON.parse(fetchMock.calls.at(-1).init.body);
      assert.equal(forwarded.dir, REMOTE_DIR, `POST /protoclaw/git/${op} dir byte-identical`);
      assert.equal(forwarded.agentId, BARE_HOST, `POST /protoclaw/git/${op} bare id`);
      assert.deepEqual(forwarded, { ...body, agentId: BARE_HOST });
    }
  });

  it('write endpoint without a key gets a local 400 and never crosses the tunnel', async () => {
    fetchMock.calls.length = 0;
    for (const op of WRITE_OPS) {
      const res = await request('POST', `/protoclaw/git/${op}`, { dir: REMOTE_DIR, agentId: HOST_NS });
      assert.equal(res.status, 400, `POST /protoclaw/git/${op} gated`);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, 'idempotency_key_required');
      assert.equal(res.body.retryable, false);
    }
    assert.equal(fetchMock.calls.length, 0, 'keyless writes must not cross the tunnel');
  });

  it('accepts the write idempotency key via body idempotencyKey or x-idempotency-key header', async () => {
    // body 键（既有 operationId 体系）与头形态（x-idempotency-key）等价，
    // 均读自 readOperationMetadata 的统一读取链
    for (const op of WRITE_OPS) {
      fetchMock.calls.length = 0;
      const viaBody = await request('POST', `/protoclaw/git/${op}`, baseBody({ idempotencyKey: `idem-${op}` }));
      assert.equal(viaBody.status, 200, `POST /protoclaw/git/${op} body key accepted`);
      assert.equal(fetchMock.calls.length, 1, `POST /protoclaw/git/${op} body key forwarded`);
      fetchMock.calls.length = 0;
      const viaHeader = await request('POST', `/protoclaw/git/${op}`, baseBody(), { 'x-idempotency-key': `idem-h-${op}` });
      assert.equal(viaHeader.status, 200, `POST /protoclaw/git/${op} header key accepted`);
      assert.equal(fetchMock.calls.length, 1, `POST /protoclaw/git/${op} header key forwarded`);
    }
  });

  it('read endpoints forward without an idempotency gate', async () => {
    fetchMock.calls.length = 0;
    for (const op of READ_OPS) {
      const res = await request('POST', `/protoclaw/git/${op}`, baseBody());
      assert.equal(res.status, 200, `POST /protoclaw/git/${op} forwarded without key`);
    }
    assert.equal(fetchMock.calls.length, READ_OPS.length);
  });

  it('returns the remote error response as-is for remote-side validation failures', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => ({ status: 400, body: JSON.stringify({ error: 'dir is not a directory' }) });
    const res = await request('POST', '/protoclaw/git/status', { dir: '/does/not/exist', agentId: HOST_NS });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'dir is not a directory', 'remote error body passthrough');
    fetchMock.handler = null;
  });

  it('maps unknown and disabled connections onto the operation contract', async () => {
    const r404 = await request('POST', '/protoclaw/git/status', { dir: REMOTE_DIR, agentId: 'remote:ghost:agent-9' });
    assert.equal(r404.status, 404);
    assert.equal(r404.body.ok, false);
    assert.equal(r404.body.code, 'target_not_found');

    const r503 = await request('POST', '/protoclaw/git/status', { dir: REMOTE_DIR, agentId: 'remote:server-off:agent-9' });
    assert.equal(r503.status, 503);
    assert.equal(r503.body.code, 'transport_unavailable');
    assert.equal(r503.body.retryable, true);
  });

  it('transport failure presents the three-class contract without leaking raw fetch errors', async () => {
    // server-a 在表中（origin 可解析），fetch 网络层失败 → transport_unavailable
    // （forwardProtoclawRoute 的既有契约，git 分支不重造错误码）
    fetchMock.calls.length = 0;
    fetchMock.handler = () => { throw new Error('ECONNREFUSED'); };
    const res = await request('POST', '/protoclaw/git/status', baseBody());
    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'transport_unavailable');
    assert.equal(res.body.retryable, true);
    fetchMock.handler = null;
  });

  it('keeps local branches byte-identical: zero network, no body rewrite, writes need no key', async () => {
    // 真实本地仓库走完整本地路径（status + stage 写端点无幂等键也放行）
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-git-local-'));
    const git = (cmd) => execSync(`git ${cmd}`, { cwd: dir }).toString();
    git('init -q');
    git('config user.email test@local');
    git('config user.name test');
    try {
      fetchMock.calls.length = 0;
      let res = await request('POST', '/protoclaw/git/status', { dir, agentId: BARE_HOST });
      assert.equal(res.status, 200);
      assert.equal(res.body.isRepo, true);
      assert.equal(res.body.root, path.resolve(dir));
      // 本地写端点不要求幂等键（闸只对远程分支生效）
      await fs.writeFile(path.join(dir, 'a.txt'), 'v1');
      res = await request('POST', '/protoclaw/git/stage', { dir, agentId: BARE_HOST });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      // 本地分支零网络、非远程身份不改写请求
      assert.equal(fetchMock.calls.length, 0, 'local requests must not hit the network');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// frontend git-panel 远程适配（frontend-vm 沙箱，不依赖真实远程服务器）
// ═════════════════════════════════════════════════════════════════════════

const okStatus = (dir) => ({
  ok: true, isRepo: true, root: dir,
  status: {
    current: 'main',
    // 一个暂存改动（staged 组）+ 一个工作区改动（changes 组，stage-all 入口）
    files: [
      { path: 'staged.txt', index: 'M', working_dir: ' ', from: null },
      { path: 'dirty.txt', index: ' ', working_dir: 'M', from: null },
    ],
    ahead: 0, behind: 0, tracking: 'origin/main',
  },
});
const okGraph = { ok: true, commits: [], aheadHashes: [] };
const okBranches = { ok: true, locals: [], remotes: [], current: 'main' };
const localRecord = { workspace_sessions: { sessions: [{ id: 'sess-1', openDirectory: '/repo' }] } };

function makePanelSandbox({ focusedAgentId = null, sessionId = 'sess-1', remoteMeta = '', capabilityFor = null } = {}) {
  const timers = new Set();
  const trackedSetTimeout = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const trackedSetInterval = (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; };
  const trackedClear = (t) => { clearTimeout(t); clearInterval(t); timers.delete(t); };
  const listeners = {};
  const featurePanelBody = {
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelector: () => null,
  };
  const calls = [];

  const ctx = createFrontendSandbox({
    fetch: async (url, init) => {
      const op = String(url).split('/').pop();
      calls.push({ url: String(url), init });
      const bodies = { status: okStatus('/repo'), graph: okGraph, branches: okBranches };
      return { ok: true, status: 200, json: async () => bodies[op] ?? { ok: true } };
    },
    AbortController,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClear,
    setInterval: trackedSetInterval,
    clearInterval: trackedClear,
    featurePanelBody,
    activeFeaturePanel: 'git',
    currentRuntimeAgentId: 'agent-1',
    focusedAgentId,
    getRuntimeWorkspaceSessionId: () => sessionId,
    getActiveWorkspaceSessionId: () => sessionId,
    getCurrentAgentRecord: () => localRecord,
    // 当前会话富元数据留档（远程 = agent_detail 经命名空间转发返回的路径）
    readCurrentSessionViewState: () => ({ sessionMeta: { openDirectory: remoteMeta } }),
    renderFeaturePanel: () => { ctx.__dom = ctx.window.GitPanel.render(); },
  });
  if (capabilityFor) {
    ctx.window.RemoteConnections = { capabilityFor };
  }
  ctx.__disposeTimers = () => { for (const t of timers) trackedClear(t); timers.clear(); };
  ctx.loadSource('public/src/modules/git-graph.js');
  ctx.loadSource('public/src/modules/git-panel.js');
  ctx.__calls = calls;
  // 事件委托驱动：模块在 featurePanelBody 上注册 click/mousedown/input/keydown
  ctx.__click = (action, file = '') => listeners.click?.({
    target: {
      closest: (sel) => (sel === '[data-gp-action]' ? { dataset: { gpAction: action, gpFile: file } } : null),
    },
    stopPropagation() {},
  });
  return ctx;
}

const tick = () => new Promise((r) => setTimeout(r, 40));
const opOf = (url) => String(url).split('/').pop();
const payloadOf = (init) => JSON.parse(init.body);

describe('git-panel remote adaptation (R2-06)', () => {
  it('local requests carry the plain host agentId; reads stay keyless', async () => {
    const ctx = makePanelSandbox({ focusedAgentId: 'programming-helper' });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      const statusCall = ctx.__calls.find((c) => opOf(c.url) === 'status');
      assert.ok(statusCall, 'status called');
      const body = payloadOf(statusCall.init);
      assert.equal(body.dir, '/repo', 'local dir unchanged');
      assert.equal(body.agentId, 'programming-helper', 'local identity carried as-is');
      assert.equal(statusCall.init.headers['x-idempotency-key'], undefined, 'reads carry no key');
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('remote session dir comes from sessionMeta (catalog-sourced remote path) with the namespaced identity', async () => {
    // 远程条目不在 allAgents（record 链落空），dir 取 agent_detail 经命名空间
    // 转发返回的富元数据留档；身份 = 宿主级命名空间 id
    const ctx = makePanelSandbox({
      focusedAgentId: HOST_NS,
      sessionId: '',
      remoteMeta: REMOTE_DIR,
    });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      const statusCall = ctx.__calls.find((c) => opOf(c.url) === 'status');
      assert.ok(statusCall, 'status called for remote dir');
      const body = payloadOf(statusCall.init);
      assert.equal(body.dir, REMOTE_DIR, 'dir is the remote machine path (catalog projectDir source)');
      assert.equal(body.agentId, HOST_NS, 'host-level namespace identity carried');
      assert.equal(ctx.__calls.length, 3, 'status/graph/branches all addressed remotely');
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('write ops carry an idempotency key header (local sessions included)', async () => {
    const ctx = makePanelSandbox({ focusedAgentId: 'programming-helper' });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      ctx.__calls.length = 0;
      // stage-all（写）经 featurePanelBody click 委托触发（与真实交互同链路）
      ctx.__click('stage-all');
      await tick(); await tick();
      const stageCalls = ctx.__calls.filter((c) => opOf(c.url) === 'stage');
      assert.ok(stageCalls.length >= 1, 'stage write issued');
      for (const call of stageCalls) {
        const key = call.init.headers['x-idempotency-key'];
        assert.equal(typeof key, 'string', 'write carries a key');
        assert.ok(key.length > 0, 'idempotency key present');
        assert.equal(payloadOf(call.init).agentId, 'programming-helper');
      }
      assert.ok(ctx.__calls.some((c) => opOf(c.url) === 'status'), 'loadAll follows the write');
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('capabilityFor write=false disables write controls and blocks the write before fetch', async () => {
    const ctx = makePanelSandbox({
      focusedAgentId: HOST_NS,
      sessionId: '',
      remoteMeta: REMOTE_DIR,
      capabilityFor: (agentId, action) => agentId === HOST_NS && action === 'write' ? false : true,
    });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      ctx.__calls.length = 0;
      ctx.__dom = ctx.window.GitPanel.render();
      // 读视图照常渲染（降级只禁写），无任何远程连接标识（面板不加远程徽标，
      // 呈现与本地会话同一套语言）
      assert.ok(ctx.__dom.includes('git-panel'), 'panel renders');
      // 写按钮禁用：stage-all / unstage-all / commit 与行内 stage / discard
      assert.ok(ctx.__dom.includes('data-gp-action="stage-all" disabled'), 'stage-all disabled');
      assert.ok(ctx.__dom.includes('data-gp-action="unstage-all" disabled'), 'unstage-all disabled');
      assert.ok(ctx.__dom.includes('data-gp-action="discard" data-gp-file="staged.txt" disabled'), 'per-file actions disabled');
      assert.ok(ctx.__dom.includes('data-gp-action="commit"') && ctx.__dom.includes('disabled'), 'commit disabled');
      // runAction 守卫兜底：委托层点击不产生写请求，显式错误呈现
      ctx.__click('stage-all');
      await tick(); await tick();
      assert.ok(!ctx.__calls.some((c) => opOf(c.url) === 'stage'), 'gated write never hits the endpoint');
      const gatedHtml = ctx.window.GitPanel.render();
      assert.ok(gatedHtml.includes('写能力'), 'capability guard error is visible');
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('write-capable remote sessions render identical to local (no remote marker) and forward writes', async () => {
    const ctx = makePanelSandbox({
      focusedAgentId: HOST_NS,
      sessionId: '',
      remoteMeta: REMOTE_DIR,
      capabilityFor: (agentId, action) => agentId === HOST_NS && action === 'write',
    });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      const html = ctx.window.GitPanel.render();
      // 写能力齐备：与本地一致（同一套控件语言，无禁用降级、无远程连接标识）
      assert.ok(html.includes('data-gp-action="stage-all"'), 'stage-all present');
      assert.ok(!html.includes('data-gp-action="stage-all" disabled'), 'not degraded with write capability');
      assert.ok(!html.includes('data-gp-action="discard" data-gp-file="staged.txt" disabled'), 'per-file actions enabled');
      assert.ok(!html.includes('data-gp-action="unstage-all" disabled'), 'unstage-all enabled');
      // 写操作经同一链路发出（dir=远程路径，身份=宿主级命名空间 id，幂等键头）
      ctx.__calls.length = 0;
      ctx.__click('stage-all');
      await tick(); await tick();
      const stageCall = ctx.__calls.find((c) => opOf(c.url) === 'stage');
      assert.ok(stageCall, 'stage forwarded');
      assert.equal(typeof stageCall.init.headers['x-idempotency-key'], 'string', 'write carries key');
      const body = payloadOf(stageCall.init);
      assert.equal(body.dir, REMOTE_DIR);
      assert.equal(body.agentId, HOST_NS);
    } finally {
      ctx.__disposeTimers();
    }
  });
});
