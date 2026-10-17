/**
 * ScheduledTrigger — 通用持久定时机制件（feature 形态，装配即得）
 *
 * 臂 / 重臂 / 落盘 / 恢复全部内聚，业务零感知：构造时给数据文件路径与
 * 到点回调，机制件负责读盘、重臂（含进程重启后的过期补发）、到点触发。
 *
 * 数据契约（机制件与业务共知的唯一约定）：JSON 文件 `{ items: [...] }`，
 * 每条目至少含：
 * - `id`：条目唯一标识；
 * - `fire_at`：ISO 时刻（业务按本地时区带偏移存取，机制件只读 ms）；
 * - `status`（可选）：缺省或 `'scheduled'` 才会被臂——其它值（如 `'fired'`）
 *   视为已完结，永不触发。这是跨重启「已投递不重发」的唯一真相，业务在
 *   回调里负责把完结条目改写为非 scheduled（或删除）。
 *
 * 条目其它字段业务自有，机制件原样透传给回调，不做任何解释。
 *
 * 到点语义：
 * - 业务装配层在 feature `onInitiate` 时调用 arm() 读盘重臂：`fire_at`
 *   已过的条目立即回调（过期即发，`due.overdue=true` 并携带过期毫秒数），
 *   未到的按最近到期时刻 setTimeout；
 * - 长臂分层：最近条目进入 1 分钟窗口后精确臂；更远用粗步进定时器分段
 *   推进（单段上限 7 天——Node setTimeout 32 位有符号上限约 24.8 天，
 *   超长 delay 会被内核立即触发），每段醒来重读重算，避免超长 timer
 *   漂移，业务写盘变更同时生效；
 * - 回调后由业务决定条目去留（循环类重算下次 fire_at 写回 / once 标
 *   fired / 删除），机制件不解释业务规则：每轮回调完成后重读盘重臂，
 *   业务写回的新状态自然生效；
 * - 进程内防重：`${id}:${fire_at}` 只触发一次。业务把循环条目写回新的
 *   fire_at 后天然可再触发；写回过去时刻（业务 bug）不会形成触发风暴。
 *   集合量级 = 触发次数（提醒场景极小），不设上限。
 */

import { promises as fs } from 'fs';

export interface TriggerItem {
  id: string;
  fire_at: string;
  status?: string;
  [key: string]: unknown;
}

export interface TriggerDocument {
  items: TriggerItem[];
}

export interface DueInfo {
  /** 触发时刻晚于 fire_at（过期补发）。 */
  overdue: boolean;
  /** 过期毫秒数（准点触发的亚秒延迟也计入，业务自行决定标注阈值）。 */
  overdueMs: number;
}

export interface ScheduledTriggerConfig {
  dataFile: string;
  /** 到点回调。约定内部自捕获业务异常（投递失败不阻断其它条目与重臂）。
   *  不得在回调内 await arm()：arm 串行链排在当前回调所属轮次之后，
   *  会形成循环等待；机制件在本轮回调全部完成后自动重读重臂，业务写盘
   *  的新状态自然生效。 */
  onDue: (item: TriggerItem, due: DueInfo) => Promise<void>;
  /** 时钟注入；缺省 Date.now（测试用 node:test mock.timers 驱动）。 */
  now?: () => number;
  /** 机制件内部诊断（读盘失败 / 数据异常）出口，业务接 logger。 */
  onLog?: (message: string, data?: Record<string, unknown>) => void;
}

/** 1 分钟内精确臂。 */
export const PRECISE_WINDOW_MS = 60_000;
/** 粗步进单段上限：Node setTimeout 32 位有符号上限（约 24.8 天）内取整周。 */
export const ARM_CHUNK_MS = 7 * 24 * 60 * 60 * 1000;

/** 臂谓词：status 缺省或 'scheduled' 才触发（跨重启「已投递不重发」的依据）。 */
export function isArmableItem(item: unknown): boolean {
  const status = (item as { status?: unknown } | null)?.status;
  return status === undefined || status === null || status === 'scheduled';
}

/** fire_at → epoch ms；缺失或无法解析返回 null（调用方跳过，不猜时刻）。 */
export function readItemFireAtMs(item: unknown): number | null {
  const raw = (item as { fire_at?: unknown } | null)?.fire_at;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export class ScheduledTrigger {
  private readonly dataFile: string;
  private readonly onDue: ScheduledTriggerConfig['onDue'];
  private readonly now: () => number;
  private readonly onLog: ScheduledTriggerConfig['onLog'];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private disposed = false;
  /** arm 串行化链：工具面写盘后重臂与回调后重臂并发时按序执行。 */
  private armChain: Promise<void> = Promise.resolve();
  private readonly firedKeys = new Set<string>();

  constructor(config: ScheduledTriggerConfig) {
    this.dataFile = config.dataFile;
    this.onDue = config.onDue;
    this.now = typeof config.now === 'function' ? config.now : () => Date.now();
    this.onLog = typeof config.onLog === 'function' ? config.onLog : undefined;
  }

  /** 读盘 + 重臂（幂等）。业务写盘后（新增 / 改写）可再次调用。 */
  arm(): Promise<void> {
    const run = this.armChain.then(() => this.armOnce());
    // 链上吞错：单轮失败不影响后续 arm，错误由 armOnce 内部上报。
    this.armChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 清定时器（测试收尾；runtime 进程退出时定时器随进程消亡，无需显式调用）。 */
  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  private async armOnce(): Promise<void> {
    if (this.disposed) return;
    this.clearTimers();
    const items = await this.readItems();
    // readItems 是真实 IO：挂起期间可能已 dispose（测试收尾 / 关停），
    // 恢复后不得再安排任何 timer 或回调。
    if (this.disposed) return;
    const nowMs = this.now();
    const due: Array<{ item: TriggerItem; fireAtMs: number }> = [];
    let nearestMs: number | null = null;
    for (const item of items) {
      if (!item || typeof item !== 'object' || !isArmableItem(item)) continue;
      const fireAtMs = readItemFireAtMs(item);
      if (fireAtMs === null) {
        this.onLog?.('scheduled-trigger: item has no usable fire_at, skipped', {
          id: (item as { id?: unknown })?.id,
        });
        continue;
      }
      if (fireAtMs <= nowMs) {
        const key = `${item.id}:${item.fire_at}`;
        if (!this.firedKeys.has(key)) due.push({ item, fireAtMs });
      } else if (nearestMs === null || fireAtMs < nearestMs) {
        nearestMs = fireAtMs;
      }
    }
    if (nearestMs !== null) this.armTimer(nearestMs, nowMs);
    if (due.length > 0) {
      await Promise.all(due.map(({ item, fireAtMs }) => this.fireItem(item, fireAtMs)));
      // 业务可能在回调里写回了数据（循环重算 fire_at / once 标 fired）——
      // fire-and-forget 重读重臂收敛（不得 await：会等待自身的串行链而死锁）。
      void this.arm();
    }
  }

  /**
   * 臂最近到期条目：进入精确窗口用精确 delay；更远先粗步进推进到窗口
   * 起点（单段上限 ARM_CHUNK_MS，防 Node timer 32 位上限立即触发）。
   * 到点统一走 arm() 重读重算——粗步进醒来继续推进，进入窗口后精确
   * 触发，业务写盘变更同时生效。
   */
  private armTimer(nearestMs: number, nowMs: number): void {
    if (this.disposed) return;
    const delayMs = nearestMs - nowMs;
    const wait = delayMs <= PRECISE_WINDOW_MS
      ? delayMs
      : Math.min(delayMs - PRECISE_WINDOW_MS, ARM_CHUNK_MS);
    const timer = setTimeout(() => {
      this.timers = this.timers.filter((entry) => entry !== timer);
      if (!this.disposed) void this.arm();
    }, Math.max(0, wait));
    this.timers.push(timer);
  }

  private async fireItem(item: TriggerItem, fireAtMs: number): Promise<void> {
    const key = `${item.id}:${item.fire_at}`;
    this.firedKeys.add(key);
    const nowMs = this.now();
    const due: DueInfo = {
      overdue: nowMs > fireAtMs,
      overdueMs: Math.max(0, nowMs - fireAtMs),
    };
    try {
      await this.onDue(item, due);
    } catch (error) {
      // 回调约定自捕获；此处兜底防整轮 due 处理断链。
      this.onLog?.('scheduled-trigger: onDue threw', {
        id: item.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async readItems(): Promise<TriggerItem[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.dataFile, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 'ENOENT') {
        this.onLog?.('scheduled-trigger: read failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return [];
    }
    try {
      const doc = JSON.parse(raw) as TriggerDocument;
      return Array.isArray(doc?.items) ? doc.items : [];
    } catch (error) {
      this.onLog?.('scheduled-trigger: document parse failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}
