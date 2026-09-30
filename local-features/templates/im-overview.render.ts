/**
 * im_overview 渲染模板 — IM 线路状态总览
 *
 * 结果为 { text, lines[] }（text 为 LLM 通道文本，模板渲染结构化行）：
 * 每条线路一行——线路名 + 载体 chip + 连接状态 chip，绑定会话时附
 * 模型 / 上下文 / 最后活动元信息；上下文达压缩阈值以 err chip 提示。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

interface BoundSession {
  sessionId?: string;
  agentId?: string;
  sessionTitle?: string;
  modelName?: string;
  contextTokens?: number | null;
  contextLength?: number | null;
  contextUsagePct?: number | null;
  compressRatio?: number | null;
  execStatus?: string | null;
  savedAt?: number | null;
  workdir?: string | null;
}

interface IMLine {
  id?: string;
  name?: string;
  carrier?: string | null;
  boundSession?: BoundSession | null;
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

function renderRow(line: IMLine): string {
  let head = `<span>${escapeHtml(line.name || line.id || '(未命名线路)')}</span>`;
  if (line.carrier) head += `<span class="tool-chip">${escapeHtml(line.carrier)}</span>`;
  const bound = line.boundSession;
  head += bound ? '<span class="tool-chip ok">已连接</span>' : '<span class="tool-chip">空闲</span>';

  const html: string[] = [`<div class="tool-bg-row"><div class="tool-bg-row-head">${head}</div>`];
  if (bound) {
    const metas: string[] = [];
    if (bound.sessionTitle) metas.push(String(bound.sessionTitle));
    if (bound.agentId) metas.push(String(bound.agentId));
    if (metas.length > 0) html.push(`<div class="tool-bg-meta">${escapeHtml(metas.join(' · '))}</div>`);

    const ctxMetas: string[] = [];
    if (bound.modelName) ctxMetas.push(String(bound.modelName));
    if (typeof bound.contextUsagePct === 'number') {
      const detail = typeof bound.contextTokens === 'number' && typeof bound.contextLength === 'number'
        ? ` (${bound.contextTokens.toLocaleString()}/${bound.contextLength.toLocaleString()})`
        : '';
      ctxMetas.push(`上下文 ${bound.contextUsagePct}%${detail}`);
    }
    ctxMetas.push(`最后活动 ${fmtAgo(bound.savedAt)}`);
    html.push(`<div class="tool-bg-row-head">${execChip(bound.execStatus)}<span class="tool-bg-meta">${escapeHtml(ctxMetas.join(' · '))}</span></div>`);

    if (typeof bound.contextUsagePct === 'number' && typeof bound.compressRatio === 'number'
      && bound.contextUsagePct >= bound.compressRatio) {
      html.push(`<div class="tool-result-note tool-result-warning">上下文 ${bound.contextUsagePct}% 已达压缩阈值 ${bound.compressRatio}%</div>`);
    }
    if (bound.workdir) html.push(`<div class="tool-bg-meta">${escapeHtml(bound.workdir)}</div>`);
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
