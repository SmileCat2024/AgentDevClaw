/**
 * ConversationAnnotationsFeature — 会话标注（用户在对话内容上的高亮标注）
 *
 * 用户在前端选中文本创建标注，标注是用户注意力的显式记录。本 feature 是
 * 标注的权威持有方：
 * - 内存态即状态：标注数组 + 已见轮次号（lastCallIndex），持久化完全交给
 *   框架会话快照（captureState / restoreState，随 callFinished / step
 *   auto-save / 进程退出落盘），不自建任何文件存储；
 * - trim / rotate 接续经 declareContinuity（GENERIC_CONTINUITY_PROTOCOL
 *   透传）随 SuccessorSeed 流转，新会话 restoreState 时恢复；
 * - branch 分支从切割点 checkpoint 复制 featureStates，标注自动继承到
 *   分支（机制的自然结果，非本 feature 特判）；
 * - rollback 合并语义：回滚只应删除"目标消息已不存在"的标注，标注锚定
 *   消息而非创建时刻。CallStart 时框架在 user 消息落位前捕获 checkpoint
 *   （runtimeState 记录 callIndex = N-1），因此回滚到 checkpoint N 的幸存
 *   边界是 turn ≤ N-1；本 feature 在自身状态里跟踪该边界，restoreState
 *   时以旧快照的 lastCallIndex 为 cutoff 对新旧标注做并集过滤。
 *
 * 通信走 ADR-0018 feature-comms 通道（前端 <-> 本 feature 的唯一链路）：
 * - onHostRequest 请求面：list / create / remove（前端弹窗与面板调用）；
 * - 事件面：created / removed 尽力而为广播（发布失败静默——内存态与会话
 *   快照是真值，事件只是跨标签页镜像）。
 *
 * 模型读取面（annotations_recall 工具）按产品决策缓行；本 feature 只服务
 * 前端交互与状态持久化。
 */

import type { AgentFeature, CallStartContext, HookDeclarations, PackageInfo, StepStartContext } from '@agentdevjs/core';
import { CoreLifecycle, getPackageInfoFromSource } from '@agentdevjs/core';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { FeatureCommunicationClient } from '../../shared/src/feature-communication.js';
import {
  CONTINUITY_FIELD_KEY,
  declareContinuity,
  GENERIC_CONTINUITY_PROTOCOL,
} from '../../continuity-participant/src/index.js';

/** 标注记录：锚定一条消息内的文本片段。 */
export interface AnnotationRecord {
  /** 稳定标识（randomUUID），删除与面板定位用。 */
  id: string;
  /** 目标消息的轮次号（call 序号，同会话内稳定；消息无稳定 id，这是唯一可靠锚位）。 */
  turn: number;
  /** 目标消息角色。v1 只允许 user / assistant 正文。 */
  role: 'user' | 'assistant';
  /** 标注的原文摘录（渲染文本的归一化空白形式）。 */
  quote: string;
  /** quote 在目标消息全文中的第几次出现（0 起），区分重复文本。 */
  occurrence: number;
  /** 创建时间（Date.now()）。 */
  createdAt: number;
}

/** captureState / restoreState 流转的状态形状。 */
export interface AnnotationsState {
  annotations: AnnotationRecord[];
  /** 状态捕获时刻的幸存消息边界（最高已见轮次号），rollback 合并的 cutoff。 */
  lastCallIndex: number;
}

export interface ConversationAnnotationsConfig {
  agentId: string;
  sessionId: string;
  serverOrigin: string;
  /** 通道标题/描述（默认中文，宿主可覆盖）。 */
  title?: string;
  description?: string;
  /** 测试注入：替换内置通道 client。 */
  client?: AnnotationChannelClient;
}

/** 通道 client 最小面（FeatureCommunicationClient 的结构性子集，测试可注入）。 */
export interface AnnotationChannelClient {
  declareChannel(meta: { title?: string; description?: string; presentation?: unknown }): Promise<unknown>;
  publishEvent(eventType: string, data: unknown): Promise<unknown>;
}

const QUOTE_MAX_CHARS = 4_000;
const ANNOTATIONS_MAX = 2_000;

function isAnnotationRecord(value: unknown): value is AnnotationRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const { id, turn, role, quote, occurrence, createdAt } = record;
  return typeof id === 'string' && id.length > 0
    && typeof turn === 'number' && Number.isInteger(turn) && turn >= 0
    && (role === 'user' || role === 'assistant')
    && typeof quote === 'string' && quote.length > 0
    && typeof occurrence === 'number' && Number.isInteger(occurrence) && occurrence >= 0
    && typeof createdAt === 'number' && Number.isInteger(createdAt);
}

/** 从任意快照 JSON 防御性提取状态；完全不合法返回 null（restoreState 无操作）。 */
function normalizeState(snapshot: unknown): { annotations: AnnotationRecord[]; lastCallIndex: number | null } | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const raw = snapshot as Record<string, unknown>;
  const rawList = Array.isArray(raw.annotations) ? raw.annotations : [];
  const annotations = rawList.filter(isAnnotationRecord);
  const lastCallIndex = Number.isInteger(raw.lastCallIndex) && (raw.lastCallIndex as number) >= 0
    ? (raw.lastCallIndex as number)
    : null;
  return { annotations, lastCallIndex };
}

function sortByCreatedAt(list: AnnotationRecord[]): AnnotationRecord[] {
  return [...list].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

function dedupeById(list: AnnotationRecord[]): AnnotationRecord[] {
  const seen = new Set<string>();
  const result: AnnotationRecord[] = [];
  for (const item of list) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

export class ConversationAnnotationsFeatureInner implements AgentFeature {
  readonly name = 'conversation-annotations';
  readonly source = fileURLToPath(import.meta.url);

  private readonly client: AnnotationChannelClient;
  private readonly channelTitle: string;
  private readonly channelDescription: string;
  private declared = false;

  private annotations: AnnotationRecord[] = [];
  private lastCallIndex = 0;
  /**
   * 本实例是否已持有有效状态（restoreState 或本地 create 过）。
   * 区分 fresh instance（会话恢复 / continuity 导入 / feature 重载：权威替换）
   * 与 live instance（rollback：按 cutoff 合并）。前者不能过滤——call 进行中
   * 创建的标注 turn 可能大于快照捕获时的 lastCallIndex。
   */
  private hydrated = false;

  constructor(config: ConversationAnnotationsConfig) {
    this.channelTitle = config.title || '会话标注';
    this.channelDescription = config.description || '对话内容高亮标注（用户选中文本创建）';
    this.client = config.client
      ?? new FeatureCommunicationClient(config.serverOrigin, {
        agentId: config.agentId,
        sessionId: config.sessionId,
        // featureId 必须等于 feature name：IPC 分发按 agent.features.get(featureId) 查实例。
        featureId: this.name,
        channelId: 'annotations',
      });
    this.declare().catch(() => {});
  }

  getPackageInfo(): PackageInfo | null {
    return getPackageInfoFromSource(this.source);
  }

  static hooks: HookDeclarations = {
    trackCallIndexAtStart: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
    trackCallIndexAtStep: { lifecycle: CoreLifecycle.StepFinish, kind: 'observe' as const },
  };

  /**
   * CallStart 时 user 消息尚未落位，此刻的幸存边界是 `_callIndex - 1`
   * （框架在同位置捕获 checkpoint，runtimeState 记录 callIndex = N-1）。
   */
  async trackCallIndexAtStart(ctx: CallStartContext): Promise<void> {
    const callIndex = (ctx.agent as { _callIndex?: number } | undefined)?._callIndex;
    if (typeof callIndex === 'number' && Number.isInteger(callIndex) && callIndex > 0) {
      this.lastCallIndex = Math.max(this.lastCallIndex, callIndex - 1);
    }
  }

  /** StepFinish 时本轮消息已在上下文中（部分），call 进行中的命名检查点需要该边界。 */
  async trackCallIndexAtStep(ctx: StepStartContext): Promise<void> {
    if (typeof ctx.callIndex === 'number' && Number.isInteger(ctx.callIndex) && ctx.callIndex >= 0) {
      this.lastCallIndex = Math.max(this.lastCallIndex, ctx.callIndex);
    }
  }

  captureState(): Record<string, unknown> {
    return {
      annotations: this.annotations.map((item) => ({ ...item })),
      lastCallIndex: this.lastCallIndex,
    };
  }

  async restoreState(snapshot: Record<string, unknown>): Promise<void> {
    const incoming = normalizeState(snapshot);
    if (!incoming) return;
    if (!this.hydrated) {
      // fresh instance（会话恢复 / continuity 导入 / feature 重载）：快照权威，整体替换。
      this.annotations = sortByCreatedAt(incoming.annotations);
      this.lastCallIndex = Math.max(this.lastCallIndex, incoming.lastCallIndex ?? 0);
      this.hydrated = true;
      return;
    }
    // live instance：rollback 合并。保留 turn ≤ cutoff（幸存消息边界）的并集；
    // cutoff 未知（legacy 快照无 lastCallIndex）时保守并集，宁可留僵尸条目（面板可见、
    // 可手动删除）也不丢用户标注。
    const cutoff = incoming.lastCallIndex;
    const merged = dedupeById([...incoming.annotations, ...this.annotations]);
    this.annotations = sortByCreatedAt(cutoff == null ? merged : merged.filter((item) => item.turn <= cutoff));
    if (cutoff != null) this.lastCallIndex = cutoff;
  }

  /** 面板 / 弹窗请求面（server /protoclaw/feature-comms/request → runtime IPC → 此处）。 */
  async onHostRequest(requestType: string, payload: unknown): Promise<Record<string, unknown>> {
    const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    switch (requestType) {
      case 'list':
        return { ok: true, annotations: this.annotations.map((item) => ({ ...item })) };
      case 'create':
        return this.createAnnotation(body);
      case 'remove': {
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) return { ok: false, code: 'invalid_payload', error: 'id is required' };
        const before = this.annotations.length;
        this.annotations = this.annotations.filter((item) => item.id !== id);
        if (this.annotations.length === before) {
          return { ok: false, code: 'annotation_not_found', error: `No such annotation: ${id}` };
        }
        this.hydrated = true;
        void this.publishQuiet('removed', { id });
        return { ok: true };
      }
      default:
        return { ok: false, code: 'operation_unavailable', error: `Unknown requestType: ${requestType}` };
    }
  }

  private createAnnotation(body: Record<string, unknown>): Record<string, unknown> {
    const turn = body.turn;
    const role = body.role;
    const quote = body.quote;
    const occurrence = body.occurrence;
    if (!Number.isInteger(turn) || (turn as number) < 0) {
      return { ok: false, code: 'invalid_payload', error: 'turn must be a non-negative integer' };
    }
    if (role !== 'user' && role !== 'assistant') {
      return { ok: false, code: 'invalid_payload', error: 'role must be user or assistant' };
    }
    if (typeof quote !== 'string' || quote.trim().length === 0) {
      return { ok: false, code: 'invalid_payload', error: 'quote must be a non-empty string' };
    }
    if (quote.length > QUOTE_MAX_CHARS) {
      return { ok: false, code: 'invalid_payload', error: `quote exceeds ${QUOTE_MAX_CHARS} chars` };
    }
    if (!Number.isInteger(occurrence) || (occurrence as number) < 0) {
      return { ok: false, code: 'invalid_payload', error: 'occurrence must be a non-negative integer' };
    }
    // 幂等：同锚位重复提交返回已有条目（弹窗双击防抖），不重复入账、不发事件。
    const existing = this.annotations.find((item) =>
      item.turn === turn && item.role === role && item.quote === quote && item.occurrence === occurrence);
    if (existing) return { ok: true, annotation: { ...existing }, duplicate: true };

    if (this.annotations.length >= ANNOTATIONS_MAX) {
      return { ok: false, code: 'annotations_full', error: `annotations exceed ${ANNOTATIONS_MAX}` };
    }
    const record: AnnotationRecord = {
      id: randomUUID(),
      turn: turn as number,
      role,
      quote,
      occurrence: occurrence as number,
      createdAt: Date.now(),
    };
    this.annotations = sortByCreatedAt([...this.annotations, record]);
    this.hydrated = true;
    void this.publishQuiet('created', { ...record });
    return { ok: true, annotation: { ...record } };
  }

  private async declare(): Promise<void> {
    await this.client.declareChannel({ title: this.channelTitle, description: this.channelDescription });
    this.declared = true;
  }

  private async publishQuiet(eventType: string, data: unknown): Promise<void> {
    try {
      if (!this.declared) await this.declare();
      await this.client.publishEvent(eventType, data);
    } catch {
      // 镜像面尽力而为：内存态与会话快照是真值。
    }
  }
}

/**
 * continuity 自声明包装：标注随 trim / rotate 接续与 branch 复制流转
 * （GENERIC_CONTINUITY_PROTOCOL 通用透传，importMode replace——restoreState
 * 自身已实现合并语义）。
 */
export const ConversationAnnotationsFeature = declareContinuity(ConversationAnnotationsFeatureInner, {
  protocol: GENERIC_CONTINUITY_PROTOCOL,
  importMode: 'replace',
});

export { CONTINUITY_FIELD_KEY };
