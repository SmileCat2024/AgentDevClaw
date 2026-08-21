import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ControlledTodoFeature, ContinuityAwareOpencodeBasic } from '../src/index.js';
import { TodoFeature, OpencodeBasicFeature, Decision } from 'agentdev';
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

describe('ControlledTodoFeature 任务未完强制继续', () => {
  it('默认关闭：任务未完 + 自然结束 → Continue（自然停止）', async () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a', 'desc');
    const { ctx } = makeStepCtx(0);
    assert.equal(await feature.recordToolUsage(ctx), Decision.Continue);
  });

  it('开启后：任务未完 + 自然结束 → 注入提醒并 Approve 继续', async () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a', 'desc');
    feature.setForceContinue(true);
    const { ctx, injected } = makeStepCtx(0);
    assert.equal(await feature.recordToolUsage(ctx), Decision.Approve);
    assert.equal(injected.length, 1);
    assert.match(injected[0].content, /task-a/);
  });

  it('开启后：无未完成任务 → Continue（自然停止）', async () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a');
    feature.updateTask('1', { status: 'completed' });
    feature.setForceContinue(true);
    const { ctx, injected } = makeStepCtx(0);
    assert.equal(await feature.recordToolUsage(ctx), Decision.Continue);
    assert.equal(injected.length, 0);
  });

  it('开启后：带工具调用的 step → Continue（循环本来就继续），且重置连续计数', async () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a');
    feature.setForceContinue(true);
    const first = makeStepCtx(0);
    await feature.recordToolUsage(first.ctx);
    assert.equal(feature.getPlanSnapshot().forceContinue.consecutive, 1);
    const withTools = makeStepCtx(2);
    assert.equal(await feature.recordToolUsage(withTools.ctx), Decision.Continue);
    assert.equal(feature.getPlanSnapshot().forceContinue.consecutive, 0);
  });

  it('连续无工具收尾达到上限后 → Continue（避免无界续跑）', async () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a');
    feature.setForceContinue(true);
    for (let i = 0; i < 3; i++) {
      const step = makeStepCtx(0);
      assert.equal(await feature.recordToolUsage(step.ctx), Decision.Approve);
    }
    const beyond = makeStepCtx(0);
    assert.equal(await feature.recordToolUsage(beyond.ctx), Decision.Continue);
  });

  it('断点优先：强制继续开启时，中断目标任务终态仍 Deny 停止', async () => {
    const feature = new ControlledTodoFeature();
    feature.createTask('task-a');
    feature.createTask('task-b');
    feature.setForceContinue(true);
    feature.setInterruptTarget('1');
    feature.updateTask('1', { status: 'completed' });
    const { ctx } = makeStepCtx(0);
    assert.equal(await feature.recordToolUsage(ctx), Decision.Deny);
    assert.equal(feature.getInterruptTarget(), null);
  });

  it('开关与计数随 captureState/restoreState 往返', () => {
    const feature = new ControlledTodoFeature();
    feature.setForceContinue(true);
    const state = feature.captureState() as Record<string, any>;
    assert.equal(state.forceContinue.enabled, true);
    const restored = new ControlledTodoFeature();
    restored.restoreState(state);
    assert.equal(restored.getForceContinue(), true);
    assert.deepEqual(restored.getPlanSnapshot().forceContinue, {
      enabled: true, consecutive: 0, max: 3,
    });
  });
});
