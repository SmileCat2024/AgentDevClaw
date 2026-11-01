/**
 * 编程小助手入口运行模式透传（POST /protoclaw/prebuilt_sessions）
 *
 * 入口语义（ADR-0037 会话级运行模式，交互入口无策略闸门）：
 * - 不携带 runtimeMode 的创建 = 现状：opts 不得出现 runtimeMode 字段。
 * - 显式 standard / container 原样到达 createPrebuiltSession（并随
 *   startManagedAgent 传入启动选项）。
 * - agent-choice 或未知值在路由层 400，不触发创建。
 *
 * harness 参照 session-create-coder-directory.test.js：capture handler
 * 直接调用；createPrebuiltSession stub 以 STOP_AFTER_GATE 停住正路径，
 * 透传的可观测事实 = stub 收到的 opts。AGENTDEV_DATA_DIR 隔离数据目录。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-ph-runtime-mode-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const { setupSessionRoutes } = await import('../server/routes/session.js');

after(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

function captureCreateHandler(recordCreate, recordStart) {
  let handler = null;
  setupSessionRoutes(
    {
      get: () => {},
      put: () => {},
      delete: () => {},
      post: (routePath, ...rest) => {
        if (routePath === '/protoclaw/prebuilt_sessions') handler = rest[rest.length - 1];
      },
    },
    { json: () => (_req, _res, next) => next?.() },
    {
      requireAgentLight: async (id) => ({ id }),
      createPrebuiltSession: async (agentId, opts) => {
        if (recordCreate) recordCreate(agentId, opts);
        throw Object.assign(new Error('STOP_AFTER_GATE'), { statusCode: 599 });
      },
      startManagedAgent: async () => { throw new Error('startManagedAgent must not run in gate tests'); },
      waitForManagedRuntimeReady: async () => true,
      readSessionIndex: async () => ({ revision: 0, activeSessionId: null, sessions: [] }),
      updateSessionIndex: async () => { throw new Error('index update must not run in gate tests'); },
    },
  );
  void recordStart;
  return handler;
}

function makeRes() {
  return {
    statusCode: 200,
    jsonPayload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonPayload = payload; },
  };
}

describe('POST /protoclaw/prebuilt_sessions programming-helper 入口运行模式', () => {
  const createCalls = [];
  const handler = captureCreateHandler((agentId, opts) => createCalls.push({ agentId, opts }));

  test('不携带 runtimeMode → opts 无 runtimeMode 字段（现状路径零变化）', async () => {
    createCalls.length = 0;
    const res = makeRes();
    await new Promise((resolve) => {
      handler({ body: { agentId: 'programming-helper' } }, res, (e) => resolve(e));
    });
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].agentId, 'programming-helper');
    assert.equal('runtimeMode' in createCalls[0].opts, false, '未选择模式不得固定 executor');
  });

  test('显式 container → 解析后原样透传到 createPrebuiltSession', async () => {
    createCalls.length = 0;
    const res = makeRes();
    await new Promise((resolve) => {
      handler({ body: { agentId: 'programming-helper', runtimeMode: 'container', openDirectory: DATA_ROOT } }, res, (e) => resolve(e));
    });
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].opts.runtimeMode, 'container');
  });

  test('显式 standard → 透传 standard', async () => {
    createCalls.length = 0;
    const res = makeRes();
    await new Promise((resolve) => {
      handler({ body: { agentId: 'programming-helper', runtimeMode: 'standard' } }, res, (e) => resolve(e));
    });
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].opts.runtimeMode, 'standard');
  });

  test('agent-choice / 未知值 → 结构化 400 错误，未触发创建', async () => {
    for (const bad of ['agent-choice', 'vm']) {
      createCalls.length = 0;
      const res = makeRes();
      // 校验错误经 next(error) 交给全局错误中间件（server.js 按 statusCode/code
      // 响应 400）；此处断言错误对象携带的契约字段。
      const nextError = await new Promise((resolve) => {
        handler({ body: { agentId: 'programming-helper', runtimeMode: bad } }, res, (e) => resolve(e));
      });
      assert.equal(nextError?.statusCode, 400, `runtimeMode=${bad} 应为 400`);
      assert.equal(nextError?.code, 'invalid_runtime_mode');
      assert.equal(createCalls.length, 0, '拒绝路径不得触发会话创建');
    }
  });

  test('策略外的 agent 携带 runtimeMode → 字段被忽略（不支持集外不透传）', async () => {
    createCalls.length = 0;
    const res = makeRes();
    await new Promise((resolve) => {
      handler({ body: { agentId: 'agent-studio', runtimeMode: 'container' } }, res, (e) => resolve(e));
    });
    assert.equal(createCalls.length, 1);
    assert.equal('runtimeMode' in createCalls[0].opts, false, '支持集外的 agent 不接受运行模式');
  });
});
