/**
 * tool-state 路由 hook scope 自动化测试
 *
 * 覆盖：
 * 1. hook scope 的 discriminated union 校验
 * 2. tool/feature scope 原有行为不受影响
 * 3. run-prebuilt-agent IPC handler 的 hook 分支独立性
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock 工具 ──

function createMockReq(body) {
  return { body: body || {} };
}

function createMockRes() {
  const res = {
    _statusCode: null,
    _jsonData: null,
    _ended: false,
    status(code) {
      this._statusCode = code;
      return this;
    },
    json(data) {
      this._jsonData = data;
      this._ended = true;
      return this;
    },
  };
  return res;
}

// ── 捕获路由 handler ──

async function captureHandler() {
  let capturedHandler = null;
  let capturedMiddleware = null;

  const mockApp = {
    post(path, ...handlers) {
      if (path === '/protoclaw/agent/tool_state') {
        // handlers[0] = jsonMiddleware, handlers[1] = actual handler
        capturedMiddleware = handlers[0];
        capturedHandler = handlers[handlers.length - 1];
      }
    },
  };

  // Import and setup
  const { setupToolStateRoutes } = await import('../server/routes/tool-state.js');
  setupToolStateRoutes(mockApp);

  return { capturedHandler, capturedMiddleware };
}

// ── 测试 ──

describe('tool-state 路由 — hook scope 校验', () => {
  let handler;

  beforeEach(async () => {
    const { capturedHandler } = await captureHandler();
    handler = capturedHandler;
  });

  it('scope=hook 且字段齐全 → 不返回 name required 错误', async () => {
    const req = createMockReq({
      agentId: 'test-agent',
      sessionId: 'test-session',
      scope: 'hook',
      lifecycle: 'ToolUse',
      featureName: 'audit',
      methodName: 'onToolUse',
      action: 'disable',
    });
    const res = createMockRes();

    await handler(req, res, () => {});

    // 不应该是 400（验证通过后走到 IPC 投递，因为没有运行中的 agent 会返回 503）
    assert.notStrictEqual(res._statusCode, 400,
      `Expected non-400 for valid hook request, got ${res._statusCode}: ${JSON.stringify(res._jsonData)}`);
  });

  it('scope=hook 缺少 lifecycle → 返回 400', async () => {
    const req = createMockReq({
      agentId: 'test-agent',
      sessionId: 'test-session',
      scope: 'hook',
      featureName: 'audit',
      methodName: 'onToolUse',
      action: 'disable',
    });
    const res = createMockRes();

    await handler(req, res, () => {});

    assert.strictEqual(res._statusCode, 400);
    assert.match(res._jsonData.error, /lifecycle is required/);
  });

  it('scope=hook 缺少 featureName → 返回 400', async () => {
    const req = createMockReq({
      agentId: 'test-agent',
      sessionId: 'test-session',
      scope: 'hook',
      lifecycle: 'ToolUse',
      methodName: 'onToolUse',
      action: 'disable',
    });
    const res = createMockRes();

    await handler(req, res, () => {});

    assert.strictEqual(res._statusCode, 400);
    assert.match(res._jsonData.error, /featureName is required/);
  });

  it('scope=hook 缺少 methodName → 返回 400', async () => {
    const req = createMockReq({
      agentId: 'test-agent',
      sessionId: 'test-session',
      scope: 'hook',
      lifecycle: 'ToolUse',
      featureName: 'audit',
      action: 'disable',
    });
    const res = createMockRes();

    await handler(req, res, () => {});

    assert.strictEqual(res._statusCode, 400);
    assert.match(res._jsonData.error, /methodName is required/);
  });

  it('scope=hook 不携带 name → 不报 "name is required" 错误', async () => {
    const req = createMockReq({
      agentId: 'test-agent',
      sessionId: 'test-session',
      scope: 'hook',
      lifecycle: 'CallStart',
      featureName: 'memory',
      methodName: 'onCallStart',
      action: 'enable',
      // 故意不携带 name
    });
    const res = createMockRes();

    await handler(req, res, () => {});

    // 不应该因为缺少 name 而 400
    assert.ok(
      res._statusCode !== 400 || !res._jsonData?.error?.includes('name is required'),
      `Hook request should not require 'name', got: ${JSON.stringify(res._jsonData)}`
    );
  });

  it('action 非法 → 返回 400', async () => {
    const req = createMockReq({
      agentId: 'test-agent',
      sessionId: 'test-session',
      scope: 'hook',
      lifecycle: 'ToolUse',
      featureName: 'audit',
      methodName: 'onToolUse',
      action: 'toggle',
    });
    const res = createMockRes();

    await handler(req, res, () => {});

    assert.strictEqual(res._statusCode, 400);
    assert.match(res._jsonData.error, /action must be/);
  });

  it('缺少 agentId → 返回 400', async () => {
    const req = createMockReq({
      scope: 'hook',
      lifecycle: 'ToolUse',
      featureName: 'audit',
      methodName: 'onToolUse',
      action: 'disable',
    });
    const res = createMockRes();

    await handler(req, res, () => {});

    assert.strictEqual(res._statusCode, 400);
    assert.match(res._jsonData.error, /agentId is required/);
  });
});

describe('tool-state 路由 — tool/feature scope 回归', () => {
  let handler;

  beforeEach(async () => {
    const { capturedHandler } = await captureHandler();
    handler = capturedHandler;
  });

  it('scope=tool 缺少 name → 仍返回 400', async () => {
    const req = createMockReq({
      agentId: 'test-agent',
      sessionId: 'test-session',
      scope: 'tool',
      action: 'disable',
    });
    const res = createMockRes();

    await handler(req, res, () => {});

    assert.strictEqual(res._statusCode, 400);
    assert.match(res._jsonData.error, /name is required/);
  });

  it('scope=feature 缺少 name → 仍返回 400', async () => {
    const req = createMockReq({
      agentId: 'test-agent',
      sessionId: 'test-session',
      scope: 'feature',
      action: 'enable',
    });
    const res = createMockRes();

    await handler(req, res, () => {});

    assert.strictEqual(res._statusCode, 400);
    assert.match(res._jsonData.error, /name is required/);
  });

  it('scope 未指定（默认 tool）缺少 name → 返回 400', async () => {
    const req = createMockReq({
      agentId: 'test-agent',
      sessionId: 'test-session',
      action: 'disable',
    });
    const res = createMockRes();

    await handler(req, res, () => {});

    assert.strictEqual(res._statusCode, 400);
    assert.match(res._jsonData.error, /name is required/);
  });
});

describe('IPC handler — hook 分支独立性', () => {
  // 模拟 run-prebuilt-agent.js 中的 handleIPC 逻辑
  // 只测试 hook 分支不受 name guard 影响

  function createMockSession(agent) {
    return {
      agent,
      handleIPC(msg) {
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'tool-state') {
          const { scope, action } = msg;
          if (action !== 'enable' && action !== 'disable') return;
          try {
            if (scope === 'hook') {
              const { lifecycle, featureName, methodName } = msg;
              if (!lifecycle || !featureName || !methodName) return;

              if (typeof this.agent?.[`${action}Hook`] !== 'function') {
                return;
              }
              this.agent[`${action}Hook`](lifecycle, featureName, methodName);
            } else if (scope === 'feature') {
              const { name } = msg;
              if (!name) return;
              if (typeof this.agent?.[action] !== 'function') return;
              this.agent[action](name);
            } else {
              const { name } = msg;
              if (!name) return;
              if (!this.agent?.tools || typeof this.agent.tools[action] !== 'function') return;
              this.agent.tools[action](name);
            }
          } catch (err) {
            // swallow
          }
        }
      },
    };
  }

  it('scope=hook 消息不携带 name 时不被丢弃', () => {
    const calls = [];
    const agent = {
      enableHook(lifecycle, featureName, methodName) {
        calls.push({ method: 'enableHook', lifecycle, featureName, methodName });
      },
      disableHook(lifecycle, featureName, methodName) {
        calls.push({ method: 'disableHook', lifecycle, featureName, methodName });
      },
    };
    const session = createMockSession(agent);

    session.handleIPC({
      type: 'tool-state',
      scope: 'hook',
      lifecycle: 'ToolUse',
      featureName: 'audit',
      methodName: 'onToolUse',
      action: 'disable',
      // 故意不携带 name
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'disableHook');
    assert.strictEqual(calls[0].lifecycle, 'ToolUse');
    assert.strictEqual(calls[0].featureName, 'audit');
    assert.strictEqual(calls[0].methodName, 'onToolUse');
  });

  it('handler 正确调用 agent.enableHook', () => {
    const calls = [];
    const agent = {
      enableHook(...args) { calls.push(['enableHook', ...args]); },
      disableHook(...args) { calls.push(['disableHook', ...args]); },
    };
    const session = createMockSession(agent);

    session.handleIPC({
      type: 'tool-state',
      scope: 'hook',
      lifecycle: 'CallStart',
      featureName: 'memory',
      methodName: 'onCallStart',
      action: 'enable',
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], 'enableHook');
    assert.deepStrictEqual(calls[0].slice(1), ['CallStart', 'memory', 'onCallStart']);
  });

  it('handler 正确调用 agent.disableHook', () => {
    const calls = [];
    const agent = {
      enableHook(...args) { calls.push(['enableHook', ...args]); },
      disableHook(...args) { calls.push(['disableHook', ...args]); },
    };
    const session = createMockSession(agent);

    session.handleIPC({
      type: 'tool-state',
      scope: 'hook',
      lifecycle: 'StepFinish',
      featureName: 'subagent',
      methodName: 'onStepFinish',
      action: 'disable',
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], 'disableHook');
  });

  it('agent 不存在 enableHook 方法时不崩溃', () => {
    const agent = { tools: { enable() {}, disable() {} } };
    const session = createMockSession(agent);

    // 不应该抛异常
    assert.doesNotThrow(() => {
      session.handleIPC({
        type: 'tool-state',
        scope: 'hook',
        lifecycle: 'ToolUse',
        featureName: 'audit',
        methodName: 'onToolUse',
        action: 'enable',
      });
    });
  });

  it('tool scope 仍然需要 name（回归测试）', () => {
    const calls = [];
    const agent = {
      tools: {
        enable(name) { calls.push(['tools.enable', name]); },
        disable(name) { calls.push(['tools.disable', name]); },
      },
    };
    const session = createMockSession(agent);

    // 没有 name 的 tool scope 消息被丢弃
    session.handleIPC({
      type: 'tool-state',
      scope: 'tool',
      action: 'disable',
    });
    assert.strictEqual(calls.length, 0);

    // 有 name 的正常处理
    session.handleIPC({
      type: 'tool-state',
      scope: 'tool',
      name: 'bash',
      action: 'disable',
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], 'tools.disable');
    assert.strictEqual(calls[0][1], 'bash');
  });

  it('hook scope 缺少字段时静默丢弃', () => {
    const calls = [];
    const agent = {
      enableHook(...args) { calls.push(args); },
      disableHook(...args) { calls.push(args); },
    };
    const session = createMockSession(agent);

    // 缺少 methodName
    session.handleIPC({
      type: 'tool-state',
      scope: 'hook',
      lifecycle: 'ToolUse',
      featureName: 'audit',
      action: 'disable',
    });
    assert.strictEqual(calls.length, 0);
  });
});
