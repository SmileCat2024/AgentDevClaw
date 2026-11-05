/**
 * im_browse 渲染模板 — 可连接的线程
 *
 * 结果为 { text, sessions[] }。数组名沿用 sessions（历史命名，工具返回形状），
 * 但元素是**线程**投影，字段为：
 *   { agentId, agentName, threadId, title, headSessionId, status, modelName,
 *     execStatus, updatedAt }
 *
 * ADR-0042 决策 1：可绑目标从「运行中会话」换成「活跃线程」。模板此前仍读
 * sessionId / sessionTitle / savedAt，与真实字段零重叠，结果是标题恒定显示
 * 「(无标题会话)」、threadId 整行消失、最后活动显示「?」，且底部提示还在
 * 教用户传 sessionId——拼接后的指令必然被服务端拒绝。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

interface BrowseThread {
  agentId?: string;
  agentName?: string;
  threadId?: string;
  title?: string;
  headSessionId?: string;
  status?: string | null;
  modelName?: string;
  execStatus?: string | null;
  updatedAt?: number | null;
}

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

function fmtAgo(ms: unknown): string {
  if (typeof ms !== 'number' || !ms) return '?';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return `${Math.floor(diff / 86_400_000)}天前`;
}

function execChip(status: unknown): string {
  const s = String(status ?? '');
  if (s === 'running') return '<span class="tool-chip ok">忙</span>';
  if (s === 'queued') return '<span class="tool-chip">排队中</span>';
  return '';
}

function renderThread(t: BrowseThread): string {
  let head = `<span>${escapeHtml(t.title || t.threadId || '(无标题线程)')}</span>`;
  if (t.status === 'closed') {
    head += '<span class="tool-chip">已关闭</span>';
  }
  head += execChip(t.execStatus);

  const metas: string[] = [];
  if (t.modelName) metas.push(String(t.modelName));
  metas.push(`最后活动 ${fmtAgo(t.updatedAt)}`);
  head += `<span class="tool-bg-meta">${escapeHtml(metas.join(' · '))}</span>`;

  const html = [`<div class="tool-bg-row"><div class="tool-bg-row-head">${head}</div>`];
  // threadId 单独一行：im_connect_line 直接复制它
  if (t.threadId) html.push(`<div class="tool-bg-meta">${escapeHtml(t.threadId)}</div>`);
  if (t.headSessionId) html.push(`<div class="tool-bg-meta">head 会话 ${escapeHtml(t.headSessionId)}</div>`);
  html.push('</div>');
  return html.join('');
}

export default {
  call: () => '<div class="bash-command">可连接线程</div>',
  result: (data: unknown, success?: boolean) => {
    if (!success || (data && typeof data === 'object' && 'error' in data)) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data ?? '');
      return `<div class="tool-error"><span>${escapeHtml(text)}</span></div>`;
    }
    if (data && typeof data === 'object' && Array.isArray((data as { sessions?: BrowseThread[] }).sessions)) {
      const threads = (data as { sessions?: BrowseThread[] }).sessions ?? [];
      if (threads.length === 0) {
        return '<div class="tool-result-note">当前没有可连接的线程</div>';
      }
      // 按工作空间分组（保持返回顺序）
      const groups: Array<{ key: string; label: string; items: BrowseThread[] }> = [];
      for (const t of threads) {
        const key = String(t.agentId || '');
        const label = String(t.agentName || t.agentId || '(未知工作空间)');
        let group = groups.find(g => g.key === key);
        if (!group) {
          group = { key, label, items: [] };
          groups.push(group);
        }
        group.items.push(t);
      }
      const body = groups.map(g =>
        `<div class="tool-search-file">`
        + `<div class="tool-search-path">${escapeHtml(g.label)}${g.key ? ' · ' + escapeHtml(g.key) : ''}</div>`
        + `<div class="tool-bg-tasks">${g.items.map(renderThread).join('')}</div>`
        + `</div>`,
      ).join('');
      return body
        + `<div class="tool-result-note">共 ${threads.length} 条线程 · im_connect_line 传入 lineId + agentId + threadId 接线</div>`;
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return `<div class="tool-plain-text">${escapeHtml(text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
