/**
 * Tests for Feature dynamic mount/unmount lifecycle
 *
 * Covers:
 * - mountFeature after agent initialization: tools + hooks are immediately registered
 * - mountFeature before agent initialization: deferred to ensureFeatureTools
 * - removeFeature: tools AND hooks are properly cleaned up
 * - onFeatureToolsReady: runs during initial batch but not for individual mounts
 *
 * Uses the real Agent class imported from agentdev dist.
 * Hooks decorators are applied manually (legacy TS decorator signature) since
 * the test file is plain JS ESM.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, CallStart } from 'agentdev';

// ── Helpers ──

/** Create a mock LLM that returns a simple text response */
function createMockLLM() {
  return {
    modelName: 'mock-model',
    async chat() {
      return { content: 'OK' };
    },
  };
}

/**
 * Apply a hooks decorator manually to a class method.
 * Works with legacy TypeScript decorator signature: (target, propertyKey, descriptor)
 */
function applyDecorator(decoratorFn, ClassProto, methodName) {
  const desc = Object.getOwnPropertyDescriptor(ClassProto, methodName);
  decoratorFn(ClassProto, methodName, desc);
  Object.defineProperty(ClassProto, methodName, desc);
}

/** Create a feature class with a CallStart hook and tools */
function createFeatureClass(opts = {}) {
  const {
    name = 'test-feature',
    toolName = 'test_tool',
    hookMethod = 'handleCallStart',
  } = opts;

  class FeatureClass {
    constructor() {
      this.name = name;
      this.initiateCalled = false;
      this.hookCalled = false;
    }

    async [hookMethod](_ctx) {
      this.hookCalled = true;
    }

    getTools() {
      return [{
        name: toolName,
        description: `Tool from ${name}`,
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ result: 'ok' }),
      }];
    }

    async onInitiate(_ctx) {
      this.initiateCalled = true;
    }

    onDestroy() {}
  }

  // Apply CallStart decorator to the hook method
  applyDecorator(CallStart, FeatureClass.prototype, hookMethod);

  return FeatureClass;
}

/** Count CallStart hooks for a given feature name */
function countCallStartHooks(agent, featureName) {
  const snapshot = agent.hooksRegistry.getSnapshot();
  const callStartEntry = snapshot.find(s => s.lifecycle === 'CallStart');
  if (!callStartEntry) return 0;
  if (featureName) {
    return callStartEntry.entries.filter(e => e.featureName === featureName).length;
  }
  return callStartEntry.entries.length;
}

/** Get all tool names from agent's ToolRegistry */
function getToolNames(agent) {
  return agent.tools.getEntries().map(e => e.tool.name);
}

// ── Tests ──

describe('Feature dynamic mount/unmount lifecycle', () => {

  describe('mountFeature after agent initialization', () => {
    let agent;

    beforeEach(async () => {
      agent = new Agent({ llm: createMockLLM() });
      // Trigger initialization by calling onCall once
      await agent.onCall('init');
      assert.equal(agent.featureToolsReady, true);
    });

    it('immediately registers the new feature\'s tools', async () => {
      const FeatureClass = createFeatureClass({ name: 'dyn-tools', toolName: 'dyn_tool' });
      const feature = new FeatureClass();

      assert.equal(getToolNames(agent).includes('dyn_tool'), false);

      await agent.mountFeature(feature);

      assert.equal(getToolNames(agent).includes('dyn_tool'), true);
      const entry = agent.tools.getEntries().find(e => e.tool.name === 'dyn_tool');
      assert.equal(entry.state, 'enabled');
    });

    it('immediately collects the new feature\'s hooks', async () => {
      const FeatureClass = createFeatureClass({ name: 'dyn-hooks', toolName: 'hook_tool' });
      const feature = new FeatureClass();

      assert.equal(countCallStartHooks(agent, 'dyn-hooks'), 0);

      await agent.mountFeature(feature);

      assert.equal(countCallStartHooks(agent, 'dyn-hooks'), 1);
    });

    it('calls onInitiate for the dynamically mounted feature', async () => {
      const FeatureClass = createFeatureClass({ name: 'dyn-init', toolName: 'init_tool' });
      const feature = new FeatureClass();

      assert.equal(feature.initiateCalled, false);

      await agent.mountFeature(feature);

      assert.equal(feature.initiateCalled, true);
    });

    it('does not re-run onFeatureToolsReady for individual mounts', async () => {
      // onFeatureToolsReady runs once after the initial batch.
      // For individual mounts, it should NOT run again.
      // We verify by checking that a tool registered in onFeatureToolsReady
      // doesn't get duplicated.
      let readyCallCount = 0;
      agent.onFeatureToolsReady = async function () {
        readyCallCount++;
      };

      // Re-init: call onCall again won't re-trigger ensureFeatureTools (already ready)
      const FeatureClass = createFeatureClass({ name: 'dyn-ready', toolName: 'ready_tool' });
      await agent.mountFeature(new FeatureClass());

      assert.equal(readyCallCount, 0, 'onFeatureToolsReady should not run for individual mounts');
    });
  });

  describe('mountFeature before agent initialization', () => {
    it('defers initialization to ensureFeatureTools (behaves like use)', async () => {
      const agent = new Agent({ llm: createMockLLM() });
      assert.equal(agent.featureToolsReady, false);

      const FeatureClass = createFeatureClass({ name: 'pre-init', toolName: 'pre_tool' });
      const feature = new FeatureClass();

      await agent.mountFeature(feature);

      // Feature is in the Map but not yet initialized
      assert.equal(agent.features.has('pre-init'), true);
      assert.equal(getToolNames(agent).includes('pre_tool'), false);
      assert.equal(countCallStartHooks(agent, 'pre-init'), 0);
      assert.equal(feature.initiateCalled, false);

      // Now trigger initialization
      await agent.onCall('test');

      // After init, tools and hooks should be present
      assert.equal(getToolNames(agent).includes('pre_tool'), true);
      assert.equal(countCallStartHooks(agent, 'pre-init'), 1);
      assert.equal(feature.initiateCalled, true);
    });
  });

  describe('removeFeature hooks cleanup', () => {
    it('removes both tools and hooks when feature is removed', async () => {
      const agent = new Agent({ llm: createMockLLM() });

      const FeatureClass = createFeatureClass({ name: 'removable', toolName: 'removable_tool' });
      const feature = new FeatureClass();
      agent.use(feature);

      // Initialize
      await agent.onCall('init');

      // Verify presence
      assert.equal(getToolNames(agent).includes('removable_tool'), true);
      assert.equal(countCallStartHooks(agent, 'removable'), 1);

      // Remove
      agent.removeFeature('removable');

      // Tool should be removed
      const toolEntry = agent.tools.getEntries().find(e => e.tool.name === 'removable_tool');
      assert.ok(toolEntry);
      assert.equal(toolEntry.state, 'removed');

      // Hook should also be removed
      assert.equal(countCallStartHooks(agent, 'removable'), 0);
    });

    it('does not affect other features\' hooks when removing one', async () => {
      const agent = new Agent({ llm: createMockLLM() });

      const ClassA = createFeatureClass({ name: 'feature-a', toolName: 'tool_a' });
      const ClassB = createFeatureClass({ name: 'feature-b', toolName: 'tool_b' });
      agent.use(new ClassA());
      agent.use(new ClassB());

      await agent.onCall('init');

      assert.equal(countCallStartHooks(agent, 'feature-a'), 1);
      assert.equal(countCallStartHooks(agent, 'feature-b'), 1);

      agent.removeFeature('feature-a');

      assert.equal(countCallStartHooks(agent, 'feature-a'), 0);
      assert.equal(countCallStartHooks(agent, 'feature-b'), 1);
    });

    it('cleans up hooks after dynamic mount then unmount', async () => {
      const agent = new Agent({ llm: createMockLLM() });
      await agent.onCall('init');

      const FeatureClass = createFeatureClass({ name: 'dyn-removable', toolName: 'dyn_rem_tool' });

      // Mount
      await agent.mountFeature(new FeatureClass());
      assert.equal(countCallStartHooks(agent, 'dyn-removable'), 1);
      assert.equal(getToolNames(agent).includes('dyn_rem_tool'), true);

      // Unmount
      agent.removeFeature('dyn-removable');
      assert.equal(countCallStartHooks(agent, 'dyn-removable'), 0);

      const toolEntry = agent.tools.getEntries().find(e => e.tool.name === 'dyn_rem_tool');
      assert.ok(toolEntry);
      assert.equal(toolEntry.state, 'removed');
    });

    it('warns when removing a non-existent feature', () => {
      const agent = new Agent({ llm: createMockLLM() });
      // Should not throw
      agent.removeFeature('does-not-exist');
      assert.equal(agent.features.has('does-not-exist'), false);
    });
  });

  describe('mountFeature + removeFeature round-trip', () => {
    it('can mount, unmount, then re-mount the same feature name', async () => {
      const agent = new Agent({ llm: createMockLLM() });
      await agent.onCall('init');

      const FeatureClass = createFeatureClass({ name: 'roundtrip', toolName: 'rt_tool' });

      // First mount
      await agent.mountFeature(new FeatureClass());
      assert.equal(countCallStartHooks(agent, 'roundtrip'), 1);
      assert.equal(getToolNames(agent).includes('rt_tool'), true);

      // Unmount
      agent.removeFeature('roundtrip');
      assert.equal(countCallStartHooks(agent, 'roundtrip'), 0);

      // Re-mount
      await agent.mountFeature(new FeatureClass());
      assert.equal(countCallStartHooks(agent, 'roundtrip'), 1);
      assert.equal(getToolNames(agent).includes('rt_tool'), true);
    });
  });
});
