/**
 * FlowAwareFeature - 带 Flow 能力的 Feature 基类
 *
 * AgentDevClaw 侧的 Feature 基类，扩展 AgentFeature 接口，
 * 增加变量暴露和节点模板声明能力。
 * 未来 Claw 侧的 Feature 继承此类即可向 Flow 暴露变量和模板。
 */

import type { AgentFeature, FeatureInitContext, FeatureStateSnapshot, Tool, PackageInfo, ContextInjector } from 'agentdev';
import type {
  FlowVariable,
  FlowNodeTemplate,
  FlowModeDefinition,
  FeatureManifestDefinition,
} from './types.js';

export interface FlowModeContext {
  nodeId: string;
  workflowId: string;
  agent: any;
}

export abstract class FlowAwareFeature implements AgentFeature {
  abstract readonly name: string;
  readonly dependencies?: string[];
  readonly source?: string;
  readonly description?: string;

  /** 声明此 Feature 的配置契约（schema / 默认值） */
  getFeatureManifest?(): FeatureManifestDefinition | null;

  /** 声明此 Feature 暴露给 Flow 的业务模式 */
  getFlowModes?(): FlowModeDefinition[];

  /** 声明此 Feature 暴露给 Flow 的运行时变量 */
  getFlowVariables?(): FlowVariable[];

  /** 声明此 Feature 提供的节点模板 */
  getFlowNodeTemplates?(): FlowNodeTemplate[];

  /** 切换到某个 Flow mode（Feature 内部状态层） */
  applyFlowMode?(modeId: string, ctx: FlowModeContext): Promise<void> | void;

  /** 恢复 Feature 的 mode 基线 */
  resetFlowModes?(ctx: FlowModeContext): Promise<void> | void;

  // AgentFeature 可选方法的默认实现
  getTools?(): Tool[] { return []; }
  getAsyncTools?(ctx: FeatureInitContext): Promise<Tool[]> { return Promise.resolve([]); }
  getPackageInfo?(): PackageInfo | null { return null; }
  getTemplateNames?(): string[] { return []; }
  getContextInjectors?(): Map<string | RegExp, ContextInjector> { return new Map(); }
  onInitiate?(ctx: FeatureInitContext): Promise<void> { return Promise.resolve(); }
  onDestroy?(ctx: any): Promise<void> { return Promise.resolve(); }
  captureState?(): FeatureStateSnapshot { return {}; }
  restoreState?(snapshot: FeatureStateSnapshot): void {}
  beforeRollback?(snapshot: FeatureStateSnapshot): Promise<void> { return Promise.resolve(); }
  afterRollback?(snapshot: FeatureStateSnapshot): Promise<void> { return Promise.resolve(); }
}
