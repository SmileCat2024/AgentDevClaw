/**
 * im_browse 渲染模板 — 可连接的工作空间会话
 *
 * 结果为 { text, sessions[] }（扁平会话列表，携带 agentId/agentName 分组键）。
 * 按工作空间分组（grep 文件分组同款布局），行内展示会话标题、执行状态、
 * 模型 / 上下文 / 消息数 / 最后活动，sessionId 单独一行便于接线时复制。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

interface BrowseSession {
  agentId?: string;
  agentName?: string;
  sessionId?: string;
  sessionTitle?: string;
  modelName?: string;
  contextUsagePct?: number | null;
  compressRatio?: number | null;
  messageCount?: number | null;
  sessionType?: string | null;
  execStatus?: string | null;
  execQueueLength?: number | null;
  workdir?: string | null;
  savedAt?: number | null;
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

function renderSession(s: BrowseSession): string {
  let head = `<span>${escapeHtml(s.sessionTitle || '(无标题会话)')}</span>`;
  if (s.sessionType && s.sessionType !== 'main') {
    head += `<span class="tool-chip">${escapeHtml(s.sessionType)}</span>`;
  }
  head += execChip(s.execStatus);

  const metas: string[] = [];
  if (s.modelName) metas.push(String(s.modelName));
  if (typeof s.contextUsagePct === 'number') metas.push(`上下文 ${s.contextUsagePct}%`);
  if (typeof s.messageCount === 'number') metas.push(`${s.messageCount} 条`);
  if (typeof s.execQueueLength === 'number' && s.execQueueLength > 0) metas.push(`队列 ${s.execQueueLength}`);
  metas.push(`最后活动 ${fmtAgo(s.savedAt)}`);
  head += `<span class="tool-bg-meta">${escapeHtml(metas.join(' · '))}</span>`;

  const html = [`<div class="tool-bg-row"><div class="tool-bg-row-head">${head}</div>`];
  if (s.sessionId) html.push(`<div class="tool-bg-meta">${escapeHtml(s.sessionId)}</div>`);
  if (s.workdir) html.push(`<div class="tool-bg-meta">${escapeHtml(s.workdir)}</div>`);
  if (typeof s.contextUsagePct === 'number' && typeof s.compressRatio === 'number'
    && s.contextUsagePct >= s.compressRatio) {
    html.push(`<div class="tool-result-note tool-result-warning">上下文 ${s.contextUsagePct}% 已达压缩阈值 ${s.compressRatio}%</div>`);
  }
  html.push('</div>');
  return html.join('');
}

export default {
  call: () => '<div class="bash-command">可连接会话</div>',
  result: (data: unknown, success?: boolean) => {
    if (!success || (data && typeof data === 'object' && 'error' in data)) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data ?? '');
      return `<div class="tool-error"><span>${escapeHtml(text)}</span></div>`;
    }
    if (data && typeof data === 'object' && Array.isArray((data as { sessions?: BrowseSession[] }).sessions)) {
      const sessions = (data as { sessions?: BrowseSession[] }).sessions ?? [];
      if (sessions.length === 0) {
        return '<div class="tool-result-note">当前没有在线的工作空间会话</div>';
      }
      // 按工作空间分组（保持返回顺序）
      const groups: Array<{ key: string; label: string; items: BrowseSession[] }> = [];
      for (const s of sessions) {
        const key = String(s.agentId || '');
        const label = String(s.agentName || s.agentId || '(未知工作空间)');
        let group = groups.find(g => g.key === key);
        if (!group) {
          group = { key, label, items: [] };
          groups.push(group);
        }
        group.items.push(s);
      }
      const body = groups.map(g =>
        `<div class="tool-search-file">`
        + `<div class="tool-search-path">${escapeHtml(g.label)}${g.key ? ' · ' + escapeHtml(g.key) : ''}</div>`
        + `<div class="tool-bg-tasks">${g.items.map(renderSession).join('')}</div>`
        + `</div>`,
      ).join('');
      return body + `<div class="tool-result-note">共 ${sessions.length} 个会话 · im_connect_line 传入 lineId + agentId + sessionId 接线</div>`;
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return `<div class="tool-plain-text">${escapeHtml(text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
