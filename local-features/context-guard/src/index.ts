import { fileURLToPath } from 'url';
import type { AgentFeature, FeatureInitContext, FeatureManifestDefinition, PackageInfo } from '@agentdev/core';
import { CoreLifecycle, getPackageInfoFromSource } from '@agentdev/core';
import type { HookDeclarations } from '@agentdev/core';

const __filename = fileURLToPath(import.meta.url);

export interface ContextGuardConfig {
  /** 一次性拦截保险丝的会话启动初值（Runtime 配置面板的 manifest 勾选框）。 */
  enabled?: boolean;
  contextLength?: number | null;
  compressRatio?: number | null;
}

export interface ContextGuardTrip {
  at: number;
  thresholdTokens: number;
  inputTokens: number;
  reason: string;
}

export interface ContextGuardStatus {
  /** 保险丝是否装填：true 时下一次过界会拦截并消耗。 */
  armed: boolean;
  /** 最近一次拦截事实；null 表示本会话从未触发。 */
  trip: ContextGuardTrip | null;
  thresholdTokens: number | null;
}

export interface ContextRotationTriggerConfig {
  contextLength?: number | null;
  compressRatio?: number | null;
  agentId?: string;
  sessionId?: string | null;
  serverOrigin?: string;
}

interface ThresholdCrossing {
  inputTokens: number;
  thresholdTokens: number;
}

/**
 * 共享检测核心：阈值 = 当前模型元数据（contextLength × compressRatio）的纯函数，
 * 换模型即重算，不持久化阈值本身。
 */
class ContextGuardCore {
  private thresholdTokens: number | null = null;

  constructor(contextLength?: number | null, compressRatio?: number | null) {
    this.updateThreshold(contextLength ?? null, compressRatio ?? null);
  }

  getThresholdTokens(): number | null {
    return this.thresholdTokens;
  }

  updateThreshold(contextLength: number | null, compressRatio: number | null): void {
    const cl = Number(contextLength);
    const cr = Number(compressRatio ?? 80);
    this.thresholdTokens = Number.isFinite(cl) && cl > 0
      && Number.isFinite(cr) && cr > 0
      ? Math.floor(cl * Math.min(100, cr) / 100)
      : null;
  }

  /** 过线返回用量事实，未过线或无阈值返回 null。 */
  evaluate(usage: unknown): ThresholdCrossing | null {
    if (!this.thresholdTokens) return null;
    const inputTokens = Number((usage as { inputTokens?: unknown } | null)?.inputTokens);
    if (!Number.isFinite(inputTokens) || inputTokens <= 0 || inputTokens < this.thresholdTokens) return null;
    return { inputTokens: Math.round(inputTokens), thresholdTokens: this.thresholdTokens };
  }
}

/**
 * 包装 agent.llm.chat，在每个响应返回后观察 usage。幂等：同一 llm 只包装一次，
 * 热切换模型后由下一次 CallStart 重新安装。
 */
function installChatObserver(agent: any, observer: (usage: any) => void): void {
  const llm = agent?.llm;
  if (!llm || typeof llm.chat !== 'function' || llm.__clawContextGuardInstalled) return;
  const originalChat = llm.chat.bind(llm);
  llm.chat = async function guardedChat(...args: any[]) {
    const response = await originalChat(...args);
    try {
      observer(response?.usage);
    } catch { /* observation must never break the call */ }
    return response;
  };
  llm.__clawContextGuardInstalled = true;
}

function tripReason(crossing: ThresholdCrossing): string {
  return `Context threshold reached: ${crossing.inputTokens} input tokens (limit ${crossing.thresholdTokens}).`;
}

/**
 * 交互式工作空间的一次性过界拦截。
 *
 * 过界（inputTokens ≥ 压缩阈值）时打断当前轮并退回排队消息，保险丝随之消耗；
 * 之后输入完全放行（继续对话的上下文开销由用户自负）。触发一次后可在
 * 会话控制面板重新装填。状态只存 feature 内存：会话精简/分支产生的
 * successor runtime 天然回到 manifest 初值，不参与 continuity 转移。
 */
export class ContextGuardFeature implements AgentFeature {

  static hooks: HookDeclarations = {
    installUsageGuard: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
  };
  readonly name = 'context-guard';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'Interrupts a session once when its context reaches the compression threshold; the fuse is re-armed from the session control panel.';

  private readonly core: ContextGuardCore;
  private armed: boolean;
  private trip: ContextGuardTrip | null = null;
  private logger?: FeatureInitContext['logger'];
  private packageInfo: PackageInfo | null = null;
  private callArbiter: any = null;
  private _agent: any = null;

  constructor(config: ContextGuardConfig = {}) {
    this.core = new ContextGuardCore(config.contextLength, config.compressRatio);
    this.armed = config.enabled !== false;
  }

  getPackageInfo(): PackageInfo | null {
    if (!this.packageInfo) this.packageInfo = getPackageInfoFromSource(this.source);
    return this.packageInfo;
  }

  getTemplateNames(): string[] {
    return [];
  }

  getFeatureManifest(): FeatureManifestDefinition {
    return {
      schemaVersion: 1,
      settings: {
        properties: {
          enabled: {
            type: 'boolean',
            title: '上下文保护',
            description: '开启后，上下文超过压缩阈值时自动打断当前会话并提醒精简；触发后自动关闭，可在会话控制面板重新开启。仅交互式工作空间；coder 线程自动接力不受此配置影响。',
            default: true,
          },
        },
        sections: [{ id: 'guard', title: '上下文保护', properties: ['enabled'] }],
      },
    };
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger?.info('Context guard initiated', {
      armed: this.armed,
      thresholdTokens: this.core.getThresholdTokens(),
    });
  }

  setCallArbiter(arbiter: any): void {
    this.callArbiter = arbiter;
  }

  getStatus(): ContextGuardStatus {
    return {
      armed: this.armed,
      trip: this.trip ? { ...this.trip } : null,
      thresholdTokens: this.core.getThresholdTokens(),
    };
  }

  /** 会话控制面板开关：装填/卸下保险丝。装填后再过界会再拦一次。 */
  setArmed(armed: boolean): void {
    this.armed = armed === true;
  }

  /**
   * 阈值锚定到当前 LLM 的活元数据：挂载注入值只是初值，每个 CallStart
   * 重算一次。这覆盖两类漂移——会话首轮调用前热切换模型（onLLMSwap 时
   * _agent 尚未捕获）、以及 runtime 启动预设与会话实际模型不一致。
   * meta 缺 contextLength 时保留现值（不做破坏性清空）。
   */
  private syncThresholdFromLiveMeta(agent: any): void {
    const meta = agent?.getLLMMeta?.();
    const cl = Number(meta?.contextLength);
    const cr = Number(meta?.compressRatio);
    if (Number.isFinite(cl) && cl > 0) {
      this.updateThreshold(cl, Number.isFinite(cr) && cr > 0 ? cr : null);
    }
  }

  async installUsageGuard(ctx: any): Promise<void> {
    const agent = ctx?.agent;
    if (!agent) return;
    if (!this._agent) this._agent = agent;
    this.syncThresholdFromLiveMeta(agent);
    if (!this.armed) return;
    installChatObserver(agent, (usage) => this.observeUsage(usage, agent));
    this.logger?.info('Context guard is observing LLM usage', {
      thresholdTokens: this.core.getThresholdTokens(),
    });
  }

  observeUsage(usage: any, agent?: any): boolean {
    if (!this.armed) return false;
    const crossing = this.core.evaluate(usage);
    if (!crossing) return false;

    this.armed = false;
    this.trip = {
      at: Date.now(),
      thresholdTokens: crossing.thresholdTokens,
      inputTokens: crossing.inputTokens,
      reason: tripReason(crossing),
    };
    this.logger?.warn?.('Context guard tripped — interrupting the call and returning queued inputs', {
      inputTokens: crossing.inputTokens,
      thresholdTokens: crossing.thresholdTokens,
    });
    this.callArbiter?.interruptActive?.(this.trip.reason);
    if (typeof agent?.interrupt === 'function') {
      agent.interrupt();
    }
    return true;
  }

  /**
   * 换模型（热切换）后按新模型元数据重算阈值。
   */
  updateThreshold(contextLength: number | null, compressRatio: number | null): void {
    this.core.updateThreshold(contextLength, compressRatio);
    this.logger?.info('Context guard threshold updated', { thresholdTokens: this.core.getThresholdTokens() });
  }

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

/**
 * 线程宿主（coder）的自动接力触发器。
 *
 * 过界时打断当前轮并上报 /protoclaw/context_guard_event，由服务端
 * thread-rotation 执行 trim+摘要接力。装配即确定，无配置——它的存在本身
 * 就是「该工作空间的上下文管理方式是自动接力」这一装配决策的表达。
 * 触发一次性锁定：接力成功后旧 runtime 被退役；上报失败由服务端不可达
 * 场景兜底（此时一切托管机制均已失效）。
 */
export class ContextRotationTriggerFeature implements AgentFeature {

  static hooks: HookDeclarations = {
    installUsageObserver: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
  };
  readonly name = 'context-rotation-trigger';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'Interrupts the thread-host session at the compression threshold and reports the event for automatic trim+summary rotation.';

  private readonly core: ContextGuardCore;
  private readonly agentId: string;
  private readonly sessionId: string;
  private readonly serverOrigin: string;
  private triggered = false;
  private logger?: FeatureInitContext['logger'];
  private packageInfo: PackageInfo | null = null;
  private callArbiter: any = null;
  private _agent: any = null;

  constructor(config: ContextRotationTriggerConfig = {}) {
    this.core = new ContextGuardCore(config.contextLength, config.compressRatio);
    this.agentId = typeof config.agentId === 'string' ? config.agentId.trim() : '';
    this.sessionId = typeof config.sessionId === 'string' ? config.sessionId.trim() : '';
    this.serverOrigin = typeof config.serverOrigin === 'string'
      ? config.serverOrigin.replace(/\/$/, '')
      : '';
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
    this.logger?.info('Context rotation trigger initiated', {
      thresholdTokens: this.core.getThresholdTokens(),
      agentId: this.agentId || null,
      sessionId: this.sessionId || null,
    });
  }

  setCallArbiter(arbiter: any): void {
    this.callArbiter = arbiter;
  }

  /** 阈值锚定到当前 LLM 的活元数据，语义同交互壳的 syncThresholdFromLiveMeta。 */
  private syncThresholdFromLiveMeta(agent: any): void {
    const meta = agent?.getLLMMeta?.();
    const cl = Number(meta?.contextLength);
    const cr = Number(meta?.compressRatio);
    if (Number.isFinite(cl) && cl > 0) {
      this.updateThreshold(cl, Number.isFinite(cr) && cr > 0 ? cr : null);
    }
  }

  async installUsageObserver(ctx: any): Promise<void> {
    const agent = ctx?.agent;
    if (!agent) return;
    if (!this._agent) this._agent = agent;
    this.syncThresholdFromLiveMeta(agent);
    if (this.triggered) return;
    installChatObserver(agent, (usage) => this.observeUsage(usage, agent));
    this.logger?.info('Context rotation trigger is observing LLM usage', {
      thresholdTokens: this.core.getThresholdTokens(),
    });
  }

  observeUsage(usage: any, agent?: any): boolean {
    if (this.triggered) return false;
    const crossing = this.core.evaluate(usage);
    if (!crossing) return false;

    this.triggered = true;
    const reason = tripReason(crossing);
    this.logger?.warn?.('Context rotation trigger fired — interrupting and reporting for rotation', {
      inputTokens: crossing.inputTokens,
      thresholdTokens: crossing.thresholdTokens,
      agentId: this.agentId || null,
      sessionId: this.sessionId || null,
    });
    this.callArbiter?.interruptActive?.(reason);
    if (typeof agent?.interrupt === 'function') {
      agent.interrupt();
    }
    this.reportRotationEvent(crossing, reason);
    return true;
  }

  private reportRotationEvent(crossing: ThresholdCrossing, reason: string): void {
    if (!this.serverOrigin || !this.agentId || !this.sessionId || typeof fetch !== 'function') return;
    void fetch(`${this.serverOrigin}/protoclaw/context_guard_event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: this.agentId,
        sessionId: this.sessionId,
        contextGuard: {
          blocked: true,
          blockedAt: Date.now(),
          thresholdTokens: crossing.thresholdTokens,
          inputTokens: crossing.inputTokens,
          reason,
        },
      }),
    }).catch((error) => {
      this.logger?.warn?.('Context rotation event sync failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  updateThreshold(contextLength: number | null, compressRatio: number | null): void {
    this.core.updateThreshold(contextLength, compressRatio);
    this.logger?.info('Context rotation threshold updated', { thresholdTokens: this.core.getThresholdTokens() });
  }

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
