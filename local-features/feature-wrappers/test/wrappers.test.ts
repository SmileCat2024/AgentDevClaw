import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ControlledTodoFeature, ContinuityAwareOpencodeBasic } from '../src/index.js';
import { TodoFeature, OpencodeBasicFeature } from 'agentdev';

describe('feature-wrappers smoke', () => {
  it('ControlledTodoFeature 是 TodoFeature 的 continuity 包装', () => {
    const feature = new ControlledTodoFeature();
    assert.ok(feature instanceof TodoFeature);
    assert.equal(typeof feature.setInterruptTarget, 'function');
    // continuity descriptor 随包装导出
    const state = feature.captureState();
    const descriptor = (state as Record<string, unknown>).__claw_continuity__ as
      | { protocol?: string }
      | undefined;
    assert.equal(descriptor?.protocol, 'claw.todo-continuity.v1');
  });

  it('ContinuityAwareOpencodeBasic 是 OpencodeBasicFeature 的通用协议包装', () => {
    const feature = new ContinuityAwareOpencodeBasic();
    assert.ok(feature instanceof OpencodeBasicFeature);
    const state = feature.captureState();
    const descriptor = (state as Record<string, unknown>).__claw_continuity__ as
      | { protocol?: string }
      | undefined;
    assert.equal(descriptor?.protocol, 'claw.feature-continuity.v1');
  });
});
