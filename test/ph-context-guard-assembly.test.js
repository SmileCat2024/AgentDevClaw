/**
 * PH 装配 wiring：ContextGuardFeature 的 rotate 上报身份（2026-11-04 修复回归）。
 *
 * 事故形态：装配处漏传 runtimeIdentity（agentId / sessionId / serverOrigin），
 * feature 的 rotate 上报在身份缺失时静默跳过（reportRotationEvent 首行守卫），
 * 表现为「过界打断生效但轮转永不触发」——打断链路不依赖身份，上报链路依赖，
 * feature 层单测自传身份因而全绿，断点只在装配层暴露。
 *
 * 防线：真实实例化 ProgrammingHelperAgent（构造期装配，无 onInitiate / 网络副作用），
 * 断言守卫 feature 收到完整身份三元组 + allowRotation，并在行为层验证上报 fetch
 * 携带正确 agentId / sessionId / strategy。全程隔离数据根，无真实模型请求。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-ph-guard-assembly-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

after(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

// 先设 env 再 import：agent.js 顶层数据根常量在 import 时解析
const { default: ProgrammingHelperAgent } = await import('../prebuilt-agents/official/programming-helper/agent.js');

const RUNTIME_IDENTITY = {
  agentId: 'programming-helper',
  sessionId: 's-guard-assembly-1',
  serverOrigin: 'http://127.0.0.1:1420',
};

describe('PH context-guard 装配 wiring（rotate 上报身份）', () => {
  /** @type {import('node:assert').Assertions} guard feature 实例 */
  let guard;

  before(() => {
    const agent = new ProgrammingHelperAgent({
      workspaceDir: tmpdir(),
      runtime: { ...RUNTIME_IDENTITY },
    });
    guard = agent.getFeature('context-guard');
    assert.ok(guard, 'context-guard feature 应已被装配');
  });

  test('无会话宿主 runtime 不创建需要会话寻址的面板投影', () => {
    assert.doesNotThrow(() => new ProgrammingHelperAgent({
      workspaceDir: tmpdir(),
      runtime: { agentId: 'programming-helper', serverOrigin: 'http://127.0.0.1:14200' },
    }));
  });

  test('装配传入身份三元组：agentId / sessionId / serverOrigin（缺失即上报静默跳过）', () => {
    assert.equal(guard.agentId, RUNTIME_IDENTITY.agentId);
    assert.equal(guard.sessionId, RUNTIME_IDENTITY.sessionId);
    assert.equal(guard.serverOrigin, RUNTIME_IDENTITY.serverOrigin);
  });

  test('装配声明线程宿主能力（allowRotation: true）', () => {
    assert.equal(guard.allowRotation, true);
  });

  test('缺省档（ADR-0040 修订）：新对话无快照无配置时默认自动接续', () => {
    // 构造期未传 mode / enabled（配置层无 context-guard 键），初值由装配
    // 能力决定：allowRotation: true → rotate。这是「新对话默认自动接续」
    // 的装配层验收点；会话内切换与快照继承由 feature 层测试覆盖。
    assert.equal(guard.getStatus().mode, 'rotate');
    assert.equal(guard.getStatus().strategy, 'adaptive');
  });

  test('行为层：rotate 态过界上报携带完整身份与会话级策略（fetch 可达验证）', async () => {
    // 经真实控制面切到 rotate（上报的 mode 守卫只放行 rotate 态——默认
    // interrupt 下被拦截不是缺陷，是 mode 守卫语义，此处前置为 rotate）
    const switched = await guard.onHostRequest('set', { mode: 'rotate' });
    assert.equal(switched.ok, true);

    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return { ok: true };
    };
    try {
      // 私有方法直调（继承包装下运行时可访问）：等价于 CallFinish 上报路径
      guard.reportRotationEvent(
        { inputTokens: 99000, thresholdTokens: 98000 },
        'Context threshold reached: 99000 input tokens (limit 98000).',
      );
      // 上报是 void fetch（fire-and-forget），让微任务队列冲洗一次
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(calls.length, 1, '上报应恰好发出一次（身份齐备时不静默跳过）');
      assert.equal(calls[0].url, `${RUNTIME_IDENTITY.serverOrigin}/protoclaw/context_guard_event`);
      const { body } = calls[0];
      assert.equal(body.agentId, RUNTIME_IDENTITY.agentId);
      assert.equal(body.sessionId, RUNTIME_IDENTITY.sessionId);
      assert.ok(['adaptive', 'trim', 'summary'].includes(body.strategy), '策略载荷应为合法枚举值');
      assert.equal(body.contextGuard?.blocked, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
