import type { InlineRenderTemplate } from '@agentdevjs/core';

function escapeHtml(value: unknown): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (char) => map[char]!);
}

export default {
  call: (args: Record<string, unknown>) =>
    `<div class="bash-command">线程连续对话 ${escapeHtml(args?.threadId || '')}</div>`,
  result: (data: unknown, success?: boolean) => {
    if (!success || (data && typeof data === 'object' && 'error' in data)) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data ?? '');
      return `<div class="tool-error"><span>${escapeHtml(text)}</span></div>`;
    }
    if (data && typeof data === 'object' && typeof (data as { text?: unknown }).text === 'string') {
      const result = data as { text: string; omittedEvents?: number; eventCount?: number };
      const note = result.omittedEvents
        ? `<div class="tool-result-note">为控制篇幅省略 ${escapeHtml(result.omittedEvents)} / ${escapeHtml(result.eventCount ?? '?')} 条事件；可按地址用 session_read_turn 回读。</div>`
        : '';
      return `${note}<div class="tool-plain-text">${escapeHtml(result.text)}</div>`;
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return `<div class="tool-plain-text">${escapeHtml(text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
