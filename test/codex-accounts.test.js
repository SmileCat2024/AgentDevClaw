/**
 * Codex 多账号账号簿（server/codex-accounts.js + routes/oauth-codex.js 账号端点）测试
 *
 * 覆盖的契约（每条对应一个伤害场景）：
 * - 懒合并：存量 'OpenAI Auth' 登录（token 文件存在、无 codex 段）无损呈现为
 *   "Codex 账号 1"，且仍是当前账号——升级后不丢可用性、不需要重新登录
 * - sanitize 归一：列表条目 'OpenAI Auth'（带空格）与 token 文件 OpenAI_Auth
 *   是同一槽位，合并视图不得出现重复行（重复行会让用户操作错行）
 * - 槽位名生成：不会生成与已有 token 文件同名的槽位（同名互相覆盖 token）
 * - activate：未登录槽位不得激活（否则全局静默切到无凭证账号）；激活落盘可回读
 * - 登出当前账号：active 自动回退到下一个有 token 的账号（不留全局无凭证态）
 * - 路由：activate 变更触发 refresh-credentials 广播（运行中会话换账号的唯一
 *   通道）；重复激活同一账号不广播；登出当前账号广播
 *
 * 数据隔离：AGENTDEV_DATA_DIR 指向临时目录，必须在任何 server 模块 import
 * 之前设置（constants 在模块加载期解析 USER_DATA_ROOT）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'path';

const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claw-codex-accounts-'));
process.env.AGENTDEV_DATA_DIR = DATA_DIR;
const TOKENS_DIR = path.join(DATA_DIR, 'oauth-tokens');
const CONNECTIONS_PATH = path.join(DATA_DIR, 'model-connections.json');

const express = (await import('express')).default;
const {
  listCodexAccounts,
  registerCodexAccount,
  generateCodexSlotName,
  activateCodexAccount,
  renameCodexAccount,
  removeCodexAccount,
  resolveActiveCodexProviderName,
} = await import('../server/codex-accounts.js');
const { setupOAuthCodexRoutes } = await import('../server/routes/oauth-codex.js');
const { managedAgents } = await import('../server/shared/agent-access.js');

// ── helpers ────────────────────────────────────────────────────────

function writeTokenFile(slotName, accessToken = 'fake-opaque-token') {
  mkdirSync(TOKENS_DIR, { recursive: true });
  const file = path.join(TOKENS_DIR, `${slotName}.json`);
  writeFileSync(file, JSON.stringify({ access_token: accessToken, refresh_token: 'rt', last_refresh: new Date().toISOString() }), 'utf8');
  return file;
}

function resetState() {
  rmSync(TOKENS_DIR, { recursive: true, force: true });
  rmSync(CONNECTIONS_PATH, { force: true });
}

function writeConnections(codexSection) {
  writeFileSync(CONNECTIONS_PATH, JSON.stringify({ ...(codexSection ? { codex: codexSection } : {}) }, null, 2), 'utf8');
}

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

function withFakeRuntimes(entries) {
  const added = [];
  for (const [key, runtime] of entries) {
    managedAgents.set(key, runtime);
    added.push(key);
  }
  return () => { for (const key of added) managedAgents.delete(key); };
}

async function withServer(handler) {
  const app = express();
  handler(app);
  const server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

// ── 账号簿纯函数 ───────────────────────────────────────────────────

describe('codex-accounts book', () => {
  before(() => resetState());
  after(() => resetState());

  it('presents the legacy OpenAI Auth token as account #1 and keeps it active', () => {
    // 存量场景：升级前只有 'OpenAI Auth' 登录（token 文件名 sanitize 为 OpenAI_Auth），
    // connections.json 无 codex 段
    writeTokenFile('OpenAI_Auth');
    const state = listCodexAccounts(CONNECTIONS_PATH);
    assert.equal(state.accounts.length, 1);
    assert.equal(state.accounts[0].displayName, 'Codex 账号 1');
    assert.equal(state.accounts[0].hasToken, true);
    assert.equal(state.activeProvider, 'OpenAI_Auth');
    assert.equal(resolveActiveCodexProviderName(CONNECTIONS_PATH), 'OpenAI_Auth');
  });

  it('deduplicates list entries against token files by sanitized slot key', () => {
    // 列表已有带空格的 'OpenAI Auth' 条目（手工编辑过的存量）+ 同一 token 文件：
    // 不得出现两行
    writeTokenFile('OpenAI_Auth');
    writeConnections({ accounts: [{ providerName: 'OpenAI Auth', displayName: '主号' }], activeProvider: 'OpenAI Auth' });
    const state = listCodexAccounts(CONNECTIONS_PATH);
    assert.equal(state.accounts.length, 1);
    assert.equal(state.accounts[0].displayName, '主号');
    assert.equal(state.activeProvider, 'OpenAI Auth');
  });

  it('keeps configured account order and appends orphan slots by name', () => {
    resetState();
    writeTokenFile('OpenAI_Auth');
    writeTokenFile('codex-account-2');
    writeConnections({ accounts: [{ providerName: 'codex-account-1', displayName: 'A' }], activeProvider: '' });
    const names = listCodexAccounts(CONNECTIONS_PATH).accounts.map((a) => a.providerName);
    // 列表条目（含无 token 的 codex-account-1）在前，孤儿按文件名排序追加
    assert.deepEqual(names, ['codex-account-1', 'OpenAI_Auth', 'codex-account-2']);
  });

  it('falls back to the first tokened account when the explicit active slot has no token', () => {
    resetState();
    writeTokenFile('OpenAI_Auth');
    writeConnections({ accounts: [
      { providerName: 'ghost-slot', displayName: '幽灵' },
      { providerName: 'OpenAI Auth', displayName: '主号' },
    ], activeProvider: 'ghost-slot' });
    const state = listCodexAccounts(CONNECTIONS_PATH);
    assert.equal(state.activeProvider, 'OpenAI Auth', 'active 指向无 token 槽位时必须回退，不得让全局留在无凭证态');
  });

  it('generates slot names that never collide with existing token files or list entries', () => {
    writeTokenFile('codex-account-1'); // 孤儿占用 1 号位
    const first = generateCodexSlotName(CONNECTIONS_PATH);
    assert.equal(first, 'codex-account-2');
    // 登记后再生成，继续避让
    registerCodexAccount(first, CONNECTIONS_PATH);
    assert.equal(generateCodexSlotName(CONNECTIONS_PATH), 'codex-account-3');
  });

  it('registers accounts idempotently and numbers default display names', () => {
    resetState();
    registerCodexAccount('codex-account-1', CONNECTIONS_PATH);
    registerCodexAccount('codex-account-1', CONNECTIONS_PATH); // 重登同一槽位不得重复登记
    registerCodexAccount('codex-account-2', CONNECTIONS_PATH);
    const state = listCodexAccounts(CONNECTIONS_PATH);
    assert.deepEqual(state.accounts.map((a) => a.displayName), ['Codex 账号 1', 'Codex 账号 2']);
  });

  it('refuses to activate a slot without a token', () => {
    resetState();
    writeTokenFile('OpenAI_Auth');
    const result = activateCodexAccount('ghost-slot', CONNECTIONS_PATH);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not_logged_in');
  });

  it('activates an account, persists the pointer, and reports the previous account', () => {
    resetState();
    writeTokenFile('OpenAI_Auth');
    writeTokenFile('codex-account-1');
    registerCodexAccount('OpenAI Auth', CONNECTIONS_PATH);
    registerCodexAccount('codex-account-1', CONNECTIONS_PATH);
    // 未显式设置 active：懒回退到第一个有 token 的账号
    assert.equal(resolveActiveCodexProviderName(CONNECTIONS_PATH), 'OpenAI Auth');
    const result = activateCodexAccount('codex-account-1', CONNECTIONS_PATH);
    assert.equal(result.ok, true);
    assert.equal(result.previous, 'OpenAI Auth');
    assert.equal(resolveActiveCodexProviderName(CONNECTIONS_PATH), 'codex-account-1');
    // 显式落盘后无 token 的 OpenAI_Auth 仍可作为 active 出现在列表（hasToken 保留真相）
    const state = listCodexAccounts(CONNECTIONS_PATH);
    assert.equal(state.accounts.find((a) => a.providerName === 'OpenAI Auth').hasToken, true);
  });

  it('renames an account and rejects blank names or unknown slots', () => {
    resetState();
    registerCodexAccount('codex-account-1', CONNECTIONS_PATH);
    assert.equal(renameCodexAccount('codex-account-1', '  工作号  ', CONNECTIONS_PATH).ok, true);
    assert.equal(listCodexAccounts(CONNECTIONS_PATH).accounts[0].displayName, '工作号');
    assert.equal(renameCodexAccount('codex-account-1', '   ', CONNECTIONS_PATH).ok, false);
    assert.equal(renameCodexAccount('no-such-slot', 'x', CONNECTIONS_PATH).error, 'not_found');
  });

  it('falls active back to the next tokened account after removing the active one', () => {
    resetState();
    writeTokenFile('OpenAI_Auth');
    writeTokenFile('codex-account-1');
    writeConnections({ accounts: [
      { providerName: 'OpenAI Auth', displayName: '主号' },
      { providerName: 'codex-account-1', displayName: '二号' },
    ], activeProvider: 'OpenAI Auth' });
    removeCodexAccount('OpenAI Auth', CONNECTIONS_PATH);
    assert.equal(resolveActiveCodexProviderName(CONNECTIONS_PATH), 'codex-account-1');

    // 移除最后一个账号并删除其 token（路由登出的完整序列：deleteTokens 先行）；
    // token 仍在时孤儿扫描会让账号继续可用，这是有意行为
    removeCodexAccount('codex-account-1', CONNECTIONS_PATH);
    rmSync(path.join(TOKENS_DIR, 'OpenAI_Auth.json'), { force: true });
    rmSync(path.join(TOKENS_DIR, 'codex-account-1.json'), { force: true });
    assert.equal(resolveActiveCodexProviderName(CONNECTIONS_PATH), null);
  });
});

// ── 路由：accounts 端点 + refresh-credentials 广播 ─────────────────

describe('codex accounts routes', () => {
  let server;
  let baseUrl;
  let child;
  let restoreRuntimes;

  before(async () => {
    ({ server, baseUrl } = await withServer((app) => {
      setupOAuthCodexRoutes(app, express);
    }));
    child = makeFakeChild();
    restoreRuntimes = withFakeRuntimes([
      ['programming-helper::sess-acc', { process: child, stopped: false, selectedSessionId: 'sess-acc' }],
    ]);
  });

  after(async () => {
    restoreRuntimes();
    await new Promise((resolve) => server.close(resolve));
    resetState();
  });

  const refreshCount = () => child.sent.filter((m) => m.type === 'refresh-credentials').length;

  it('GET accounts merges orphan token files into the account list with token status', async () => {
    resetState();
    writeTokenFile('OpenAI_Auth');
    const resp = await fetch(`${baseUrl}/protoclaw/oauth/codex/accounts`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.accounts.length, 1);
    assert.equal(data.accounts[0].providerName, 'OpenAI_Auth');
    assert.equal(data.accounts[0].displayName, 'Codex 账号 1');
    assert.equal(data.accounts[0].hasToken, true);
    assert.equal(data.accounts[0].active, true);
    assert.equal(data.accounts[0].status.loggedIn, true);
  });

  it('activate broadcasts refresh-credentials on change and stays silent when re-activating', async () => {
    resetState();
    writeTokenFile('OpenAI_Auth');
    writeTokenFile('codex-account-1');
    registerCodexAccount('OpenAI Auth', CONNECTIONS_PATH);
    registerCodexAccount('codex-account-1', CONNECTIONS_PATH);

    const before = refreshCount();
    const resp = await fetch(`${baseUrl}/protoclaw/oauth/codex/accounts/codex-account-1/activate`, { method: 'POST' });
    assert.equal(resp.status, 200);
    assert.equal(refreshCount(), before + 1, '切换当前账号必须广播，运行中会话才有机会换 token 来源');

    const resp2 = await fetch(`${baseUrl}/protoclaw/oauth/codex/accounts/codex-account-1/activate`, { method: 'POST' });
    assert.equal(resp2.status, 200);
    assert.equal(refreshCount(), before + 1, '重复激活同一账号不得打扰运行中会话');

    // active 落盘生效
    const list = await (await fetch(`${baseUrl}/protoclaw/oauth/codex/accounts`)).json();
    assert.equal(list.activeProvider, 'codex-account-1');
  });

  it('activate rejects a slot without a token with 409', async () => {
    const resp = await fetch(`${baseUrl}/protoclaw/oauth/codex/accounts/ghost-slot/activate`, { method: 'POST' });
    assert.equal(resp.status, 409);
    const data = await resp.json();
    assert.equal(data.error, 'not_logged_in');
  });

  it('logout of the active account deletes the token, removes the entry, and broadcasts the fallback', async () => {
    // 续上：active = codex-account-1，OpenAI_Auth 仍持有 token
    const before = refreshCount();
    const resp = await fetch(`${baseUrl}/protoclaw/oauth/codex/accounts/codex-account-1`, { method: 'DELETE' });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.activeProvider, 'OpenAI Auth', '登出当前账号后 active 回退到剩余账号（登记名与文件名 sanitize 等价）');
    assert.equal(refreshCount(), before + 1, '当前账号被登出必须广播回退');
    assert.equal(existsSync(path.join(TOKENS_DIR, 'codex-account-1.json')), false, 'token 文件必须删除');

    // 登出非当前账号：回退未变，不广播
    const before2 = refreshCount();
    const resp2 = await fetch(`${baseUrl}/protoclaw/oauth/codex/accounts/OpenAI_Auth`, { method: 'DELETE' });
    assert.equal(resp2.status, 200);
    assert.equal(refreshCount(), before2, '非当前账号登出不改变全局 token 来源，不广播');
  });

  it('rename persists through the route and rejects unknown slots', async () => {
    resetState();
    writeTokenFile('OpenAI_Auth');
    const ok = await fetch(`${baseUrl}/protoclaw/oauth/codex/accounts/OpenAI_Auth`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '工作号' }),
    });
    assert.equal(ok.status, 200);
    const list = await (await fetch(`${baseUrl}/protoclaw/oauth/codex/accounts`)).json();
    assert.equal(list.accounts[0].displayName, '工作号');

    const missing = await fetch(`${baseUrl}/protoclaw/oauth/codex/accounts/no-such`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'x' }),
    });
    assert.equal(missing.status, 404);
  });
});
