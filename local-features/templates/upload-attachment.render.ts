/**
 * upload_attachment 渲染模板 — IM 附件上传
 *
 * 统一覆盖注册的工具委托给当前活跃渠道执行，返回形态随渠道略有差异
 * （QQ 渠道为 { text, uploaded, type, fileName, pendingCount }）。模板做
 * 宽容渲染：成功回执一行 + 队列元信息，未知形态走文本回退。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

export default {
  call: (args: Record<string, unknown>) => {
    const path = String(args?.path ?? '');
    let html = `<div class="bash-command">${escapeHtml(path)}</div>`;
    if (args?.filename) {
      html += `<div class="tool-bg-meta">${escapeHtml(args.filename)}</div>`;
    }
    return html;
  },
  result: (data: unknown, success?: boolean) => {
    if (!success || (data && typeof data === 'object' && 'error' in data)) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data ?? '');
      return `<div class="tool-error"><span>${escapeHtml(text)}</span></div>`;
    }
    const d = data as { uploaded?: boolean; type?: string; fileName?: string; pendingCount?: number; text?: string } | null;
    if (d && typeof d === 'object' && d.uploaded === true) {
      const metas: string[] = [];
      if (d.type) metas.push(String(d.type));
      if (d.fileName) metas.push(String(d.fileName));
      if (typeof d.pendingCount === 'number') metas.push(`待发送 ${d.pendingCount} 项`);
      return `<div class="tool-bg-head"><span class="tool-chip ok">已上传</span>`
        + `<span class="tool-bg-meta">${escapeHtml(metas.join(' · '))}</span></div>`
        + '<div class="tool-result-note">附件将在本轮回复结束后自动发送</div>';
    }
    const text = typeof data === 'string' ? data : (d?.text ?? JSON.stringify(data, null, 2));
    return `<div class="tool-plain-text">${escapeHtml(text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
