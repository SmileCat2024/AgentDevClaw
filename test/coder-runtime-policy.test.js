import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCoderRuntimeMode, resolveSessionRuntimeMode, runtimeModeToExecutor,
  supportsSessionRuntimeMode,
} from '../server/shared/coder-runtime-policy.js';
import { CODER_RUNTIME_MODE_VALUES, PERMISSION_ITEMS } from '../server/shared/permission-registry.js';

const policies = (runtimeExecutionMode) => async () => ({ coder: { runtimeExecutionMode } });

describe('Coder runtime execution mode', () => {
  it('validates the three user-selectable policy values', () => {
    assert.deepEqual(CODER_RUNTIME_MODE_VALUES, ['standard', 'container', 'agent-choice']);
    for (const value of CODER_RUNTIME_MODE_VALUES) assert.equal(PERMISSION_ITEMS.runtimeExecutionMode.validate(value), true);
    assert.equal(PERMISSION_ITEMS.runtimeExecutionMode.validate('vm'), false);
  });

  it('requires dispatch to choose a mode in agent-choice policy and permits either supported choice', async () => {
    await assert.rejects(resolveCoderRuntimeMode(undefined, { readPolicies: policies('agent-choice') }), { code: 'coder_runtime_mode_required' });
    assert.equal(await resolveCoderRuntimeMode('standard', { readPolicies: policies('agent-choice') }), 'standard');
    assert.equal(await resolveCoderRuntimeMode('container', { readPolicies: policies('agent-choice') }), 'container');
  });

  it('rejects dispatch that contradicts fixed user policy', async () => {
    assert.equal(await resolveCoderRuntimeMode('standard', { readPolicies: policies('standard') }), 'standard');
    await assert.rejects(resolveCoderRuntimeMode('container', { readPolicies: policies('standard') }), { code: 'coder_runtime_mode_forbidden' });
    assert.equal(await resolveCoderRuntimeMode('container', { readPolicies: policies('container') }), 'container');
    await assert.rejects(resolveCoderRuntimeMode('standard', { readPolicies: policies('container') }), { code: 'coder_runtime_mode_forbidden' });
  });

  it('allows derived-session creation to use fixed policy but not agent-choice default', async () => {
    assert.equal(await resolveCoderRuntimeMode(undefined, { readPolicies: policies('standard'), allowPolicyDefault: true }), 'standard');
    await assert.rejects(resolveCoderRuntimeMode(undefined, { readPolicies: policies('agent-choice'), allowPolicyDefault: true }), { code: 'coder_runtime_mode_required' });
  });

  it('rejects unknown requested and stored policy values', async () => {
    await assert.rejects(resolveCoderRuntimeMode('vm', { readPolicies: policies('agent-choice') }), { code: 'invalid_runtime_mode' });
    await assert.rejects(resolveCoderRuntimeMode('standard', { readPolicies: policies('vm') }), { code: 'coder_runtime_policy_invalid' });
  });

  it('maps standard and container selections to their executor backends', () => {
    assert.equal(runtimeModeToExecutor('standard'), 'local');
    assert.equal(runtimeModeToExecutor('container'), 'container');
    assert.equal(runtimeModeToExecutor('agent-choice'), null);
  });
});

describe('Session runtime mode beyond coder (programming-helper entry)', () => {
  it('lists exactly the session-runtime-mode agents', () => {
    assert.equal(supportsSessionRuntimeMode('coder'), true);
    assert.equal(supportsSessionRuntimeMode('programming-helper'), true);
    assert.equal(supportsSessionRuntimeMode('agent-studio'), false);
    assert.equal(supportsSessionRuntimeMode('memo'), false);
  });

  it('treats an interactive entry without a selection as unset (no policy gate)', async () => {
    // 短按新建 = 现状：不携带 runtimeMode 的创建既不报错也不固定模式。
    assert.equal(await resolveSessionRuntimeMode('programming-helper', undefined), undefined);
  });

  it('accepts explicit standard and container selections from the entry', async () => {
    assert.equal(await resolveSessionRuntimeMode('programming-helper', 'standard'), 'standard');
    assert.equal(await resolveSessionRuntimeMode('programming-helper', 'container'), 'container');
  });

  it('rejects any other value at the entry', async () => {
    await assert.rejects(resolveSessionRuntimeMode('programming-helper', 'agent-choice'), { code: 'invalid_runtime_mode' });
    await assert.rejects(resolveSessionRuntimeMode('programming-helper', 'vm'), { code: 'invalid_runtime_mode' });
  });

  it('keeps the coder policy gate for coder sessions', async () => {
    await assert.rejects(
      resolveSessionRuntimeMode('coder', 'container', { readPolicies: policies('standard') }),
      { code: 'coder_runtime_mode_forbidden' },
    );
  });
});
