/**
 * CheckpointFeature smoke test (node:test format)
 *
 * Validates:
 * 1. Tool registration (names, executionMode, parameter schema)
 * 2. set_checkpoint registers continuation request
 * 3. rollback_to_checkpoint fails without active checkpoint
 * 4. rollback_to_checkpoint succeeds with active checkpoint
 * 5. Summary validation (empty, whitespace, too long)
 * 6. captureState/restoreState
 * 7. Context injector
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointFeature } from '../src/index.js';

describe('CheckpointFeature', () => {

  describe('Tool registration', () => {
    it('should have exactly 2 tools', () => {
      const feature = new CheckpointFeature();
      const tools = feature.getTools()!;
      assert.equal(tools.length, 2);
    });

    it('should have correct tool names', () => {
      const feature = new CheckpointFeature();
      const tools = feature.getTools()!;
      assert.equal(tools[0].name, 'set_checkpoint');
      assert.equal(tools[1].name, 'rollback_to_checkpoint');
    });

    it('should have exclusive executionMode on both tools', () => {
      const feature = new CheckpointFeature();
      const tools = feature.getTools()!;
      assert.equal(tools[0].executionMode, 'exclusive');
      assert.equal(tools[1].executionMode, 'exclusive');
    });

    it('should have note parameter on set_checkpoint', () => {
      const feature = new CheckpointFeature();
      const tools = feature.getTools()!;
      const params = tools[0].parameters as any;
      assert.equal(params?.properties?.note?.type, 'string');
    });

    it('should have required summary parameter on rollback_to_checkpoint', () => {
      const feature = new CheckpointFeature();
      const tools = feature.getTools()!;
      const params = tools[1].parameters as any;
      assert.equal(params?.properties?.summary?.type, 'string');
      assert.ok(Array.isArray(params?.required) && params.required.includes('summary'));
    });
  });

  describe('set_checkpoint', () => {
    it('should register a checkpoint continuation request', async () => {
      const feature = new CheckpointFeature();
      const tools = feature.getTools()!;
      const setCheckpoint = tools[0];

      let registeredRequest: any = null;
      const mockContext = {
        registerContinuationRequest: (req: any) => { registeredRequest = req; },
      };

      await setCheckpoint.execute({ note: 'trying approach A' }, mockContext);

      assert.ok(registeredRequest !== null);
      assert.equal(registeredRequest.kind, 'checkpoint');
      assert.equal(registeredRequest.checkpointId, '__active__');
      assert.equal(registeredRequest.metadata?.note, 'trying approach A');
    });
  });

  describe('rollback_to_checkpoint', () => {
    it('should fail without active checkpoint', async () => {
      const feature = new CheckpointFeature();
      const tools = feature.getTools()!;
      const rollback = tools[1];

      let registeredRequest: any = null;
      const mockContext = {
        registerContinuationRequest: (req: any) => { registeredRequest = req; },
        hasActiveCheckpoint: false,
      };

      const result: any = await rollback.execute({ summary: 'test summary' }, mockContext);

      assert.equal(registeredRequest, null);
      assert.ok(result?.error !== undefined);
      assert.match(result.error, /No active checkpoint/);
    });

    it('should succeed with active checkpoint', async () => {
      const feature = new CheckpointFeature();
      const tools = feature.getTools()!;
      const setCheckpoint = tools[0];
      const rollback = tools[1];

      await setCheckpoint.execute({ note: 'before exploration' }, {
        registerContinuationRequest: () => {},
      });

      let registeredRequest: any = null;
      const mockContext = {
        registerContinuationRequest: (req: any) => { registeredRequest = req; },
        hasActiveCheckpoint: true,
      };

      const result: any = await rollback.execute(
        { summary: 'Approach A failed because of X. Try B instead.' },
        mockContext,
      );

      assert.ok(registeredRequest !== null);
      assert.equal(registeredRequest.kind, 'rollback');
      assert.equal(registeredRequest.checkpointId, '__active__');
      assert.equal(typeof registeredRequest.summary, 'string');
      assert.ok(result?.message !== undefined);
    });

    it('should reject empty summary', async () => {
      const feature = new CheckpointFeature();
      const tools = feature.getTools()!;
      const rollback = tools[1];
      const mockContext = {
        registerContinuationRequest: () => {},
        hasActiveCheckpoint: true,
      };

      const result: any = await rollback.execute({ summary: '' }, mockContext);
      assert.ok(result?.error !== undefined);
    });

    it('should reject whitespace-only summary', async () => {
      const feature = new CheckpointFeature();
      const tools = feature.getTools()!;
      const rollback = tools[1];
      const mockContext = {
        registerContinuationRequest: () => {},
        hasActiveCheckpoint: true,
      };

      const result: any = await rollback.execute({ summary: '   ' }, mockContext);
      assert.ok(result?.error !== undefined);
    });

    it('should reject summary over 2000 chars', async () => {
      const feature = new CheckpointFeature();
      const tools = feature.getTools()!;
      const rollback = tools[1];
      const mockContext = {
        registerContinuationRequest: () => {},
        hasActiveCheckpoint: true,
      };

      const result: any = await rollback.execute({ summary: 'x'.repeat(2001) }, mockContext);
      assert.ok(result?.error !== undefined);
    });
  });

  describe('captureState / restoreState', () => {
    it('should capture and restore checkpoint state', async () => {
      const feature = new CheckpointFeature();

      // Initially no active checkpoint
      let state = feature.captureState() as any;
      assert.equal(state.hasActiveCheckpoint, false);

      // Set a checkpoint
      const tools = feature.getTools()!;
      await tools[0].execute({ note: 'test' }, { registerContinuationRequest: () => {} });

      // Now should have active checkpoint
      state = feature.captureState() as any;
      assert.equal(state.hasActiveCheckpoint, true);

      // Restore to no-checkpoint state
      feature.restoreState({ hasActiveCheckpoint: false });
      state = feature.captureState() as any;
      assert.equal(state.hasActiveCheckpoint, false);

      // Restore to checkpoint state
      feature.restoreState({ hasActiveCheckpoint: true });
      state = feature.captureState() as any;
      assert.equal(state.hasActiveCheckpoint, true);

      // Restore null should default to false
      feature.restoreState(null);
      state = feature.captureState() as any;
      assert.equal(state.hasActiveCheckpoint, false);
    });
  });

  describe('Context injector', () => {
    it('should inject hasActiveCheckpoint state', async () => {
      const feature = new CheckpointFeature();
      const injectors = feature.getContextInjectors!();

      assert.equal(injectors.size, 1);

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
      assert.equal(injected?.hasActiveCheckpoint, false);

      // Set a checkpoint
      const tools = feature.getTools()!;
      await tools[0].execute({}, { registerContinuationRequest: () => {} });

      injected = getInjected('rollback_to_checkpoint');
      assert.equal(injected?.hasActiveCheckpoint, true);
    });
  });
});
