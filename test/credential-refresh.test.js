/**
 * 凭证变更 → refresh-credentials 广播（ADR-0028 修订）测试
 *
 * 覆盖：
 * - broadcastIPCToAllRuntimes：只投递存活 runtime，逐条盖 __targetSessionId
 * - PUT model_connections：OpenCode apiKey/tier 变更触发广播，未变更不触发
 * - PUT model_config：preset 连接字段 / defaultModel 凭证字段变更触发广播，
 *   非连接字段（档位等）变更不触发，新增 preset 不触发
 * - OAuth 登录完成（真实 runDeviceCodeLogin + mock fetch）经
 *   setCredentialChangeListener 接线广播到运行中 runtime
 *
 * 数据隔离：AGENTDEV_DATA_DIR 指向临时目录，必须在任何 server 模块 import
 * 之前设置（constants 在模块加载期解析 USER_DATA_ROOT）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claw-cred-refresh-'));
process.env.AGENTDEV_DATA_DIR = DATA_DIR;

const express = (await import('express')).default;
const { setupModelConfigRoutes, presetsConnectionChanged, defaultModelConnectionChanged } =
  await import('../server/routes/model-config.js');
const { setupOAuthCodexRoutes } = await import('../server/routes/oauth-codex.js');
const { broadcastIPCToAllRuntimes } = await import('../server/shared/ipc.js');
const { managedAgents } = await import('../server/shared/agent-access.js');
const {
  createLoginSession,
  runDeviceCodeLogin,
} = await import('../server/oauth-codex.js');

// ── helpers ────────────────────────────────────────────────────────

function makeFakeChild() {
  const emitter = new EventEmitter();
  return {
    emitter,
    exitCode: null,
    sent: [],
    send(payload) { this.sent.push(payload); return true; },
    on(event, listener) { emitter.on(event, listener); },
    removeListener(event, listener) { emitter.removeListener(event, listener); },
  };
}

function makeRuntime(child, selectedSessionId) {
  return { process: child, stopped: false, selectedSessionId };
}

/** 注册一对 fake runtime，返回收件箱（sent 列表）与清理句柄。 */
function withFakeRuntimes(entries) {
  const added = [];
  for (const [key, runtime] of entries) {
    managedAgents.set(key, runtime);
    added.push(key);
  }
  return () => { for (const key of added) managedAgents.delete(key); };
}

function credentialRefreshMessages(child) {
  return child.sent.filter((m) => m.type === 'refresh-credentials');
}

async function withServer(handler) {
  const app = express();
  handler(app);
  const server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

// ── broadcastIPCToAllRuntimes（纯 IPC 单测）─────────────────────────

describe('broadcastIPCToAllRuntimes', () => {
  it('delivers only to live runtimes with per-runtime session scoping', () => {
    const alive = makeFakeChild();
    const dead = makeFakeChild(); dead.exitCode = 1;
    const stoppedChild = makeFakeChild();
    const restore = withFakeRuntimes([
      ['a::s1', makeRuntime(alive, 's1')],
      ['a::s2', makeRuntime(dead, 's2')],
      ['b::s3', { process: stoppedChild, stopped: true, selectedSessionId: 's3' }],
    ]);
    try {
      const delivered = broadcastIPCToAllRuntimes({ type: 'refresh-credentials' });
      assert.equal(delivered, 1);
      assert.equal(alive.sent.length, 1);
      assert.equal(alive.sent[0].__targetSessionId, 's1');
      assert.equal(stoppedChild.sent.length, 0);
    } finally {
      restore();
    }
  });
});

// ── 连接签名 diff（纯函数）─────────────────────────────────────────

describe('connection-change diff helpers', () => {
  const basePreset = {
    name: 'glm', provider: 'openai', catalogProvider: '', baseUrl: 'https://x/v1',
    apiKey: 'sk-old', authType: '', clientId: '',
  };

  it('detects apiKey change on an existing preset', () => {
    assert.equal(presetsConnectionChanged(
      [basePreset],
      [{ ...basePreset, apiKey: 'sk-new' }],
    ), true);
  });

  it('ignores non-connection field changes and preset additions', () => {
    assert.equal(presetsConnectionChanged(
      [basePreset],
      [{ ...basePreset, thinkingEffort: 'high', starred: true }],
    ), false);
    assert.equal(presetsConnectionChanged(
      [basePreset],
      [basePreset, { ...basePreset, name: 'new-one', apiKey: 'sk-other' }],
    ), false);
  });

  it('defaultModel diff only reacts to credential fields and presence', () => {
    const dm = { provider: 'anthropic', baseUrl: 'https://y/v1', apiKey: 'k1' };
    assert.equal(defaultModelConnectionChanged(dm, { ...dm, apiKey: 'k2' }), true);
    assert.equal(defaultModelConnectionChanged(dm, { ...dm, thinkingEffort: 'low' }), false);
    assert.equal(defaultModelConnectionChanged(dm, null), false);
  });
});

// ── 路由触发（真实 express server + fetch）─────────────────────────

describe('credential-change broadcasts from save routes', () => {
  let server;
  let baseUrl;
  let runtimeChild;
  let restoreRuntimes;

  before(async () => {
    ({ server, baseUrl } = await withServer((app) => {
      setupModelConfigRoutes(app, express);
      setupOAuthCodexRoutes(app, express);
    }));
    runtimeChild = makeFakeChild();
    restoreRuntimes = withFakeRuntimes([
      ['programming-helper::sess-cred', makeRuntime(runtimeChild, 'sess-cred')],
    ]);
  });

  after(async () => {
    restoreRuntimes();
    await new Promise((resolve) => server.close(resolve));
  });

  it('PUT model_connections broadcasts when the OpenCode key changes', async () => {
    const before = credentialRefreshMessages(runtimeChild).length;
    const resp = await fetch(`${baseUrl}/protoclaw/model_connections`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opencode: { apiKey: 'oc-key-1', tier: 'zen' } }),
    });
    assert.equal(resp.status, 200);
    assert.equal(credentialRefreshMessages(runtimeChild).length, before + 1, 'apiKey first save must broadcast');

    // 同值重复保存不广播
    const resp2 = await fetch(`${baseUrl}/protoclaw/model_connections`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opencode: { apiKey: 'oc-key-1', tier: 'zen' } }),
    });
    assert.equal(resp2.status, 200);
    assert.equal(credentialRefreshMessages(runtimeChild).length, before + 1, 'same-key save must not broadcast');

    // tier 变更（baseUrl 连接字段）也广播
    const resp3 = await fetch(`${baseUrl}/protoclaw/model_connections`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opencode: { apiKey: 'oc-key-1', tier: 'go' } }),
    });
    assert.equal(resp3.status, 200);
    assert.equal(credentialRefreshMessages(runtimeChild).length, before + 2, 'tier change must broadcast');
  });

  it('PUT model_config broadcasts on preset apiKey change only', async () => {
    // 种子：一个带 key 的 preset + 一个内联 defaultModel
    writeFileSync(path.join(DATA_DIR, 'presets.json'), JSON.stringify({
      providers: [{ name: 'p1', apiKey: 'sk-old', endpoints: { openai: 'https://x/v1' } }],
      presets: [{ name: 'glm', providerName: 'p1', protocol: 'openai', model: 'glm-5' }],
    }), 'utf8');
    writeFileSync(path.join(DATA_DIR, 'default.json'), JSON.stringify({
      defaultModel: { model: 'm', provider: 'anthropic', baseUrl: 'https://y/v1', apiKey: 'dm-old' },
    }), 'utf8');

    const getPresetList = async () => (await (await fetch(`${baseUrl}/protoclaw/model_config`)).json()).presets;

    // 非连接字段变更（thinkingEffort）→ 不广播
    let presets = await getPresetList();
    const tuned = presets.map((p) => ({ ...p, thinkingEffort: 'high' }));
    const before = credentialRefreshMessages(runtimeChild).length;
    const resp = await fetch(`${baseUrl}/protoclaw/model_config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presets: tuned }),
    });
    assert.equal(resp.status, 200);
    assert.equal(credentialRefreshMessages(runtimeChild).length, before, 'non-connection change must not broadcast');

    // preset apiKey 变更 → 广播
    presets = await getPresetList();
    const rekeyed = presets.map((p) => ({ ...p, apiKey: 'sk-new-2' }));
    const resp2 = await fetch(`${baseUrl}/protoclaw/model_config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presets: rekeyed }),
    });
    assert.equal(resp2.status, 200);
    assert.equal(credentialRefreshMessages(runtimeChild).length, before + 1, 'preset apiKey change must broadcast');

    // defaultModel 凭证变更 → 广播
    const config = (await (await fetch(`${baseUrl}/protoclaw/model_config`)).json()).config;
    const resp3 = await fetch(`${baseUrl}/protoclaw/model_config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { ...config, defaultModel: { ...config.defaultModel, apiKey: 'dm-new' } } }),
    });
    assert.equal(resp3.status, 200);
    assert.equal(credentialRefreshMessages(runtimeChild).length, before + 2, 'defaultModel credential change must broadcast');
  });
});

// ── OAuth 登录完成 → 广播（真实 runDeviceCodeLogin + mock fetch）────

describe('oauth login completion triggers broadcast', () => {
  const originalFetch = globalThis.fetch;

  // 显式装配一次路由，使 setCredentialChangeListener 的接线真实发生
  //（幂等：重复注册只是覆盖为同一语义的监听）
  before(() => {
    const app = express();
    setupOAuthCodexRoutes(app, express);
  });

  after(() => { globalThis.fetch = originalFetch; });

  it('runDeviceCodeLogin notifies the registered listener end-to-end', async () => {
    const nowSec = () => Math.floor(Date.now() / 1000);
    const makeJwt = (payload) => `header.${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
    const makeResponse = ({ status = 200, body = {} }) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    globalThis.fetch = async (url) => {
      const s = String(url);
      if (s.includes('deviceauth/usercode')) {
        // interval 走 3 秒下限（requestDeviceCode: Math.max(3, ...)）——本用例
        // 因此恒有 ~3s 轮询等待，属设备码流的生产语义（同 oauth-codex.test.js
        // 已知慢类），不是被测行为本身的耗时
        return makeResponse({ body: { user_code: 'CRED-OK', device_auth_id: 'dae-cred', interval: 3 } });
      }
      if (s.includes('deviceauth/token')) {
        return makeResponse({ body: { authorization_code: 'cred-code', code_verifier: 'cred-verifier' } });
      }
      if (s.includes('/oauth/token')) {
        return makeResponse({ body: { access_token: makeJwt({ exp: nowSec() + 3600 }), refresh_token: 'cred-refresh' } });
      }
      return makeResponse({ status: 404, body: 'no mock' });
    };

    const providerName = '__test_cred_refresh_provider';
    const sessionId = createLoginSession(providerName, 'app_EMoamEEZ73f0CkXaXp7hrann');
    const child = makeFakeChild();
    const restore = withFakeRuntimes([[`a::cred-login`, makeRuntime(child, 'cred-login')]]);

    try {
      await runDeviceCodeLogin(sessionId, providerName, 'app_EMoamEEZ73f0CkXaXp7hrann');
      const msgs = credentialRefreshMessages(child);
      assert.equal(msgs.length, 1, 'login completion must broadcast refresh-credentials once');
      assert.equal(msgs[0].__targetSessionId, 'cred-login');
    } finally {
      restore();
      globalThis.fetch = originalFetch;
    }
  });
});

// ── 清理临时数据目录（最后一个 describe 之后统一执行）───────────────

process.on('exit', () => { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } });
