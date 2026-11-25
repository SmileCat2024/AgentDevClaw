/**
 * model_catalog / openai-auth 路由的「上游账号未登录」错误契约。
 *
 * 历史事故：这两条路由用 401 表达「Codex / OpenAI OAuth 账号未登录」，被前端
 * 全局 401 拦截器判成「访问保护会话过期」，打开 Codex 设置页误弹登录浮层。
 * 契约：这是服务端业务前置状态——用 400 + 结构化错误码表达；401 语义只留给
 * 调用方认证（认证层响应带 code:'AUTH_REQUIRED'）。本文件钉路由侧的回归。
 *
 * 数据隔离：AGENTDEV_DATA_DIR 指向空临时目录（无 presets、无 oauth-tokens），
 * 必须在任何 server 模块 import 之前设置（constants 在模块加载期解析）。
 */
import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claw-catalog-authcode-'));
process.env.AGENTDEV_DATA_DIR = DATA_DIR;

const express = (await import('express')).default;
const { setupModelConfigRoutes } = await import('../server/routes/model-config.js');

let server;
let baseUrl;

before(async () => {
  const app = express();
  setupModelConfigRoutes(app, express);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(DATA_DIR, { recursive: true, force: true });
});

it('model_catalog/codex 无已登录账号 → 400 + codex_account_required（不得用 401 冒充认证层）', async () => {
  const res = await fetch(`${baseUrl}/protoclaw/model_catalog/codex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.json();
  assert.equal(res.status, 400, `业务前置状态用 400，实际 ${res.status}（body=${JSON.stringify(body)}）`);
  assert.equal(body.code, 'codex_account_required');
  assert.ok(typeof body.error === 'string' && body.error.length > 0, '错误文案保留给前端目录区呈现');
});

it('openai-auth/models 无该账号 token → 400 + openai_account_required', async () => {
  const res = await fetch(`${baseUrl}/protoclaw/openai-auth/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerName: 'OpenAI Auth' }),
  });
  const body = await res.json();
  assert.equal(res.status, 400, `业务前置状态用 400，实际 ${res.status}（body=${JSON.stringify(body)}）`);
  assert.equal(body.code, 'openai_account_required');
});
