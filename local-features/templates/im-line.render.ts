/**
 * im_connect_line / im_disconnect_line 渲染模板 — IM 线路接线操作
 *
 * call 卡展示接线意图（lineId → agentId → threadId）；结果为 { text, success }
 * 回执，状态 chip + 首行文案（操作时间戳行是给人看时间轴的冗余，聊天卡不重复）。
 *
 * ADR-0042 决策 1：接线目标是线程，(agentId, threadId) 成对寻址。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

/** 去掉 text 中的「（操作时间: …）」时间戳行，其余保持原文。 */
function stripTimestampLines(text: string): string {
  return text.split('\n').filter(line => !line.trim().startsWith('（操作时间')).join('\n').trim();
}

export default {
  call: (args: Record<string, unknown>) => {
    const lineId = String(args?.lineId ?? '');
    // 接线目标按线程寻址（agentId + threadId）。旧模板判 args.sessionId，
    // 而 im_connect_line 的参数早已换成 threadId——调用卡只显示 lineId，
    // 用户看不出这条线路要绑到哪条线程。
    let html: string;
    const threadId = String(args?.threadId ?? args?.sessionId ?? '');
    if (args?.agentId || threadId) {
      const target = [String(args?.agentId ?? ''), threadId].filter(Boolean).join(' → ');
      html = `<div class="bash-command">${escapeHtml(lineId)} → ${escapeHtml(target)}</div>`;
    } else {
      html = `<div class="bash-command">${escapeHtml(lineId)}</div>`;
    }
    return html;
  },
  result: (data: unknown, success?: boolean) => {
    if (!success || (data && typeof data === 'object' && 'error' in data)) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data ?? '');
      return `<div class="tool-error"><span>${escapeHtml(text)}</span></div>`;
    }
    const d = data as { text?: unknown; success?: boolean } | null;
    if (d && typeof d === 'object' && typeof d.text === 'string') {
      const isConnect = d.text.includes('已连接');
      const chip = isConnect
        ? '<span class="tool-chip ok">已连接</span>'
        : '<span class="tool-chip ok">已断开</span>';
      return `<div class="tool-bg-head">${chip}</div>`
        + `<div class="tool-plain-text">${escapeHtml(stripTimestampLines(d.text))}</div>`;
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return `<div class="tool-plain-text">${escapeHtml(text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
