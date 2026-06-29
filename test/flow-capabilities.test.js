/**
 * Tests for server/routes/flow.js — Flow capability aggregation helpers.
 *
 * Covers:
 * 1. normalizeBuiltInCapabilityId — PascalCase Feature export name → kebab-case ID
 * 2. graphToRuntimeFlowsForCapabilities — BFS algorithm converting editor graph
 *    (nodes + edges + workflows) into runtime flow objects:
 *    - null/empty/legacy graphs
 *    - workflow-head partitioning
 *    - connected component fallback
 *    - auto-mode enforcement (only one auto per graph)
 *    - position/workflowId stripping from runtime nodes
 *
 * Uses node:test format per project convention (test/*.test.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBuiltInCapabilityId,
  graphToRuntimeFlowsForCapabilities,
} from '../server/routes/flow.js';

// ─── normalizeBuiltInCapabilityId ──────────────────────────────────

describe('normalizeBuiltInCapabilityId', () => {
  it('should convert simple PascalCase Feature names', () => {
    assert.strictEqual(normalizeBuiltInCapabilityId('SkillFeature'), 'skill');
    assert.strictEqual(normalizeBuiltInCapabilityId('ShellFeature'), 'shell');
    assert.strictEqual(normalizeBuiltInCapabilityId('TtsFeature'), 'tts');
    assert.strictEqual(normalizeBuiltInCapabilityId('MemoryFeature'), 'memory');
  });

  it('should convert multi-word PascalCase names with hyphens', () => {
    assert.strictEqual(normalizeBuiltInCapabilityId('UserInputFeature'), 'user-input');
    assert.strictEqual(normalizeBuiltInCapabilityId('WebSearchFeature'), 'web-search');
    assert.strictEqual(normalizeBuiltInCapabilityId('AudioFeedbackFeature'), 'audio-feedback');
  });

  it('should handle consecutive uppercase prefixes (no extra hyphen)', () => {
    assert.strictEqual(normalizeBuiltInCapabilityId('QQBotFeature'), 'qqbot');
    assert.strictEqual(normalizeBuiltInCapabilityId('TTSFeature'), 'tts');
  });

  it('should handle digit boundaries', () => {
    assert.strictEqual(normalizeBuiltInCapabilityId('Foo2BarFeature'), 'foo2-bar');
    assert.strictEqual(normalizeBuiltInCapabilityId('Mp3Feature'), 'mp3');
  });

  it('should handle null/empty/non-string input', () => {
    assert.strictEqual(normalizeBuiltInCapabilityId(''), '');
    assert.strictEqual(normalizeBuiltInCapabilityId(null), '');
    assert.strictEqual(normalizeBuiltInCapabilityId(undefined), '');
  });

  it('should still process names without Feature suffix', () => {
    assert.strictEqual(normalizeBuiltInCapabilityId('UserInput'), 'user-input');
    assert.strictEqual(normalizeBuiltInCapabilityId('NotAFeature'), 'not-a');
  });
});

// ─── graphToRuntimeFlowsForCapabilities ────────────────────────────

describe('graphToRuntimeFlowsForCapabilities', () => {
  // ── Edge cases ───────────────────────────────────────────────

  it('should return [] for null/undefined graph', () => {
    assert.deepEqual(graphToRuntimeFlowsForCapabilities(null), []);
    assert.deepEqual(graphToRuntimeFlowsForCapabilities(undefined), []);
  });

  it('should return [] when graph has no nodes array', () => {
    assert.deepEqual(graphToRuntimeFlowsForCapabilities({ edges: [] }), []);
    assert.deepEqual(graphToRuntimeFlowsForCapabilities({}), []);
  });

  it('should return [] for empty nodes array', () => {
    assert.deepEqual(graphToRuntimeFlowsForCapabilities({ nodes: [], edges: [] }), []);
  });

  // ── Legacy single-flow graph ────────────────────────────────

  it('should return graph as-is for legacy format (mode+entry, no workflows)', () => {
    const graph = {
      nodes: [{ id: 'n1', prompt: 'hello' }],
      edges: [],
      mode: 'auto',
      entry: 'n1',
      // no workflows key
    };
    const result = graphToRuntimeFlowsForCapabilities(graph);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], graph);
  });

  // ── Workflow-head partitioning ──────────────────────────────

  it('should partition nodes by workflow-head into separate flows', () => {
    const graph = {
      nodes: [
        { id: 'wh1', type: 'workflow-head', workflowId: 'wf1' },
        { id: 'n1', prompt: 'task A' },
        { id: 'n2', prompt: 'task B' },
        { id: 'wh2', type: 'workflow-head', workflowId: 'wf2' },
        { id: 'n3', prompt: 'task C' },
      ],
      edges: [
        { from: 'wh1', to: 'n1' },
        { from: 'n1', to: 'n2' },
        { from: 'wh2', to: 'n3' },
      ],
      workflows: {},
    };
    const result = graphToRuntimeFlowsForCapabilities(graph);
    assert.strictEqual(result.length, 2);

    // First workflow: wh1 → n1 → n2
    assert.strictEqual(result[0].id, 'wf1');
    assert.strictEqual(result[0].nodes.length, 2); // excludes workflow-head
    assert.strictEqual(result[0].entry, 'n1'); // first edge from head

    // Second workflow: wh2 → n3
    assert.strictEqual(result[1].id, 'wf2');
    assert.strictEqual(result[1].nodes.length, 1);
    assert.strictEqual(result[1].entry, 'n3');
  });

  it('should strip position and workflowId from runtime nodes', () => {
    const graph = {
      nodes: [
        { id: 'wh1', type: 'workflow-head', workflowId: 'wf1' },
        {
          id: 'n1', prompt: 'task', position: { x: 100, y: 200 }, workflowId: 'wf1',
        },
      ],
      edges: [{ from: 'wh1', to: 'n1' }],
      workflows: {},
    };
    const [flow] = graphToRuntimeFlowsForCapabilities(graph);
    assert.strictEqual(flow.nodes[0].position, undefined);
    assert.strictEqual(flow.nodes[0].workflowId, undefined);
    assert.strictEqual(flow.nodes[0].prompt, 'task'); // other fields preserved
  });

  it('should filter workflow-head nodes from runtime nodes', () => {
    const graph = {
      nodes: [
        { id: 'wh1', type: 'workflow-head', workflowId: 'wf1' },
        { id: 'n1', prompt: 'a' },
      ],
      edges: [{ from: 'wh1', to: 'n1' }],
      workflows: {},
    };
    const [flow] = graphToRuntimeFlowsForCapabilities(graph);
    assert.ok(!flow.nodes.some((n) => n.type === 'workflow-head'));
  });

  it('should return null (filtered out) for workflow-head with no runtime nodes', () => {
    const graph = {
      nodes: [
        { id: 'wh1', type: 'workflow-head', workflowId: 'wf1' },
        { id: 'wh2', type: 'workflow-head', workflowId: 'wf2' },
        { id: 'n1', prompt: 'a' },
      ],
      edges: [
        { from: 'wh1', to: 'n1' },
        // wh2 has no edges to runtime nodes
      ],
      workflows: {},
    };
    const result = graphToRuntimeFlowsForCapabilities(graph);
    assert.strictEqual(result.length, 1); // only wf1 survives
    assert.strictEqual(result[0].id, 'wf1');
  });

  // ── Entry resolution ────────────────────────────────────────

  it('should prefer meta.runtimeEntry, then meta.entry, then first edge target', () => {
    const graph = {
      nodes: [
        { id: 'wh1', type: 'workflow-head', workflowId: 'wf1' },
        { id: 'n1', prompt: 'first' },
        { id: 'n2', prompt: 'second' },
      ],
      edges: [
        { from: 'wh1', to: 'n1' },
        { from: 'n1', to: 'n2' },
      ],
      workflows: {
        wf1: { entry: 'n2' },
      },
    };
    const [flow] = graphToRuntimeFlowsForCapabilities(graph);
    assert.strictEqual(flow.entry, 'n2'); // meta.entry wins over first edge
  });

  it('should fall back to first edge target when meta entry is missing', () => {
    const graph = {
      nodes: [
        { id: 'wh1', type: 'workflow-head', workflowId: 'wf1' },
        { id: 'n1', prompt: 'first' },
        { id: 'n2', prompt: 'second' },
      ],
      edges: [
        { from: 'wh1', to: 'n2' },
        { from: 'n2', to: 'n1' },
      ],
      workflows: {},
    };
    const [flow] = graphToRuntimeFlowsForCapabilities(graph);
    assert.strictEqual(flow.entry, 'n2'); // first edge from head
  });

  // ── Auto-mode enforcement ───────────────────────────────────

  it('should allow only one auto workflow; demote the rest to agent-initiated', () => {
    const graph = {
      nodes: [
        { id: 'wh1', type: 'workflow-head', workflowId: 'wf1' },
        { id: 'n1', prompt: 'a' },
        { id: 'wh2', type: 'workflow-head', workflowId: 'wf2' },
        { id: 'n2', prompt: 'b' },
      ],
      edges: [
        { from: 'wh1', to: 'n1' },
        { from: 'wh2', to: 'n2' },
      ],
      workflows: {
        wf1: { mode: 'auto' },
        wf2: { mode: 'auto' },
      },
    };
    const result = graphToRuntimeFlowsForCapabilities(graph);
    assert.strictEqual(result[0].mode, 'auto');
    assert.strictEqual(result[1].mode, 'agent-initiated');
  });

  it('should default mode to agent-initiated when not specified', () => {
    const graph = {
      nodes: [
        { id: 'wh1', type: 'workflow-head', workflowId: 'wf1' },
        { id: 'n1', prompt: 'a' },
      ],
      edges: [{ from: 'wh1', to: 'n1' }],
      workflows: {},
    };
    const [flow] = graphToRuntimeFlowsForCapabilities(graph);
    assert.strictEqual(flow.mode, 'agent-initiated');
  });

  // ── Connected component fallback (no workflow-head nodes) ───

  it('should use connected components when no workflow-head nodes exist', () => {
    const graph = {
      nodes: [
        { id: 'n1', prompt: 'a', workflowId: 'wf1' },
        { id: 'n2', prompt: 'b', workflowId: 'wf1' },
        { id: 'n3', prompt: 'c', workflowId: 'wf2' },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        // n3 is isolated → own component
      ],
      workflows: {},
    };
    const result = graphToRuntimeFlowsForCapabilities(graph);
    assert.strictEqual(result.length, 2);

    // Component 1: n1 → n2, workflowId determined by majority vote
    assert.strictEqual(result[0].nodes.length, 2);

    // Component 2: n3 alone
    assert.strictEqual(result[1].nodes.length, 1);
  });

  it('should infer workflowId by majority vote in connected component fallback', () => {
    const graph = {
      nodes: [
        { id: 'n1', prompt: 'a', workflowId: 'wfX' },
        { id: 'n2', prompt: 'b', workflowId: 'wfX' },
        { id: 'n3', prompt: 'c', workflowId: 'wfY' },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
      ],
      workflows: {},
    };
    const [flow] = graphToRuntimeFlowsForCapabilities(graph);
    assert.strictEqual(flow.id, 'wfX'); // 2 out of 3 nodes
  });

  // ── Edge filtering ──────────────────────────────────────────

  it('should exclude edges to workflow-head nodes from runtime edges', () => {
    const graph = {
      nodes: [
        { id: 'wh1', type: 'workflow-head', workflowId: 'wf1' },
        { id: 'n1', prompt: 'a' },
        { id: 'n2', prompt: 'b' },
      ],
      edges: [
        { from: 'wh1', to: 'n1' },   // head edge — excluded from runtime
        { from: 'n1', to: 'n2' },     // runtime edge — included
        { from: 'n2', to: 'wh1' },    // head edge — excluded
      ],
      workflows: {},
    };
    const [flow] = graphToRuntimeFlowsForCapabilities(graph);
    assert.strictEqual(flow.edges.length, 1);
    assert.strictEqual(flow.edges[0].from, 'n1');
    assert.strictEqual(flow.edges[0].to, 'n2');
  });

  // ── Default values ──────────────────────────────────────────

  it('should set default reminderFrequency and empty variables/prompts', () => {
    const graph = {
      nodes: [
        { id: 'wh1', type: 'workflow-head', workflowId: 'wf1' },
        { id: 'n1', prompt: 'a' },
      ],
      edges: [{ from: 'wh1', to: 'n1' }],
      workflows: {},
    };
    const [flow] = graphToRuntimeFlowsForCapabilities(graph);
    assert.strictEqual(flow.reminderFrequency, 'every-step');
    assert.strictEqual(flow.reminderInterval, undefined);
    assert.deepEqual(flow.variables, {});
    assert.deepEqual(flow.prompts, []);
  });
});
