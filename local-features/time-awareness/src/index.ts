/**
 * TimeAwarenessFeature — 时间感知
 *
 * Call 开始时按节奏注入系统时间信息，让 AI 对"现在"有感知：
 *
 * - 时间汇报：距上一次发生汇报的 call 超过 4 小时才注入（含系统时区），
 *   避免每个 call 都注入造成上下文噪音。措辞强调上下文不一定在时间上
 *   均速积累，可能包含用户离线静默的时间。
 * - 长间隔提示：距上一轮 call（不限是否发生过汇报）超过 24 小时额外提示
 *   ——用户可能在其他会话推进过相关工作、系统可能重启、项目环境可能变化，
 *   不要完全代入之前的上下文假设与用户决策。连续多天但 call 间隔一直
 *   不超过 24 小时的会话不触发。
 *
 * 状态不自行落盘：经框架原生 feature 快照契约（captureState / restoreState）
 * 随会话快照持久化，会话恢复（含 runtime 重启）时自动回填——跨重启存活
 * 由会话存储保证，且状态天然按会话隔离。
 *
 * observe 语义：注入失败不阻断 call，只降级为本轮不注入。
 */

import { fileURLToPath } from 'url';
import type { AgentFeature, FeatureInitContext, CallStartContext, FeatureStateSnapshot } from '@agentdevjs/core';
import { CoreLifecycle } from '@agentdevjs/core';
import type { HookDeclarations } from '@agentdevjs/core';

const __filename = fileURLToPath(import.meta.url);

/** 时间汇报节奏：距上次汇报超过 4 小时才再次汇报。 */
export const REPORT_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** 长间隔阈值：距上一轮 call 超过 24 小时触发额外提示。 */
export const LONG_GAP_MS = 24 * 60 * 60 * 1000;

/** 会话内时间节奏状态：均存 null 表示无从比较（首次），不伪造基线。 */
export interface TimeAwarenessState {
  /** 上次发生时间汇报的 call 时刻（epoch ms）；null = 从未汇报。 */
  lastReportAt: number | null;
  /** 上一轮 call 时刻（epoch ms）；null = 没有上一轮。 */
  lastCallAt: number | null;
}

export interface TimeAwarenessDecision {
  /** 本次 call 是否注入时间汇报。 */
  report: boolean;
  /** 本次 call 是否注入长间隔提示。 */
  longGap: boolean;
  /** 本次 call 之后应持有的状态。 */
  nextState: TimeAwarenessState;
}

function readTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 汇报决策（纯函数）：
 * - 从未汇报过视为无限间隔 → 汇报（首轮拿到时间锚点是有用信息）；
 * - 没有上一轮 call 时不触发长间隔提示（无从比较，不假设静默）；
 * - 时钟回拨（now 早于记录值）视为未过阈值，只顺延 lastCallAt。
 */
export function evaluateTimeAwareness(state: unknown, now: number): TimeAwarenessDecision {
  const record = (state && typeof state === 'object' ? state : {}) as Record<string, unknown>;
  const lastReportAt = readTimestamp(record.lastReportAt);
  const lastCallAt = readTimestamp(record.lastCallAt);
  const report = lastReportAt === null || now - lastReportAt > REPORT_INTERVAL_MS;
  const longGap = lastCallAt !== null && now - lastCallAt > LONG_GAP_MS;
  return {
    report,
    longGap,
    nextState: {
      lastReportAt: report ? now : lastReportAt,
      lastCallAt: now,
    },
  };
}

/** 本地时区标注，如 "UTC+08:00（Asia/Shanghai）"；IANA 名解析失败时只给偏移。 */
export function formatTimezone(now: Date): string {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offset = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  let iana = '';
  try {
    iana = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    /* 极端环境无 ICU，只剩偏移量 */
  }
  return iana ? `${offset}（${iana}）` : offset;
}

/** 本地时间 `YYYY-MM-DD HH:mm`（按运行环境本地时区，不走 locale）。 */
export function formatLocalDateTime(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 渲染注入文本。两段都触发时合并为一条 reminder，减少系统消息条数。 */
export function renderTimeReminder(now: Date, decision: Pick<TimeAwarenessDecision, 'report' | 'longGap'>): string {
  const parts: string[] = [];
  if (decision.report) {
    parts.push(
      `上下文进行到此处时，时间是 ${formatLocalDateTime(now)}（时区 ${formatTimezone(now)}）。`
      + '上下文并不一定在时间范围内均速积累，其中可能包含用户离线静默的时间。',
    );
  }
  if (decision.longGap) {
    parts.push(
      '距离上一轮交互已经超过 24 小时。这段时间里，用户可能在其他会话中推进了与当前工作相关的内容，'
      + '系统可能经历过重启，或项目环境发生了重大变化。不要完全代入之前上下文中的信息假设与用户决策，'
      + '必要时先核实当前实际状态。',
    );
  }
  return `[时间感知] ${parts.join('\n\n')}`;
}

export class TimeAwarenessFeature implements AgentFeature {

  static hooks: HookDeclarations = {
    injectTimeContext: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
  };

  readonly name = 'time-awareness';
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '按节奏注入系统时间信息（超过 4 小时未汇报才汇报，含时区）；距上一轮 call 超过 24 小时时额外提示长间隔，提醒不要代入过时的上下文假设。';

  private state: TimeAwarenessState = { lastReportAt: null, lastCallAt: null };
  private readonly now: () => number;
  private logger?: FeatureInitContext['logger'];

  constructor(config: { now?: () => number } = {}) {
    this.now = typeof config.now === 'function' ? config.now : () => Date.now();
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
  }

  async injectTimeContext(ctx: CallStartContext): Promise<void> {
    try {
      const now = this.now();
      const decision = evaluateTimeAwareness(this.state, now);
      this.state = decision.nextState;
      if (!decision.report && !decision.longGap) return;

      const text = renderTimeReminder(new Date(now), decision);
      const turn = typeof (ctx.agent as { _callIndex?: unknown })?._callIndex === 'number'
        ? (ctx.agent as { _callIndex: number })._callIndex
        : 0;
      ctx.context.addSystemMessage(text, turn, this.name, 'reminder');
      this.logger?.info?.('Time awareness injected', {
        report: decision.report,
        longGap: decision.longGap,
      });
    } catch (error) {
      // observe 语义兜底：任何异常都不阻断 call。
      this.logger?.warn?.('Time awareness injection failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Feature state snapshot（框架原生快照契约，随会话持久化）──

  captureState(): FeatureStateSnapshot {
    return { ...this.state };
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const record = (snapshot && typeof snapshot === 'object' ? snapshot : {}) as Record<string, unknown>;
    this.state = {
      lastReportAt: readTimestamp(record.lastReportAt),
      lastCallAt: readTimestamp(record.lastCallAt),
    };
  }
}
