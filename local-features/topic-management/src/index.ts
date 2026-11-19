/**
 * TopicManagementFeature — 编程小助手的主题簇管理工具与主题引用注入。
 *
 * 主题簇（Topic）由会话引用关系客观形成（session-relations 投影的显式
 * 引用连通分量），Feature 提供三个动作：列出（topic_list）、单主题结构化
 * 读取（topic_get）、逐个更新标注（topic_update）。可更新字段为主题标题、
 * 简介、参考文档与相关提交（均为自由文本，内容形态尊重写入方判断）；
 * 不创建、不删除、不合并、不拆分簇，也不经线程列表重组簇。写入落在
 * server 侧主题标注存储（topic-notes）。
 *
 * 另一职责：承接输入框的主题引用（Topic 看板卡片拖到输入框 / 左栏会话
 * 条目，链路对标会话引用）。消费 turn metadata['topic-management']
 * （键 = 本 feature 注册名：call 内排队路径的 dispatchTurnMetadata 按
 * 「metadata 键 = feature 名」派发），在 CallStart / onTurnMetadata 两个
 * 互斥入口注入指针式 reminder——引用时只携带主题元信息（标题 / 简介 /
 * 参考文档 / 相关提交 / 对话数），成员对话等结构化细节由模型按需经
 * topic_get 读取，不随引用全量注入。
 */
import { fileURLToPath } from 'node:url';
import { createTool, CoreLifecycle } from '@agentdevjs/core';
import type { CallStartContext, Context, HookDeclarations } from '@agentdevjs/core';
import { internalAuthHeaders } from '../../shared/src/internal-auth.js';

const __filename = fileURLToPath(import.meta.url).replace(/\\/g, '/');
const AGENT_ID = 'programming-helper';

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 数组字段清洗：仅字符串数组有意义；trim 并丢弃空串（null = 类型不合法）。 */
function cleanTextList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return null;
  return value.map(item => (item as string).trim()).filter(Boolean);
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** reminder 内列表字段的展示上限：截断防 overread，完整清单走 topic_get。 */
const REMINDER_LIST_MAX_ITEMS = 10;
const REMINDER_LIST_ITEM_MAX = 120;

function clipListItems(items: string[]): string {
  const shown = items.slice(0, REMINDER_LIST_MAX_ITEMS).map(item => truncateText(item, REMINDER_LIST_ITEM_MAX));
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join('、')} 等 ${items.length} 条` : shown.join('、');
}

/** 最小 fetch 接口：request() 只依赖这些成员，测试可注入轻量 mock。 */
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** 主题注入 reminder 的条目形态：拖拽身份 + 服务端标注元信息 + 存在性。 */
export interface VerifiedTopicReference {
  agentId: string;
  topicId: string;
  title: string;
  summary: string;
  docs: string[];
  commits: string[];
  conversations: number;
  availability: 'ok' | 'missing' | 'unknown';
}

/**
 * 渲染主题引用 reminder。指针式：注入的是定位与元信息（标题 / 简介 /
 * 参考文档 / 相关提交 / 对话数），成员对话明细不随引用注入（防 overread），
 * 尾行指引 topic_get 按需读取。agentId 标注为可原样填参的纯值（与
 * session-reference 的 renderReferenceReminder 同约定）。标题可由自定义
 * 标注或会话标题回退而来，仅供参考——文案提示以 topic_get 实际内容为准。
 */
export function renderTopicReferenceReminder(topics: VerifiedTopicReference[]): string {
  const lines = topics.map((topic) => {
    const label = topic.title ? `「${truncateText(topic.title, 80)}」` : '';
    const head = `- ${topic.topicId}${label} — agentId: ${topic.agentId}（${topic.conversations} 个对话）`;
    if (topic.availability === 'missing') return `${head} — 主题已不存在（簇可能已被重组），请告知用户该引用失效`;
    if (topic.availability === 'unknown') return `${head} — 主题详情暂不可用（读取失败），需要时可用 topic_get 重试`;
    const parts = [head];
    if (topic.summary) parts.push(`简介: ${truncateText(topic.summary, 240)}`);
    if (topic.docs.length > 0) parts.push(`参考文档: ${clipListItems(topic.docs)}`);
    if (topic.commits.length > 0) parts.push(`相关提交: ${clipListItems(topic.commits)}`);
    return parts.join('；');
  });
  return [
    '[主题引用] 用户在本条消息中引用了以下主题簇（会话引用关系形成的对话分组；标题与简介是标注快照，以实际读取内容为准）：',
    ...lines,
    '成员对话等结构化细节按需用 topic_get（参数 topicId）读取；与当前任务无关的主题可忽略。',
  ].join('\n');
}

export class TopicManagementFeature {
  name = 'topic-management';
  source = __filename;
  description = '主题簇管理工具：列出 / 单主题结构化读取 / 逐个更新标注；并承接输入框主题引用（注入主题元信息）。不创建、删除或重组主题。';
  agentId: string;
  serverOrigin: string;
  fetchImpl: FetchLike;

  /**
   * 输入框主题引用的消费入口：CallStart 读 metadata['topic-management']
   * （键 = 本 feature 注册名，见类头注）并注入 reminder。observe 语义——
   * 注入失败不阻断用户消息。与 onTurnMetadata（忙时排队的消息经
   * dispatchTurnMetadata 派发）互斥，一条消息只走其一。
   */
  static hooks: HookDeclarations = {
    injectTopicReferences: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
  };

  constructor(config: { agentId?: string; serverOrigin?: string; fetchImpl?: FetchLike } = {}) {
    this.agentId = cleanText(config.agentId) || AGENT_ID;
    this.serverOrigin = String(config.serverOrigin || process.env.PROTOCLAW_SERVER_ORIGIN || `http://127.0.0.1:${process.env.PORT || 14200}`).replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
  }

  async injectTopicReferences(ctx: CallStartContext): Promise<void> {
    const entries = this.parseTopicReferenceEntries(
      (ctx.metadata as Record<string, unknown> | undefined)?.[this.name],
    );
    if (entries.length === 0) return;
    const turn = typeof (ctx.agent as any)?._callIndex === 'number'
      ? (ctx.agent as any)._callIndex
      : 0;
    await this.verifyAndInjectTopicReferences(entries, ctx.context, turn);
  }

  /** call 内注入点（与 CallStart 路径共享注入逻辑，产物一致）。 */
  async onTurnMetadata(
    value: unknown,
    { context, agent }: { context: Context; agent?: unknown },
  ): Promise<void> {
    const entries = this.parseTopicReferenceEntries(value);
    if (entries.length === 0) return;
    const turn = typeof (agent as any)?._callIndex === 'number'
      ? (agent as any)._callIndex
      : 0;
    await this.verifyAndInjectTopicReferences(entries, context, turn);
  }

  /** 解析 metadata 引用条目：非对象数组与缺 topicId 的条目一律剔除。 */
  private parseTopicReferenceEntries(raw: unknown): Array<Record<string, unknown>> {
    return Array.isArray(raw)
      ? raw.filter((item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && cleanText((item as Record<string, unknown>).topicId) !== '')
      : [];
  }

  /**
   * 存在性验证 + 元信息补齐 + 注入 reminder。同一 agentId 的条目共享一次
   * topic_groups 拉取（Promise 去重，非结果缓存）；拉取失败 → 'unknown'
   * （不把基础设施故障误报为主题不存在），拉取成功但 id 不在列表 →
   * 'missing'。标注字段以服务端为准，拖拽携带的 title 仅作回退。
   */
  private async verifyAndInjectTopicReferences(
    entries: Array<Record<string, unknown>>,
    context: Context,
    turn: number,
  ): Promise<void> {
    const fetches = new Map<string, Promise<any[] | null>>();
    const groupsFor = (agentId: string) => {
      let pending = fetches.get(agentId);
      if (!pending) {
        pending = this.fetchTopicGroups(agentId);
        fetches.set(agentId, pending);
      }
      return pending;
    };
    const verified: VerifiedTopicReference[] = await Promise.all(entries.map(async (entry) => {
      const agentId = cleanText(entry.agentId) || this.agentId;
      const topicId = cleanText(entry.topicId);
      const groups = await groupsFor(agentId);
      const group = Array.isArray(groups) ? groups.find(item => cleanText(item?.id) === topicId) : undefined;
      const docs = cleanTextList(group?.docs) || [];
      const commits = cleanTextList(group?.commits) || [];
      return {
        agentId,
        topicId,
        title: cleanText(group?.title) || cleanText(entry.title),
        summary: cleanText(group?.summary),
        docs,
        commits,
        conversations: Number(group?.memberCount) || 0,
        availability: groups === null ? 'unknown' : group ? 'ok' : 'missing',
      };
    }));
    context.addSystemMessage(renderTopicReferenceReminder(verified), turn, this.name, 'reminder');
  }

  /** 拉取某 agent 范围的全部主题簇；失败（网络 / 服务错误 / 形态异常）返回 null。 */
  private async fetchTopicGroups(agentId: string): Promise<any[] | null> {
    try {
      const response = await this.fetchImpl(
        `${this.serverOrigin}/protoclaw/topic_groups?agentId=${encodeURIComponent(agentId)}`,
        { headers: internalAuthHeaders(), signal: AbortSignal.timeout(8000) },
      );
      if (!response.ok) return null;
      const payload: any = await response.json().catch(() => null);
      return Array.isArray(payload?.groups) ? payload.groups : null;
    } catch {
      return null;
    }
  }

  getTools() {
    return [
      createTool({
        name: 'topic_list',
        description: '列出当前已存在的主题簇（会话引用关系形成的对话分组），按最近活动倒序。返回每个主题的 topicId、标题、简介、参考文档、相关提交与对话数。主题是客观存在的分组，不要自行创建或合并主题；各字段的写法遵循 topic-management 技能的风格约定。',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          const payload = await this.request('GET', `/protoclaw/topic_groups?agentId=${encodeURIComponent(this.agentId)}`);
          if (payload?.error) return payload;
          const groups = Array.isArray(payload?.groups) ? payload.groups : [];
          return {
            total: groups.length,
            partial: Boolean(payload?.partial),
            topics: groups.map((group: any) => ({
              topicId: group.id,
              title: group.title || '',
              summary: group.summary || '',
              docs: Array.isArray(group.docs) ? group.docs : [],
              commits: Array.isArray(group.commits) ? group.commits : [],
              customTitle: Boolean(group.customTitle),
              conversations: group.memberCount || 0,
              updatedAt: group.updatedAt || '',
            })),
          };
        },
      }),
      createTool({
        name: 'topic_get',
        description: [
          '读取单个主题簇的结构化详情：标注（标题/简介/参考文档/相关提交）与成员对话列表（线程身份 threadId、标题、最新一代会话锚点 headSessionId、代数、更新时间）。',
          'topicId 来自 topic_list 或主题引用提醒（[主题引用] reminder）；成员对话需要深入时，threadId 可直接作 session_read_overview 输入读代际导航。列表内不展开每个成员的完整会话清单，需要时按 threadId 读取。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            topicId: { type: 'string', description: '已有主题簇的 topicId（来自 topic_list 或主题引用提醒）。' },
          },
          required: ['topicId'],
        },
        execute: async (args: any) => {
          const topicId = cleanText(args?.topicId);
          if (!topicId) return { error: 'topicId 不能为空。' };
          const groups = await this.fetchTopicGroups(this.agentId);
          if (groups === null) return { error: '主题列表读取失败（服务暂不可用），请稍后重试。' };
          const group = groups.find(item => cleanText(item?.id) === topicId);
          if (!group) return { error: `主题不存在或已被重组（topicId: ${topicId}）。可先用 topic_list 列出当前全部主题确认。` };
          const threads = Array.isArray(group.threads) ? group.threads : [];
          return {
            topic: {
              topicId: group.id,
              title: cleanText(group.title),
              summary: cleanText(group.summary),
              docs: cleanTextList(group.docs) || [],
              commits: cleanTextList(group.commits) || [],
              customTitle: Boolean(group.customTitle),
              conversations: Number(group.memberCount) || threads.length,
              updatedAt: cleanText(group.updatedAt),
              threads: threads.map((thread: any) => ({
                threadId: cleanText(thread?.threadId),
                title: cleanText(thread?.title),
                agentId: cleanText(thread?.agentId),
                generations: Number(thread?.generations) || 0,
                sessionCount: Array.isArray(thread?.sessionIds) ? thread.sessionIds.length : 0,
                headSessionId: cleanText(thread?.headSessionId),
                updatedAt: cleanText(thread?.updatedAt),
              })),
            },
          };
        },
      }),
      createTool({
        name: 'topic_update',
        description: [
          '更新一个已存在主题簇的标注。标题是话题域（名词性），简介是事件还原式概括（现象/动机 → 做法 → 结果锚点），写法规范见 topic-management 技能。先用 topic_list 获取 topicId，一次只处理一个主题。',
          '可更新字段：title、summary（字符串；空字符串分别表示恢复自动标题、清除简介）；docs（参考文档条目数组）、commits（相关 git 提交条目数组）——条目是自由文本，推荐「路径或提交号 + 半句说明」。数组字段整体覆盖：传空数组清除该字段，需要追加条目时先用 topic_list 读回现值再合并后整体提交。不允许创建、删除、合并、拆分主题。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            topicId: { type: 'string', description: '已有主题簇的 topicId（来自 topic_list）。' },
            title: { type: 'string', description: '新的主题标题；空字符串恢复自动标题。' },
            summary: { type: 'string', description: '新的主题简介；空字符串清除简介。' },
            docs: { type: 'array', items: { type: 'string' }, description: '参考文档条目（自由文本：文档路径或 URL，可带半句说明）；整体覆盖，空数组清除。' },
            commits: { type: 'array', items: { type: 'string' }, description: '相关 git 提交条目（自由文本：提交号，可带半句说明）；整体覆盖，空数组清除。' },
          },
          required: ['topicId'],
        },
        execute: async (args: any) => {
          const topicId = cleanText(args?.topicId);
          if (!topicId) return { error: 'topicId 不能为空。' };
          const has = (key: string) => Object.prototype.hasOwnProperty.call(args || {}, key);
          const hasTitle = has('title');
          const hasSummary = has('summary');
          const hasDocs = has('docs');
          const hasCommits = has('commits');
          if (!hasTitle && !hasSummary && !hasDocs && !hasCommits) return { error: '至少提供 title、summary、docs 或 commits 之一。' };
          if (hasTitle && typeof args.title !== 'string') return { error: 'title 必须是字符串。' };
          if (hasSummary && typeof args.summary !== 'string') return { error: 'summary 必须是字符串。' };
          const docs = hasDocs ? cleanTextList(args.docs) : undefined;
          if (hasDocs && !docs) return { error: 'docs 必须是字符串数组。' };
          const commits = hasCommits ? cleanTextList(args.commits) : undefined;
          if (hasCommits && !commits) return { error: 'commits 必须是字符串数组。' };
          const body: Record<string, unknown> = {};
          if (hasTitle) body.title = cleanText(args.title);
          if (hasSummary) body.summary = cleanText(args.summary);
          if (hasDocs) body.docs = docs;
          if (hasCommits) body.commits = commits;
          return this.request('PUT', `/protoclaw/topic_groups/${encodeURIComponent(topicId)}?agentId=${encodeURIComponent(this.agentId)}`, body);
        },
      }),
    ];
  }

  async request(method: string, route: string, body?: unknown): Promise<any> {
    try {
      const response = await this.fetchImpl(`${this.serverOrigin}${route}`, {
        method,
        headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload: any = await response.json().catch(() => null);
      if (!response.ok) return { error: String(payload?.error || `主题管理请求失败 (${response.status})`) };
      return payload || { ok: true };
    } catch (error) {
      return { error: `主题管理请求失败: ${String((error as Error)?.message || error)}` };
    }
  }
}
