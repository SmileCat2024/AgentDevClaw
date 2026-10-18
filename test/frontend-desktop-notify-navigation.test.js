import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * desktop-notify.js 通知点击导航的沙箱测试（frontend-vm 先例同
 * frontend-desktop-notify.test.js）。
 *
 * 回归背景（历史 bug）：多会话工作空间的宿主 prebuilt 条目会镜像其「当前」
 * runtime id 且排在 allAgents 前面；完成会话恰为宿主当前 runtime 时，
 * _findAgentByRuntimeId 先命中宿主条目，_navigateToAgent 走
 * handlePrebuiltAgentClick → kind: workspace 宿主一律落工作空间首页，
 * 通知点击跳不进对话。期望：通知点击定位会话（switchAgent(runtime)），
 * 只有无 runtime 的宿主才回落首页点击语义。
 */
function createNavigationSandbox() {
  const calls = { switchAgent: [], prebuiltClick: [] };
  const ctx = createFrontendSandbox({
    normalizeAgentIdentity: (id) => String(id || '').trim(),
  });
  ctx.document.hidden = false;
  ctx.document.hasFocus = () => true;
  ctx.window.focus = () => {};
  ctx.window.switchAgent = (id) => { calls.switchAgent.push(String(id)); };
  ctx.window.handlePrebuiltAgentClick = (id) => { calls.prebuiltClick.push(String(id)); };
  ctx.loadSource('public/src/modules/desktop-notify.js');
  return {
    ctx,
    calls,
    activate: (nav) => ctx.window.__clawConsumeNotificationActivation(JSON.stringify(nav)),
  };
}

const hostEntry = (overrides = {}) => ({
  id: 'programming-helper',
  source: 'prebuilt',
  kind: 'workspace',
  runtime_session_id: 'runtime-current',
  ...overrides,
});

const childEntry = (overrides = {}) => ({
  id: 'runtime-current',
  source: 'child',
  parent_id: 'programming-helper',
  runtime_session_id: 'runtime-current',
  ...overrides,
});

describe('desktop-notify activation navigation', () => {
  it('host entry mirroring the finished runtime must not shadow the conversation entry', () => {
    const { ctx, calls, activate } = createNavigationSandbox();
    // /api/agents 组装顺序：宿主条目在前，children 在后；宿主镜像其当前
    // runtime id（与完成会话相同——正是历史 bug 的遮蔽条件）。
    ctx.allAgents = [hostEntry(), childEntry()];
    activate({ runtimeId: 'runtime-current', agentId: 'programming-helper' });
    assert.deepEqual(calls.switchAgent, ['runtime-current'], '通知点击必须切到会话 runtime');
    assert.deepEqual(calls.prebuiltClick, [], '不得落到宿主首页点击语义');
  });

  it('viewer-only runtime merged into its host still navigates to the conversation', () => {
    const { ctx, calls, activate } = createNavigationSandbox();
    ctx.allAgents = [hostEntry()]; // 无 child 条目，宿主是唯一镜像 runtime 的条目
    activate({ runtimeId: 'runtime-current', agentId: 'programming-helper' });
    assert.deepEqual(calls.switchAgent, ['runtime-current'], '宿主携带 runtime id 时直接切 runtime');
    assert.deepEqual(calls.prebuiltClick, []);
  });

  it('runtime-less host falls back to the prebuilt click semantics (workspace home / start)', () => {
    const { ctx, calls, activate } = createNavigationSandbox();
    ctx.allAgents = [hostEntry({ runtime_session_id: null })];
    activate({ runtimeId: 'programming-helper', agentId: 'programming-helper' });
    assert.deepEqual(calls.switchAgent, [], '无 runtime 可切时不盲目 switchAgent');
    assert.deepEqual(calls.prebuiltClick, ['programming-helper'], '回落 handlePrebuiltAgentClick');
  });

  it('child entry matching wins over a host carrying a different runtime id', () => {
    const { ctx, calls, activate } = createNavigationSandbox();
    ctx.allAgents = [
      hostEntry(), // 宿主当前是另一个会话的 runtime
      childEntry({ id: 'runtime-b', runtime_session_id: 'runtime-b' }),
    ];
    activate({ runtimeId: 'runtime-b', agentId: 'programming-helper' });
    assert.deepEqual(calls.switchAgent, ['runtime-b']);
    assert.deepEqual(calls.prebuiltClick, []);
  });
});
