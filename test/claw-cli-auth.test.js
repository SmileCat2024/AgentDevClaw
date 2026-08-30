/**
 * CLI / ACP 适配器内部令牌鉴权头测试（批次 9）。
 *
 * 覆盖两条对 Claw server 的出站通道的 Authorization 行为，全部 mock fetch，
 * 不依赖真实 server：
 *   1. bin/claw.mjs clawServerFetch — PROTOCLAW_INTERNAL_TOKEN 环境变量驱动；
 *      mock globalThis.fetch 验证请求头形状。
 *   2. scripts/coder-acp/claw-client.js — 环境变量 / auth.json fallback 两条
 *      令牌解析路径 + 匿名语义；auth.json 路径经 AGENTDEV_DATA_DIR 指向临时
 *      目录隔离，不读真实用户数据。
 */

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { clawServerFetch } from '../bin/claw.mjs';
import { createClawClient } from '../scripts/coder-acp/claw-client.js';

// ── scripts/coder-acp/claw-client.js（ACP 适配器唯一出站通道） ────

describe('coder-acp claw-client Authorization header', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'claw-cli-auth-test-'));
  const originalDataDir = process.env.AGENTDEV_DATA_DIR;
  const originalTokenEnv = process.env.PROTOCLAW_INTERNAL_TOKEN;

  after(() => {
    if (originalTokenEnv === undefined) delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    else process.env.PROTOCLAW_INTERNAL_TOKEN = originalTokenEnv;
    if (originalDataDir === undefined) delete process.env.AGENTDEV_DATA_DIR;
    else process.env.AGENTDEV_DATA_DIR = originalDataDir;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeRecordingClient() {
    const sent = [];
    const claw = createClawClient({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async (url, init) => {
        sent.push({ url: String(url), authorization: init?.headers?.Authorization });
        return new Response(JSON.stringify({ ok: true, threads: [] }), { status: 200 });
      },
    });
    return { claw, sent };
  }

  test('attaches Bearer header when token resolves from env var', async () => {
    delete process.env.AGENTDEV_DATA_DIR; // env token 生效，不读 auth.json
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'acp-env-token';
    try {
      const { claw, sent } = makeRecordingClient();
      await claw.listCoderSessions();
      assert.equal(sent[0].authorization, 'Bearer acp-env-token');
    } finally {
      delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    }
  });

  test('falls back to auth.json serviceToken when env var is unset', async () => {
    const dataDir = join(tempRoot, 'with-auth');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'auth.json'), JSON.stringify({ serviceToken: 'file-token' }));
    process.env.AGENTDEV_DATA_DIR = dataDir;
    try {
      const { claw, sent } = makeRecordingClient();
      await claw.listCoderSessions();
      assert.equal(sent[0].authorization, 'Bearer file-token');
    } finally {
      delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    }
  });

  test('anonymous semantics: no Authorization header when no token anywhere', async () => {
    const dataDir = join(tempRoot, 'empty');
    process.env.AGENTDEV_DATA_DIR = dataDir; // 目录不存在 → readFileSync 抛错 → 无令牌
    try {
      const { claw, sent } = makeRecordingClient();
      await claw.listCoderSessions();
      assert.equal(sent[0].authorization, undefined);
    } finally {
      delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    }
  });

  test('explicit internalToken option takes precedence over env var', async () => {
    const sent = [];
    const claw = createClawClient({
      baseUrl: 'http://127.0.0.1:1',
      internalToken: 'explicit-option-token',
      fetchImpl: async (url, init) => {
        sent.push({ authorization: init?.headers?.Authorization ?? null });
        return new Response(JSON.stringify({ ok: true, threads: [] }), { status: 200 });
      },
    });
    await claw.listCoderSessions();
    assert.equal(sent[0].authorization, 'Bearer explicit-option-token');
  });
});

// ── bin/claw.mjs clawServerFetch（环境变量驱动，进程内单测） ──────

describe('clawServerFetch Authorization header', () => {
  const originalToken = process.env.PROTOCLAW_INTERNAL_TOKEN;
  const sent = [];

  // clawServerFetch 经全局 fetch 出站；mock.globalThis 隔离网络面
  before(() => {
    mock.method(globalThis, 'fetch', async (url, init) => {
      sent.push({ url: String(url), authorization: init?.headers?.Authorization ?? null });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  after(() => {
    mock.restoreAll();
    if (originalToken === undefined) delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    else process.env.PROTOCLAW_INTERNAL_TOKEN = originalToken;
  });

  test('attaches Bearer header when PROTOCLAW_INTERNAL_TOKEN is set', async () => {
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'cli-internal-token';
    sent.length = 0;
    await clawServerFetch('/protoclaw/threads');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].url.startsWith('http://127.0.0.1:'));
    assert.ok(sent[0].url.endsWith('/protoclaw/threads'));
    assert.equal(sent[0].authorization, 'Bearer cli-internal-token');
  });

  test('trims surrounding whitespace of PROTOCLAW_INTERNAL_TOKEN', async () => {
    process.env.PROTOCLAW_INTERNAL_TOKEN = '  padded-token  ';
    sent.length = 0;
    await clawServerFetch('/protoclaw/threads');
    assert.equal(sent[0].authorization, 'Bearer padded-token');
  });

  test('anonymous semantics preserved: no Authorization when env unset or blank', async () => {
    delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    sent.length = 0;
    await clawServerFetch('/protoclaw/threads');
    assert.equal(sent[0].authorization, null);

    process.env.PROTOCLAW_INTERNAL_TOKEN = '   ';
    await clawServerFetch('/protoclaw/threads');
    assert.equal(sent[1].authorization, null);
  });

  test('does not overwrite an explicitly passed Authorization header', async () => {
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'env-token';
    sent.length = 0;
    await clawServerFetch('/protoclaw/threads', {
      headers: { Authorization: 'Bearer caller-token' },
    });
    assert.equal(sent[0].authorization, 'Bearer caller-token');
  });

  test('keeps caller content-type header alongside injected auth', async () => {
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'env-token';
    sent.length = 0;
    await clawServerFetch('/protoclaw/threads/t-1/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'user_message' }),
    });
    assert.equal(sent[0].authorization, 'Bearer env-token');
  });
});
