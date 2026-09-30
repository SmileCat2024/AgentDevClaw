/**
 * session_list 渲染模板 — 可参考的历史会话目录
 *
 * 结果为 { text, total, sessions[] } 结构化数据（text 为 LLM 通道的紧凑文本，
 * 模板忽略 text 直接渲染结构化行）；无 sessions 字段的历史/异常结果走文本回退。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

interface SessionEntry {
  agentId?: string;
  sessionId?: string;
  title?: string;
  openDirectory?: string;
  updatedAt?: string;
  messageCount?: number | null;
  sessionType?: string | null;
  preview?: string | null;
  archived?: boolean;
}

interface SessionListResult {
  sessions?: SessionEntry[];
  total?: number;
}

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

function renderRow(s: SessionEntry): string {
  const title = String(s.title || '(无标题)');
  const metas: string[] = [];
  if (s.agentId) metas.push(String(s.agentId));
  if (typeof s.messageCount === 'number') metas.push(`${s.messageCount} 条`);
  if (s.updatedAt) metas.push(String(s.updatedAt));

  let head = `<span>${escapeHtml(title)}</span>`;
  const sessionType = String(s.sessionType || 'main');
  if (sessionType && sessionType !== 'main') {
    head += `<span class="tool-chip">${escapeHtml(sessionType)}</span>`;
  }
  if (s.archived) {
    head += '<span class="tool-chip">已归档</span>';
  }
  head += metas.map(m => `<span class="tool-bg-meta">${escapeHtml(m)}</span>`).join('');

  let html = `<div class="tool-bg-row"><div class="tool-bg-row-head">${head}</div>`;
  if (s.sessionId) {
    html += `<div class="tool-bg-meta">${escapeHtml(s.sessionId)}</div>`;
  }
  if (s.preview) {
    html += `<div class="tool-bg-meta">摘要: ${escapeHtml(s.preview)}</div>`;
  }
  if (s.openDirectory) {
    html += `<div class="tool-bg-meta">${escapeHtml(s.openDirectory)}</div>`;
  }
  return html + '</div>';
}

export default {
  call: (args: Record<string, unknown>) => {
    let html = '<div class="bash-command">会话目录</div>';
    const metas: string[] = [];
    if (typeof args?.limit === 'number' && args.limit > 0) metas.push(`最近 ${args.limit} 条`);
    if (args?.includeArchived === true) metas.push('含已归档');
    if (metas.length > 0) {
      html += `<div class="tool-bg-meta">${escapeHtml(metas.join(' · '))}</div>`;
    }
    return html;
  },
  result: (data: unknown, success?: boolean) => {
    if (!success || (data && typeof data === 'object' && 'error' in data)) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data ?? '');
      return `<div class="tool-error"><span>${escapeHtml(text)}</span></div>`;
    }
    if (data && typeof data === 'object' && Array.isArray((data as SessionListResult).sessions)) {
      const d = data as SessionListResult;
      if (d.sessions.length === 0) {
        return '<div class="tool-result-note">没有可参考的会话</div>';
      }
      return `<div class="tool-bg-tasks">${d.sessions.map(renderRow).join('')}</div>`
        + `<div class="tool-result-note">共 ${d.total ?? d.sessions.length} 个会话（按更新时间倒序）</div>`;
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return `<div class="tool-plain-text">${escapeHtml(text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
