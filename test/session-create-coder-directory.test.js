/**
 * coder 会话创建目录闸门（POST /protoclaw/prebuilt_sessions）
 *
 * coder 是无人值守身份，目录绑定错的代价是在错误的项目里施工：服务端
 * 拒绝裸创建（sessionType=coder 且无 openDirectory 且无 sourceSessionId），
 * 显式目录必须是已存在的绝对路径；successor 继承路径（sourceSessionId）
 * 与 main 会话流程不受约束。
 *
 * harness 参照 remote-write.test.js：capture handler 直接调用，ctx 最小替身。
 * AGENTDEV_DATA_DIR 隔离数据目录（session.js 模块链在 import 时解析数据根）。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-coder-dir-gate-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const { setupSessionRoutes } = await import('../server/routes/session.js');

after(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

/**
 * capture POST /protoclaw/prebuilt_sessions handler。
 * createPrebuiltSession stub 默认以 STOP_AFTER_GATE 停住放行路径——闸门
 * 放行的可观测事实 = stub 被调用且收到透传参数；索引/线程真实依赖不进。
 */
function captureCreateHandler(recordCreate) {
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

describe('POST /protoclaw/prebuilt_sessions coder 目录闸门', () => {
  const createCalls = [];
  const handler = captureCreateHandler((agentId, opts) => createCalls.push({ agentId, opts }));
  const existingDir = DATA_ROOT;

  test('coder 裸创建（无 openDirectory 无 sourceSessionId）→ 400，未触发 createPrebuiltSession', async () => {
    const res = makeRes();
    let nextError = null;
    await handler({ body: { agentId: 'programming-helper', sessionType: 'coder' } }, res, (e) => { nextError = e; });
    assert.equal(res.statusCode, 400);
    assert.match(res.jsonPayload.error, /openDirectory/);
    assert.match(res.jsonPayload.error, /回退默认/);
    assert.equal(nextError, null, '闸门拒绝是结构化 400 响应，不是异常');
    assert.equal(createCalls.length, 0, '拒绝路径不得触发会话创建');
  });

  test('coder 相对路径 → 400', async () => {
    const res = makeRes();
    await handler({ body: { agentId: 'programming-helper', sessionType: 'coder', openDirectory: './relative/dir' } }, res, (e) => { throw e; });
    assert.equal(res.statusCode, 400);
    assert.match(res.jsonPayload.error, /绝对路径/);
  });

  test('coder 不存在的目录 → 400', async () => {
    const res = makeRes();
    const missingDir = join(DATA_ROOT, 'missing', 'subdir');
    await handler({ body: { agentId: 'programming-helper', sessionType: 'coder', openDirectory: missingDir } }, res, (e) => { throw e; });
    assert.equal(res.statusCode, 400);
    assert.match(res.jsonPayload.error, /不存在或不是目录/);
  });

  test('coder 显式存在的绝对路径 → 闸门放行，openDirectory 透传到 createPrebuiltSession', async () => {
    createCalls.length = 0;
    const res = makeRes();
    // createPrebuiltSession stub 抛 STOP_AFTER_GATE 停住正路径：闸门放行的
    // 可观测事实 = stub 被调用且收到目录，错误经 next(error) 到达
    const stopError = await new Promise((resolve) => {
      handler(
        { body: { agentId: 'programming-helper', sessionType: 'coder', openDirectory: existingDir } },
        res,
        (e) => resolve(e),
      );
    });
    assert.match(String(stopError?.message), /STOP_AFTER_GATE/);
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].agentId, 'programming-helper');
    assert.equal(createCalls[0].opts.openDirectory, existingDir);
    assert.equal(createCalls[0].opts.sessionType, 'coder');
  });

  test('coder 带 sourceSessionId 无目录（successor 继承路径）→ 闸门放行', async () => {
    createCalls.length = 0;
    const res = makeRes();
    await new Promise((resolve) => {
      handler(
        { body: { agentId: 'programming-helper', sessionType: 'coder', sourceSessionId: 'session-src' } },
        res,
        (e) => resolve(e),
      );
    });
    assert.equal(createCalls.length, 1, '继承路径放行：目录由来源会话继承');
    assert.equal(createCalls[0].opts.sourceSessionId, 'session-src');
  });

  test('main 会话无目录 → 不受闸门约束（UI 既有流程零变化）', async () => {
    createCalls.length = 0;
    const res = makeRes();
    await new Promise((resolve) => {
      handler({ body: { agentId: 'programming-helper' } }, res, (e) => resolve(e));
    });
    assert.equal(createCalls.length, 1, 'main 路径不设闸门');
  });
});
