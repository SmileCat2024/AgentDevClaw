import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ControlledTodoFeature, ContinuityAwareOpencodeBasic } from '../src/index.js';
import { TodoFeature, OpencodeBasicFeature, Decision } from '@agentdevjs/core';
import { CONTINUITY_FIELD_KEY } from '../../continuity-participant/src/index.js';

function makeStepCtx(toolCallsCount: number) {
  const injected: Array<{ role: string; content: string }> = [];
  return {
    ctx: {
      toolCallsCount,
      callIndex: 0,
      llmResponse: { toolCalls: [] },
      context: {
        add: (msg: { role: string; content: string }) => injected.push(msg),
        addSystemMessage: () => {},
      },
    },
    injected,
  };
}

describe('feature-wrappers smoke', () => {
  it('ControlledTodoFeature 是 TodoFeature 的 continuity 包装', () => {
    const feature = new ControlledTodoFeature();
    assert.ok(feature instanceof TodoFeature);
    assert.equal(typeof feature.setInterruptTarget, 'function');
    // continuity descriptor 随包装导出
    const state = feature.captureState();
    const descriptor = (state as Record<string, unknown>)[CONTINUITY_FIELD_KEY] as
      | { protocol?: string }
      | undefined;
    assert.equal(descriptor?.protocol, 'claw.todo-continuity.v1');
  });

  it('ContinuityAwareOpencodeBasic 是 OpencodeBasicFeature 的专用接续协议包装', () => {
    const feature = new ContinuityAwareOpencodeBasic();
    assert.ok(feature instanceof OpencodeBasicFeature);
    const state = feature.captureState();
    const descriptor = (state as Record<string, unknown>)[CONTINUITY_FIELD_KEY] as
      | { protocol?: string }
      | undefined;
    assert.equal(descriptor?.protocol, 'claw.opencode-basic-continuity.v1');
  });
});

describe('ControlledTodoFeature 执行到此处', () => {
  it('无断点：任务未完 + 自然结束 → Continue（自然停止）', async () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a', 'desc');
    const { ctx } = makeStepCtx(0);
    assert.equal(await feature.recordToolUsage(ctx), Decision.Continue);
  });

  it('设置断点后：目标未终态 + 自然结束 → 注入提醒并 Approve 继续', async () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a', 'desc');
    feature.setInterruptTarget('1');
    const { ctx, injected } = makeStepCtx(0);
    assert.equal(await feature.recordToolUsage(ctx), Decision.Approve);
    assert.equal(injected.length, 1);
    assert.match(injected[0].content, /task-a/);
  });

  it('目标进入终态 → Deny 停止，断点自动清除', async () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a', 'desc');
    feature.createTask('task-b', 'desc');
    feature.setInterruptTarget('1');
    feature.updateTask('1', { status: 'completed' });
    const { ctx, injected } = makeStepCtx(0);
    assert.equal(await feature.recordToolUsage(ctx), Decision.Deny);
    assert.equal(feature.getInterruptTarget(), null);
    assert.equal(injected.length, 0);
  });

  it('带工具调用的 step → Continue（循环本来就继续），且重置连续计数', async () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a', 'desc');
    feature.setInterruptTarget('1');
    const first = makeStepCtx(0);
    await feature.recordToolUsage(first.ctx);
    assert.equal(feature.getPlanSnapshot().interruptTargetId, '1');
    const withTools = makeStepCtx(2);
    assert.equal(await feature.recordToolUsage(withTools.ctx), Decision.Continue);
    assert.equal(feature.getPlanSnapshot().interruptTargetId, '1');
  });

  it('连续无工具收尾达到上限后 → Continue（避免无界续跑）', async () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a', 'desc');
    feature.setInterruptTarget('1');
    for (let i = 0; i < 3; i++) {
      const step = makeStepCtx(0);
      assert.equal(await feature.recordToolUsage(step.ctx), Decision.Approve);
    }
    const beyond = makeStepCtx(0);
    assert.equal(await feature.recordToolUsage(beyond.ctx), Decision.Continue);
  });

  it('设置新断点时重置连续计数', async () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a', 'desc');
    feature.createTask('task-b', 'desc');
    feature.setInterruptTarget('1');
    for (let i = 0; i < 3; i++) {
      await feature.recordToolUsage(makeStepCtx(0).ctx);
    }
    // 上限已耗尽；重新设置断点后预算重置
    feature.setInterruptTarget('2');
    const step = makeStepCtx(0);
    assert.equal(await feature.recordToolUsage(step.ctx), Decision.Approve);
  });

  it('断点目标随 captureState/restoreState 往返', () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a', 'desc');
    feature.setInterruptTarget('1');
    const state = feature.captureState() as Record<string, any>;
    assert.equal(state.interruptTargetId, '1');
    // 旧版快照的 forceContinue 字段（已移除的开关）在恢复时被忽略
    state.forceContinue = { enabled: true, consecutive: 2 };
    const restored = new ControlledTodoFeature();
    restored.restoreState(state);
    assert.equal(restored.getInterruptTarget(), '1');
    assert.equal((restored.getPlanSnapshot() as Record<string, any>).forceContinue, undefined);
  });

  it('restoreState 清除僵尸断点（目标已终态或不存在）', () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a', 'desc');
    feature.updateTask('1', { status: 'completed' });
    feature.restoreState({ interruptTargetId: '1' });
    assert.equal(feature.getInterruptTarget(), null);
    feature.restoreState({ interruptTargetId: '999' });
    assert.equal(feature.getInterruptTarget(), null);
  });
});
