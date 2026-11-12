/**
 * AutoTitlePolicyFeature — 会话标题策略（ADR-0041 参考实现）
 *
 * 这是「标题策略属于应用」的官方样板：Claw 提供标题能力（生成 / 直接写入）
 * 与轮次事件面，本 Feature 决定要不要生成、什么时候生成、用什么规则生成。
 * 其他应用可以直接装配本 Feature，也可以照抄其中一段改成自己的策略。
 *
 * ── 策略（本实现的取舍，不是 OS 规定）──────────────────────────────
 *
 * 触发时机：会话的第一次成功交付之后，且仅此一次。
 *   - 订阅 turn 事件总线；只在 `turn.completed` 且**非挂起**时考虑。
 *     挂起的回合虽然落定（ADR-0019），工作尚未交付，此时起名会得到一个
 *     描述半成品的标题。
 *   - 每个会话只自动生成一次。标题是导航信息，反复改写会让用户找不到
 *     对话；任务方向确实变了时，应用可以调用本 Feature 的公开方法再次
 *     生成（那是显式行为，不是默认节奏）。
 *   - 用户已经在会话里改过名（服务端 titleState=user 且未显式要求覆盖）时，
 *     由服务端能力层挡住，本 Feature 不重复判断——保护规则只应有一份实现。
 *
 * 提示词：内置一套面向工程会话的补充规则，附加在 OS 内置规则之后。应用
 * 若需要别的风格，构造时传 instructions 覆盖即可，不必改这里。
 *
 * ── 为什么状态要进会话快照 ────────────────────────────────────────
 *
 * "已自动起名过"必须跨 runtime 重启存活，否则重启后每个会话都会再生成一次。
 * 走框架原生 captureState / restoreState（随会话快照落盘、随 trim / rotate
 * 的 continuity 流转），不另建文件存储。
 */

import { fileURLToPath } from 'node:url';
import type {
  AgentFeature,
  FeatureInitContext,
  FeatureStateSnapshot,
} from '@agentdevjs/core';
import { internalAuthHeaders } from '../../shared/src/internal-auth.js';

const __filename = fileURLToPath(import.meta.url).replace(/\\/g, '/');

/** 面向工程会话的补充标题规则：强调可区分的技术对象，避免泛泛表述。 */
export const ENGINEERING_TITLE_INSTRUCTIONS = [
  '这是编程助手会话，标题应优先体现具体的技术对象与动作：',
  '受影响的模块或文件、要解决的具体故障、引入的具体机制。',
  '避免「讨论问题」「代码实现」「继续开发」这类无法区分并行会话的表述。',
  '如果本轮尚未形成明确的技术焦点，就用用户提出的原始诉求命名，不要臆测。',
].join('\n');

export interface AutoTitlePolicyConfig {
  /** 服务端基址；缺省取 PROTOCLAW_SERVER_ORIGIN / 本地 14200。 */
  serverOrigin?: string;
  /** agentId，随会话固定。 */
  agentId?: string;
  /** 生成用的模型角色。缺省交给服务端（system）。 */
  modelRole?: string;
  /** 追加的标题规则，替换内置的工程会话规则。 */
  instructions?: string;
  /** 注入的 fetch 实现（测试用）。 */
  fetchImpl?: typeof fetch;
}

export interface AutoTitlePolicyState {
  /** 已自动起名的会话 id → 起名时刻（epoch ms）。按会话隔离，故只记一条也带 id。 */
  generatedAt: Record<string, number>;
}

/** 一次生成尝试是否需要发起（纯函数，便于直接断言判定逻辑）。 */
export interface TitleTriggerInput {
  eventType: string;
  suspended?: boolean;
  sessionId?: string;
}

/**
 * 是否应该为这个事件发起标题生成。
 *
 * 判定只看事件事实与已生成记录，不比对标题文本——文本是展示值，
 * 不是状态。
 */
export function shouldGenerateTitle(
  input: TitleTriggerInput,
  state: AutoTitlePolicyState,
): boolean {
  if (input.eventType !== 'turn.completed') return false;
  // 挂起的回合落定了但没交付：此刻的会话内容是半成品，起名会误导。
  if (input.suspended === true) return false;
  const sessionId = String(input.sessionId || '').trim();
  if (!sessionId) return false;
  return state.generatedAt[sessionId] === undefined;
}

export class AutoTitlePolicyFeature implements AgentFeature {
  readonly name = 'auto-title-policy';
  readonly source = __filename;
  readonly description = '会话标题策略（参考实现）：首次成功交付后自动生成一次标题，规则与触发时机由本 Feature 决定。';

  private readonly serverOrigin: string;
  private readonly agentId: string;
  private readonly modelRole?: string;
  private readonly instructions: string;
  private readonly fetchImpl: typeof fetch;
  private state: AutoTitlePolicyState = { generatedAt: {} };
  private unsubscribe: (() => void) | null = null;
  private logger?: FeatureInitContext['logger'];

  constructor(config: AutoTitlePolicyConfig = {}) {
    this.serverOrigin = String(
      config.serverOrigin
      || process.env.PROTOCLAW_SERVER_ORIGIN
      || `http://127.0.0.1:${process.env.PORT || 14200}`,
    ).replace(/\/+$/, '');
    this.agentId = String(config.agentId || process.env.PROTOCLAW_PREBUILT_AGENT_ID || '').trim();
    this.modelRole = typeof config.modelRole === 'string' && config.modelRole.trim()
      ? config.modelRole.trim()
      : undefined;
    this.instructions = typeof config.instructions === 'string' && config.instructions.trim()
      ? config.instructions.trim()
      : ENGINEERING_TITLE_INSTRUCTIONS;
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
  }

  /**
   * 宿主注入轮次事件总线（run-prebuilt-agent 在 CallArbiter 就绪后调用）。
   * 订阅在宿主总线可用前是不可能的，因此实现这个可选钩子而不是在
   * onInitiate 里自建事件源。
   */
  setTurnEventBus(bus: { subscribe: (fn: (event: unknown) => void) => () => void }): void {
    this.unsubscribe?.();
    this.unsubscribe = bus.subscribe((event) => { this.handleTurnEvent(event); });
  }

  /** 显式再生成（应用主动调用；不受"只生成一次"约束）。 */
  async regenerateTitle(sessionId: string): Promise<void> {
    await this.requestGeneration(String(sessionId || '').trim(), { allowUserOverride: false });
  }

  captureState(): FeatureStateSnapshot {
    return { generatedAt: { ...this.state.generatedAt } };
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const record = (snapshot && typeof snapshot === 'object' ? snapshot : {}) as Record<string, unknown>;
    const raw = record.generatedAt && typeof record.generatedAt === 'object'
      ? record.generatedAt as Record<string, unknown>
      : {};
    const generatedAt: Record<string, number> = {};
    for (const [sessionId, at] of Object.entries(raw)) {
      if (typeof at === 'number' && Number.isFinite(at)) generatedAt[sessionId] = at;
    }
    this.state = { generatedAt };
  }

  /** 退订：宿主销毁 runtime 时应调用，避免总线持有已废弃实例。 */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private handleTurnEvent(raw: unknown): void {
    const event = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const sessionId = String(event.sessionId || '').trim();
    const input: TitleTriggerInput = {
      eventType: String(event.type || ''),
      suspended: event.suspended === true,
      sessionId,
    };
    if (!shouldGenerateTitle(input, this.state)) return;
    // 先登记再请求：请求是异步的，若不先登记，同一会话连发的两个事件会
    // 都通过判定并发起两次生成。登记失败也要允许下次重试，因此登记时间
    // 在请求发出前、失败时回滚。
    this.state.generatedAt[sessionId] = Date.now();
    this.requestGeneration(sessionId, { allowUserOverride: false }).catch((error) => {
      // 失败回滚登记，让下一次交付还能重试；标题是辅助能力，失败不重试风暴。
      delete this.state.generatedAt[sessionId];
      this.logger?.warn?.('auto title generation failed', {
        sessionId,
        error: String((error as Error)?.message || error),
      });
    });
  }

  private async requestGeneration(sessionId: string, options: { allowUserOverride: boolean }): Promise<void> {
    if (!sessionId) return;
    if (!this.agentId) throw new Error('auto-title-policy: agentId is not configured');
    const body = {
      agentId: this.agentId,
      sessionId,
      allowUserOverride: options.allowUserOverride,
      params: {
        ...(this.modelRole ? { modelRole: this.modelRole } : {}),
        instructions: this.instructions,
      },
    };
    const response = await this.fetchImpl(`${this.serverOrigin}/protoclaw/generate_session_title`, {
      method: 'POST',
      headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`generate_session_title ${response.status}: ${text.slice(0, 200)}`);
    }
    const payload = await response.json().catch(() => ({}));
    // 服务端明确跳过（用户已接管）不是失败：标题保持用户的名字，登记保留，
    // 不再重复请求。
    if (payload?.skipped) {
      this.logger?.info?.('auto title skipped', { sessionId, reason: payload.skipped });
    }
  }
}
