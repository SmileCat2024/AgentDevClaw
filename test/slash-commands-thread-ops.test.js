/**
 * slash 手动精简命令（/trim /summary）的线程域可见性谓词（VM 沙箱驱动真实源码）。
 *
 * ADR-0032 决策 2：手动接续 APP（编程小助手）的线程会话保留手动精简入口；
 * 自动接续 APP（coder / memo）的线程会话继续隐藏（ADR-0024 决策 4，行为不变）。
 * 产品面事实源复用 ctx-menu-items 的 ctxSessionOpsAllowed（CTX_SESSION_OPS_AGENTS
 * 白名单），不新增平行清单。
 *
 * isThreadHostAgentId 以 thread-store.js 真实语义 stub（查 sessionIndex 成员关系）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * @param {object} params
 * @param {string} params.agentId 当前视图的 logical agent id
 * @param {string} params.sessionId 当前视图绑定会话
 * @param {string[]} params.threadSessions 已进入线程 sessionIndex 的 `${agentId}::${sessionId}` 键
 */
function makeSlashCtx({ agentId, sessionId, threadSessions = [] }) {
  const sessionIndex = Object.fromEntries(threadSessions.map((key) => [key, { threadId: 'th-x' }]));
  const agentRecord = { id: agentId, workspace_sessions: { activeSessionId: sessionId } };
  const registered = [];
  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    currentRuntimeAgentId: '',
    SlashMenu: { registerCommands: (cmds) => { registered.push(...cmds); } },
    getRuntimeId: () => '',
    getCurrentRuntimeRecord: () => null,
    getCurrentAgentRecord: () => agentRecord,
    getLogicalAgentId: (record) => record.id,
    getRuntimeWorkspaceSessionId: () => null,
    getActiveWorkspaceSessionId: (record) => record.workspace_sessions.activeSessionId,
    runWorkspaceAction: () => {},
  });
  ctx.window.isThreadHostAgentId = (id, sid) => !!sessionIndex[`${id}::${sid}`];
  ctx.loadSource('public/src/modules/ctx-menu-items.js');
  ctx.loadSource('public/src/modules/slash-commands.js');
  return { ctx, registered };
}

describe('slash 手动精简命令：线程域可见性谓词', () => {
  it('命令注册：trim / summary 的 applies 即谓词', () => {
    const { registered } = makeSlashCtx({ agentId: 'programming-helper', sessionId: 's1' });
    const names = registered.map((cmd) => cmd.name).sort();
    assert.deepEqual(names, ['summary', 'trim']);
    for (const cmd of registered) assert.equal(typeof cmd.applies, 'function');
  });

  it('PH 线程会话：保留手动入口（ADR-0032 决策 2，applies 为真）', () => {
    const { ctx } = makeSlashCtx({
      agentId: 'programming-helper',
      sessionId: 's1',
      threadSessions: ['programming-helper::s1'],
    });
    assert.equal(ctx.run('_manualSessionOpsApplicable()'), true);
  });

  it('coder 线程会话：隐藏手动入口（ADR-0024 决策 4，行为不变）', () => {
    const { ctx } = makeSlashCtx({
      agentId: 'coder',
      sessionId: 's2',
      threadSessions: ['coder::s2'],
    });
    assert.equal(ctx.run('_manualSessionOpsApplicable()'), false);
  });

  it('memo 线程会话：隐藏手动入口（行为不变）', () => {
    const { ctx } = makeSlashCtx({
      agentId: 'memo',
      sessionId: 's3',
      threadSessions: ['memo::s3'],
    });
    assert.equal(ctx.run('_manualSessionOpsApplicable()'), false);
  });

  it('PH 无线程会话（混合期存量）：显示手动入口（行为不变）', () => {
    const { ctx } = makeSlashCtx({ agentId: 'programming-helper', sessionId: 's4' });
    assert.equal(ctx.run('_manualSessionOpsApplicable()'), true);
  });

  it('agent-studio 会话（产品面白名单内、非线程宿主）：显示手动入口（行为不变）', () => {
    const { ctx } = makeSlashCtx({ agentId: 'agent-studio', sessionId: 's5' });
    assert.equal(ctx.run('_manualSessionOpsApplicable()'), true);
  });
});
