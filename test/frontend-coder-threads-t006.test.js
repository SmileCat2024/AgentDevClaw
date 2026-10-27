import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadCoderThreadsUI() {
  const ctx = createFrontendSandbox({ currentLanguage: 'zh' });
  ctx.loadSource('public/src/modules/coder-threads-ui.js');
  return ctx;
}

describe('T006 coder-threads-ui: 归档取消结果与删除确认文案', () => {
  it('opening a thread targets its current head through the unified conversation entry', async () => {
    const ctx = loadCoderThreadsUI();
    let openedTarget = null;
    ctx.run(`window.ClawThreads = { byId: { 'wt-1': {
      threadId: 'wt-1', agentId: 'programming-helper', headSessionId: 'head-1',
    } } }`);
    ctx.window.getThreadById = (id) => ctx.window.ClawThreads.byId[id];
    ctx.window.openConversationTarget = async (target) => { openedTarget = target; };
    await ctx.run(`window.CoderThreadsUI.openHead('wt-1')`);
    assert.equal(openedTarget?.agentId, 'programming-helper');
    assert.equal(openedTarget?.threadId, 'wt-1');
  });

  it('归档文案以 cleanup 事实为准，明确「取消归档不重发已取消消息」', () => {
    const ctx = loadCoderThreadsUI();
    const text = ctx.run(`window.CoderThreadsUI.archiveResultText({
      status: 'complete',
      commandsCancelled: 2,
      handoffConverged: true,
      inflightDrain: { count: 1 },
    }, true)`);
    assert.ok(text.includes('2 条排队中的消息已取消'));
    assert.ok(text.includes('归档后不再接收新消息'));
    assert.ok(text.includes('1 项进行中的任务正在收尾'));
    assert.ok(text.includes('取消归档后这些消息不会自动重新发送'));
  });

  it('无取消事实时文案如实省略，不虚构也不制造无来由提醒', () => {
    const ctx = loadCoderThreadsUI();
    const text = ctx.run(`window.CoderThreadsUI.archiveResultText({
      status: 'complete',
      commandsCancelled: 0,
      handoffConverged: false,
      inflightDrain: { count: 0 },
    }, true)`);
    assert.ok(!text.includes('条排队中的消息已取消'));
    assert.ok(!text.includes('项进行中的任务正在收尾'));
    // 提醒只在真的取消了消息时出现：空闲归档不提「已取消的消息」
    assert.ok(!text.includes('不会自动重新发送'));
    assert.ok(!text.includes('指令'), '文案不得残留「指令」这类内部术语');
  });

  it('删除确认展示级联影响范围（成员会话数 + 待投递指令数）', () => {
    const ctx = loadCoderThreadsUI();
    const zh = ctx.run(`window.CoderThreadsUI.deleteConfirmText({
      sessionChain: [{ sessionId: 's-1' }, { sessionId: 's-2' }],
      headSessionId: 's-3',
      rootSessionId: 's-1',
      commands: [{ status: 'pending' }, { status: 'in_flight' }, { status: 'delivered' }],
    }, true)`);
    assert.ok(zh.includes('3 个会话'));
    assert.ok(zh.includes('2 条待投递/运行中指令会被取消'));
    assert.ok(zh.includes('不可撤销'));
  });

  it('删除确认无待投递指令时不提示取消（不虚构）', () => {
    const ctx = loadCoderThreadsUI();
    const zh = ctx.run(`window.CoderThreadsUI.deleteConfirmText({
      sessionChain: [{ sessionId: 's-1' }],
      headSessionId: 's-1',
      commands: [{ status: 'delivered' }],
    }, true)`);
    assert.ok(!zh.includes('待投递/运行中指令会被取消'));
  });
});
