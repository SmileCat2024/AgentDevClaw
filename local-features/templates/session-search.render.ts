import type { InlineRenderTemplate } from '@agentdevjs/core';

function escapeHtml(value: unknown): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (char) => map[char]!);
}

export default {
  call: (args: Record<string, unknown>) =>
    `<div class="bash-command">历史对话搜索：${escapeHtml(args?.query || '')}</div>`,
  result: (data: unknown, success?: boolean) => {
    if (!success || (data && typeof data === 'object' && 'error' in data)) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data ?? '');
      return `<div class="tool-error"><span>${escapeHtml(text)}</span></div>`;
    }
    const result = data as { results?: Array<{ threadId?: string; title?: string; agentId?: string; matches?: Array<{ role?: string; kind?: string; snippet?: string; source?: Record<string, unknown> }> }>; total?: number; limitCapped?: boolean; maxResults?: number };
    const cap = result?.limitCapped ? `；单次最多展示 ${result.maxResults ?? 50} 个线程` : '';
    if (!Array.isArray(result?.results) || result.results.length === 0) {
      return `<div class="tool-result-note">没有匹配的历史对话${cap}</div>`;
    }
    const groups = result.results.map((group) => {
      const heading = `${group.threadId || '(非线程会话)'}${group.title ? `「${group.title}」` : ''} — ${group.agentId || ''}`;
      const matches = (group.matches || []).map((match) => {
        const source = match.source || {};
        const address = `${source.agentId || ''}/${source.sessionId || ''} T${source.turn ?? '?'} 消息 ${source.messageIndex ?? '?'}`;
        return `<div class="tool-bg-row"><div class="tool-bg-row-head"><span class="tool-chip">${escapeHtml(match.role || '')}${match.kind ? `/${escapeHtml(match.kind)}` : ''}</span><span>${escapeHtml(match.snippet || '')}</span></div><div class="tool-bg-meta">来源: ${escapeHtml(address)}</div></div>`;
      }).join('');
      return `<div class="tool-bg-row"><div class="tool-bg-row-head">${escapeHtml(heading)}</div>${matches}</div>`;
    }).join('');
    return `<div class="tool-bg-tasks">${groups}</div><div class="tool-result-note">命中 ${result.total ?? result.results.length} 个线程${cap}</div>`;
  },
} as const satisfies InlineRenderTemplate;
