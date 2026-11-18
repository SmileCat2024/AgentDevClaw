/**
 * TopicManagementFeature — 编程小助手的主题簇管理工具。
 *
 * 主题簇（Topic）由会话引用关系客观形成（session-relations 投影的显式
 * 引用连通分量），Feature 只提供「列出 + 逐个更新」两个动作，可更新字段
 * 为主题标题、简介、参考文档与相关提交（均为自由文本，内容形态尊重
 * 写入方判断）；不创建、不删除、不合并、不拆分簇，也不经线程列表
 * 重组簇。写入落在 server 侧主题标注存储（topic-notes）。
 */
import { fileURLToPath } from 'node:url';
import { createTool } from '@agentdevjs/core';
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

/** 最小 fetch 接口：request() 只依赖这些成员，测试可注入轻量 mock。 */
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export class TopicManagementFeature {
  name = 'topic-management';
  source = __filename;
  description = '列出已有主题簇并逐个更新主题标题与简介；不创建、删除或重组主题。';
  agentId: string;
  serverOrigin: string;
  fetchImpl: FetchLike;

  constructor(config: { agentId?: string; serverOrigin?: string; fetchImpl?: FetchLike } = {}) {
    this.agentId = cleanText(config.agentId) || AGENT_ID;
    this.serverOrigin = String(config.serverOrigin || process.env.PROTOCLAW_SERVER_ORIGIN || `http://127.0.0.1:${process.env.PORT || 14200}`).replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
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
