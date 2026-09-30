/**
 * session_read_overview / session_read_turn 渲染模板 — 会话读取
 *
 * 两个工具同性质：轮次/截断元信息 + 大段预格式文本（概览骨架 / 轮次原文）。
 * 正文用 pre-wrap 保留文本自身的结构（轮次标注、缩进、会话标识头），
 * 不伪造额外层级。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

function renderError(data: unknown): string {
  const d = data as { error?: unknown; hint?: unknown; availableTurns?: unknown } | null;
  let html = '<div class="tool-error"><span>';
  html += escapeHtml(typeof d?.error === 'object' ? JSON.stringify(d.error, null, 2) : (d?.error ?? JSON.stringify(data, null, 2)));
  html += '</span></div>';
  if (Array.isArray(d?.availableTurns) && d.availableTurns.length > 0) {
    html += `<div class="tool-result-note">可用轮次: T${d.availableTurns.join(', T')}</div>`;
  }
  if (d?.hint) {
    html += `<div class="tool-result-note">${escapeHtml(d.hint)}</div>`;
  }
  return html;
}

export default {
  call: (args: Record<string, unknown>) => {
    const agentId = String(args?.agentId ?? '');
    const sessionId = String(args?.sessionId ?? '');
    let html = `<div class="bash-command">${escapeHtml(agentId)}${sessionId ? '/' + escapeHtml(sessionId) : ''}</div>`;
    if (args?.turn !== undefined && args?.turn !== null) {
      html += `<div class="tool-bg-meta">轮次 T${escapeHtml(args.turn)}</div>`;
    }
    return html;
  },
  result: (data: unknown, success?: boolean) => {
    if (!success || (data && typeof data === 'object' && 'error' in data)) {
      return renderError(data);
    }
    const d = data as { text?: unknown; truncated?: boolean; messageCount?: number | null; turn?: number | null } | null;
    if (!d || typeof d !== 'object' || typeof d.text !== 'string') {
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      return `<div class="tool-plain-text">${escapeHtml(text)}</div>`;
    }
    let head = '';
    if (d.turn !== undefined && d.turn !== null) {
      head += `<span class="tool-chip">T${escapeHtml(d.turn)}</span>`;
    }
    if (d.truncated) {
      head += '<span class="tool-chip err">已截断</span>';
    }
    if (typeof d.messageCount === 'number') {
      head += `<span class="tool-bg-meta">${d.messageCount} 条消息</span>`;
    }
    return (head ? `<div class="tool-bg-head">${head}</div>` : '')
      + `<div class="tool-plain-text">${escapeHtml(d.text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
