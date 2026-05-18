/**
 * FlowFeature - Flow 编排层运行时核心
 *
 * 通过 @CallStart + @StepStart 钩子驱动 Flow 执行：
 * - 注入节点 prompt
 * - 过滤工具可见性
 * - 检测状态转换（手动 complete_node + 变量驱动自动切换）
 */

import type { AgentFeature, ContextInjector, FeatureStateSnapshot, Tool } from 'agentdev';
import { CallStart, StepStart, createTool } from 'agentdev';
import { readFileSync, existsSync } from 'fs';
import type {
  FlowGraph, FlowNode, FlowEdge, ExitCondition, AutoAction,
  FlowVariable, FlowFeatureConfig, FlowStateSnapshot, ReminderFrequency,
  FlowToolRule, FlowModeDefinition, FlowNodeFeatureModeChange,
  FlowPromptRule, PromptTiming, FlowInteractionConfig, FlowInteractionOption,
} from './types.js';
import type { FlowModeContext } from './flow-aware-feature.js';

export { FlowAwareFeature } from './flow-aware-feature.js';
export type { FlowVariable, FlowNodeTemplate, FlowPromptRule, PromptTiming } from './types.js';

interface CompleteNodeRuntimeContext {
  getFeature?<T = any>(featureName: string): T | undefined;
}

interface FlowInteractionRequestPayload {
  prompt?: string;
  question?: string;
  options?: Array<{
    id?: string;
    label?: string;
    description?: string;
    blocksTransition?: boolean;
    allowSupplement?: boolean;
    supplementRequired?: boolean;
    supplementLabel?: string;
    supplementPlaceholder?: string;
  }>;
}

interface UserInputFeatureLike {
  requestUserChoices(
    prompt: string,
    questions: Array<{
      id: string;
      question: string;
      options: Array<{
        id: string;
        label: string;
        description?: string;
        allowSupplement?: boolean;
        supplementRequired?: boolean;
        supplementLabel?: string;
        supplementPlaceholder?: string;
      }>;
    }>,
    timeout?: number,
  ): Promise<Array<{
    questionId: string;
    optionId?: string;
    supplementText?: string;
  }>>;
}

interface PendingInteractionRetryState {
  fromNodeId: string;
  nextNodeId: string;
  nextNodeName: string;
}

// ========== 硬编码测试 Flow ==========

const TEST_FLOW: FlowGraph = {
  id: 'test-flow',
  name: '测试流程',
  description: '用于验证 Flow 运行时的测试流程',
  mode: 'auto',
  nodes: [
    {
      id: 'greet',
      name: '问候',
      prompt: '你正在"问候"阶段。先向用户打招呼，了解他们想做什么。完成后调用 complete_node 工具。',
    },
    {
      id: 'work',
      name: '工作',
      prompt: '你正在"工作"阶段。根据用户需求执行任务。你可以使用 mock_increment 工具来增加计数器。当前计数器: {{mockCounter}}。当计数器 >= 3 时会自动进入下一阶段。',
      exitWhen: { variable: 'mockCounter', operator: 'gt', value: 2 },
    },
    {
      id: 'wrap',
      name: '收尾',
      prompt: '你正在"收尾"阶段。总结本次对话，询问是否还有其他需求。',
    },
  ],
  edges: [
    { from: 'greet', to: 'work' },
    { from: 'work', to: 'wrap' },
  ],
  entry: 'greet',
  reminderFrequency: 'every-step',
};

// ========== FlowFeature ==========

export class FlowFeature implements AgentFeature {
  readonly name = 'flow';
  readonly dependencies: string[] = [];
  readonly source = import.meta.url;
  readonly description = 'Flow 编排层运行时：节点 prompt 注入、工具 scope 管理、状态转换';

  // Flow 定义
  private flows: FlowGraph[] = [];

  // 运行时状态
  private activeFlow: FlowGraph | null = null;
  private currentNodeId: string | null = null;
  private stepsInNode = 0;
  private pendingTransition = false;
  private pendingTargetNode: string | null = null;
  private pendingInteractionRetry: PendingInteractionRetryState | null = null;
  private nodeHistory: Array<{ nodeId: string; enteredAt: number; exitedAt?: number }> = [];

  // Call 计数
  private callsInNode = 0;
  private isFirstStepOfCall = false;

  // 工具 scope 管理
  private previousToolStates: Map<string, 'enabled' | 'disabled' | 'removed'> = new Map();
  private toolRegistry: any = null;
  private currentAgentRef: any = null;

  // Feature 变量收集
  private flowVariables: Map<string, FlowVariable> = new Map();
  private effectiveModesByFeature: Map<string, string> = new Map();

  // 配置
  private autoInjectStatus: boolean;

  // 提醒控制
  private promptInjectedThisNode = false;

  private flowPath: string | undefined;

  constructor(config?: FlowFeatureConfig) {
    this.flowPath = config?.flowPath;
    this.autoInjectStatus = config?.autoInjectStatus ?? true;

    if (config?.flows) {
      this.flows = config.flows;
    } else if (this.flowPath) {
      this.flows = this.loadFlowsFromPath(this.flowPath);
    } else if (config?.useTestFlow === false) {
      this.flows = [];
    } else {
      this.flows = [TEST_FLOW];
    }
  }

  private isAutoEntryMode(mode: string | undefined): boolean {
    return mode === 'auto' || mode === 'auto-reenterable';
  }

  private loadFlowsFromPath(flowPath: string): FlowGraph[] {
    try {
      if (!existsSync(flowPath)) return [TEST_FLOW];
      const raw = readFileSync(flowPath, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return data;
      if (data.nodes && data.edges) return [data];
      return [TEST_FLOW];
    } catch {
      return [TEST_FLOW];
    }
  }

  // ========== AgentFeature: 工具注册 ==========

  getTools(): Tool[] {
    return [
      createTool({
        name: 'enter_flow',
        description: '进入指定的工作流。当前已在工作流中时调用无效。',
        parameters: {
          type: 'object',
          properties: {
            flowName: {
              type: 'string',
              description: '要进入的工作流名称',
            },
          },
          required: ['flowName'],
        },
        execute: async ({ flowName }) => {
          if (this.activeFlow) {
            return { success: false, error: `当前已在工作流 "${this.activeFlow.name}" 中，请先退出。` };
          }
          const flow = this.flows.find(f => f.name === flowName || f.id === flowName);
          if (!flow) {
            const available = this.flows.map(f => `"${f.name}"`).join(', ');
            return { success: false, error: `找不到工作流 "${flowName}"。可用工作流: ${available}` };
          }
          if (flow.mode === 'auto') {
            return { success: false, error: `"${flow.name}" 是一次性自动工作流，无法重新进入。` };
          }
          this.activateFlow(flow);
          return { success: true, message: `已进入工作流 "${flow.name}"，当前阶段: ${this.getCurrentNode()?.name || flow.entry}` };
        },
      }),
      createTool({
        name: 'complete_node',
        description: '声明当前阶段目标已完成，推进到下一阶段。若当前节点存在多个可选下一节点，必须显式指定 nextNodeId 或 nextNodeName。',
        parameters: {
          type: 'object',
          properties: {
            result: {
              type: 'string',
              description: '当前阶段的完成摘要（可选）',
            },
            nextNodeId: {
              type: 'string',
              description: '要进入的下一节点 ID。当前节点存在多个出口时建议优先使用。',
            },
            nextNodeName: {
              type: 'string',
              description: '要进入的下一节点名称。若名称唯一，可替代 nextNodeId。',
            },
            interactionRequest: {
              type: 'object',
              description: '当边配置为“模型生成决策内容”时，模型在重试 complete_node 时需要通过该字段提供用户决策标题、说明和选项。',
            },
          },
          required: [],
        },
        execute: async ({ result, nextNodeId, nextNodeName, interactionRequest }, runtimeContext?: CompleteNodeRuntimeContext) => {
          if (!this.activeFlow || !this.currentNodeId) {
            return { success: false, error: '当前不在任何工作流中。' };
          }
          if (this.pendingTransition) {
            return { success: false, error: '已有待处理的节点切换，无需重复调用。' };
          }
          const selection = this.resolveNextNodeSelection(this.currentNodeId, {
            nextNodeId,
            nextNodeName,
          });
          if (selection.error) {
            return { success: false, error: selection.error };
          }
          const nextNode = selection.node;
          if (!nextNode) {
            this.pendingInteractionRetry = null;
            await this.exitFlow();
            return { success: true, message: '工作流已完成。', result };
          }
          const transitionEdge = this.getTransitionEdge(this.currentNodeId, nextNode.id);
          if (transitionEdge?.interaction) {
            const interactionResult = await this.handleEdgeInteraction({
              edge: transitionEdge,
              nextNode,
              result,
              interactionRequest,
              runtimeContext,
            });
            if (interactionResult) {
              return interactionResult;
            }
          }
          this.pendingInteractionRetry = null;
          this.pendingTransition = true;
          this.pendingTargetNode = nextNode.id;
          return { success: true, message: `准备进入下一阶段 "${nextNode.name}"。`, result };
        },
      }),
      createTool({
        name: 'exit_flow',
        description: '主动退出当前工作流，恢复全部工具。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        execute: async () => {
          if (!this.activeFlow) {
            return { success: false, error: '当前不在任何工作流中。' };
          }
          const name = this.activeFlow.name;
          await this.exitFlow();
          return { success: true, message: `已退出工作流 "${name}"。` };
        },
      }),
    ];
  }

  getContextInjectors(): Map<string | RegExp, ContextInjector> {
    return new Map([
      ['complete_node', () => ({
        getFeature: <T = any>(featureName: string): T | undefined => {
          const agent = this.currentAgentRef;
          if (!agent) return undefined;
          if (typeof agent.getFeature === 'function') {
            return agent.getFeature(featureName) as T | undefined;
          }
          return agent.features instanceof Map ? agent.features.get(featureName) as T | undefined : undefined;
        },
      })],
    ]);
  }

  // ========== @CallStart ==========

  @CallStart
  async handleCallStart(ctx: any): Promise<void> {
    if (ctx.agent) {
      this.currentAgentRef = ctx.agent;
    }

    // 缓存 ToolRegistry
    if (ctx.agent && !this.toolRegistry) {
      const agent = ctx.agent;
      if (typeof agent.getToolRegistry === 'function') {
        this.toolRegistry = agent.getToolRegistry();
      } else if (agent.toolRegistry) {
        this.toolRegistry = agent.toolRegistry;
      } else if (agent.tools) {
        this.toolRegistry = agent.tools;
      }
    }

    // 收集 Feature 变量
    if (ctx.agent) {
      this.collectFlowVariables(ctx.agent);
    }

    // 自动激活 auto Flow
    if (!this.activeFlow) {
      const autoFlow = this.flows.find(f => f.mode === 'auto' || f.mode === 'auto-reenterable');
      if (autoFlow) {
        this.activateFlow(autoFlow);
      }
    }

    // 追踪 call 计数（用于 every-call / every-n-calls 时机）
    if (this.activeFlow && this.currentNodeId) {
      this.callsInNode++;
      this.isFirstStepOfCall = true;
    }
  }

  // ========== @StepStart ==========

  @StepStart
  async handleStepStart(ctx: any): Promise<void> {
    if (!this.activeFlow || !this.currentNodeId) return;
    this.currentAgentRef = ctx.agent || this.currentAgentRef;

    // 1. 处理 pendingTransition
    if (this.pendingTransition && this.pendingTargetNode) {
      const targetId = this.pendingTargetNode;
      this.pendingTransition = false;
      this.pendingTargetNode = null;
      this.transitionTo(targetId, ctx);
    }

    // 2. 检查 exitWhen 自动切换
    const node = this.getCurrentNode();
    if (node?.exitWhen && !this.pendingTransition) {
      if (this.evaluateExitWhen(node.exitWhen)) {
        const nextId = this.getDefaultNextNodeId(this.currentNodeId!);
        if (nextId) {
          this.pendingTransition = true;
          this.pendingTargetNode = nextId;
          // 立即处理
          this.pendingTransition = false;
          this.pendingTargetNode = null;
          this.transitionTo(nextId, ctx);
        } else {
          await this.exitFlow();
          return;
        }
      }
    }

    // 3. 应用 Feature mode 与工具覆盖
    await this.applyFeatureModesAndToolScope(ctx);

    // 4. 按提示词规则注入
    const rules = this.getEffectivePromptRules();
    const parts: string[] = [];
    for (const rule of rules) {
      if (this.shouldInjectRule(rule)) {
        const resolved = this.resolvePrompt(rule.template);
        if (resolved.trim()) {
          parts.push(resolved);
        }
      }
    }
    if (parts.length > 0) {
      ctx.context.add({ role: 'system', content: parts.join('\n\n') });
      this.promptInjectedThisNode = true;
    }
    const interactionRetryPrompt = this.buildPendingInteractionRetryPrompt();
    if (interactionRetryPrompt) {
      ctx.context.add({ role: 'system', content: interactionRetryPrompt });
    }

    this.isFirstStepOfCall = false;
    this.stepsInNode++;
  }

  // ========== 状态持久化 ==========

  captureState(): FeatureStateSnapshot {
    const snapshot: FlowStateSnapshot = {
      activeFlowId: this.activeFlow?.id ?? null,
      currentNodeId: this.currentNodeId,
      stepsInNode: this.stepsInNode,
      pendingTransition: this.pendingTransition,
      pendingTargetNode: this.pendingTargetNode,
      pendingInteractionRetry: this.pendingInteractionRetry ? { ...this.pendingInteractionRetry } : null,
      callsInNode: this.callsInNode,
      nodeHistory: this.nodeHistory.map(h => ({ ...h })),
      previousToolStates: Object.fromEntries(this.previousToolStates),
      effectiveModesByFeature: Object.fromEntries(this.effectiveModesByFeature),
    };
    return snapshot;
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    const state = snapshot as FlowStateSnapshot;
    if (state.activeFlowId) {
      this.activeFlow = this.flows.find(f => f.id === state.activeFlowId) ?? null;
    } else {
      this.activeFlow = null;
    }
    this.currentNodeId = state.currentNodeId ?? null;
    this.stepsInNode = state.stepsInNode ?? 0;
    this.pendingTransition = state.pendingTransition ?? false;
    this.pendingTargetNode = state.pendingTargetNode ?? null;
    this.pendingInteractionRetry = state.pendingInteractionRetry ?? null;
    this.callsInNode = state.callsInNode ?? 0;
    this.nodeHistory = Array.isArray(state.nodeHistory) ? state.nodeHistory : [];
    this.previousToolStates = new Map(Object.entries(state.previousToolStates || {}));
    this.effectiveModesByFeature = new Map(Object.entries(state.effectiveModesByFeature || {}));
  }

  // ========== 内部方法 ==========

  private activateFlow(flow: FlowGraph): void {
    this.activeFlow = flow;
    this.currentNodeId = flow.entry;
    this.stepsInNode = 0;
    this.pendingTransition = false;
    this.pendingTargetNode = null;
    this.pendingInteractionRetry = null;
    this.promptInjectedThisNode = false;
    this.nodeHistory = [];
    this.callsInNode = 0;
    this.isFirstStepOfCall = false;
    this.effectiveModesByFeature.clear();
    this.nodeHistory.push({ nodeId: flow.entry, enteredAt: Date.now() });

    // 保存当前工具状态
    this.saveToolStates();

    // 执行入口节点的 onEnter
    const entryNode = this.findNode(flow.entry);
    if (entryNode?.onEnter) {
      this.executeOnEnter(entryNode.onEnter);
    }
  }

  private async exitFlow(): Promise<void> {
    // 关闭当前节点历史
    if (this.nodeHistory.length > 0) {
      const last = this.nodeHistory[this.nodeHistory.length - 1];
      if (!last.exitedAt) {
        last.exitedAt = Date.now();
      }
    }
    this.activeFlow = null;
    this.currentNodeId = null;
    this.stepsInNode = 0;
    this.pendingTransition = false;
    this.pendingTargetNode = null;
    this.pendingInteractionRetry = null;
    this.promptInjectedThisNode = false;
    this.callsInNode = 0;
    this.isFirstStepOfCall = false;
    this.effectiveModesByFeature.clear();

    // 恢复工具状态
    await this.resetManagedFeatureModes({ agent: this.currentAgentRef });
    this.restoreToolStates();
  }

  private transitionTo(nodeId: string, ctx: any): void {
    // 关闭旧节点历史
    if (this.nodeHistory.length > 0) {
      const last = this.nodeHistory[this.nodeHistory.length - 1];
      if (!last.exitedAt) {
        last.exitedAt = Date.now();
      }
    }

    // 切换节点
    this.currentNodeId = nodeId;
    this.stepsInNode = 0;
    this.pendingInteractionRetry = null;
    this.promptInjectedThisNode = false;
    this.callsInNode = 0;
    this.nodeHistory.push({ nodeId, enteredAt: Date.now() });

    // 执行新节点 onEnter
    const node = this.findNode(nodeId);
    if (node?.onEnter) {
      const warnings = this.executeOnEnter(node.onEnter);
      // 如果 onEnter 有警告，注入到上下文
      if (warnings.length > 0 && ctx?.context) {
        ctx.context.add({ role: 'system', content: `[Flow 警告] ${warnings.join('; ')}` });
      }
    }

    // 检查是否是最后一个节点（没有出边）
    const nextId = this.getDefaultNextNodeId(nodeId);
    if (!nextId && !node?.exitWhen) {
      // 这是最后一个节点，完成后的 complete_node 将结束 Flow
    }
  }

  private findNode(nodeId: string): FlowNode | undefined {
    if (!this.activeFlow) return undefined;
    return this.activeFlow.nodes.find(n => n.id === nodeId);
  }

  private getCurrentNode(): FlowNode | undefined {
    return this.currentNodeId ? this.findNode(this.currentNodeId) : undefined;
  }

  private getOutgoingEdges(fromNodeId: string): FlowEdge[] {
    if (!this.activeFlow) return [];
    return this.activeFlow.edges.filter(edge => edge.from === fromNodeId);
  }

  private getTransitionEdge(fromNodeId: string, toNodeId: string): FlowEdge | undefined {
    return this.getOutgoingEdges(fromNodeId).find(edge => edge.to === toNodeId);
  }

  private getNextNodes(fromNodeId: string): FlowNode[] {
    return this.getOutgoingEdges(fromNodeId)
      .map(edge => this.findNode(edge.to))
      .filter((node): node is FlowNode => Boolean(node));
  }

  private formatNodeChoice(node: FlowNode): string {
    return `${node.name} (id: ${node.id})`;
  }

  private getNextNodeOptionsText(fromNodeId: string | null = this.currentNodeId): string {
    if (!fromNodeId) return '无';
    const nextNodes = this.getNextNodes(fromNodeId);
    if (nextNodes.length === 0) return '无';
    return nextNodes.map(node => `- ${this.formatNodeChoice(node)}`).join('\n');
  }

  private getDefaultNextNodeId(fromNodeId: string): string | null {
    if (!this.activeFlow) return null;
    // 按声明顺序匹配，第一条满足条件的边生效
    for (const edge of this.getOutgoingEdges(fromNodeId)) {
      if (edge.from === fromNodeId) {
        if (edge.condition) {
          // TODO: 评估边条件
          continue;
        }
        return edge.to;
      }
    }
    return null;
  }

  private resolveNextNodeSelection(
    fromNodeId: string,
    input: { nextNodeId?: unknown; nextNodeName?: unknown },
  ): { node: FlowNode | null; error?: string } {
    const nextNodes = this.getNextNodes(fromNodeId);
    if (nextNodes.length === 0) {
      return { node: null };
    }

    const requestedId = typeof input.nextNodeId === 'string' ? input.nextNodeId.trim() : '';
    const requestedName = typeof input.nextNodeName === 'string' ? input.nextNodeName.trim() : '';

    if (!requestedId && !requestedName) {
      if (nextNodes.length === 1) {
        return { node: nextNodes[0] };
      }
      return {
        node: null,
        error: `当前节点存在多个可选下一节点，调用 complete_node 时必须指定 nextNodeId 或 nextNodeName。可选节点:\n${this.getNextNodeOptionsText(fromNodeId)}`,
      };
    }

    const matched = nextNodes.find(node => {
      if (requestedId && node.id === requestedId) return true;
      if (requestedName && node.name === requestedName) return true;
      return false;
    });

    if (!matched) {
      const currentNode = this.findNode(fromNodeId);
      return {
        node: null,
        error: `无法从当前节点 "${currentNode?.name || fromNodeId}" 进入目标节点 "${requestedName || requestedId}"。可选节点:\n${this.getNextNodeOptionsText(fromNodeId)}`,
      };
    }

    return { node: matched };
  }

  private getResolvedUserInputFeature(runtimeContext?: CompleteNodeRuntimeContext): UserInputFeatureLike | null {
    const fromContext = runtimeContext?.getFeature?.<UserInputFeatureLike>('user-input');
    if (fromContext?.requestUserChoices) {
      return fromContext;
    }
    const fromAgent = typeof this.currentAgentRef?.getFeature === 'function'
      ? this.currentAgentRef.getFeature('user-input')
      : (this.currentAgentRef?.features instanceof Map ? this.currentAgentRef.features.get('user-input') : undefined);
    return fromAgent?.requestUserChoices ? fromAgent as UserInputFeatureLike : null;
  }

  private normalizeInteractionGuidance(interaction: FlowInteractionConfig, nextNodeName: string): string {
    const text = String(interaction.guidanceMessage || '').trim();
    if (text) return text;
    return [
      `当前从本节点进入 "${nextNodeName}" 之前，需要由你先生成一组用户决策内容。`,
      '请重新调用 complete_node，并在 interactionRequest 中补充决策标题、决策说明和 1~4 个选项。',
      'interactionRequest.options 中每个选项都至少要有 id 和 label；如果某个选项会取消转移，请把该项 blocksTransition 设为 true。',
      '重新调用时保持原本的 nextNodeId / nextNodeName 选择不变。',
    ].join('\n');
  }

  private buildPendingInteractionRetryPrompt(): string {
    if (!this.pendingInteractionRetry) return '';
    const nextNodeName = this.pendingInteractionRetry.nextNodeName || this.pendingInteractionRetry.nextNodeId;
    return [
      `当前从本节点进入 "${nextNodeName}" 前，Flow 正在等待你再次调用 complete_node。`,
      '你必须继续使用 flow feature 的 complete_node 工具，并在 interactionRequest 中补充本次用户决策的标题、说明和选项。',
      '不要直接调用 ask_user_choice 或 ask_user_choices；这些只是底层 UI 实现，不负责本次状态转移。',
      '重试时保持原本的 nextNodeId / nextNodeName 目标不变。',
    ].join('\n');
  }

  private normalizeInteractionPrompt(config: { prompt?: string; question?: string }, nextNodeName: string): { prompt: string; question: string } {
    const prompt = String(config.prompt || '').trim() || `进入 "${nextNodeName}" 前的用户决策`;
    const question = String(config.question || '').trim() || `你希望如何处理进入 "${nextNodeName}" 这一步？`;
    return { prompt, question };
  }

  private normalizeInteractionOptions(options: Array<FlowInteractionOption | NonNullable<FlowInteractionRequestPayload['options']>[number]> | undefined): Array<{
    id: string;
    label: string;
    description?: string;
    blocksTransition?: boolean;
    allowSupplement?: boolean;
    supplementRequired?: boolean;
    supplementLabel?: string;
    supplementPlaceholder?: string;
  }> {
    return (Array.isArray(options) ? options : [])
      .map((option, index) => ({
        id: String(option?.id || `option_${index + 1}`).trim(),
        label: String(option?.label || '').trim(),
        description: option?.description ? String(option.description) : undefined,
        blocksTransition: Boolean(option?.blocksTransition),
        allowSupplement: Boolean(option?.allowSupplement),
        supplementRequired: Boolean(option?.supplementRequired),
        supplementLabel: option?.supplementLabel ? String(option.supplementLabel) : undefined,
        supplementPlaceholder: option?.supplementPlaceholder ? String(option.supplementPlaceholder) : undefined,
      }))
      .filter(option => option.id && option.label);
  }

  private buildInteractionSummary(
    config: { prompt?: string; question?: string },
    options: FlowInteractionOption[],
    answer: {
    optionId?: string;
    supplementText?: string;
    },
    source: FlowInteractionConfig['mode'],
  ): {
    source: FlowInteractionConfig['mode'];
    prompt?: string;
    question?: string;
    options: Array<{ id: string; label: string; description?: string; blocksTransition?: boolean }>;
    selected: {
      optionId?: string;
      label?: string;
      supplementText?: string;
      blocksTransition: boolean;
    };
  } {
    const selectedOption = options.find(option => option.id === answer.optionId);
    return {
      source,
      prompt: config.prompt,
      question: config.question,
      options: options.map(option => ({
        id: option.id,
        label: option.label,
        description: option.description,
        blocksTransition: Boolean(option.blocksTransition),
      })),
      selected: {
        optionId: answer.optionId,
        label: selectedOption?.label,
        supplementText: answer.supplementText,
        blocksTransition: Boolean(selectedOption?.blocksTransition),
      },
    };
  }

  private async handleEdgeInteraction(params: {
    edge: FlowEdge;
    nextNode: FlowNode;
    result: unknown;
    interactionRequest?: FlowInteractionRequestPayload;
    runtimeContext?: CompleteNodeRuntimeContext;
  }): Promise<Record<string, unknown> | null> {
    const interaction = params.edge.interaction;
    if (!interaction) return null;

    const source = interaction.mode;
    const effectiveConfig = source === 'model-generated'
      ? params.interactionRequest
      : interaction;

    if (source === 'model-generated' && !effectiveConfig) {
      this.pendingInteractionRetry = {
        fromNodeId: params.edge.from,
        nextNodeId: params.nextNode.id,
        nextNodeName: params.nextNode.name,
      };
      return {
        success: false,
        interactionRequired: true,
        error: this.normalizeInteractionGuidance(interaction, params.nextNode.name),
      };
    }

    const normalizedOptions = this.normalizeInteractionOptions(effectiveConfig?.options);
    if (normalizedOptions.length === 0) {
      if (source === 'model-generated') {
        this.pendingInteractionRetry = {
          fromNodeId: params.edge.from,
          nextNodeId: params.nextNode.id,
          nextNodeName: params.nextNode.name,
        };
      }
      return {
        success: false,
        interactionRequired: source === 'model-generated',
        error: source === 'model-generated'
          ? `当前边要求模型生成决策内容，但 interactionRequest 中没有可用选项，无法进入 "${params.nextNode.name}"。`
          : `当前边已配置预设决策内容，但没有可用选项，无法进入 "${params.nextNode.name}"。`,
      };
    }

    const userInput = this.getResolvedUserInputFeature(params.runtimeContext);
    if (!userInput) {
      return {
        success: false,
        error: `当前边进入 "${params.nextNode.name}" 前需要用户决策，但 user-input feature 不可用。`,
      };
    }
    this.pendingInteractionRetry = null;

    const promptInfo = this.normalizeInteractionPrompt(effectiveConfig || interaction, params.nextNode.name);
    const answers = await userInput.requestUserChoices(promptInfo.prompt, [{
      id: `${params.edge.from}__${params.edge.to}__interaction`,
      question: promptInfo.question,
      options: normalizedOptions,
    }]);
    const answer = Array.isArray(answers) ? answers[0] || {} : {};
    const interactionSummary = this.buildInteractionSummary({
      prompt: promptInfo.prompt,
      question: promptInfo.question,
    }, normalizedOptions as FlowInteractionOption[], answer, source);

    if (interactionSummary.selected.blocksTransition) {
      return {
        success: true,
        cancelled: true,
        message: `用户选择了阻塞项，已取消进入下一阶段 "${params.nextNode.name}"。`,
        result: params.result,
        interaction: interactionSummary,
      };
    }

    this.pendingTransition = true;
    this.pendingTargetNode = params.nextNode.id;
    return {
      success: true,
      message: `已完成用户决策，准备进入下一阶段 "${params.nextNode.name}"。`,
      result: params.result,
      interaction: interactionSummary,
    };
  }

  private getAvailableActions(): string {
    const actions = ['complete_node', 'exit_flow'];
    if (!this.activeFlow) {
      const agentFlows = this.flows.filter(f => f.mode === 'agent-initiated' || f.mode === 'auto-reenterable');
      if (agentFlows.length > 0) {
        actions.push('enter_flow');
      }
    }
    return actions.join(', ');
  }

  // ========== 提示词规则 ==========

  private normalizeLegacyTiming(frequency: string): PromptTiming {
    if (frequency === 'once-per-node' || frequency === 'every-call') return 'on-enter';
    if (frequency === 'every-step' || frequency === 'every-n-steps' || frequency === 'every-n-calls') return frequency as PromptTiming;
    return 'every-step';
  }

  private getEffectivePromptRules(): FlowPromptRule[] {
    const rules: FlowPromptRule[] = [];

    // 工作流级提示词规则
    if (this.activeFlow?.prompts && this.activeFlow.prompts.length > 0) {
      rules.push(...this.activeFlow.prompts);
    }

    // 节点级提示词规则（含旧格式兼容）
    const node = this.getCurrentNode();
    if (node) {
      if (node.prompts && node.prompts.length > 0) {
        rules.push(...node.prompts);
      } else if (node.prompt) {
        rules.push({
          id: '__legacy__',
          timing: this.normalizeLegacyTiming(node.reminderFrequency || this.activeFlow?.reminderFrequency || 'every-step'),
          interval: node.reminderInterval || this.activeFlow?.reminderInterval,
          template: node.prompt,
        });
      }

      // children 兼容
      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          if (child.prompt) {
            rules.push({
              id: `__child_${child.id}__`,
              timing: 'every-step',
              template: child.prompt,
            });
          }
        }
      }
    }

    return rules;
  }

  private shouldInjectRule(rule: FlowPromptRule): boolean {
    switch (rule.timing) {
      case 'on-enter':
        return this.stepsInNode === 0;
      case 'every-step':
        return true;
      case 'every-n-steps': {
        const interval = rule.interval || 3;
        return this.stepsInNode % interval === 0;
      }
      case 'every-call':
        return this.isFirstStepOfCall;
      case 'every-n-calls': {
        const interval = rule.interval || 1;
        return this.isFirstStepOfCall && this.callsInNode > 0 && this.callsInNode % interval === 0;
      }
      default:
        return false;
    }
  }

  private resolvePrompt(template: string): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
      const value = this.resolveVariable(varName);
      if (Array.isArray(value)) {
        return value
          .map(item => String(item ?? '').trim())
          .filter(Boolean)
          .join('\n');
      }
      if (value && typeof value === 'object') {
        try {
          return JSON.stringify(value, null, 2);
        } catch {
          return String(value);
        }
      }
      return value !== undefined ? String(value) : match;
    });
  }

  private resolveVariable(key: string): any {
    // 先查 Flow 变量
    const flowVar = this.flowVariables.get(key);
    if (flowVar) {
      try {
        return flowVar.resolver();
      } catch {
        return undefined;
      }
    }
    // 再查 FlowGraph 自定义变量
    if (this.activeFlow?.variables && key in this.activeFlow.variables) {
      return this.activeFlow.variables[key];
    }
    return undefined;
  }

  getFlowVariables(): FlowVariable[] {
    return [
      {
        key: 'flowSummaryItems',
        type: 'string',
        title: '工作流摘要数组',
        description: '当前 Agent 可用工作流摘要，每项带进入方式、名称和介绍。',
        resolver: () => this.flows.map(flow => this.formatFlowSummary(flow)),
      },
      {
        key: 'flowSummaryText',
        type: 'string',
        title: '工作流摘要文本',
        description: '当前 Agent 可用工作流的多行摘要，可直接插入系统提示词。',
        resolver: () => this.flows.map(flow => `- ${this.formatFlowSummary(flow)}`).join('\n'),
      },
      {
        key: 'agentInitiatedFlowSummaryText',
        type: 'string',
        title: '主动进入工作流摘要',
        description: '需要 Agent 主动调用 enter_flow 进入的工作流列表。',
        resolver: () => this.flows
          .filter(flow => flow.mode === 'agent-initiated' || flow.mode === 'auto-reenterable')
          .map(flow => `- ${flow.name}${flow.description ? `：${flow.description}` : ''}`)
          .join('\n'),
      },
      {
        key: 'autoFlowSummaryText',
        type: 'string',
        title: '自动进入工作流摘要',
        description: '会自动激活的工作流列表。',
        resolver: () => this.flows
          .filter(flow => this.isAutoEntryMode(flow.mode))
          .map(flow => `- ${flow.name}${flow.description ? `：${flow.description}` : ''}`)
          .join('\n'),
      },
      {
        key: 'currentFlowName',
        type: 'string',
        title: '当前工作流名称',
        description: '当前激活工作流的名称；若未进入工作流则为空。',
        resolver: () => this.activeFlow?.name || '',
      },
      {
        key: 'currentFlowNodeName',
        type: 'string',
        title: '当前节点名称',
        description: '当前激活节点名称；若未进入工作流则为空。',
        resolver: () => this.getCurrentNode()?.name || '',
      },
      {
        key: 'flowNextNodeOptionsText',
        type: 'string',
        title: '当前节点可选后继节点文本',
        description: '当前节点调用 complete_node 后可进入的候选节点列表。',
        resolver: () => this.getNextNodeOptionsText(),
      },
    ];
  }

  getFlowNodeTemplates() {
    return [
      {
        id: 'flow-availability-prompt',
        name: '工作流总览提示',
        description: '向 Agent 注入当前可用工作流，并区分自动进入和主动进入的工作流。',
        prompt: [
          '当前编排图中可用的工作流如下：',
          '{{flowSummaryText}}',
          '',
          '需要你主动调用 enter_flow 的工作流：',
          '{{agentInitiatedFlowSummaryText}}',
          '',
          '会自动激活的工作流：',
          '{{autoFlowSummaryText}}',
        ].join('\n'),
        tools: { enable: ['enter_flow'] },
      },
      {
        id: 'flow-transition-options-prompt',
        name: '节点分支提示',
        description: '提醒 Agent 当前节点可以进入哪些下一节点，以及多分支时要显式选择目标。',
        prompt: [
          '当前工作流：{{currentFlowName}}',
          '当前节点：{{currentFlowNodeName}}',
          '当前节点完成后可进入的下一节点：',
          '{{flowNextNodeOptionsText}}',
          '如果有多个候选节点，调用 complete_node 时必须传 nextNodeId 或 nextNodeName。',
        ].join('\n'),
        tools: { enable: ['complete_node'] },
      },
    ];
  }

  private formatFlowSummary(flow: FlowGraph): string {
    const modeLabels: Record<string, string> = { 'auto': '自动进入', 'agent-initiated': '主动进入', 'auto-reenterable': '自动·可重入' };
    const modeLabel = modeLabels[flow.mode] || '主动进入';
    const description = flow.description ? `：${flow.description}` : '';
    return `[${modeLabel}] ${flow.name}${description}`;
  }

  // ========== ExitWhen 评估 ==========

  private evaluateExitWhen(condition: ExitCondition): boolean {
    const actualValue = this.resolveVariable(condition.variable);
    if (actualValue === undefined) return false;

    const expected = condition.value;

    switch (condition.operator) {
      case 'eq': return actualValue === expected;
      case 'neq': return actualValue !== expected;
      case 'gt': return actualValue > expected;
      case 'lt': return actualValue < expected;
      case 'contains': return String(actualValue).includes(String(expected));
      case 'changed': return true; // changed 总是在被评估时为 true（变量已变化才会到这里）
      default: return false;
    }
  }

  // ========== onEnter 执行 ==========

  private executeOnEnter(actions: AutoAction[]): string[] {
    const warnings: string[] = [];
    for (const action of actions) {
      try {
        if (action.type === 'set-variable' && action.variablePath) {
          if (!this.activeFlow) continue;
          if (!this.activeFlow.variables) this.activeFlow.variables = {};
          this.activeFlow.variables[action.variablePath] = action.variableValue;
        } else if (action.type === 'tool-call' && action.tool) {
          if (!this.toolRegistry) {
            warnings.push(`进入动作 ${action.tool} 执行失败: ToolRegistry 未就绪`);
            continue;
          }
          const tool = this.toolRegistry.get(action.tool);
          if (!tool) {
            warnings.push(`进入动作 ${action.tool} 执行失败: 工具不存在`);
            continue;
          }
          tool.execute(action.args || {});
        }
      } catch (err: any) {
        warnings.push(`进入动作 ${action.type === 'tool-call' ? action.tool : action.variablePath} 执行失败: ${err.message}`);
      }
    }
    return warnings;
  }

  // ========== Feature 变量收集 ==========

  private collectFlowVariables(agent: any): void {
    this.flowVariables.clear();
    // 从 agent 的 features 中收集
    const features: Map<string, any> = agent.features;
    if (!features) return;

    for (const [, feature] of features) {
      if (typeof feature.getFlowVariables === 'function') {
        try {
          const vars: FlowVariable[] = feature.getFlowVariables();
          if (Array.isArray(vars)) {
            for (const v of vars) {
              this.flowVariables.set(v.key, v);
            }
          }
        } catch {
          // 静默忽略收集失败
        }
      }
    }
  }

  // ========== Feature Modes / 工具 Scope ==========

  private getAgentFeatures(agent: any): Map<string, any> {
    return agent?.features instanceof Map ? agent.features : new Map();
  }

  private getFeaturePackageName(feature: any): string {
    try {
      return String(feature?.getPackageInfo?.()?.name || '').trim();
    } catch {
      return '';
    }
  }

  private normalizeFeatureIdentifier(value: string): string[] {
    const raw = String(value || '').trim();
    if (!raw) return [];
    const variants = new Set<string>([raw]);
    const withoutScope = raw.replace(/^@agentdev\//, '');
    variants.add(withoutScope);
    variants.add(withoutScope.replace(/-feature$/, ''));
    return [...variants].map(item => item.toLowerCase());
  }

  private getFeatureIdentifiers(featureName: string, feature: any): string[] {
    const values = new Set<string>();
    for (const candidate of [featureName, feature?.name, this.getFeaturePackageName(feature)]) {
      for (const normalized of this.normalizeFeatureIdentifier(String(candidate || ''))) {
        values.add(normalized);
      }
    }
    return [...values];
  }

  private resolveFeatureNameForModeChange(change: FlowNodeFeatureModeChange, agent: any): string | null {
    const features = this.getAgentFeatures(agent);
    const targets = new Set<string>();
    for (const candidate of [change.featureId, change.packageName]) {
      for (const normalized of this.normalizeFeatureIdentifier(String(candidate || ''))) {
        targets.add(normalized);
      }
    }
    if (targets.size === 0) return null;

    for (const [featureName, feature] of features) {
      const identifiers = this.getFeatureIdentifiers(featureName, feature);
      if (identifiers.some(identifier => targets.has(identifier))) {
        return featureName;
      }
    }
    return null;
  }

  private getNodeFeatureModeChanges(node: FlowNode | undefined): FlowNodeFeatureModeChange[] {
    if (!Array.isArray(node?.featureModeChanges)) return [];
    return node.featureModeChanges.filter(change => {
      if (!change || typeof change.modeId !== 'string' || !change.modeId.trim()) return false;
      return Boolean(change.featureId || change.packageName);
    });
  }

  private computeNextEffectiveModes(agent: any, node: FlowNode | undefined): Map<string, string> {
    const nextModes = new Map(this.effectiveModesByFeature);
    for (const change of this.getNodeFeatureModeChanges(node)) {
      const featureName = this.resolveFeatureNameForModeChange(change, agent);
      if (!featureName) continue;
      nextModes.set(featureName, change.modeId.trim());
    }
    return nextModes;
  }

  private getFlowModesForFeature(feature: any): FlowModeDefinition[] {
    if (typeof feature?.getFlowModes !== 'function') return [];
    try {
      const modes = feature.getFlowModes();
      return Array.isArray(modes) ? modes : [];
    } catch {
      return [];
    }
  }

  private findModeDefinition(featureName: string, feature: any, modeId: string): FlowModeDefinition | undefined {
    const normalizedModeId = String(modeId || '').trim();
    if (!normalizedModeId) return undefined;

    const identifiers = this.getFeatureIdentifiers(featureName, feature);
    return this.getFlowModesForFeature(feature).find(mode => {
      const rawId = String(mode?.id || '').trim();
      if (!rawId) return false;
      if (rawId === normalizedModeId) return true;
      return identifiers.some(identifier => `${identifier}:${rawId}` === normalizedModeId.toLowerCase());
    });
  }

  private buildModeContext(ctx: any): FlowModeContext {
    const agent = ctx?.agent || this.currentAgentRef;
    return {
      nodeId: this.currentNodeId || '',
      workflowId: this.activeFlow?.id || '',
      agent,
    };
  }

  private async resetManagedFeatureModes(ctx?: any): Promise<string[]> {
    const warnings: string[] = [];
    const features = this.getAgentFeatures(ctx?.agent);
    if (!features.size) return warnings;

    const modeContext = this.buildModeContext(ctx);
    for (const [, feature] of features) {
      if (typeof feature?.resetFlowModes !== 'function') continue;
      try {
        await Promise.resolve(feature.resetFlowModes(modeContext));
      } catch (error: any) {
        warnings.push(`${feature?.name || 'unknown'} resetFlowModes 失败: ${error?.message || String(error)}`);
      }
    }
    return warnings;
  }

  private applyDeclaredModeToolEffects(agent: any, modesByFeature: Map<string, string>): void {
    for (const [featureName, modeId] of modesByFeature) {
      const feature = this.getAgentFeatures(agent).get(featureName);
      if (!feature) continue;
      const mode = this.findModeDefinition(featureName, feature, modeId);
      const rules = Array.isArray(mode?.effects?.tools) ? mode.effects.tools : [];
      for (const rule of rules) {
        if (!rule?.name || !this.toolRegistry) continue;
        this.applyToolRule(rule);
      }
    }
  }

  private async applyFeatureModesAndToolScope(ctx: any): Promise<void> {
    const agent = ctx?.agent || this.currentAgentRef;
    if (!this.activeFlow || !this.currentNodeId || !agent) return;

    const warnings: string[] = [];
    const node = this.getCurrentNode();
    const nextModes = this.computeNextEffectiveModes(agent, node);

    warnings.push(...await this.resetManagedFeatureModes({ ...ctx, agent }));
    if (this.toolRegistry) {
      this.restoreBaselineToolStates();
    }

    const modeContext = this.buildModeContext({ ...ctx, agent });
    for (const [featureName, modeId] of nextModes) {
      const feature = this.getAgentFeatures(agent).get(featureName);
      if (!feature) continue;
      if (typeof feature.applyFlowMode === 'function') {
        try {
          await Promise.resolve(feature.applyFlowMode(modeId, modeContext));
        } catch (error: any) {
          warnings.push(`${featureName} applyFlowMode(${modeId}) 失败: ${error?.message || String(error)}`);
        }
      }
    }

    if (this.toolRegistry) {
      this.applyDeclaredModeToolEffects(agent, nextModes);
      this.applyAdvancedToolOverrides(node);
      this.applyPendingInteractionToolGuard();
    }
    this.effectiveModesByFeature = nextModes;

    if (warnings.length > 0 && ctx?.context) {
      ctx.context.add({ role: 'system', content: `[Flow 警告] ${warnings.join('; ')}` });
    }
  }

  private getEffectiveToolRules(node: FlowNode | undefined): FlowToolRule[] {
    const advancedRules = node?.advanced?.tools?.rules;
    if (Array.isArray(advancedRules) && advancedRules.length > 0) {
      return advancedRules.filter(rule => rule && typeof rule.name === 'string' && rule.name.trim());
    }

    const legacyRules = node?.tools?.rules;
    if (Array.isArray(legacyRules) && legacyRules.length > 0) {
      return legacyRules.filter(rule => rule && typeof rule.name === 'string' && rule.name.trim());
    }

    if (Array.isArray(node?.tools?.enable) && node.tools.enable.length > 0) {
      return node.tools.enable
        .filter(name => typeof name === 'string' && name.trim())
        .map(name => ({ name, mode: 'enabled' as const }));
    }

    return [];
  }

  private saveToolStates(): void {
    this.previousToolStates.clear();
    if (!this.toolRegistry) return;

    const entries = this.toolRegistry.getEntries?.();
    if (!entries) return;

    for (const entry of entries) {
      this.previousToolStates.set(entry.tool.name, this.getToolEntryState(entry));
    }
  }

  private getToolEntryState(entry: any): 'enabled' | 'disabled' | 'removed' {
    if (entry?.state === 'enabled' || entry?.state === 'disabled' || entry?.state === 'removed') {
      return entry.state;
    }
    return entry?.enabled === false ? 'disabled' : 'enabled';
  }

  private getToolRuleMode(rule: any): 'enabled' | 'disabled' | 'removed' {
    if (rule?.mode === 'enabled' || rule?.mode === 'disabled' || rule?.mode === 'removed') {
      return rule.mode;
    }
    return rule?.enabled === false ? 'disabled' : 'enabled';
  }

  private applyToolRule(rule: FlowToolRule): void {
    if (!this.toolRegistry || !rule?.name) return;
    const toolName = rule.name.trim();
    if (!toolName) return;
    const flowToolNames = new Set(['enter_flow', 'complete_node', 'exit_flow']);
    const mode = this.getToolRuleMode(rule);
    if (mode === 'enabled' || flowToolNames.has(toolName)) {
      this.toolRegistry.enable(toolName);
      return;
    }
    if (mode === 'disabled') {
      this.toolRegistry.disable(toolName);
      return;
    }
    if (this.toolRegistry.remove) {
      this.toolRegistry.remove(toolName);
    } else {
      this.toolRegistry.disable(toolName);
    }
  }

  private applyAdvancedToolOverrides(node: FlowNode | undefined): void {
    if (!this.toolRegistry || !node) return;

    const rules = this.getEffectiveToolRules(node);
    for (const rule of rules) {
      this.applyToolRule(rule);
    }
  }

  private applyPendingInteractionToolGuard(): void {
    if (!this.toolRegistry || !this.pendingInteractionRetry) return;
    for (const toolName of ['ask_user_choice', 'ask_user_choices']) {
      if (typeof this.toolRegistry.remove === 'function') {
        this.toolRegistry.remove(toolName);
      } else {
        this.toolRegistry.disable(toolName);
      }
    }
  }

  private restoreBaselineToolStates(): void {
    if (!this.toolRegistry || this.previousToolStates.size === 0) return;

    for (const [name, state] of this.previousToolStates) {
      if (state === 'enabled') {
        this.toolRegistry.enable(name);
      } else if (state === 'removed') {
        if (this.toolRegistry.remove) {
          this.toolRegistry.remove(name);
        } else {
          this.toolRegistry.disable(name);
        }
      } else {
        this.toolRegistry.disable(name);
      }
    }
  }

  private restoreToolStates(): void {
    if (!this.toolRegistry) return;

    this.restoreBaselineToolStates();
    this.previousToolStates.clear();
  }
}
