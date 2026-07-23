/**
 * FlowFeature test (node:test format)
 *
 * Validates branching flows and interactive edges.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FlowFeature } from '../src/index.js';
import type { FlowGraph } from '../src/types.js';

function createContextRecorder() {
  const messages: string[] = [];
  return {
    messages,
    context: {
      add(message: { role: string; content: string }) {
        messages.push(String(message?.content || ''));
      },
    },
  };
}

describe('FlowFeature', () => {

  describe('Branching flow', () => {
    const branchFlow: FlowGraph = {
      id: 'branching-flow',
      name: '分支流程',
      description: '用于验证 complete_node 的显式分支选择。',
      mode: 'auto',
      entry: 'start',
      reminderFrequency: 'every-step',
      nodes: [
        { id: 'start', name: '开始', prompt: '起始节点' },
        { id: 'path-a', name: '路径A', prompt: 'A 节点' },
        { id: 'path-b', name: '路径B', prompt: 'B 节点' },
      ],
      edges: [
        { from: 'start', to: 'path-a' },
        { from: 'start', to: 'path-b' },
      ],
    };

    it('should expose flow summary via getFlowVariables', () => {
      const feature = new FlowFeature({
        flows: [branchFlow],
        autoInjectStatus: true,
      });

      const vars = feature.getFlowVariables();
      const flowSummary = vars.find(item => item.key === 'flowSummaryText')?.resolver();
      assert.ok(String(flowSummary).includes('[自动进入] 分支流程'));
    });

    it('should reject ambiguous branching without explicit target', async () => {
      const feature = new FlowFeature({
        flows: [branchFlow],
        autoInjectStatus: true,
      });

      const { context } = createContextRecorder();
      const agent = { features: new Map(), getToolRegistry: () => null };
      await feature.handleCallStart({ agent, context });
      await feature.handleStepStart({ agent, context });

      const completeNode = feature.getTools().find(tool => tool.name === 'complete_node')!;
      const result = await completeNode.execute({});

      const res = result as Record<string, unknown>;
      assert.equal(res.success, false);
      assert.match(String(res.error || ''), /必须指定 nextNodeId 或 nextNodeName/);
    });

    it('should accept explicit nextNodeName', async () => {
      const feature = new FlowFeature({
        flows: [branchFlow],
        autoInjectStatus: true,
      });

      const { context } = createContextRecorder();
      const agent = { features: new Map(), getToolRegistry: () => null };
      await feature.handleCallStart({ agent, context });
      await feature.handleStepStart({ agent, context });

      const completeNode = feature.getTools().find(tool => tool.name === 'complete_node')!;
      const result = await completeNode.execute({ nextNodeName: '路径B' });

      const res = result as Record<string, unknown>;
      assert.equal(res.success, true);
      assert.match(String(res.message || ''), /路径B/);
    });

    it('should apply queued transition at next StepStart', async () => {
      const feature = new FlowFeature({
        flows: [branchFlow],
        autoInjectStatus: true,
      });

      const { context } = createContextRecorder();
      const agent = { features: new Map(), getToolRegistry: () => null };
      await feature.handleCallStart({ agent, context });
      await feature.handleStepStart({ agent, context });

      const completeNode = feature.getTools().find(tool => tool.name === 'complete_node')!;
      await completeNode.execute({ nextNodeName: '路径B' });

      await feature.handleStepStart({ agent, context });
      const snapshot = feature.captureState() as { currentNodeId: string | null };
      assert.equal(snapshot.currentNodeId, 'path-b');
    });
  });

  describe('Interactive edge (model-generated)', () => {
    const interactiveFlow: FlowGraph = {
      id: 'interactive-flow',
      name: '交互流程',
      description: '用于验证边级交互会拦截 complete_node 状态转移。',
      mode: 'auto',
      entry: 'start',
      reminderFrequency: 'every-step',
      nodes: [
        { id: 'start', name: '开始', prompt: '起始节点' },
        { id: 'review', name: '审核', prompt: '审核节点' },
      ],
      edges: [
        {
          from: 'start',
          to: 'review',
          interaction: {
            mode: 'model-generated',
            guidanceMessage: '请重新调用 complete_node，并在 interactionRequest 中提供决策标题、说明和选项。',
          },
        },
      ],
    };

    function createInteractiveAgent() {
      let requestedPrompt = '';
      let requestedQuestions: any[] = [];
      const toolStates = new Map<string, 'enabled' | 'disabled' | 'removed'>([
        ['complete_node', 'enabled'],
        ['exit_flow', 'enabled'],
        ['ask_user_choice', 'enabled'],
        ['ask_user_choices', 'enabled'],
      ]);
      const mockToolRegistry = {
        getEntries() {
          return [...toolStates.entries()].map(([name, state]) => ({ tool: { name }, state }));
        },
        enable(name: string) { toolStates.set(name, 'enabled'); },
        disable(name: string) { toolStates.set(name, 'disabled'); },
        remove(name: string) { toolStates.set(name, 'removed'); },
      };
      const interactionFeature = {
        async requestUserChoices(prompt: string, questions: any[]) {
          requestedPrompt = prompt;
          requestedQuestions = questions;
          return [{ questionId: questions[0]?.id, optionId: 'approve' }];
        },
      };
      const agent = {
        features: new Map([['user-input', interactionFeature]]),
        getToolRegistry: () => mockToolRegistry,
        getFeature(name: string) { return this.features.get(name); },
      };
      return { agent, mockToolRegistry, toolStates, interactionFeature, getRequestedPrompt: () => requestedPrompt, getRequestedQuestions: () => requestedQuestions };
    }

    it('should reject first plain complete_node on guided-retry edge', async () => {
      const helper = createInteractiveAgent();
      const feature = new FlowFeature({ flows: [interactiveFlow], autoInjectStatus: true });

      const { context } = createContextRecorder();
      await feature.handleCallStart({ agent: helper.agent, context });
      await feature.handleStepStart({ agent: helper.agent, context });

      const completeNode = feature.getTools().find(tool => tool.name === 'complete_node')!;
      const result = await (completeNode.execute as any)({});

      assert.equal(result.success, false);
      assert.match(String(result.error || ''), /interactionRequest/);
    });

    it('should remove ask_user tools while waiting for retry', async () => {
      const helper = createInteractiveAgent();
      const feature = new FlowFeature({ flows: [interactiveFlow], autoInjectStatus: true });

      const { context } = createContextRecorder();
      await feature.handleCallStart({ agent: helper.agent, context });
      await feature.handleStepStart({ agent: helper.agent, context });

      const completeNode = feature.getTools().find(tool => tool.name === 'complete_node')!;
      await (completeNode.execute as any)({});

      const recorder = createContextRecorder();
      await feature.handleStepStart({ agent: helper.agent, context: recorder.context });

      assert.ok(recorder.messages.some(m => m.includes('不要直接调用 ask_user_choice')));
      assert.equal(helper.toolStates.get('ask_user_choice'), 'removed');
      assert.equal(helper.toolStates.get('ask_user_choices'), 'removed');
    });

    it('should pass through interactive edge after confirmed choice', async () => {
      const helper = createInteractiveAgent();
      const feature = new FlowFeature({ flows: [interactiveFlow], autoInjectStatus: true });

      const { context } = createContextRecorder();
      await feature.handleCallStart({ agent: helper.agent, context });
      await feature.handleStepStart({ agent: helper.agent, context });

      const completeNode = feature.getTools().find(tool => tool.name === 'complete_node')!;
      // First call triggers guided-retry
      await (completeNode.execute as any)({});

      // Retry with interactionRequest
      const recorder = createContextRecorder();
      await feature.handleStepStart({ agent: helper.agent, context: recorder.context });

      const result = await (completeNode.execute as any)(
        {
          interactionRequest: {
            prompt: '进入审核前的用户决策',
            question: '你希望如何处理进入审核节点这一步？',
            options: [
              { id: 'approve', label: '继续进入', description: '允许状态转移继续' },
              { id: 'cancel', label: '取消转移', description: '阻塞这次切换', blocksTransition: true },
            ],
          },
        },
        { getFeature: () => helper.interactionFeature },
      );

      assert.equal(result.success, true);
      assert.match(String(result.message || ''), /审核/);
      assert.equal(helper.getRequestedPrompt(), '进入审核前的用户决策');
      assert.match(String(helper.getRequestedQuestions()[0]?.question || ''), /审核节点/);

      // Verify transition applied after non-blocking choice
      await feature.handleStepStart({ agent: helper.agent, context });
      const snapshot = feature.captureState() as { currentNodeId: string | null };
      assert.equal(snapshot.currentNodeId, 'review');
    });
  });
});
