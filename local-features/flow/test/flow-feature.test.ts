import { FlowFeature } from '../src/index.js';
import type { FlowGraph } from '../src/types.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function createContextRecorder(): { messages: string[]; context: { add: (message: { role: string; content: string }) => void } } {
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

async function main(): Promise<void> {
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

  const feature = new FlowFeature({
    flows: [branchFlow],
    autoInjectStatus: true,
  });

  const vars = feature.getFlowVariables();
  const flowSummary = vars.find(item => item.key === 'flowSummaryText')?.resolver();
  assert(String(flowSummary).includes('[自动进入] 分支流程'), 'flowSummaryText should describe flow mode and name');

  const { messages, context } = createContextRecorder();
  const agent = { features: new Map(), getToolRegistry: () => null };
  await feature.handleCallStart({ agent, context });
  await feature.handleStepStart({ agent, context });

  const completeNode = feature.getTools().find(tool => tool.name === 'complete_node');
  assert(completeNode, 'complete_node tool should exist');

  const missingChoice = await completeNode!.execute({});
  assert(missingChoice.success === false, 'complete_node should reject ambiguous branching without explicit target');
  assert(String(missingChoice.error || '').includes('必须指定 nextNodeId 或 nextNodeName'), 'branching error should instruct the caller to specify a target node');

  const chosen = await completeNode!.execute({ nextNodeName: '路径B' });
  assert(chosen.success === true, 'complete_node should accept an explicit nextNodeName');
  assert(String(chosen.message || '').includes('路径B'), 'success message should mention the selected next node');

  await feature.handleStepStart({ agent, context });
  const snapshot = feature.captureState() as { currentNodeId: string | null };
  assert(snapshot.currentNodeId === 'path-b', 'handleStepStart should apply the queued transition to the selected node');

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
    enable(name: string) {
      toolStates.set(name, 'enabled');
    },
    disable(name: string) {
      toolStates.set(name, 'disabled');
    },
    remove(name: string) {
      toolStates.set(name, 'removed');
    },
  };
  const interactionFeature = {
    async requestUserChoices(prompt: string, questions: any[]) {
      requestedPrompt = prompt;
      requestedQuestions = questions;
      return [{ questionId: questions[0]?.id, optionId: 'approve' }];
    },
  };
  const interactiveAgent = {
    features: new Map([['user-input', interactionFeature]]),
    getToolRegistry: () => mockToolRegistry,
    getFeature(name: string) {
      return this.features.get(name);
    },
  };

  const interactive = new FlowFeature({
    flows: [interactiveFlow],
    autoInjectStatus: true,
  });
  await interactive.handleCallStart({ agent: interactiveAgent, context });
  await interactive.handleStepStart({ agent: interactiveAgent, context });
  const interactiveComplete = interactive.getTools().find(tool => tool.name === 'complete_node');
  assert(interactiveComplete, 'complete_node should exist for interactive flow');
  const interactiveExecute = interactiveComplete!.execute as any;

  const firstAttempt = await interactiveExecute({});
  assert(firstAttempt.success === false, 'guided-retry edge should reject the first plain complete_node call');
  assert(String(firstAttempt.error || '').includes('interactionRequest'), 'model-generated interaction should instruct the model to retry with interactionRequest');

  const retryRecorder = createContextRecorder();
  await interactive.handleStepStart({ agent: interactiveAgent, context: retryRecorder.context });
  assert(retryRecorder.messages.some(message => message.includes('不要直接调用 ask_user_choice') || message.includes('不要直接调用 ask_user_choice 或 ask_user_choices')), 'flow should inject retry guidance that forbids direct user-input tool calls');
  assert(toolStates.get('ask_user_choice') === 'removed', 'ask_user_choice should be temporarily removed while waiting for interactionRequest retry');
  assert(toolStates.get('ask_user_choices') === 'removed', 'ask_user_choices should be temporarily removed while waiting for interactionRequest retry');

  const secondAttempt = await interactiveExecute(
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
    { getFeature: () => interactionFeature },
  );
  assert(secondAttempt.success === true, 'confirmed complete_node should pass through interactive edge');
  assert(String(secondAttempt.message || '').includes('审核'), 'interactive success message should mention the next node');
  assert(requestedPrompt === '进入审核前的用户决策', 'interactive edge should call user-input with configured prompt');
  assert(String(requestedQuestions[0]?.question || '').includes('审核节点'), 'interactive edge should pass the configured question');

  await interactive.handleStepStart({ agent: interactiveAgent, context });
  const interactiveSnapshot = interactive.captureState() as { currentNodeId: string | null };
  assert(interactiveSnapshot.currentNodeId === 'review', 'interactive edge should still transition after a non-blocking choice');

  console.log('[PASS] Flow feature branching and prompt exposure test passed');
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
