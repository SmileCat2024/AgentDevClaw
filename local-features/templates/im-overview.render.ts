/**
 * im_overview 渲染模板 — IM 线路状态总览
 *
 * 结果为 { text, lines[] }，lines 来自 /protoclaw/im_routable_targets 的线路投影：
 *   { id, name, carrier, boundThread: { agentId, threadId, threadTitle, status, updatedAt } }
 *
 * ADR-0042 决策 1 后线路绑定的是线程，不是会话——投影字段是 boundThread。
 * 模板此前仍读旧字段 boundSession，导致已连接的线路恒定显示「空闲」，且
 * 完全看不到绑到了哪条线程。运行时的模型 / 上下文 / 忙碌状态不在线路投影
 * 里，属于 im_browse 的线程清单，这里不重复渲染。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

interface BoundThread {
  agentId?: string;
  threadId?: string;
  threadTitle?: string;
  status?: string | null;
  updatedAt?: number | null;
}

interface IMLine {
  id?: string;
  name?: string;
  carrier?: string | null;
  boundThread?: BoundThread | null;
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

function renderRow(line: IMLine): string {
  let head = `<span>${escapeHtml(line.name || line.id || '(未命名线路)')}</span>`;
  if (line.carrier) head += `<span class="tool-chip">${escapeHtml(line.carrier)}</span>`;
  const bound = line.boundThread;
  // 绑定事实按 boundThread 判定：只有存在 threadId 才算已连接
  const isConnected = !!(bound && bound.threadId);
  head += isConnected
    ? '<span class="tool-chip ok">已连接</span>'
    : '<span class="tool-chip">空闲</span>';

  const html: string[] = [`<div class="tool-bg-row"><div class="tool-bg-row-head">${head}</div>`];
  if (isConnected && bound) {
    const title = bound.threadTitle || bound.threadId;
    const metas: string[] = [String(title)];
    if (bound.agentId) metas.push(String(bound.agentId));
    html.push(`<div class="tool-bg-meta">${escapeHtml(metas.join(' · '))}</div>`);

    const tail: string[] = [];
    tail.push(`线程状态 ${bound.status === 'closed' ? '已关闭' : '进行中'}`);
    tail.push(`最后活动 ${fmtAgo(bound.updatedAt)}`);
    html.push(`<div class="tool-bg-row-head"><span class="tool-bg-meta">${escapeHtml(tail.join(' · '))}</span></div>`);

    // threadId 单独一行，便于 im_connect_line 复用
    html.push(`<div class="tool-bg-meta">${escapeHtml(bound.threadId)}</div>`);
  }
  html.push('</div>');
  return html.join('');
}

export default {
  call: () => '<div class="bash-command">IM 线路状态</div>',
  result: (data: unknown, success?: boolean) => {
    if (!success || (data && typeof data === 'object' && 'error' in data)) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data ?? '');
      return `<div class="tool-error"><span>${escapeHtml(text)}</span></div>`;
    }
    if (data && typeof data === 'object' && Array.isArray((data as { lines?: IMLine[] }).lines)) {
      const lines = (data as { lines: IMLine[] }).lines;
      if (lines.length === 0) {
        return '<div class="tool-result-note">当前没有配置任何 IM 线路</div>';
      }
      return `<div class="tool-bg-tasks">${lines.map(renderRow).join('')}</div>`;
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return `<div class="tool-plain-text">${escapeHtml(text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
