/**
 * API 重试：正文输出截断与网络错误独立控制，默认开启，共享有界重试预算。
 * 框架负责响应安全与错误事实；Feature 负责策略，宿主负责失败 Call 后的重试。
 */

import { fileURLToPath } from 'url';
import {
  Decision,
  getPackageInfoFromSource,
  type AgentFeature,
  type CapabilityDefinition,
  type FeatureInitContext,
  type FeatureManifestDefinition,
  type PackageInfo,
  type StepFinishDecisionContext,
  type Tool,
} from '@agentdevjs/core';

const PROVIDER_TRUNCATION_REASONS = new Set(['max_tokens', 'length']);
const DEFAULT_MAX_CONSECUTIVE_CONTINUATIONS = 5;

export interface ForceContinuationTriggers {
  outputTruncation: boolean;
  apiErrorRetry: boolean;
}

export interface ForceContinuationConfig {
  outputTruncation?: boolean;
  apiErrorRetry?: boolean;
  maxConsecutiveContinuations?: number;
}

export interface ForceContinuationStatus {
  triggers: ForceContinuationTriggers;
  maxConsecutiveContinuations: number;
  consecutiveContinuations: number;
  lastProviderStopReason: string | null;
  lastFinishReason: string | null;
  lastOutcomeStatus: string | null;
  lastAction: 'idle' | 'continued' | 'completed' | 'failed' | 'cancelled' | 'limit_reached';
}

interface OutcomeErrorFact {
  retryable?: unknown;
  category?: unknown;
}

function normalizeStopReason(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().toLowerCase() || null : null;
}

function isRetryableApiErrorOutcome(outcome: { status?: unknown; reason?: unknown; error?: OutcomeErrorFact | null }): boolean {
  return outcome.status === 'failed' && outcome.reason === 'error'
    && outcome.error?.retryable === true
    && ['connection_error', 'connection_timeout', 'rate_limit', 'server_overload', 'server_error'].includes(String(outcome.error.category));
}

function parseConfig(raw: unknown): Required<ForceContinuationConfig> {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const limit = value.maxConsecutiveContinuations;
  return {
    outputTruncation: value.outputTruncation !== false,
    apiErrorRetry: value.apiErrorRetry !== false,
    maxConsecutiveContinuations: typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(1, Math.min(10, Math.floor(limit))) : DEFAULT_MAX_CONSECUTIVE_CONTINUATIONS,
  };
}

export class ForceContinuation implements AgentFeature {
  static hooks = {
    decideContinuation: { lifecycle: 'StepFinish' as any, kind: 'guard' as const, role: 'advisor' as const },
    recordCallFinish: { lifecycle: 'CallFinish' as any, kind: 'observe' as const },
  };

  readonly name = 'force-continuation';
  readonly source = fileURLToPath(import.meta.url).replace(/\\\\/g, '/');
  readonly description = 'API 重试：正文输出达到上限或发生可重试的网络错误时，在预算内自动重试。';
  private config: Required<ForceContinuationConfig>;
  private logger?: FeatureInitContext['logger'];
  private _packageInfo: PackageInfo | null = null;
  private consecutiveContinuations = 0;
  private lastProviderStopReason: string | null = null;
  private lastFinishReason: string | null = null;
  private lastOutcomeStatus: string | null = null;
  private lastAction: ForceContinuationStatus['lastAction'] = 'idle';

  constructor(config: ForceContinuationConfig = {}) {
    this.config = parseConfig(config);
  }

  getFeatureManifest(): FeatureManifestDefinition {
    return {
      schemaVersion: 1,
      settings: {
        properties: {
          outputTruncation: {
            type: 'boolean', title: '正文输出达到上限', default: true,
            description: '已有正文时达到输出上限，保留正文及返回的思考后请求继续；本次工具调用丢弃且不执行。只有思考、没有正文时按错误结束，不自动重试。',
          },
          apiErrorRetry: {
            type: 'boolean', title: '网络错误', default: true,
            description: '模型调用因超时、断连、限流或服务端错误失败后，在预算内自动重试。不重试用户停止、认证失败或输出预算耗尽错误。',
          },
          maxConsecutiveContinuations: {
            type: 'number', title: '最大重试次数', default: DEFAULT_MAX_CONSECUTIVE_CONTINUATIONS,
            description: '两类 API 重试共享的连续重试上限（1–10），默认 5 次。', min: 1, max: 10, step: 1,
          },
        },
        sections: [{ id: 'api-retry', title: 'API 重试', properties: ['outputTruncation', 'apiErrorRetry', 'maxConsecutiveContinuations'] }],
      },
    };
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    const featureConfig = ctx.featureConfig && typeof ctx.featureConfig === 'object' ? ctx.featureConfig : {};
    this.config = parseConfig({ ...this.config, ...featureConfig });
  }

  getTools(): Tool[] { return []; }

  getCapabilities(): CapabilityDefinition[] {
    const properties = this.getFeatureManifest().settings!.properties;
    return [{
      name: 'configure', title: '配置 API 重试',
      description: '独立设置正文输出达到上限、网络错误两类重试及共享次数上限。',
      parameters: properties, entryPoints: ['slash', 'feature'],
      readCurrentValues: () => ({ ...this.config }),
      execute: (args) => {
        const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
        const triggers: Partial<ForceContinuationTriggers> = {};
        if (typeof input.outputTruncation === 'boolean') triggers.outputTruncation = input.outputTruncation;
        if (typeof input.apiErrorRetry === 'boolean') triggers.apiErrorRetry = input.apiErrorRetry;
        if (Object.keys(triggers).length) this.setTriggers(triggers);
        if (typeof input.maxConsecutiveContinuations === 'number') this.setMaxConsecutive(input.maxConsecutiveContinuations);
        return Promise.resolve(this.getStatus());
      },
    }];
  }

  /**
   * 会话控制面板请求面（宿主通用 feature-comms-request 分支投递；server
   * agent-lifecycle 路由的本地路径发此消息形态，远程保持 ADR-0011 转发）。
   * 旧宿主专用 IPC 分支（force-continuation-control / -status）已收编退役。
   * 校验语义与路由层对齐（triggers 仅两布尔键；上限 1–10 整数）。
   */
  async onHostRequest(requestType: string, payload: unknown): Promise<Record<string, unknown>> {
    const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    switch (requestType) {
      case 'status':
        return { ok: true, status: this.getStatus() };
      case 'configure': {
        const { triggers, maxConsecutiveContinuations } = body;
        if (triggers !== undefined) {
          const valid = typeof triggers === 'object' && triggers !== null && !Array.isArray(triggers)
            && Object.entries(triggers).every(([key, value]) =>
              (key === 'outputTruncation' || key === 'apiErrorRetry') && typeof value === 'boolean');
          if (!valid) {
            return { ok: false, code: 'invalid_payload', error: 'triggers must contain only boolean outputTruncation and apiErrorRetry fields' };
          }
        }
        if (maxConsecutiveContinuations !== undefined) {
          const value = maxConsecutiveContinuations;
          if (typeof value !== 'number' || !Number.isFinite(value) || Math.floor(value) !== value || value < 1 || value > 10) {
            return { ok: false, code: 'invalid_payload', error: 'maxConsecutiveContinuations must be an integer between 1 and 10' };
          }
        }
        // 先全量校验后应用：非法载荷不得部分生效。
        if (triggers !== undefined) {
          this.setTriggers(triggers as Partial<ForceContinuationTriggers>);
        }
        if (maxConsecutiveContinuations !== undefined) {
          this.setMaxConsecutive(maxConsecutiveContinuations as number);
        }
        return { ok: true, status: this.getStatus() };
      }
      default:
        return { ok: false, code: 'operation_unavailable', error: `Unknown requestType: ${requestType}` };
    }
  }

  setTriggers(triggers: Partial<ForceContinuationTriggers>): ForceContinuationStatus {
    this.config = parseConfig({ ...this.config, ...triggers });
    this.lastAction = 'idle';
    return this.getStatus();
  }

  setMaxConsecutive(value: number): ForceContinuationStatus {
    if (Number.isFinite(value)) this.config.maxConsecutiveContinuations = Math.max(1, Math.min(10, Math.floor(value)));
    return this.getStatus();
  }

  getStatus(): ForceContinuationStatus {
    return {
      triggers: { outputTruncation: this.config.outputTruncation, apiErrorRetry: this.config.apiErrorRetry },
      maxConsecutiveContinuations: this.config.maxConsecutiveContinuations,
      consecutiveContinuations: this.consecutiveContinuations,
      lastProviderStopReason: this.lastProviderStopReason, lastFinishReason: this.lastFinishReason,
      lastOutcomeStatus: this.lastOutcomeStatus, lastAction: this.lastAction,
    };
  }

  private canRequestContinuation(): boolean {
    if (this.consecutiveContinuations >= this.config.maxConsecutiveContinuations) {
      this.lastAction = 'limit_reached';
      return false;
    }
    this.consecutiveContinuations += 1;
    this.lastAction = 'continued';
    return true;
  }

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) this._packageInfo = getPackageInfoFromSource(this.source);
    return this._packageInfo;
  }

  async decideContinuation(ctx: StepFinishDecisionContext) {
    const reason = normalizeStopReason(ctx.llmResponse?.stopReason);
    this.lastProviderStopReason = reason;
    if (!this.config.outputTruncation || !reason || !PROVIDER_TRUNCATION_REASONS.has(reason)
      || !ctx.llmResponse?.content?.trim() || ctx.toolCallsCount !== 0) return Decision.Continue;
    if (!this.canRequestContinuation()) return Decision.Continue;
    ctx.context.add({
      role: 'system',
      content: '[API 重试：正文输出达到上限]\n已有正文与返回的思考已保留；本次截断响应中的工具调用已丢弃且未执行。请从正文中断处继续，必要时重新发起工具调用，不要重复已完成的工作。',
    });
    this.logger?.info('API retry requested after output truncation', { reason, count: this.consecutiveContinuations });
    return Decision.Approve;
  }

  /**
   * Called by the Claw CallArbiter after an AgentDev Call failed with a
   * retryable network error. The framework Call has already ended and only the host can start
   * a segment. Non-retryable errors never pass the retryable check, and
   * user cancellations arrive as status=cancelled, not here.
   */
  requestApiErrorContinuation(outcome: { status?: unknown; reason?: unknown; error?: OutcomeErrorFact | null }): boolean {
    if (!this.config.apiErrorRetry) return false;
    if (!isRetryableApiErrorOutcome(outcome)) return false;
    if (!this.canRequestContinuation()) return false;

    this.lastFinishReason = normalizeStopReason(outcome.reason);
    this.lastOutcomeStatus = normalizeStopReason(outcome.status);
    this.logger?.info('Force continuation requested after retryable API error', {
      category: typeof outcome.error?.category === 'string' ? outcome.error.category : null,
      consecutiveContinuations: this.consecutiveContinuations,
    });
    return true;
  }

  async recordCallFinish(ctx: { finishReason?: unknown; outcome?: { status?: unknown; reason?: unknown; error?: OutcomeErrorFact | null; model?: { providerStopReason?: unknown } } }): Promise<void> {
    this.lastFinishReason = typeof ctx.outcome?.reason === 'string'
      ? ctx.outcome.reason
      : typeof ctx.finishReason === 'string' ? ctx.finishReason : null;
    this.lastOutcomeStatus = typeof ctx.outcome?.status === 'string' ? ctx.outcome.status : null;
    this.lastProviderStopReason = normalizeStopReason(ctx.outcome?.model?.providerStopReason) ?? this.lastProviderStopReason;

    // The host retry follows CallFinish and must share the same budget.
    if (this.config.apiErrorRetry
      && isRetryableApiErrorOutcome({ status: this.lastOutcomeStatus, reason: this.lastFinishReason, error: ctx.outcome?.error })) {
      this.lastAction = 'failed';
      return;
    }

    if (this.lastOutcomeStatus === 'completed') this.lastAction = 'completed';
    else if (this.lastOutcomeStatus === 'cancelled') this.lastAction = 'cancelled';
    else if (this.lastOutcomeStatus === 'failed') this.lastAction = 'failed';
    this.consecutiveContinuations = 0;
  }

  captureState() {
    return {
      config: { ...this.config },
      consecutiveContinuations: this.consecutiveContinuations,
      lastProviderStopReason: this.lastProviderStopReason,
      lastFinishReason: this.lastFinishReason,
      lastOutcomeStatus: this.lastOutcomeStatus,
      lastAction: this.lastAction,
    };
  }

  restoreState(snapshot: unknown): void {
    const state = snapshot && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : {};
    const storedConfig = state.config && typeof state.config === 'object' ? state.config as Record<string, unknown> : {};
    this.config = parseConfig({
      ...this.config,
      ...storedConfig,
    });
    this.consecutiveContinuations = typeof state.consecutiveContinuations === 'number'
      ? Math.max(0, Math.min(this.config.maxConsecutiveContinuations, Math.floor(state.consecutiveContinuations)))
      : 0;
    this.lastProviderStopReason = normalizeStopReason(state.lastProviderStopReason);
    this.lastFinishReason = typeof state.lastFinishReason === 'string' ? state.lastFinishReason : null;
    this.lastOutcomeStatus = typeof state.lastOutcomeStatus === 'string' ? state.lastOutcomeStatus : null;
    this.lastAction = ['idle', 'continued', 'completed', 'failed', 'cancelled', 'limit_reached'].includes(String(state.lastAction))
      ? state.lastAction as ForceContinuationStatus['lastAction']
      : 'idle';
  }
}
