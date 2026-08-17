import { fileURLToPath } from 'url';
import type { AgentFeature, FeatureInitContext, PackageInfo } from 'agentdev';
import { CoreLifecycle, getPackageInfoFromSource } from 'agentdev';
import type { HookDeclarations } from 'agentdev';

const __filename = fileURLToPath(import.meta.url);

export interface ContextGuardConfig {
  enabled?: boolean;
  contextLength?: number | null;
  compressRatio?: number | null;
  agentId?: string;
  sessionId?: string | null;
  serverOrigin?: string;
}

export interface ContextGuardState {
  blocked: boolean;
  blockedAt: number | null;
  thresholdTokens: number | null;
  inputTokens: number | null;
  reason: string | null;
}

/**
 * Stops a runtime at the model's configured compression threshold.
 *
 * The LLM wrapper observes response usage before AgentDev begins executing
 * returned tools, so a threshold-crossing response cannot start another tool
 * or ReAct step. The Claw runtime persists this state into the session index.
 */
export class ContextGuardFeature implements AgentFeature {

  static hooks: HookDeclarations = {
    installUsageGuard: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
  };
  readonly name = 'context-guard';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'Stops the programming-helper session when its current request reaches the configured context compression threshold.';

  private readonly enabled: boolean;
  private thresholdTokens: number | null;
  private readonly agentId: string;
  private readonly sessionId: string;
  private readonly serverOrigin: string;
  private logger?: FeatureInitContext['logger'];
  private packageInfo: PackageInfo | null = null;
  private callArbiter: any = null;
  private _agent: any = null;
  private state: ContextGuardState = {
    blocked: false,
    blockedAt: null,
    thresholdTokens: null,
    inputTokens: null,
    reason: null,
  };

  constructor(config: ContextGuardConfig = {}) {
    this.enabled = config.enabled !== false;
    const contextLength = Number(config.contextLength);
    const compressRatio = Number(config.compressRatio ?? 80);
    this.thresholdTokens = Number.isFinite(contextLength) && contextLength > 0
      && Number.isFinite(compressRatio) && compressRatio > 0
      ? Math.floor(contextLength * Math.min(100, compressRatio) / 100)
      : null;
    this.agentId = typeof config.agentId === 'string' ? config.agentId.trim() : '';
    this.sessionId = typeof config.sessionId === 'string' ? config.sessionId.trim() : '';
    this.serverOrigin = typeof config.serverOrigin === 'string'
      ? config.serverOrigin.replace(/\/$/, '')
      : '';
    this.state.thresholdTokens = this.thresholdTokens;
  }

  getPackageInfo(): PackageInfo | null {
    if (!this.packageInfo) this.packageInfo = getPackageInfoFromSource(this.source);
    return this.packageInfo;
  }

  getTemplateNames(): string[] {
    return [];
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger?.info('Context guard initiated', {
      enabled: this.enabled,
      thresholdTokens: this.thresholdTokens,
      agentId: this.agentId || null,
      sessionId: this.sessionId || null,
    });
  }

  setCallArbiter(arbiter: any): void {
    this.callArbiter = arbiter;
  }

  isBlocked(): boolean {
    return this.enabled && this.state.blocked;
  }

  getBlockReason(): string | null {
    return this.isBlocked() ? this.state.reason : null;
  }

  getState(): ContextGuardState {
    return { ...this.state };
  }

  captureState(): ContextGuardState {
    return this.getState();
  }

  restoreState(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const state = raw as Partial<ContextGuardState>;
    this.state = {
      blocked: state.blocked === true,
      blockedAt: Number.isFinite(state.blockedAt) ? Number(state.blockedAt) : null,
      thresholdTokens: this.thresholdTokens,
      inputTokens: Number.isFinite(state.inputTokens) ? Number(state.inputTokens) : null,
      reason: typeof state.reason === 'string' ? state.reason : null,
    };
  }

  async installUsageGuard(ctx: any): Promise<void> {
    const agent = ctx?.agent;
    if (!agent || !this.enabled || !this.thresholdTokens || this.state.blocked) return;
    if (!this._agent) this._agent = agent;
    const llm = agent.llm as any;
    if (!llm || typeof llm.chat !== 'function' || llm.__clawContextGuardInstalled) return;

    const originalChat = llm.chat.bind(llm);
    const feature = this;
    llm.chat = async function guardedChat(...args: any[]) {
      const response = await originalChat(...args);
      feature.observeUsage(response?.usage, agent);
      return response;
    };
    llm.__clawContextGuardInstalled = true;
    this.logger?.info('Context guard is observing LLM usage', {
      thresholdTokens: this.thresholdTokens,
    });
  }

  observeUsage(usage: any, agent?: any): boolean {
    if (!this.enabled || this.state.blocked || !this.thresholdTokens) return false;
    const inputTokens = Number(usage?.inputTokens);
    if (!Number.isFinite(inputTokens) || inputTokens <= 0 || inputTokens < this.thresholdTokens) return false;

    const reason = `Context threshold reached: ${Math.round(inputTokens)} input tokens (limit ${this.thresholdTokens}).`;
    this.state = {
      blocked: true,
      blockedAt: Date.now(),
      thresholdTokens: this.thresholdTokens,
      inputTokens: Math.round(inputTokens),
      reason,
    };
    this.logger?.warn?.('Context guard blocked the session', {
      inputTokens: this.state.inputTokens,
      thresholdTokens: this.thresholdTokens,
      agentId: this.agentId || null,
      sessionId: this.sessionId || null,
    });
    this.reportBlockedState();
    const cleared = this.callArbiter?.blockQueued?.(reason) || 0;
    if (cleared > 0) {
      this.logger?.info('Context guard cancelled queued inputs', { cleared });
    }
    if (typeof agent?.interrupt === 'function') {
      agent.interrupt();
    }
    return true;
  }

  /**
   * Persist immediately instead of waiting for the normal session-save path.
   * The Claw UI polls this record and can therefore disable input and surface a
   * visible error while the aborted agent call is still unwinding.
   */
  private reportBlockedState(): void {
    if (!this.serverOrigin || !this.agentId || !this.sessionId || typeof fetch !== 'function') return;
    void fetch(`${this.serverOrigin}/protoclaw/context_guard_event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: this.agentId,
        sessionId: this.sessionId,
        contextGuard: this.getState(),
      }),
    }).catch((error) => {
      this.logger?.warn?.('Context guard state sync failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Update the compression threshold when the model changes (e.g. hot-swap).
   * Called from onLLMSwap or directly by the runtime IPC handler.
   */
  updateThreshold(contextLength: number | null, compressRatio: number | null): void {
    const cl = Number(contextLength);
    const cr = Number(compressRatio ?? 80);
    this.thresholdTokens = Number.isFinite(cl) && cl > 0
      && Number.isFinite(cr) && cr > 0
      ? Math.floor(cl * Math.min(100, cr) / 100)
      : null;
    this.state.thresholdTokens = this.thresholdTokens;
    this.logger?.info('Context guard threshold updated', { thresholdTokens: this.thresholdTokens });
  }

  /**
   * Called by the framework when the LLM is hot-swapped.
   * Uses agent.getLLMMeta() to read the new model metadata and recompute the threshold.
   */
  onLLMSwap(_newLLM: any, _oldLLM: any): void {
    const meta = this._agent?.getLLMMeta?.();
    if (meta) {
      this.updateThreshold(
        typeof meta.contextLength === 'number' ? meta.contextLength : null,
        typeof meta.compressRatio === 'number' ? meta.compressRatio : null,
      );
    }
  }
}
