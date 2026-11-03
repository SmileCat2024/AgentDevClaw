import { fileURLToPath } from 'url';
import type { AgentFeature, FeatureInitContext, FeatureManifestDefinition, PackageInfo, RestoreContext } from '@agentdevjs/core';
import { CoreLifecycle, Decision, getPackageInfoFromSource } from '@agentdevjs/core';
import type { HookDeclarations } from '@agentdevjs/core';
import { internalAuthHeaders } from '../../shared/src/internal-auth.js';
import { declareContinuity } from '../../continuity-participant/src/index.js';

const __filename = fileURLToPath(import.meta.url);

/**
 * 守卫模式：
 * - off        全停（不观测、不打断、不拦截）；
 * - interrupt  一次性保险丝：过界打断本轮 + 拦截机器唤醒，直到人工输入
 *              （那条输入即「批准继续」），本次越界期间维持放行；
 * - rotate     过界打断本轮后立即上报接续事件，由服务端 thread-rotation
 *              执行线程接力（coder 的 ContextRotationTriggerFeature 同构；
 *              人工批准环节被「接续即处置」取代）。
 */
export type ContextGuardMode = 'off' | 'interrupt' | 'rotate';
/** 自动接续策略（与 coder 的 contextRotationStrategy 同一枚举）。 */
export type ContextRotationStrategy = 'adaptive' | 'trim' | 'summary';

export interface ContextGuardConfig {
  /** 布尔旧值兼容（配置层遗留 enabled）：false → off；true/缺省且无 mode → interrupt。 */
  enabled?: boolean;
  mode?: ContextGuardMode;
  strategy?: ContextRotationStrategy;
  /** 装配能力门控：线程宿主工作空间传 true 才开放 rotate 态（agent-studio 等纯会话工作空间不传）。 */
  allowRotation?: boolean;
  contextLength?: number | null;
  compressRatio?: number | null;
  /** 接续事件上报身份（rotate 态必需；与 ContextRotationTriggerFeature 同通道）。 */
  agentId?: string;
  sessionId?: string | null;
  serverOrigin?: string;
}

export interface ContextGuardTrip {
  at: number;
  thresholdTokens: number;
  inputTokens: number;
  reason: string;
  /** 触发时的模式快照：interrupt 触发的 trip 才有前端打断 toast；rotate 触发由线程接力承载。 */
  mode: ContextGuardMode;
}

export interface ContextGuardStatus {
  /** 当前模式（badge 循环点击的真值）：触发不改变它，只有用户手动切换或配置初值影响。 */
  mode: ContextGuardMode;
  strategy: ContextRotationStrategy;
  /** 装配能力：false 时 rotate 不可选（badge 两态循环、面板无策略行）。 */
  allowRotation: boolean;
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
  /**
   * 进程内承接回调（plain agent 宿主模式）：过界事实同步交给宿主，
   * 由宿主在进程内执行 trim+摘要接力。与 HTTP 上报通道并存——
   * serverOrigin 等字段齐备时两者都会发生（如 plain agent 运行期同时
   * 连着 Claw server 的场景）；两者互不依赖，回调失败不影响上报。
   */
  onTrip?: (trip: { at: number; thresholdTokens: number; inputTokens: number; reason: string }) => void;
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
 * 热切换模型（setLLM 替换整个 llm 引用）后由 onLLMSwap 立即重装——不能等
 * 下一次 CallStart：单轮 ReAct 会话（coder 工单）中途没有 CallStart。
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

function normalizeGuardMode(value: unknown): ContextGuardMode | null {
  return value === 'off' || value === 'interrupt' || value === 'rotate' ? value : null;
}

function normalizeGuardStrategy(value: unknown): ContextRotationStrategy | null {
  return value === 'adaptive' || value === 'trim' || value === 'summary' ? value : null;
}

/**
 * 交互式工作空间的上下文过界守卫（三态：off / interrupt / rotate）。
 *
 * 过界（inputTokens ≥ 压缩阈值）时退回排队消息并挂起打断，已发出的工具调用
 * 先执行完、结果写入上下文（StepFinish guard），此时才中断本轮——打断时机
 * 不落在工具执行中途（终态语义与立即打断一致：cancelled，以最后一条
 * assistant 正文收尾）。interrupt 与 rotate 共用这一触发时机。
 *
 * interrupt（一次性保险丝）：触发后拦截机器唤醒（reminder 类 call），直到
 * 人工输入——那条输入本身就是「人批准继续」的表达，放行并解除拦截；此后
 * 本次越界期间不再打断、不再拦截。上下文用量回落到阈值下方后，越界事件
 * 结束，再次越界会重新触发一轮完整尽职。
 *
 * rotate（自动接续，coder 同构）：触发后同样拦截机器唤醒（接力窗口内的
 * 保护；接力成功则 runtime 被换代，拦截自然终结），本轮完全结束（CallFinish）
 * 时上报接续事件（载荷携带会话级策略），由服务端 thread-rotation 执行
 * trim+摘要接力。接续失败时线程落 rotation_failed 信号、挡板收敛回旧 head，
 * 下一次人工输入重启 runtime 后的首次过界观测会再次上报重试——重试节奏
 * 由人工输入节流，不存在无人值守的自动重试循环。
 *
 * mode 是用户选择（badge 循环点击 + 会话控制面板策略行）：触发不改变它；
 * 手动切换即复位本轮尽职状态（闩锁 / 拦截 / 待上报），新模式从下一次过界
 * 观测重新开始。allowRotation 是装配能力（线程宿主工作空间才传 true），
 * 非线程工作空间不提供 rotate 选项。
 *
 * {mode, strategy} 经 declareContinuity 随会话快照持久化、随 trim / rotate
 * 接续与 branch 注入流转（同 model-selection 模式）；触发事实 / 闩锁 /
 * 拦截状态不迁移，successor runtime 天然开启新一轮尽职。
 */
export class ContextGuardFeatureInner implements AgentFeature {

  static hooks: HookDeclarations = {
    installUsageGuard: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
    tripAtStepFinish: { lifecycle: CoreLifecycle.StepFinish, kind: 'guard' as const, role: 'advisor' as const },
    admitAfterTrip: { lifecycle: CoreLifecycle.PreCallStart, kind: 'guard' as const },
    reportRotationOnCallFinish: { lifecycle: CoreLifecycle.CallFinish, kind: 'observe' as const },
  };
  readonly name = 'context-guard';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'Guards a session at the compression threshold with three modes: off, one-shot interrupt that holds machine wakeups until a human input approves continuing, and auto-rotation that reports a thread succession event (coder-isomorphic) carrying the session-level strategy.';

  private readonly core: ContextGuardCore;
  private mode: ContextGuardMode;
  private strategy: ContextRotationStrategy;
  private readonly allowRotation: boolean;
  private readonly agentId: string;
  private readonly sessionId: string;
  private readonly serverOrigin: string;
  private trip: ContextGuardTrip | null = null;
  /** 过界已挂起、待 StepFinish（本轮已发出的工具结果落地后）触发的打断 */
  private pendingTripInterrupt = false;
  /** 触发后拦截机器唤醒；interrupt 态由人工输入解除（= 批准继续），rotate 态由接力换代终结。 */
  private holdMachineWakeups = false;
  /**
   * 越界事件闩锁：本次越界已触发过完整尽职（打断 + 拦截唤醒）。同一事件内
   * （人工批准后维持不拦截）不再重复触发；usage 回落阈值下方时复位，下一次
   * 越界重新触发。mode 不因触发改变——它只属于用户选择。
   */
  private overageHandled = false;
  /** rotate 态待 CallFinish（本轮完全结束）上报的过界事实；null 表示无需上报 */
  private pendingReport: { crossing: ThresholdCrossing; reason: string } | null = null;
  private logger?: FeatureInitContext['logger'];
  private packageInfo: PackageInfo | null = null;
  private callArbiter: any = null;
  private _agent: any = null;

  constructor(config: ContextGuardConfig = {}) {
    this.core = new ContextGuardCore(config.contextLength, config.compressRatio);
    this.allowRotation = config.allowRotation === true;
    const configuredMode = normalizeGuardMode(config.mode);
    this.mode = configuredMode === 'rotate' && !this.allowRotation
      ? 'interrupt'
      : (configuredMode ?? (config.enabled === false ? 'off' : 'interrupt'));
    this.strategy = normalizeGuardStrategy(config.strategy) ?? 'adaptive';
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

  getFeatureManifest(): FeatureManifestDefinition {
    const modeOptions = this.allowRotation
      ? [
        { label: '关闭', value: 'off' },
        { label: '自动打断', value: 'interrupt' },
        { label: '自动接续', value: 'rotate' },
      ]
      : [
        { label: '关闭', value: 'off' },
        { label: '自动打断', value: 'interrupt' },
      ];
    return {
      schemaVersion: 1,
      settings: {
        properties: {
          mode: {
            type: 'select',
            title: '上下文保护',
            description: '关闭 = 全停；自动打断 = 过界打断本轮并拦截机器唤醒直到人工输入（那条输入即视为批准继续），本次越界期间不再拦截；自动接续 = 过界打断后立即走线程接力（coder 同构）。仅交互式工作空间；coder / memo 线程自动接力不受此配置影响。',
            default: 'interrupt',
            options: modeOptions,
          },
          ...(this.allowRotation
            ? {
              strategy: {
                type: 'select',
                title: '接续策略',
                description: '自动接续采用的精简方式（会话内可随时经会话控制面板切换，下一次接力生效）。',
                default: 'adaptive',
                options: [
                  { label: '自适应', value: 'adaptive' },
                  { label: '纯精简', value: 'trim' },
                  { label: '纯摘要', value: 'summary' },
                ],
                showWhen: { property: 'mode', values: ['rotate'] },
              },
            }
            : {}),
        },
        sections: [{
          id: 'guard',
          title: '上下文保护',
          properties: this.allowRotation ? ['mode', 'strategy'] : ['mode'],
        }],
      },
    };
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger?.info('Context guard initiated', {
      mode: this.mode,
      strategy: this.strategy,
      allowRotation: this.allowRotation,
      thresholdTokens: this.core.getThresholdTokens(),
    });
  }

  setCallArbiter(arbiter: any): void {
    this.callArbiter = arbiter;
  }

  getStatus(): ContextGuardStatus {
    return {
      mode: this.mode,
      strategy: this.strategy,
      allowRotation: this.allowRotation,
      trip: this.trip ? { ...this.trip } : null,
      thresholdTokens: this.core.getThresholdTokens(),
    };
  }

  /**
   * 手动切换（badge 循环点击 / 配置面）：全停 ⇄ 保险丝 ⇄ 自动接续。切换即
   * 复位本轮尽职状态（闩锁 / 拦截 / 待上报）——新模式从下一次过界观测重新
   * 开始。rotate 在当前装配未开放时钳制为 interrupt（能力是装配事实）。
   */
  setMode(mode: ContextGuardMode): void {
    const normalized = normalizeGuardMode(mode);
    this.mode = normalized === 'rotate' && !this.allowRotation ? 'interrupt' : (normalized ?? 'interrupt');
    this.holdMachineWakeups = false;
    this.overageHandled = false;
    this.pendingReport = null;
  }

  /**
   * 会话控制面板请求面（宿主通用 feature-comms-request 分支投递；server
   * agent-lifecycle 路由的本地路径发此消息形态，远程保持 ADR-0011 转发）。
   * 旧宿主专用 IPC 分支（context-guard-control / -status）已收编退役。
   */
  async onHostRequest(requestType: string, payload: unknown): Promise<Record<string, unknown>> {
    const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    switch (requestType) {
      case 'status':
        return { ok: true, status: this.getStatus() };
      case 'set': {
        if ('mode' in body) {
          const nextMode = normalizeGuardMode(body.mode);
          if (!nextMode) {
            return { ok: false, code: 'invalid_payload', error: 'mode must be one of off | interrupt | rotate' };
          }
          if (nextMode === 'rotate' && !this.allowRotation) {
            return { ok: false, code: 'rotation_unavailable', error: 'rotation is not enabled for this workspace' };
          }
          this.setMode(nextMode);
        }
        if ('strategy' in body) {
          const nextStrategy = normalizeGuardStrategy(body.strategy);
          if (!nextStrategy) {
            return { ok: false, code: 'invalid_payload', error: 'strategy must be one of adaptive | trim | summary' };
          }
          this.strategy = nextStrategy;
        }
        if (!('mode' in body) && !('strategy' in body)) {
          return { ok: false, code: 'invalid_payload', error: 'mode or strategy is required' };
        }
        return { ok: true, status: this.getStatus() };
      }
      default:
        return { ok: false, code: 'operation_unavailable', error: `Unknown requestType: ${requestType}` };
    }
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
    this.pendingTripInterrupt = false;
    this.syncThresholdFromLiveMeta(agent);
    if (this.mode === 'off') return;
    installChatObserver(agent, (usage) => this.observeUsage(usage, agent));
    this.logger?.info('Context guard is observing LLM usage', {
      mode: this.mode,
      thresholdTokens: this.core.getThresholdTokens(),
    });
  }

  observeUsage(usage: any, agent?: any): boolean {
    // 兜底捕获：真实链路 agent 总是在场（CallStart 已存），直接调用 observeUsage
    // 的路径也能让稍后的 StepFinish 打断拿到 agent 引用。
    if (!this._agent && agent) this._agent = agent;
    if (this.mode === 'off') return false;
    const crossing = this.core.evaluate(usage);
    if (!crossing) {
      // 用量回落到阈值下方：本次越界事件结束，闩锁复位——下一次越界会
      // 重新触发一轮完整尽职。无读数或无阈值时没有新事实，不动闩锁。
      const inputTokens = Number((usage as { inputTokens?: unknown } | null)?.inputTokens);
      const thresholdTokens = this.core.getThresholdTokens();
      if (this.overageHandled && thresholdTokens !== null
        && Number.isFinite(inputTokens) && inputTokens > 0 && inputTokens < thresholdTokens) {
        this.overageHandled = false;
      }
      return false;
    }
    // 同一越界事件已尽职过（人工已批准或接力已处置）：维持不拦截，不再触发。
    if (this.overageHandled) return false;

    this.overageHandled = true;
    this.holdMachineWakeups = true;
    this.trip = {
      at: Date.now(),
      thresholdTokens: crossing.thresholdTokens,
      inputTokens: crossing.inputTokens,
      reason: tripReason(crossing),
      mode: this.mode,
    };
    this.logger?.warn?.('Context guard tripped — deferring interrupt until in-flight tool results land', {
      mode: this.mode,
      inputTokens: crossing.inputTokens,
      thresholdTokens: crossing.thresholdTokens,
    });
    // 排队消息立即退回；打断延后到 StepFinish，避免把本轮已发出的工具调用
    // 中途 abort 成无结果调用。mode 不变：它只属于用户选择（badge 恒显示）。
    this.callArbiter?.interruptActive?.(this.trip.reason);
    this.pendingTripInterrupt = true;
    // rotate 态：本轮完全结束（CallFinish）后上报接续事件，服务端 thread-rotation
    // 执行线程接力（coder 的 ContextRotationTriggerFeature 同构时机）。
    if (this.mode === 'rotate') {
      this.pendingReport = { crossing, reason: this.trip.reason };
    }
    return true;
  }

  /**
   * PreCallStart guard：超限后阻止机器唤醒，人工输入是接管边界。
   * StepFinish guard：过界打断的触发点。此刻本轮 step 已发出的工具调用均已
   * 执行完毕、结果已写入上下文。触发 interrupt 后由下一个 step 头部的信号
   * 检查收尾（终态 cancelled）；若本步本就是无工具调用的自然收尾步，信号
   * 不被消费、本轮照常自然结束（与既有过界竞态行为一致）。
   */
  async admitAfterTrip(ctx: any): Promise<Decision> {
    if (!this.holdMachineWakeups) return Decision.Continue;
    const kind = ctx?.options?.kind;
    if (kind === 'reminder') {
      return Decision.Deny;
    }
    // A user input is the explicit handoff boundary: after it is admitted,
    // the user owns the decision whether to continue despite the context size.
    if (kind !== 'resume') this.holdMachineWakeups = false;
    return Decision.Continue;
  }

  async tripAtStepFinish(_ctx: any): Promise<Decision> {
    if (!this.pendingTripInterrupt) return Decision.Continue;
    this.pendingTripInterrupt = false;
    this.logger?.info?.('Context guard: interrupting the call after tool results landed');
    if (typeof this._agent?.interrupt === 'function') {
      this._agent.interrupt();
    }
    return Decision.Continue;
  }

  /**
   * CallFinish：rotate 态本轮完全结束后上报接续事件（同
   * ContextRotationTriggerFeature 的通道与时机——此刻上下文已定稿，服务端
   * 接力退役 runtime 触发的 flush 读到的是完整快照）。载荷携带会话级策略，
   * thread-rotation 有载荷用载荷、无载荷回落 APP 级判定链（coder / memo 不变）。
   */
  async reportRotationOnCallFinish(_ctx: any): Promise<void> {
    const pending = this.pendingReport;
    if (!pending) return;
    this.pendingReport = null;
    this.reportRotationEvent(pending.crossing, pending.reason);
  }

  private reportRotationEvent(crossing: ThresholdCrossing, reason: string): void {
    if (this.mode !== 'rotate' || !this.serverOrigin || !this.agentId || !this.sessionId || typeof fetch !== 'function') {
      return;
    }
    void fetch(`${this.serverOrigin}/protoclaw/context_guard_event`, {
      method: 'POST',
      headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        agentId: this.agentId,
        sessionId: this.sessionId,
        strategy: this.strategy,
        contextGuard: {
          blocked: true,
          blockedAt: Date.now(),
          thresholdTokens: crossing.thresholdTokens,
          inputTokens: crossing.inputTokens,
          reason,
        },
      }),
    }).catch((error) => {
      this.logger?.warn?.('Context guard rotation event sync failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * continuity 白名单：只有模式与策略迁移（快照随会话持久化、接续 / 分支
   * 读旧写新）；触发事实 / 闩锁 / 拦截状态不迁移——successor runtime 天然
   * 开启新一轮尽职。
   */
  captureState(): { schemaVersion: number; mode: ContextGuardMode; strategy: ContextRotationStrategy } {
    return { schemaVersion: 1, mode: this.mode, strategy: this.strategy };
  }

  /**
   * 按 origin 区分恢复（ADR-0034 决策 2 链级当前状态原则，同 model-selection）：
   * rollback 保留当前值；接续 / 分支导入按快照入账。rotate 在当前装配未开放
   * 时钳制为 interrupt——能力是装配事实，快照不能越权。非法或缺省字段保持
   * 当前值（防御性读取，不因坏快照打断恢复链路）。
   */
  async restoreState(snapshot: unknown, ctx?: RestoreContext): Promise<void> {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (ctx?.origin?.kind === 'rollback') return;
    const raw = snapshot as Record<string, unknown>;
    const mode = normalizeGuardMode(raw.mode);
    if (mode) {
      this.mode = mode === 'rotate' && !this.allowRotation ? 'interrupt' : mode;
    }
    const strategy = normalizeGuardStrategy(raw.strategy);
    if (strategy) this.strategy = strategy;
  }

  /**
   * 换模型（热切换）后按新模型元数据重算阈值。
   */
  updateThreshold(contextLength: number | null, compressRatio: number | null): void {
    this.core.updateThreshold(contextLength, compressRatio);
    this.logger?.info('Context guard threshold updated', { thresholdTokens: this.core.getThresholdTokens() });
  }

  /**
   * 换模型（热切换）后按新模型元数据重算阈值，并把 usage observer 重装到
   * 新 llm 上：setLLM 替换整个 agent.llm 引用，旧对象上的 chat 包装随之
   * 作废；单轮 ReAct 会话中途不会再有 CallStart 重装窗口，不在此刻重装
   * 触发器将对 swap 之后的全部用量失明。
   */
  onLLMSwap(_newLLM: any, _oldLLM: any): void {
    const meta = this._agent?.getLLMMeta?.();
    if (meta) {
      this.updateThreshold(
        typeof meta.contextLength === 'number' ? meta.contextLength : null,
        typeof meta.compressRatio === 'number' ? meta.compressRatio : null,
      );
    }
    if (this.mode !== 'off') {
      installChatObserver(this._agent, (usage) => this.observeUsage(usage, this._agent));
    }
  }
}

/**
 * continuity 自声明包装：{mode, strategy} 随会话快照持久化、随 trim / rotate
 * 接续与 branch 注入流转（protocol 'claw.context-guard-continuity.v1'，
 * importMode replace——restoreState 自身按 origin / allowRotation 区分语义）。
 * 协议在 server/context-continuity/feature-continuity.js 的 PROTOCOL_ADAPTERS
 * 不登记（通用透传）。
 */
export const ContextGuardFeature = declareContinuity(ContextGuardFeatureInner, {
  protocol: 'claw.context-guard-continuity.v1',
  importMode: 'replace',
});

/**
 * 线程宿主（coder）的自动接力触发器。
 *
 * 过界时退回排队消息并挂起打断；本轮已发出的工具调用执行完、结果写入上下文
 * （StepFinish guard）后再中断本轮，本轮完全结束（CallFinish）时上报
 * /protoclaw/context_guard_event，由服务端 thread-rotation 执行 trim+摘要接力。
 * 上报时机会话上下文已是完整快照——服务端退役 runtime 触发的 flush 不会截走
 * 工具结果，摘要不会基于失真的中间状态生成。装配即确定，无配置——它的存在
 * 本身就是「该工作空间的上下文管理方式是自动接力」这一装配决策的表达。
 *
 * triggered 一次性锁定是设计语义而非缺陷，逐场景论证（不要当 bug「修」成
 * 自动重武装）：
 *   - begin 被 thread_held 拒绝 → 归档窗口，线程即将终局，重试无对象；
 *   - 被 handoff_in_progress / head_mismatch 拒绝 → 竞争者正在/已完成接力，
 *     successor 换代后是全新 runtime + 全新 feature 实例（triggered 天然复位）；
 *   - 存储失败 → server 侧问题，立即重试同样失败；
 *   - apply/compact 失败 → 旧 runtime 已退役，触发器随 runtime 终止；
 *   - 上报 fetch 失败 → server 不可达，此刻一切托管机制均已失效。
 * 若改为按轮重置，上下文持续超阈时每一轮都会被打断去重试一次注定失败的
 * 接力（每轮打断的 UX 代价远大于残留风险）。唯一残留：非归档的手动
 * setHold 解冻后旧 head 不再有自动接力——行政冻结本就是宿主亲自手续，
 * 善后责任在宿主；批次三 R2 恢复管线落地后由恢复管线接管死活判定。
 */
export class ContextRotationTriggerFeature implements AgentFeature {

  static hooks: HookDeclarations = {
    installUsageObserver: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
    tripAtStepFinish: { lifecycle: CoreLifecycle.StepFinish, kind: 'guard' as const, role: 'advisor' as const },
    reportRotationOnCallFinish: { lifecycle: CoreLifecycle.CallFinish, kind: 'observe' as const },
  };
  readonly name = 'context-rotation-trigger';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'Interrupts the thread-host session at the compression threshold and reports the event for automatic trim+summary rotation.';

  private readonly core: ContextGuardCore;
  private readonly agentId: string;
  private readonly sessionId: string;
  private readonly serverOrigin: string;
  private readonly onTrip: ContextRotationTriggerConfig['onTrip'];
  private triggered = false;
  /** 过界已挂起、待 StepFinish（本轮已发出的工具结果落地后）触发的打断 */
  private pendingTripInterrupt = false;
  /** 待 CallFinish（本轮完全结束）上报的过界事实；null 表示无需上报 */
  private pendingReport: { crossing: ThresholdCrossing; reason: string } | null = null;
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
    this.onTrip = typeof config.onTrip === 'function' ? config.onTrip : undefined;
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
    // 兜底捕获，语义同交互壳 ContextGuardFeature.observeUsage。
    if (!this._agent && agent) this._agent = agent;
    if (this.triggered) return false;
    const crossing = this.core.evaluate(usage);
    if (!crossing) return false;

    this.triggered = true;
    const reason = tripReason(crossing);
    this.logger?.warn?.('Context rotation trigger fired — deferring interrupt until in-flight tool results land', {
      inputTokens: crossing.inputTokens,
      thresholdTokens: crossing.thresholdTokens,
      agentId: this.agentId || null,
      sessionId: this.sessionId || null,
    });
    // 排队消息立即退回；打断延后到 StepFinish（工具结果落地后），上报延后到
    // CallFinish（本轮完全结束）——服务端接力退役 runtime 时的 flush 读到的
    // 是完整上下文快照。
    this.callArbiter?.interruptActive?.(reason);
    this.pendingTripInterrupt = true;
    this.pendingReport = { crossing, reason };
    return true;
  }

  /**
   * StepFinish guard：过界打断的触发点（语义同交互壳 ContextGuardFeature）。
   * 此刻本轮 step 已发出的工具调用均已执行完毕、结果已写入上下文。
   */
  async tripAtStepFinish(_ctx: any): Promise<Decision> {
    if (!this.pendingTripInterrupt) return Decision.Continue;
    this.pendingTripInterrupt = false;
    this.logger?.info?.('Context rotation trigger: interrupting the call after tool results landed', {
      agentId: this.agentId || null,
      sessionId: this.sessionId || null,
    });
    if (typeof this._agent?.interrupt === 'function') {
      this._agent.interrupt();
    }
    return Decision.Continue;
  }

  /**
   * CallFinish：本轮完全结束后上报接力事件（onTrip 回调 + HTTP）。此时会话
   * 上下文已定稿，服务端 thread-rotation 退役 runtime 触发的 flush 不会
   * 截走工具结果。
   */
  async reportRotationOnCallFinish(_ctx: any): Promise<void> {
    const pending = this.pendingReport;
    if (!pending) return;
    this.pendingReport = null;
    // 进程内承接（plain agent 宿主模式）：回调失败不吞掉 HTTP 上报。
    try {
      this.onTrip?.({
        at: Date.now(),
        thresholdTokens: pending.crossing.thresholdTokens,
        inputTokens: pending.crossing.inputTokens,
        reason: pending.reason,
      });
    } catch (error) {
      this.logger?.warn?.('Context rotation onTrip callback failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.reportRotationEvent(pending.crossing, pending.reason);
  }

  private reportRotationEvent(crossing: ThresholdCrossing, reason: string): void {
    if (!this.serverOrigin || !this.agentId || !this.sessionId || typeof fetch !== 'function') return;
    void fetch(`${this.serverOrigin}/protoclaw/context_guard_event`, {
      method: 'POST',
      headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
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

  /**
   * 换模型（热切换）后按新模型元数据重算阈值，并重装 usage observer
   * （语义同交互壳 ContextGuardFeature.onLLMSwap：单轮 ReAct 会话中途
   * 没有 CallStart 重装窗口，swap 后不重装即失明）。
   */
  onLLMSwap(_newLLM: any, _oldLLM: any): void {
    const meta = this._agent?.getLLMMeta?.();
    if (meta) {
      this.updateThreshold(
        typeof meta.contextLength === 'number' ? meta.contextLength : null,
        typeof meta.compressRatio === 'number' ? meta.compressRatio : null,
      );
    }
    if (!this.triggered) {
      installChatObserver(this._agent, (usage) => this.observeUsage(usage, this._agent));
    }
  }
}
