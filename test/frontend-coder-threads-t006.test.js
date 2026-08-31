import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadCoderThreadsUI() {
  const ctx = createFrontendSandbox({ currentLanguage: 'zh' });
  ctx.loadSource('public/src/modules/coder-threads-ui.js');
  return ctx;
}

describe('T006 coder-threads-ui: 归档取消结果与删除确认文案', () => {
  it('归档文案以 cleanup 事实为准，明确「恢复不复活已取消指令」', () => {
    const ctx = loadCoderThreadsUI();
    const text = ctx.run(`window.CoderThreadsUI.archiveResultText({
      status: 'complete',
      commandsCancelled: 2,
      handoffConverged: true,
      inflightDrain: { count: 1 },
    }, true)`);
    assert.ok(text.includes('2 条未开始指令已取消'));
    assert.ok(text.includes('新派发已拒绝'));
    assert.ok(text.includes('1 条运行中调用已收尾'));
    assert.ok(text.includes('不复活已取消的指令'));
  });

  it('无待投递指令 / 无运行中调用时文案如实省略，不编造', () => {
    const ctx = loadCoderThreadsUI();
    const text = ctx.run(`window.CoderThreadsUI.archiveResultText({
      status: 'complete',
      commandsCancelled: 0,
      handoffConverged: false,
      inflightDrain: { count: 0 },
    }, true)`);
    assert.ok(!text.includes('条未开始指令已取消'));
    assert.ok(!text.includes('运行中调用已收尾'));
    // 即使无取消，也保留「恢复不复活」的明确提醒
    assert.ok(text.includes('不复活已取消的指令'));
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
