// switchAgent 对无 runtime 的 workspace 宿主（on-demand APP）的处理：
// 必须进入其工作空间首页（selectWorkspaceSurface），而不是在 runtimeAgentId
// 守卫处静默返回。
//
// 真实事故（ADR-0025 收尾）：接续窗口点击侧栏虚线条目 → openConversationTarget
// 等待分支调用 switchAgent('coder')，coder 宿主 runtime_session_id 为 null，
// switchAgent 在 `if (!runtimeAgentId) return` 处被吞 → 视图停在原工作空间，
// 切出去后点不回来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

const source = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');

const switchAgentSource = sourceBetween(
  source,
  'window.switchAgent = async (newAgentId) => {',
  '// ── Context menu action handlers',
);

function createSwitchAgentSandbox({
  coderRecord,
  focusedAgentId,
  currentRuntimeAgentId,
} = {}) {
  const calls = { selectSurface: [] };
  const ctx = createFrontendSandbox({
    focusedAgentId,
    currentRuntimeAgentId,
    hasPendingSessionNavigation: () => false,
    bumpNavigationGuard: () => {},
    closeAgentContextMenu: () => {},
    isWorkspaceHostUnit: (agent) => agent?.source === 'prebuilt' && agent?.id === 'coder',
    isWorkspaceSurfaceUnit: (agent) => agent?.source === 'prebuilt' && agent?.id === 'coder',
    isRemoteNamespaceAgentId: () => false,
    findAgentByIdentity: (agentId) => (
      coderRecord && coderRecord.id === agentId ? coderRecord : null
    ),
    getRuntimeId: (agent) => agent?.runtime_session_id || null,
    getAgentRuntimeId: (agent) => agent?.runtime_session_id || '',
    selectWorkspaceSurface: (agentId) => { calls.selectSurface.push(agentId); },
    loadAgentData: async () => { throw new Error('loadAgentData must not run for workspace-surface hosts'); },
  });
  ctx.run('let pendingSwitchTarget = null; let _switchEpoch = 0;');
  ctx.run(switchAgentSource);
  return { ctx, calls };
}

const coderHostWithoutRuntime = { id: 'coder', source: 'prebuilt', visibility: 'on-demand' };

test('无 runtime 的 on-demand 宿主：switchAgent 进入工作空间首页而非静默返回', async () => {
  const { ctx, calls } = createSwitchAgentSandbox({
    coderRecord: coderHostWithoutRuntime,
    focusedAgentId: 'programming-helper',
    currentRuntimeAgentId: 'ph-runtime',
  });

  await ctx.run('window.switchAgent("coder")');

  assert.deepEqual(calls.selectSurface, ['coder'],
    '接续窗口切走后点击 coder 条目必须能回到 coder 工作空间');
});

test('已在宿主首页时点击为幂等 no-op（不得重复进入 surface）', async () => {
  const { ctx, calls } = createSwitchAgentSandbox({
    coderRecord: coderHostWithoutRuntime,
    focusedAgentId: 'coder',
    currentRuntimeAgentId: '',
  });

  await ctx.run('window.switchAgent("coder")');

  assert.deepEqual(calls.selectSurface, [], '停留态重复点击不产生导航');
});

test('宿主有 runtime 时：请求宿主 id 仍进入 workspace surface，请求 runtime id 才绑定运行时', async () => {
  const withRuntime = { ...coderHostWithoutRuntime, runtime_session_id: 'rt-coder' };
  const { ctx, calls } = createSwitchAgentSandbox({
    coderRecord: withRuntime,
    focusedAgentId: 'programming-helper',
    currentRuntimeAgentId: 'ph-runtime',
  });

  await ctx.run('window.switchAgent("coder")');
  assert.deepEqual(calls.selectSurface, ['coder'],
    '按宿主 id 切换 = 进入工作空间首页（与无 runtime 形态一致）');
});
