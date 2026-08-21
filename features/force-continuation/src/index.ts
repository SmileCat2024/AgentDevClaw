/**
 * ForceContinuation Feature
 *
 * The session-local master switch gates individually configurable recovery
 * candidates: provider max_tokens, provider length, and the framework-level
 * CallOutcome.reason=limit_reached. Provider values remain diagnostic facts;
 * the framework reason is the authoritative signal for a Call boundary.
 *
 * It deliberately never resumes user cancellations or failed calls. Those are
 * explicit user/host boundaries or errors that require a dedicated retry
 * policy, rather than a generic "keep working" decision.
 */

import { fileURLToPath } from 'url';
import {
  Decision,
  getPackageInfoFromSource,
  type AgentFeature,
  type FeatureInitContext,
  type FeatureManifestDefinition,
  type PackageInfo,
  type StepFinishDecisionContext,
  type Tool,
} from '@agentdev/core';

const PROVIDER_TRUNCATION_REASONS = new Set(['max_tokens', 'length']);
const DEFAULT_MAX_CONSECUTIVE_CONTINUATIONS = 5;

export interface ForceContinuationTriggers {
  /** Continue a Step after a provider signals token-budget truncation. */
  providerMaxTokens: boolean;
  /** Continue a Step after an OpenAI-style provider signals length truncation. */
  providerLength: boolean;
  /** Ask the Claw host to continue after AgentDev exhausts its ReAct-step budget. */
  frameworkLimitReached: boolean;
}

export interface ForceContinuationConfig {
  /** Starts each newly-created runtime enabled only when explicitly true. */
  enabled?: boolean;
  /** Maximum forced continuations in the same call/envelope, 1–10. */
  maxConsecutiveContinuations?: number;
  /** Independently controlled continuation candidates; all default to true. */
  triggers?: ForceContinuationTriggers;
}

export interface ForceContinuationStatus {
  enabled: boolean;
  triggers: ForceContinuationTriggers;
  maxConsecutiveContinuations: number;
  consecutiveContinuations: number;
  lastProviderStopReason: string | null;
  lastFinishReason: string | null;
  lastOutcomeStatus: string | null;
  lastAction: 'idle' | 'continued' | 'completed' | 'failed' | 'cancelled' | 'limit_reached';
}

function parseTriggers(raw: unknown): ForceContinuationTriggers {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    providerMaxTokens: value.providerMaxTokens !== false,
    providerLength: value.providerLength !== false,
    frameworkLimitReached: value.frameworkLimitReached !== false,
  };
}

function parseConfig(raw: unknown): Required<ForceContinuationConfig> {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const requestedLimit = value.maxConsecutiveContinuations;
  const maxConsecutiveContinuations = typeof requestedLimit === 'number' && Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(10, Math.floor(requestedLimit)))
    : DEFAULT_MAX_CONSECUTIVE_CONTINUATIONS;

  return {
    // This is a deliberate opt-in: mounting the feature must not unexpectedly
    // make every session retry/continue incomplete calls.
    enabled: value.enabled === true,
    maxConsecutiveContinuations,
    triggers: parseTriggers(value.triggers),
  };
}

function normalizeStopReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

export class ForceContinuation implements AgentFeature {
  static hooks = {
    decideContinuation: { lifecycle: 'StepFinish' as any, kind: 'guard' as const, role: 'advisor' as const },
    recordCallFinish: { lifecycle: 'CallFinish' as any, kind: 'observe' as const },
  };

  readonly name = 'force-continuation';
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description = '在可恢复的模型输出截断时，以受限次数强制 Agent 继续当前任务。';

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
          enabled: {
            type: 'boolean',
            title: '保持任务继续',
            description: '总开关。开启后，才会对启用的异常中断候选请求受限继续；不会覆盖用户中断或 API/运行时错误。',
            default: false,
          },
          providerMaxTokens: {
            type: 'boolean',
            title: 'Provider max_tokens 截断',
            description: 'Provider 报告 max_tokens 时，在当前 step 内请求继续。',
            default: true,
          },
          providerLength: {
            type: 'boolean',
            title: 'Provider length 截断',
            description: 'Provider 报告 length 时，在当前 step 内请求继续。',
            default: true,
          },
          frameworkLimitReached: {
            type: 'boolean',
            title: '框架执行 step 上限耗尽',
            description: '框架 Call 因 ReAct step 上限结束后，由宿主在预算内开始下一段。',
            default: true,
          },
          maxConsecutiveContinuations: {
            type: 'number',
            title: '最大连续继续次数',
            description: '同一次 call 中连续检测到 provider 截断时允许的最大继续次数，达到上限后停止，避免无界循环。',
            default: DEFAULT_MAX_CONSECUTIVE_CONTINUATIONS,
            min: 1,
            max: 10,
            step: 1,
          },
        },
        sections: [{ id: 'continuation', title: '继续策略', properties: ['enabled', 'providerMaxTokens', 'providerLength', 'frameworkLimitReached', 'maxConsecutiveContinuations'] }],
      },
    };
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    // Project configuration overrides the constructor defaults and preserves
    // an explicit false value.
    const featureConfig = ctx.featureConfig && typeof ctx.featureConfig === 'object'
      ? ctx.featureConfig as Record<string, unknown>
      : {};
    this.config = parseConfig({
      ...this.config,
      ...featureConfig,
      triggers: {
        ...this.config.triggers,
        providerMaxTokens: featureConfig.providerMaxTokens === false ? false : this.config.triggers.providerMaxTokens,
        providerLength: featureConfig.providerLength === false ? false : this.config.triggers.providerLength,
        frameworkLimitReached: featureConfig.frameworkLimitReached === false ? false : this.config.triggers.frameworkLimitReached,
      },
    });
  }

  getTools(): Tool[] {
    // Fully automatic, session-scoped policy Feature. The private session IPC
    // bridge (Claw side panel) is the only control surface; exposing a tool to
    // the model would give model output a way to interact with a mode that can
    // loop, so no tools are declared on purpose.
    return [];
  }

  /** Public control API for the Claw session IPC bridge and other Features. */
  setEnabled(enabled: boolean): ForceContinuationStatus {
    this.config.enabled = enabled === true;
    this.consecutiveContinuations = 0;
    this.lastAction = 'idle';
    return this.getStatus();
  }

  /** Updates one or more candidate switches without bypassing the master switch. */
  setTriggers(triggers: Partial<ForceContinuationTriggers>): ForceContinuationStatus {
    this.config.triggers = parseTriggers({ ...this.config.triggers, ...triggers });
    this.consecutiveContinuations = 0;
    this.lastAction = 'idle';
    return this.getStatus();
  }

  /**
   * Adjusts the per-task auto-resume cap from the control panel. The value is
   * clamped to 1–10 the same way parseConfig does; the running count is kept
   * because raising the cap should let an in-flight task resume again, and
   * lowering it takes effect on the next continuation decision.
   */
  setMaxConsecutive(value: number): ForceContinuationStatus {
    const next = typeof value === 'number' && Number.isFinite(value)
      ? Math.max(1, Math.min(10, Math.floor(value)))
      : this.config.maxConsecutiveContinuations;
    this.config.maxConsecutiveContinuations = next;
    return this.getStatus();
  }

  getStatus(): ForceContinuationStatus {
    return {
      enabled: this.config.enabled,
      triggers: { ...this.config.triggers },
      maxConsecutiveContinuations: this.config.maxConsecutiveContinuations,
      consecutiveContinuations: this.consecutiveContinuations,
      lastProviderStopReason: this.lastProviderStopReason,
      lastFinishReason: this.lastFinishReason,
      lastOutcomeStatus: this.lastOutcomeStatus,
      lastAction: this.lastAction,
    };
  }

  private isProviderTriggerEnabled(stopReason: string): boolean {
    return (stopReason === 'max_tokens' && this.config.triggers.providerMaxTokens)
      || (stopReason === 'length' && this.config.triggers.providerLength);
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
    const stopReason = normalizeStopReason(ctx.llmResponse?.stopReason);
    this.lastProviderStopReason = stopReason;

    if (!this.config.enabled || ctx.toolCallsCount !== 0 || !stopReason) {
      if (ctx.toolCallsCount !== 0 || !stopReason) this.consecutiveContinuations = 0;
      return Decision.Continue;
    }

    if (!PROVIDER_TRUNCATION_REASONS.has(stopReason) || !this.isProviderTriggerEnabled(stopReason)) {
      return Decision.Continue;
    }

    if (!this.canRequestContinuation()) {
      this.logger?.warn('Force continuation limit reached', {
        stopReason,
        maxConsecutiveContinuations: this.config.maxConsecutiveContinuations,
      });
      return Decision.Continue;
    }

    ctx.context.add({
      role: 'system',
      content: [
        '[强制继续]',
        `上一段模型输出因 provider stop reason=${stopReason} 被截断。`,
        '继续完成当前任务；不要重复已完成的工作。先检查已有上下文，再从中断处继续。',
      ].join('\n'),
    });
    this.logger?.info('Force continuation requested', {
      stopReason,
      consecutiveContinuations: this.consecutiveContinuations,
      maxConsecutiveContinuations: this.config.maxConsecutiveContinuations,
    });
    return Decision.Approve;
  }

  /**
   * Called by the Claw CallArbiter after an AgentDev Call reaches its own ReAct
   * step budget. This is intentionally separate from StepFinish: at that point
   * the framework Call has already ended and only the host can start a segment.
   */
  requestFrameworkLimitContinuation(outcome: { reason?: unknown; status?: unknown }): string | null {
    const reason = normalizeStopReason(outcome.reason);
    const status = normalizeStopReason(outcome.status);
    if (!this.config.enabled || !this.config.triggers.frameworkLimitReached || reason !== 'limit_reached') {
      return null;
    }
    // AgentDev represents an exhausted step budget as status=failed +
    // reason=limit_reached. The reason (not status) is the recovery contract.
    if (!this.canRequestContinuation()) return null;

    this.lastFinishReason = reason;
    this.lastOutcomeStatus = status;
    this.logger?.info('Force continuation requested after framework limit', {
      reason,
      status,
      consecutiveContinuations: this.consecutiveContinuations,
    });
    return '[本条消息由系统自动发送] 当前任务因框架执行步数上限而中断。请检查已有上下文，从中断处继续完成当前任务；不要重复已经完成的工作。';
  }

  async recordCallFinish(ctx: { finishReason?: unknown; outcome?: { status?: unknown; reason?: unknown; model?: { providerStopReason?: unknown } } }): Promise<void> {
    this.lastFinishReason = typeof ctx.outcome?.reason === 'string'
      ? ctx.outcome.reason
      : typeof ctx.finishReason === 'string' ? ctx.finishReason : null;
    this.lastOutcomeStatus = typeof ctx.outcome?.status === 'string' ? ctx.outcome.status : null;
    this.lastProviderStopReason = normalizeStopReason(ctx.outcome?.model?.providerStopReason) ?? this.lastProviderStopReason;

    if (this.lastFinishReason === 'limit_reached' && this.config.enabled && this.config.triggers.frameworkLimitReached) {
      // Preserve the same-envelope budget for the host-side continuation that
      // follows this CallFinish hook.
      this.lastAction = 'limit_reached';
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
      triggers: { ...this.config.triggers, ...(storedConfig.triggers && typeof storedConfig.triggers === 'object' ? storedConfig.triggers : {}) },
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
