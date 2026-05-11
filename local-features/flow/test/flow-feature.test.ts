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

  console.log('[PASS] Flow feature branching and prompt exposure test passed');
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
