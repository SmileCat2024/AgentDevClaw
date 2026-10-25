/**
 * GET /protoclaw/threads/:threadId 代际元数据投影测试（node:test，ticket 050）
 *
 * 锁定历史存档面板的数据契约：sessionChainMeta = 链事实（时间锚 / 触发
 * 方式 / role）合并会话索引元数据（标题 / 规模 / 归档态），按时间倒序
 * （最新在前）；索引查不到的代保留链事实、其余字段收敛为 null；注入
 * 缺席时响应不含该字段（旧装配兼容）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdevjs/core';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { setupThreadRoutes } from '../server/thread-control/thread-routes.js';

let base = null;
let counter = 0;

function makeControl() {
  const root = path.join(base, `chain-meta-${++counter}`);
  return createThreadControl({
    rootDir: root,
    bridge: new WorkThreadRuntimeBridge({
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-chain-meta',
      submitTurn: async () => ({ success: true }),
    }),
    identitySource: async (_agentId, sessionId) =>
      String(sessionId || '').trim() ? 'coder' : null,
  });
}

function makeMockApp() {
  const routes = {};
  return {
    routes,
    get: (p, ...h) => { routes[`GET ${p}`] = h; },
    post: (p, ...h) => { routes[`POST ${p}`] = h; },
  };
}

async function callDetailRoute(app, threadId) {
  const handlers = app.routes['GET /protoclaw/threads/:threadId'];
  assert.ok(handlers, 'route not registered: GET /protoclaw/threads/:threadId');
  const handler = handlers[handlers.length - 1];
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  await handler({ params: { threadId }, query: {} }, res);
  return res;
}

before(async () => { base = mkdtempSync(path.join(os.tmpdir(), 'claw-chain-meta-')); });
after(async () => { if (base) await fs.rm(base, { recursive: true, force: true }); });

describe('GET /protoclaw/threads/:threadId sessionChainMeta', () => {
  it('merges chain facts with session index metadata, newest first', async () => {
    const control = makeControl();
    const app = makeMockApp();
    // 索引元数据：只有两代中的旧代查得到（新代索引缺失 → 字段 null）
    setupThreadRoutes(app, { json: () => () => {} }, {
      control,
      resolveSessionChainMeta: async (agentId, sessionIds) => sessionIds.map((sessionId) => (
        sessionId === 's-gen1'
          ? { sessionId, title: '第一代标题', updatedAt: '2026-10-24T10:00:00.000Z', messageCount: 42, archived: true }
          : null
      )),
    });

    const thread = await control.core.start({
      sessionRef: { agentId: 'programming-helper', sessionId: 's-gen1' },
      identity: 'coder',
    });
    await control.core.advanceHead({
      threadId: thread.threadId,
      fromSessionId: 's-gen1',
      toSessionId: 's-gen2',
      endKind: 'trim',
    });

    const res = await callDetailRoute(app, thread.threadId);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.ok);
    const meta = res.body.sessionChainMeta;
    assert.ok(Array.isArray(meta), 'sessionChainMeta must be an array');
    // 倒序：新 head 在前
    assert.equal(meta.length, 2);
    assert.equal(meta[0].sessionId, 's-gen2');
    assert.equal(meta[0].role, 'head');
    assert.equal(meta[0].title, null, 'index-missing generation keeps null title');
    assert.equal(meta[0].messageCount, null);
    // 旧代：链事实 + 索引元数据合并
    assert.equal(meta[1].sessionId, 's-gen1');
    assert.equal(meta[1].role, 'predecessor');
    assert.equal(meta[1].endKind, 'trim');
    assert.equal(meta[1].title, '第一代标题');
    assert.equal(meta[1].messageCount, 42);
    assert.equal(meta[1].archived, true);
    assert.ok(meta[1].endedAt, 'predecessor carries endedAt time anchor');
  });

  it('omits sessionChainMeta when resolver is not injected (legacy wiring)', async () => {
    const control = makeControl();
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, { control });

    const thread = await control.core.start({
      sessionRef: { agentId: 'programming-helper', sessionId: 's-legacy' },
      identity: 'coder',
    });
    const res = await callDetailRoute(app, thread.threadId);
    assert.equal(res.statusCode, 200);
    assert.equal('sessionChainMeta' in res.body, false, 'field absent without injection');
  });
});
