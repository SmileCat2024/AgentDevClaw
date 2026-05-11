/**
 * Flow 编排层类型定义
 */

/** 退出条件 */
export interface ExitCondition {
  variable: string;
  variableRef?: FlowCapabilityRef;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'changed';
  value?: any;
}

/** 进入动作 */
export interface AutoAction {
  type: 'tool-call' | 'set-variable';
  tool?: string;
  toolRef?: FlowCapabilityRef;
  args?: Record<string, any>;
  variablePath?: string;
  variableValue?: any;
}

/** 编排期结构化能力引用 */
export interface FlowCapabilityRef {
  source: 'feature' | 'workflow' | 'graph';
  featureId?: string;
  packageName?: string;
  workflowId?: string;
  key?: string;
  name?: string;
}

/** 节点级工具权限规则 */
export interface FlowToolRule {
  name: string;
  mode?: 'enabled' | 'disabled' | 'removed';
  enabled?: boolean;
  ref?: FlowCapabilityRef;
}

/** Flow 节点 */
export interface FlowNode {
  id: string;
  name: string;
  prompt?: string;
  tools?: { enable?: string[]; refs?: FlowCapabilityRef[]; rules?: FlowToolRule[] };
  onEnter?: AutoAction[];
  exitWhen?: ExitCondition;
  children?: FlowNode[];
  reminderFrequency?: 'every-step' | 'every-n-steps' | 'every-call' | 'once-per-node';
  reminderInterval?: number;
  /** 多提示词规则（优先于 prompt 字段） */
  prompts?: FlowPromptRule[];
  /** 节点对 Feature mode 的修改（相对继承，非完整快照） */
  featureModeChanges?: FlowNodeFeatureModeChange[];
  /** 高级覆盖层 */
  advanced?: {
    tools?: {
      rules?: FlowToolRule[];
    };
  };
}

/** Flow 边 */
export interface FlowEdge {
  from: string;
  to: string;
  condition?: string;
}

/** Flow 变量声明 */
export interface FlowVariable {
  key: string;
  type: 'string' | 'number' | 'boolean';
  title: string;
  description?: string;
  resolver: () => any;
}

/** Feature 节点模板 */
export interface FlowNodeTemplate {
  id: string;
  name: string;
  description?: string;
  prompt?: string;
  tools?: { enable: string[] };
  onEnter?: AutoAction[];
  exitWhen?: ExitCondition;
}

/** FlowGraph 顶层定义 */
export interface FlowGraph {
  id: string;
  name: string;
  description?: string;
  mode: 'auto' | 'agent-initiated' | 'auto-reenterable';
  nodes: FlowNode[];
  edges: FlowEdge[];
  entry: string;
  reminderFrequency: 'every-step' | 'every-n-steps' | 'every-call' | 'once-per-node';
  reminderInterval?: number;
  variables?: Record<string, any>;
  /** 工作流级提示词规则（适用于该工作流内所有节点） */
  prompts?: FlowPromptRule[];
}

/** FlowFeature 构造参数 */
export interface FlowFeatureConfig {
  flows?: FlowGraph[];
  flowPath?: string;
  autoInjectStatus?: boolean;
  useTestFlow?: boolean;
}

/** Flow 运行时状态快照 */
export interface FlowStateSnapshot {
  activeFlowId: string | null;
  currentNodeId: string | null;
  stepsInNode: number;
  pendingTransition: boolean;
  pendingTargetNode: string | null;
  callsInNode: number;
  nodeHistory: Array<{ nodeId: string; enteredAt: number; exitedAt?: number }>;
  previousToolStates: Record<string, 'enabled' | 'disabled' | 'removed'>;
  effectiveModesByFeature?: Record<string, string>;
}

/** 提醒频率类型 */
export type ReminderFrequency = 'every-step' | 'every-n-steps' | 'every-call' | 'once-per-node';

/** 提示词规则注入时机 */
export type PromptTiming = 'on-enter' | 'every-step' | 'every-n-steps' | 'every-call' | 'every-n-calls';

/** 单条提示词规则 */
export interface FlowPromptRule {
  id: string;
  name?: string;
  timing: PromptTiming;
  interval?: number;
  template: string;
}

// ─── Feature Mode / Manifest / Contract 类型 ───

/** Feature 配置契约中的单个配置项 */
export interface FeatureManifestSettingProperty {
  type: 'string' | 'number' | 'boolean' | 'select' | 'file';
  title: string;
  description?: string;
  default?: any;
  options?: Array<{ label: string; value: any }>;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  accept?: string | string[];
}

/** Feature 配置契约（Manifest） */
export interface FeatureManifestDefinition {
  schemaVersion: 1;
  settings?: {
    properties: Record<string, FeatureManifestSettingProperty>;
  };
}

/** Prompt 片段，作为 Flow 编辑器的手动拼装素材 */
export interface SuggestedPromptFragment {
  id: string;
  title: string;
  template: string;
  description?: string;
}

/** Feature Mode 声明式效果——mode 选中后 FlowFeature 可读取并自动应用 */
export interface FlowModeEffects {
  /** 此模式下工具的默认状态 */
  tools?: FlowToolRule[];
}

/** Feature 暴露的业务模式定义 */
export interface FlowModeDefinition {
  id: string;
  title: string;
  description?: string;
  featureId?: string;
  category?: string;
  tags?: string[];
  /** 声明式效果，由 FlowFeature 直接读取并自动应用 */
  effects?: FlowModeEffects;
  /** 预先整理好的 prompt 片段，不自动注入，仅作为编辑器素材 */
  suggestedPromptFragments?: SuggestedPromptFragment[];
}

/** 节点中的 Feature mode 修改记录 */
export interface FlowNodeFeatureModeChange {
  featureId?: string;
  packageName?: string;
  modeId: string;
}
