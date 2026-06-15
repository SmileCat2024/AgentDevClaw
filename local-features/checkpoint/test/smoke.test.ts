/**
 * CheckpointFeature smoke test
 *
 * 验证：
 * 1. 工具注册正确（名称、executionMode、参数 schema）
 * 2. set_checkpoint 登记 checkpoint continuation request
 * 3. rollback_to_checkpoint 无 checkpoint 时友好失败
 * 4. rollback_to_checkpoint 有 checkpoint 时登记 rollback continuation request
 * 5. summary 为空或过长时校验
 * 6. captureState/restoreState 正确工作
 * 7. context injector 注入 hasActiveCheckpoint
 */

async function main() {
  const mod = await import('../src/index.js');
  const { CheckpointFeature } = mod;

  let passed = 0;
  let failed = 0;

  function assert(cond: boolean, msg: string) {
    if (cond) {
      passed++;
    } else {
      failed++;
      console.error(`  [FAIL] ${msg}`);
    }
  }

  // ── Test 1: Tool registration ──
  console.log('Test 1: Tool registration');
  {
    const feature = new CheckpointFeature();
    const tools = feature.getTools()!;

    assert(tools.length === 2, 'Should have exactly 2 tools');
    assert(tools[0].name === 'set_checkpoint', 'First tool should be set_checkpoint');
    assert(tools[1].name === 'rollback_to_checkpoint', 'Second tool should be rollback_to_checkpoint');
    assert(tools[0].executionMode === 'exclusive', 'set_checkpoint should be exclusive');
    assert(tools[1].executionMode === 'exclusive', 'rollback_to_checkpoint should be exclusive');

    // Check parameters schema
    const cpParams = tools[0].parameters as any;
    assert(cpParams?.properties?.note?.type === 'string', 'set_checkpoint should have note parameter');

    const rbParams = tools[1].parameters as any;
    assert(rbParams?.properties?.summary?.type === 'string', 'rollback_to_checkpoint should have summary parameter');
    assert(Array.isArray(rbParams?.required) && rbParams.required.includes('summary'), 'summary should be required');
  }

  // ── Test 2: set_checkpoint registers continuation request ──
  console.log('Test 2: set_checkpoint registers continuation request');
  {
    const feature = new CheckpointFeature();
    const tools = feature.getTools()!;
    const setCheckpoint = tools[0];

    let registeredRequest: any = null;
    const mockContext = {
      registerContinuationRequest: (req: any) => { registeredRequest = req; },
    };

    await setCheckpoint.execute({ note: 'trying approach A' }, mockContext);

    assert(registeredRequest !== null, 'Should register a continuation request');
    assert(registeredRequest.kind === 'checkpoint', 'Should be checkpoint kind');
    assert(registeredRequest.checkpointId === '__active__', 'Should use fixed checkpoint ID');
    assert(registeredRequest.metadata?.note === 'trying approach A', 'Should include note in metadata');
  }

  // ── Test 3: rollback_to_checkpoint fails without active checkpoint ──
  console.log('Test 3: rollback_to_checkpoint fails without active checkpoint');
  {
    const feature = new CheckpointFeature();
    const tools = feature.getTools()!;
    const rollback = tools[1];

    let registeredRequest: any = null;
    const mockContext = {
      registerContinuationRequest: (req: any) => { registeredRequest = req; },
      hasActiveCheckpoint: false,
    };

    const result: any = await rollback.execute({ summary: 'test summary' }, mockContext);

    assert(registeredRequest === null, 'Should NOT register continuation request');
    assert(result?.error !== undefined, 'Should return an error');
    assert(typeof result.error === 'string' && result.error.includes('No active checkpoint'), 'Error should mention no active checkpoint');
  }

  // ── Test 4: rollback_to_checkpoint succeeds with active checkpoint ──
  console.log('Test 4: rollback_to_checkpoint succeeds with active checkpoint');
  {
    const feature = new CheckpointFeature();
    const tools = feature.getTools()!;
    const setCheckpoint = tools[0];
    const rollback = tools[1];

    // First, set a checkpoint
    await setCheckpoint.execute({ note: 'before exploration' }, {
      registerContinuationRequest: () => {},
    });

    // Now rollback should work
    let registeredRequest: any = null;
    const mockContext = {
      registerContinuationRequest: (req: any) => { registeredRequest = req; },
      hasActiveCheckpoint: true, // Simulates context injector reading feature state
    };

    const result: any = await rollback.execute(
      { summary: 'Approach A failed because of X. Try B instead.' },
      mockContext,
    );

    assert(registeredRequest !== null, 'Should register continuation request');
    assert(registeredRequest.kind === 'rollback', 'Should be rollback kind');
    assert(registeredRequest.checkpointId === '__active__', 'Should use fixed checkpoint ID');
    assert(typeof registeredRequest.summary === 'string', 'Should include summary');
    assert(result?.message !== undefined, 'Should return success message');
  }

  // ── Test 5: summary validation ──
  console.log('Test 5: summary validation');
  {
    const feature = new CheckpointFeature();
    const tools = feature.getTools()!;
    const rollback = tools[1];

    // Empty summary
    const mockContext = {
      registerContinuationRequest: () => {},
      hasActiveCheckpoint: true,
    };

    const emptyResult: any = await rollback.execute({ summary: '' }, mockContext);
    assert(emptyResult?.error !== undefined, 'Empty summary should fail');

    const whitespaceResult: any = await rollback.execute({ summary: '   ' }, mockContext);
    assert(whitespaceResult?.error !== undefined, 'Whitespace-only summary should fail');

    // Too long summary (> 2000 chars)
    const longSummary = 'x'.repeat(2001);
    const longResult: any = await rollback.execute({ summary: longSummary }, mockContext);
    assert(longResult?.error !== undefined, 'Summary > 2000 chars should fail');
  }

  // ── Test 6: captureState/restoreState ──
  console.log('Test 6: captureState/restoreState');
  {
    const feature = new CheckpointFeature();

    // Initially no active checkpoint
    let state = feature.captureState() as any;
    assert(state.hasActiveCheckpoint === false, 'Initial state should have no active checkpoint');

    // Set a checkpoint
    const tools = feature.getTools()!;
    await tools[0].execute({ note: 'test' }, { registerContinuationRequest: () => {} });

    // Now should have active checkpoint
    state = feature.captureState() as any;
    assert(state.hasActiveCheckpoint === true, 'After set_checkpoint, state should have active checkpoint');

    // Restore to no-checkpoint state
    feature.restoreState({ hasActiveCheckpoint: false });
    state = feature.captureState() as any;
    assert(state.hasActiveCheckpoint === false, 'After restoreState(false), should have no active checkpoint');

    // Restore to checkpoint state
    feature.restoreState({ hasActiveCheckpoint: true });
    state = feature.captureState() as any;
    assert(state.hasActiveCheckpoint === true, 'After restoreState(true), should have active checkpoint');

    // Restore null/undefined should default to false
    feature.restoreState(null);
    state = feature.captureState() as any;
    assert(state.hasActiveCheckpoint === false, 'Restore null should default to false');
  }

  // ── Test 7: context injector ──
  console.log('Test 7: context injector');
  {
    const feature = new CheckpointFeature();
    const injectors = feature.getContextInjectors!();

    assert(injectors.size === 1, 'Should have exactly 1 context injector');

    // Context injectors are keyed by string | RegExp; iterate to find matching injector
    function getInjected(toolName: string): any {
      for (const [key, fn] of injectors) {
        if (typeof key === 'string') {
          if (key === toolName) return fn({ name: toolName });
        } else {
          if (key.test(toolName)) return fn({ name: toolName });
        }
      }
      return null;
    }

    // Initially no active checkpoint
    let injected = getInjected('rollback_to_checkpoint');
    assert(injected?.hasActiveCheckpoint === false, 'Initial inject should be false');

    // Set a checkpoint
    const tools = feature.getTools()!;
    await tools[0].execute({}, { registerContinuationRequest: () => {} });

    injected = getInjected('rollback_to_checkpoint');
    assert(injected?.hasActiveCheckpoint === true, 'After set_checkpoint, inject should be true');
  }

  // ── Summary ──
  console.log(`\n[${failed === 0 ? 'PASS' : 'FAIL'}] ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exitCode = 1;
});
