/**
 * export_conversation 渲染模板 — 对话导出回执
 *
 * 结果为 { success, text, path, filename, size, messageCount }：产物卡
 * （文件名 + 大小 / 消息数元信息 + 等宽路径），供用户定位导出的 HTML。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

export default {
  call: (args: Record<string, unknown>) => {
    const sessionId = String(args?.sessionId ?? '');
    let html = `<div class="bash-command">导出会话 ${escapeHtml(sessionId)}</div>`;
    const metas: string[] = [];
    if (args?.agentId) metas.push(String(args.agentId));
    if (typeof args?.lastNCalls === 'number' && args.lastNCalls > 0) metas.push(`最近 ${args.lastNCalls} 轮`);
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
    const d = data as { success?: boolean; path?: string; filename?: string; size?: number; messageCount?: number } | null;
    if (d && typeof d === 'object' && d.success === true) {
      const head = `<span class="tool-bg-id">${escapeHtml(d.filename || 'conversation.html')}</span>`
        + '<span class="tool-chip ok">已导出</span>';
      const metas: string[] = [];
      if (typeof d.size === 'number') metas.push(`${(d.size / 1024).toFixed(1)} KB`);
      if (typeof d.messageCount === 'number') metas.push(`${d.messageCount} 条消息`);
      let html = `<div class="tool-bg-head">${head}</div>`;
      if (metas.length > 0) {
        html += `<div class="tool-bg-meta">${escapeHtml(metas.join(' · '))}</div>`;
      }
      if (d.path) {
        html += `<div class="bash-output">${escapeHtml(d.path)}</div>`;
      }
      return html;
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return `<div class="tool-plain-text">${escapeHtml(text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
