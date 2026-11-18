/**
 * runtime-status-loader-host 真实求值（P2 真实 ESM 图路线）。
 *
 * 装载路线：classic 相只跑仍 classic 的唯一实现（app-core 的宿主工厂/身份函数、
 * session-view-state 的 token 与 patch 机制）；runtime-status-loader-host 与其
 * 依赖（agent-data-loader 的两个稳定具名工厂、会话提交策略）经 withP2EsmCase +
 * c.load 走真实 import 整图，每个用例一份独立模块图。
 *
 * 用例内的身份查询与 UI 域副作用（applyContextGuardStatus / updateNotificationStatus）
 * 仍是 classic 能力（app-main / runtime-status），生产里由各自 classic 文件提供；
 * 这里按原语义在沙箱内覆盖为同形桩并记录调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const RUNTIME_STATUS_HOST = 'public/src/modules/runtime-status-loader-host.js';

test('runtime status host gates unsupported guards and rejects responses parsed after leaving a view', async () => {
  const requests = [];
  const effects = [];
  const warnings = [];
  let failConnection = false;
  let pauseBody = false;
  let release;
  const runtime = { id: 'rt', connected: true };

  await withP2EsmCase({
    globals: {
      // markdown-utils（真实 ESM 依赖链）装载期注册 data-action 处理器
      ClawFW: { actions: { handlers: {}, registerMany(map) { Object.assign(this.handlers, map); } } },
      console: { ...console, warn: (...args) => warnings.push(args) },
      fetch: async (url) => {
        requests.push(url);
        return {
          ok: !(failConnection && url.endsWith('/connection')),
          json: async () => {
            if (pauseBody && url.endsWith('/notification')) await new Promise((resolve) => { release = resolve; });
            return url.endsWith('/connection') ? { connected: false } : { state: 'idle' };
          },
        };
      },
    },
    classic: (sandbox) => {
      // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂（runtime-switch / poll /
      // workspace-surface / 侧栏 call 状态 / snapshot loader）都是生产实现。
      prepareClassicSandbox(sandbox);
      // 窄行为观察面（真源之后覆盖，保持原用例语义）：身份查询 owner 在 app-main，
      // 本用例需要确定的宿主/运行时记录与逻辑 id 折算。
      sandbox.getCurrentRuntimeRecord = () => ({ agentId: 'host', sessionId: 'a' });
      sandbox.getCurrentAgentRecord = () => null;
      sandbox.getLogicalAgentId = (record) => record.agentId;
      sandbox.getActiveSessionId = (record) => record.sessionId;
      sandbox.getRuntimeRecord = () => runtime;
      // 两条副作用观察面在 runtime-status（P4 T2 起 ESM）的桥键之后改写：见用例体
      // 首段的 bridge setter 覆盖（classic 相的同名赋值会被访问器顶掉）。
    },
  }, async (c) => {
    // 两条副作用观察面（生产由 runtime-status 写回 DOM 与状态）：本用例只记录调用
    // 实参。经桥键 setter 覆盖，语义与 classic 顶层赋值一致。
    c.window.applyContextGuardStatus = (data, id) => effects.push(['guard', data, id]);
    c.window.updateNotificationStatus = (data, id) => effects.push(['notification', data, id]);
    c.read(`
      currentRuntimeAgentId = 'rt';
      focusedAgentId = 'host';
      applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'a' }, connected: true });
    `);
    const {
      refreshCurrentRuntimeStatus,
      refreshContextGuardStatus,
    } = await c.load(RUNTIME_STATUS_HOST);

    assert.equal(await refreshContextGuardStatus(), null);
    assert.equal(requests.length, 0, 'an unsupported guard issues no request');
    await refreshCurrentRuntimeStatus();
    assert.deepEqual(requests, ['/api/agents/rt/notification', '/api/agents/rt/connection']);
    assert.equal(runtime.connected, false);
    assert.deepEqual(effects, [['guard', null, 'rt'], ['notification', { state: 'idle' }, 'rt']]);
    effects.length = 0;
    // 装上 context-guard 能力 → 守卫可用
    c.read(`currentHookInspector = { features: [{ name: 'context-guard' }], hooks: [] };`);
    await refreshContextGuardStatus();
    assert.equal(requests.at(-1), '/protoclaw/context_guard_status?agentId=host&sessionId=a');
    assert.deepEqual(effects, [['guard', { state: 'idle' }, 'rt']]);
    effects.length = 0;
    failConnection = true;
    assert.equal(await refreshCurrentRuntimeStatus(), null);
    assert.deepEqual(effects, [], 'a failed required endpoint must not partially apply notification or guard state');
    failConnection = false;
    pauseBody = true;
    const pending = refreshCurrentRuntimeStatus();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof release, 'function', 'the controlled body parser must have been entered');
    c.read(`
      applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'b' } });
      applySessionViewPatch({ connected: true });
    `);
    runtime.connected = true;
    release();
    assert.equal(await pending, null);
    assert.equal(runtime.connected, true);
    assert.equal(c.window.currentRuntimeConnected, true);
    assert.deepEqual(effects, [], 'an old parsed response must not update any UI domain');
    assert.deepEqual(warnings, []);
    assert.equal(c.timerCount(), 0, '用例结束不应残留计时器');
  });
});
