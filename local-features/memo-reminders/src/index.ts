/**
 * MemoRemindersFeature — memo 定时提醒（工具面 + 数据面 + 到点投递）
 *
 * ADR-0030 统一通知通道的第一个主动投递类消费者。层级模型（工单裁决，
 * 不得偏离）：
 *
 * - 提醒是 APP 级资产，对线程零绑定：数据落 workspaces/memo/reminders.json
 *   （`{ items: [...] }`），条目不带线程身份字段；线程换代、rotation 均
 *   不需要提醒迁移逻辑；
 * - 投递时解析 APP 当前唯一活动线程（GET /protoclaw/memo-app/state 的
 *   activeThread，即 server 侧 app-state 权威的只读投影）：agent 标投递
 *   经 POST /threads/:threadId/input（kind=reminder）唤醒活动线程 head，
 *   rotation 换头对提醒无感；
 * - 投递瞬间活动线程悬空（线程被删未换代、换代事务竞态）：agent 标无处
 *   唤醒时**降级直弹登记文案**并标记已投递——通知必达优先于人格化，这是
 *   显式产品行为，不是静默吞掉；
 * - 提醒生死只由用户显式操作决定（完成 / 删除），线程换代不触碰。
 *
 * 到点判定：登记时 agent 打标 delivery——「明天 9 点提醒我开会」类打
 * direct（到点直弹登记文案，零 LLM 成本）；「到点看看我今天该干嘛」类打
 * agent（到点唤醒生成后弹通知；回复弹出走现状会话呈现，本期只担保唤醒
 * 投递成功）。
 *
 * 过期补偿：错过也应执行——重臂时 fire_at 已过的条目立即触发（机制件
 * overdue 语义），通知文案标注「错过了预定时间」；不静默丢弃。
 *
 * 存储约定（server 侧 memo-app.js 有同构 inline 实现，两处必须同步修改）：
 * 文档 `{ items: [...] }`、文件级读写串行（进程内 mutex）、写时全量落盘、
 * 原子写（临时文件 + rename）。runtime 与 server 是两个写方，跨进程并发
 * 语义为 last-writer-wins（冲突窗口极小且后果轻：丢一次状态更新）。
 *
 * 相对时间解析依赖系统时间上下文（time-awareness 注入），工具描述已写清。
 */

import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, resolve } from 'path';
import { join } from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import type { AgentFeature, FeatureInitContext, PackageInfo, Tool } from '@agentdevjs/core';
import { getPackageInfoFromSource } from '@agentdevjs/core';
import { internalAuthHeaders } from '../../shared/src/internal-auth.js';
import { ScheduledTrigger } from '../../scheduled-trigger/src/index.js';

// 与 server/shared/constants.js 的 resolveUserDataDir 同语义（TS 独立构建
// 无法直接复用）：AGENTDEV_DATA_DIR 仅用于多实例/测试场景。
function resolveUserDataDir(): string {
  const override = process.env.AGENTDEV_DATA_DIR?.trim();
  return override ? resolve(override) : join(os.homedir(), '.agentdev', 'AgentDevClaw');
}

export function resolveDefaultRemindersFile(): string {
  return join(resolveUserDataDir(), 'workspaces', 'memo', 'reminders.json');
}

// ── 条目 schema ─────────────────────────────────────────────────────

export const RECURRENCES = ['once', 'daily', 'weekly', 'monthly'] as const;
export const DELIVERIES = ['direct', 'agent'] as const;

export type Recurrence = (typeof RECURRENCES)[number];
export type Delivery = (typeof DELIVERIES)[number];

export interface ReminderEntry {
  id: string;
  content: string;
  /** ISO 本地时区（带偏移）时刻，存登记原样字符串。 */
  fire_at: string;
  recurrence: Recurrence;
  /** 仅 weekly：星期几集合，0-6（0 为周日）。 */
  weekdays?: number[];
  delivery: Delivery;
  status: 'scheduled' | 'fired';
  createdAt: string;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** fire_at 参数校验：必须带时区偏移（或 Z），可被 Date 解析。 */
export function normalizeFireAt(value: unknown): { iso: string; ms: number } | null {
  const text = cleanText(value);
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? { iso: text, ms } : null;
}

export function normalizeRecurrence(value: unknown): Recurrence | null {
  const text = cleanText(value).toLowerCase();
  return (RECURRENCES as readonly string[]).includes(text) ? (text as Recurrence) : null;
}

export function normalizeDelivery(value: unknown): Delivery | null {
  const text = cleanText(value).toLowerCase();
  return (DELIVERIES as readonly string[]).includes(text) ? (text as Delivery) : null;
}

/** weekly 的 weekdays：0-6 整数、非空、去重后仍合法，否则 null。 */
export function normalizeWeekdays(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const days: number[] = [];
  for (const raw of value) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 6 || days.includes(n)) return null;
    days.push(n);
  }
  return days;
}

// ── 循环重算（本地日历语义；不做时区旅行 / DST 特判）────────────────

/** Date → 本地时区 ISO（带偏移，秒级）。 */
export function localIsoFromDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

/** 下一个月的 day 日（day 超出当月天数时 clamp 到月末），时刻不变。 */
function advanceMonthClamped(from: Date, day: number): Date {
  const target = new Date(
    from.getFullYear(), from.getMonth() + 1, 1,
    from.getHours(), from.getMinutes(), from.getSeconds(), from.getMilliseconds(),
  );
  const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, daysInMonth));
  return target;
}

/**
 * 计算循环提醒的下一次 fire_at（严格晚于 nowMs 的下一个周期时刻）：
 * - daily：逐天推进到严格未来（错过补发时不会落在已过去的「今天同时刻」）；
 * - weekly：逐天推进，命中 weekdays 集合且严格未来；
 * - monthly：按月推进（day 对月末 clamp），严格未来。
 * 无法计算（数据非法）返回 null，调用方按完结处理。
 */
export function computeNextFireAt(
  recurrence: Recurrence,
  fireAtIso: string,
  weekdays: number[] | undefined,
  nowMs: number,
): string | null {
  const base = new Date(fireAtIso);
  if (Number.isNaN(base.getTime())) return null;
  let next: Date;
  switch (recurrence) {
    case 'daily': {
      next = new Date(base);
      do {
        next.setDate(next.getDate() + 1);
      } while (next.getTime() <= nowMs);
      break;
    }
    case 'weekly': {
      const days = (weekdays ?? []).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
      if (days.length === 0) return null;
      next = new Date(base);
      do {
        next.setDate(next.getDate() + 1);
      } while (!days.includes(next.getDay()) || next.getTime() <= nowMs);
      break;
    }
    case 'monthly': {
      const day = base.getDate();
      next = new Date(base);
      do {
        next = advanceMonthClamped(next, day);
      } while (next.getTime() <= nowMs);
      break;
    }
    default:
      return null;
  }
  return localIsoFromDate(next);
}

// ── 存储（与 server/routes/memo-app.js 的 inline 实现同步约定）──────

const fileLocks = new Map<string, Promise<unknown>>();

/** 进程内文件级读写串行（同一文件互斥）。 */
function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(file) || Promise.resolve();
  const run = previous.then(task, task);
  fileLocks.set(file, run.then(() => undefined, () => undefined));
  return run;
}

/** 读取提醒文档；ENOENT（尚未登记过）回空数组，数据损坏抛错（不静默覆盖）。 */
export async function readReminderEntries(file: string): Promise<ReminderEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'ENOENT') return [];
    throw error;
  }
  const doc = JSON.parse(raw) as { items?: ReminderEntry[] };
  return Array.isArray(doc?.items) ? doc.items : [];
}

/** 原子写：临时文件 + rename（照 memo-notes 全量落盘先例，工单要求）。 */
async function writeReminderEntries(file: string, items: ReminderEntry[]): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ items }, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** 串行读改写：mutator 返回 true 才落盘。返回锁内的最新条目数组。 */
async function updateReminders(
  file: string,
  mutator: (items: ReminderEntry[]) => boolean,
): Promise<ReminderEntry[]> {
  return withFileLock(file, async () => {
    const items = await readReminderEntries(file);
    if (mutator(items)) await writeReminderEntries(file, items);
    return items;
  });
}

// ── 呈现 ────────────────────────────────────────────────────────────

/** 错过标注阈值：亚秒 / 分钟内的正常触发延迟不标注。 */
const OVERDUE_NOTE_THRESHOLD_MS = 60_000;

function formatOverdueDuration(overdueMs: number): string {
  const minutes = Math.max(1, Math.floor(overdueMs / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时`;
}

function overdueNoteFor(overdueMs: number): string {
  return overdueMs > OVERDUE_NOTE_THRESHOLD_MS
    ? `错过了预定时间（晚了 ${formatOverdueDuration(overdueMs)}）`
    : '';
}

function describeReminder(entry: ReminderEntry): string {
  const parts = [`「${entry.content}」`, entry.fire_at, entry.recurrence];
  if (entry.recurrence === 'weekly' && entry.weekdays) parts.push(`星期[${entry.weekdays.join(',')}]`);
  parts.push(entry.delivery);
  return parts.join(' · ');
}

function renderReminderPromptText(content: string, note: string): string {
  return `[定时提醒] ${content}${note ? `\n（${note}）` : ''}\n`
    + '这是 Memo 的定时提醒到点唤醒：请基于这条提醒做该做的事，并简短回复用户。';
}

// ── Feature ─────────────────────────────────────────────────────────

export interface MemoRemindersConfig {
  agentId?: string;
  sessionId?: string;
  serverOrigin?: string;
  /** 数据文件路径（测试注入；缺省 workspaces/memo/reminders.json）。 */
  dataFile?: string;
  /** 时钟注入（测试）。 */
  now?: () => number;
  /** fetch 注入（测试）。 */
  fetchImpl?: typeof fetch;
}

const NOT_FOUND_HINT = '可先用 memo_list_reminders 列出全部提醒拿到 id';

export class MemoRemindersFeature implements AgentFeature {
  readonly name = 'memo-reminders';
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');

  private readonly dataFile: string;
  private readonly agentId: string;
  private readonly sessionId: string;
  private readonly serverOrigin: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly trigger: ScheduledTrigger;
  private logger?: FeatureInitContext['logger'];
  private _packageInfo: PackageInfo | null = null;

  constructor(config: MemoRemindersConfig = {}) {
    this.dataFile = resolve(config.dataFile || resolveDefaultRemindersFile());
    // runtime 身份照 ContextRotationTriggerFeature 先例（memo agent.js 装配）。
    this.agentId = typeof config.agentId === 'string' ? config.agentId.trim() : '';
    this.sessionId = typeof config.sessionId === 'string' ? config.sessionId.trim() : '';
    this.serverOrigin = typeof config.serverOrigin === 'string'
      ? config.serverOrigin.replace(/\/$/, '')
      : '';
    this.now = typeof config.now === 'function' ? config.now : () => Date.now();
    this.fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : fetch.bind(globalThis);
    this.trigger = new ScheduledTrigger({
      dataFile: this.dataFile,
      now: this.now,
      onLog: (message, data) => this.logger?.warn?.(`memo-reminders: ${message}`, data),
      onDue: (item, due) => this.handleDue(item as unknown as ReminderEntry, due),
    });
  }

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  /** feature onInitiate 读盘重臂：过期即发，未到的按最近到期臂。 */
  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger?.info('Memo reminders initiated', {
      dataFile: this.dataFile,
      agentId: this.agentId || null,
    });
    await this.trigger.arm();
  }

  /** 测试 / 收尾用：清机制件定时器。 */
  dispose(): void {
    this.trigger.dispose();
  }

  // ── 到点投递 ──────────────────────────────────────────────────────

  private async handleDue(entry: ReminderEntry, dueInfo: { overdueMs: number }): Promise<void> {
    const note = overdueNoteFor(dueInfo.overdueMs);
    try {
      if (entry.delivery === 'agent') {
        const woke = await this.wakeActiveThread(entry, note);
        if (!woke) {
          // 活动线程悬空或唤醒失败：降级直弹登记文案（显式产品行为）。
          await this.postNotification(entry, note);
        }
      } else {
        await this.postNotification(entry, note);
      }
    } finally {
      await this.settleAfterDue(entry);
    }
  }

  /** direct 投递（038 端点）：delivered=false（权限关闭）也是终局，不补投。 */
  private async postNotification(entry: ReminderEntry, note: string): Promise<void> {
    if (!this.serverOrigin) return;
    try {
      const resp = await this.fetchImpl(`${this.serverOrigin}/protoclaw/app_notifications`, {
        method: 'POST',
        headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          agentId: this.agentId || 'memo',
          type: 'reminder',
          title: 'Memo 提醒',
          body: note ? `${entry.content}\n（${note}）` : entry.content,
        }),
      });
      if (!resp.ok) {
        this.logger?.warn?.('memo-reminders: notification delivery failed', {
          id: entry.id,
          status: resp.status,
        });
        return;
      }
      await resp.json().catch(() => null);
    } catch (error) {
      // 在线投递语义：请求失败不留补投队列（条目仍留在提醒列表可见）。
      this.logger?.warn?.('memo-reminders: notification request failed', {
        id: entry.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * agent 标投递：解析 APP 当前唯一活动线程 → 唤醒 head。
   * 返回 false = 线程悬空（state 无 activeThread）或唤醒失败，由调用方降级。
   */
  private async wakeActiveThread(entry: ReminderEntry, note: string): Promise<boolean> {
    if (!this.serverOrigin) return false;
    try {
      const stateResp = await this.fetchImpl(`${this.serverOrigin}/protoclaw/memo-app/state`, {
        headers: internalAuthHeaders(),
      });
      if (!stateResp.ok) return false;
      const state = await stateResp.json().catch(() => null) as
        { activeThread?: { threadId?: unknown } } | null;
      const threadId = String(state?.activeThread?.threadId || '').trim();
      if (!threadId) return false;
      const resp = await this.fetchImpl(
        `${this.serverOrigin}/protoclaw/threads/${encodeURIComponent(threadId)}/input`,
        {
          method: 'POST',
          headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            text: renderReminderPromptText(entry.content, note),
            kind: 'reminder',
            source: 'memo-reminder',
          }),
        },
      );
      if (!resp.ok) {
        this.logger?.warn?.('memo-reminders: agent wake failed', {
          id: entry.id,
          threadId,
          status: resp.status,
        });
        return false;
      }
      return true;
    } catch (error) {
      this.logger?.warn?.('memo-reminders: agent wake request failed', {
        id: entry.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** 到点后的条目去留（工单：循环重算写回，once 标 fired；删除的不复活）。
   *  不在此处调 trigger.arm()——机制件在每轮 due 批次后自动重读重臂，
   *  回调内 await arm() 会等待自身串行链而死锁。 */
  private async settleAfterDue(entry: ReminderEntry): Promise<void> {
    try {
      await withFileLock(this.dataFile, async () => {
        const items = await readReminderEntries(this.dataFile);
        const item = items.find((it) => it && it.id === entry.id);
        if (!item) return; // 已被用户删除：去留由用户操作决定
        if (item.recurrence && item.recurrence !== 'once') {
          const next = computeNextFireAt(item.recurrence, item.fire_at, item.weekdays, this.now());
          if (next) {
            item.fire_at = next;
            await writeReminderEntries(this.dataFile, items);
            return;
          }
          // 重算失败（数据非法）：视为完结，不静默复活。
        }
        item.status = 'fired';
        await writeReminderEntries(this.dataFile, items);
      });
    } catch (error) {
      this.logger?.warn?.('memo-reminders: settle after due failed', {
        id: entry.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── 工具面 ────────────────────────────────────────────────────────

  getTools(): Tool[] {
    return [
      {
        name: 'memo_create_reminder',
        description:
          '登记定时提醒（单次或简单循环）。content 是到点时要展示/处理的提醒文案；'
          + 'fire_at 必须是带时区偏移的 ISO 本地时间（如 2026-10-18T09:00:00+08:00）——'
          + '解析用户的相对时间表达（明天 9 点 / 每周一 8 点）时，以系统时间上下文'
          + '（time-awareness 注入的当前时间与时区）为基准换算，不要凭空猜测时区。'
          + 'recurrence：once（单次）| daily | weekly | monthly；weekly 必须携带 weekdays'
          + '（0-6 数字数组，0 为周日）。delivery 打标：到点只需把登记文案直接弹给用户'
          + '（「明天 9 点提醒我开会」类）打 direct；到点需要你查看 / 思考 / 生成内容'
          + '（「到点看看我今天该干嘛」类）打 agent（到点会唤醒本会话处理）。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '提醒文案（到点直弹或交给 agent 处理的内容）' },
            fire_at: { type: 'string', description: '首次触发时刻，带时区偏移的 ISO 本地时间' },
            recurrence: { type: 'string', description: 'once | daily | weekly | monthly' },
            weekdays: { type: 'array', items: { type: 'number' }, description: '仅 weekly：星期几集合（0-6，0 为周日）' },
            delivery: { type: 'string', description: 'direct（直弹文案）| agent（到点唤醒会话处理）' },
          },
          required: ['content', 'fire_at', 'recurrence', 'delivery'],
        },
        execute: async (args: Record<string, unknown>) => {
          const content = cleanText(args?.content);
          if (!content) return { error: 'content 不能为空' };
          const fireAt = normalizeFireAt(args?.fire_at);
          if (!fireAt) {
            return { error: 'fire_at 必须是带时区偏移的 ISO 时间（如 2026-10-18T09:00:00+08:00）' };
          }
          const recurrence = normalizeRecurrence(args?.recurrence);
          if (!recurrence) return { error: `recurrence 必须是：${RECURRENCES.join(' | ')}` };
          let weekdays: number[] | undefined;
          if (recurrence === 'weekly') {
            weekdays = normalizeWeekdays(args?.weekdays);
            if (!weekdays) {
              return { error: 'weekly 提醒必须提供 weekdays：0-6 的数字数组（0 为周日），且不含重复值' };
            }
          }
          const delivery = normalizeDelivery(args?.delivery);
          if (!delivery) return { error: 'delivery 必须是：direct | agent' };
          const entry: ReminderEntry = {
            id: randomUUID(),
            content,
            fire_at: fireAt.iso,
            recurrence,
            ...(weekdays ? { weekdays } : {}),
            delivery,
            status: 'scheduled',
            createdAt: new Date(this.now()).toISOString(),
          };
          try {
            await updateReminders(this.dataFile, (items) => {
              items.push(entry);
              return true;
            });
          } catch (error) {
            return { error: `提醒写入失败: ${error instanceof Error ? error.message : String(error)}` };
          }
          await this.trigger.arm();
          return { ok: true, reminder: entry, text: `已登记提醒：${describeReminder(entry)}` };
        },
      },
      {
        name: 'memo_list_reminders',
        parallelizable: true,
        description:
          '列出全部提醒（id / 文案 / 触发时刻 / 循环规则 / 投递方式 / 状态）。'
          + '管理提醒（完成 / 删除）前先在这里拿 id。',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          let items: ReminderEntry[];
          try {
            items = await readReminderEntries(this.dataFile);
          } catch (error) {
            return { error: `提醒读取失败: ${error instanceof Error ? error.message : String(error)}` };
          }
          if (items.length === 0) {
            return { text: '当前没有任何提醒。', reminders: [] };
          }
          const scheduled = items.filter((item) => item.status === 'scheduled');
          const settled = items.filter((item) => item.status !== 'scheduled');
          const lines = [...scheduled, ...settled].map((item) =>
            `- [${item.status}] ${describeReminder(item)}｜id=${item.id}`);
          return {
            text: `共 ${items.length} 条提醒（未触发的在前）：\n${lines.join('\n')}`,
            reminders: items,
          };
        },
      },
      {
        name: 'memo_complete_reminder',
        description: '把提醒标记为完成（不再触发，条目保留在列表）。id 来自 memo_list_reminders。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '提醒 id' } },
          required: ['id'],
        },
        execute: async (args: Record<string, unknown>) => {
          const id = cleanText(args?.id);
          if (!id) return { error: 'id 不能为空' };
          let found = false;
          let already = false;
          try {
            await updateReminders(this.dataFile, (items) => {
              const item = items.find((it) => it && it.id === id);
              if (!item) return false;
              found = true;
              already = item.status === 'fired';
              item.status = 'fired';
              return true;
            });
          } catch (error) {
            return { error: `提醒写入失败: ${error instanceof Error ? error.message : String(error)}` };
          }
          if (!found) return { error: `提醒不存在: ${id}`, hint: NOT_FOUND_HINT };
          return { ok: true, id, status: 'fired', ...(already ? { note: '该提醒此前已触发或已完成' } : {}) };
        },
      },
      {
        name: 'memo_delete_reminder',
        description: '删除提醒（永久删除，条目从列表移除）。id 来自 memo_list_reminders。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '提醒 id' } },
          required: ['id'],
        },
        execute: async (args: Record<string, unknown>) => {
          const id = cleanText(args?.id);
          if (!id) return { error: 'id 不能为空' };
          let removed: ReminderEntry | null = null;
          try {
            await updateReminders(this.dataFile, (items) => {
              const index = items.findIndex((it) => it && it.id === id);
              if (index < 0) return false;
              removed = items.splice(index, 1)[0];
              return true;
            });
          } catch (error) {
            return { error: `提醒写入失败: ${error instanceof Error ? error.message : String(error)}` };
          }
          if (!removed) return { error: `提醒不存在: ${id}`, hint: NOT_FOUND_HINT };
          return { ok: true, id, removed };
        },
      },
    ];
  }
}
