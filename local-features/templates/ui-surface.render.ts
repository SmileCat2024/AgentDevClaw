/**
 * ui_surface_upsert / ui_surface_get / ui_surface_list / ui_surface_close 渲染模板
 * — 交互面板控制面操作的聊天区摘要卡
 *
 * 面板本体渲染在右侧交互页面，聊天区只做轻量回执：upsert/close 结果一行
 * 状态回执；list 为摘要行；get 因携带完整 Spec 退回 JSON 文本（长内容由
 * 宿主自动折叠）。call 侧只在 upsert 携带 Spec 时给出根组件摘要，避免整包
 * Spec JSON 摊开在调用卡里。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

interface SurfaceSummary {
  surfaceId?: string;
  title?: string | null;
  revision?: number | null;
  status?: string | null;
}

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

function renderError(data: unknown, success?: boolean): string {
  const d = data as { ok?: boolean; code?: string; message?: string; error?: unknown } | null;
  let text: string;
  if (!success) {
    text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data ?? '');
  } else if (typeof d?.error === 'string') {
    text = d.error;
  } else {
    text = [d?.code, d?.message].filter(Boolean).join(': ') || JSON.stringify(data, null, 2);
  }
  return `<div class="tool-error"><span>${escapeHtml(text)}</span></div>`;
}

function statusChip(status: unknown): string {
  const s = String(status ?? '');
  if (s === 'active') return '<span class="tool-chip ok">active</span>';
  if (s === 'closed') return '<span class="tool-chip">closed</span>';
  return s ? `<span class="tool-chip">${escapeHtml(s)}</span>` : '';
}

/** 宽容提取 Spec 概要：标题或根组件类型（缺失时返回空串，不猜结构）。 */
function specSummary(spec: unknown): string {
  if (!spec || typeof spec !== 'object') return '';
  const s = spec as Record<string, unknown>;
  const rootType = typeof s.type === 'string' ? s.type
    : (s.root && typeof s.root === 'object' && typeof (s.root as Record<string, unknown>).type === 'string')
      ? String((s.root as Record<string, unknown>).type)
      : '';
  const title = typeof s.title === 'string' ? s.title : '';
  return [rootType, title].filter(Boolean).join(' · ');
}

export default {
  call: (args: Record<string, unknown>) => {
    const surfaceId = String(args?.surfaceId ?? '');
    let html = `<div class="bash-command">${escapeHtml(surfaceId)}</div>`;
    const metas: string[] = [];
    const summary = specSummary(args?.spec);
    if (summary) metas.push(summary);
    if (typeof args?.expectedRevision === 'number') metas.push(`期望 revision ${args.expectedRevision}`);
    if (metas.length > 0) {
      html += `<div class="tool-bg-meta">${escapeHtml(metas.join(' · '))}</div>`;
    }
    return html;
  },
  result: (data: unknown, success?: boolean) => {
    if (!success || (data && typeof data === 'object' && ((data as Record<string, unknown>).ok === false || 'error' in data))) {
      return renderError(data, success);
    }
    const d = data as {
      ok?: boolean;
      surface?: { surfaceId?: string; revision?: number; status?: string; spec?: unknown; updatedAt?: string };
      surfaces?: SurfaceSummary[];
      surfaceId?: string;
      alreadyClosed?: boolean;
    } | null;

    // ui_surface_list：摘要行
    if (d && Array.isArray(d.surfaces)) {
      if (d.surfaces.length === 0) {
        return '<div class="tool-result-note">没有活跃的交互面板</div>';
      }
      const rows = d.surfaces.map(s => {
        let head = `<span>${escapeHtml(s.title || '(无标题)')}</span>`;
        head += statusChip(s.status);
        if (s.revision !== undefined && s.revision !== null) {
          head += `<span class="tool-bg-meta">rev ${escapeHtml(s.revision)}</span>`;
        }
        return `<div class="tool-bg-row"><div class="tool-bg-row-head">${head}</div>`
          + `<div class="tool-bg-meta">${escapeHtml(s.surfaceId ?? '')}</div></div>`;
      }).join('');
      return `<div class="tool-bg-tasks">${rows}</div>`
        + `<div class="tool-result-note">共 ${d.surfaces.length} 个面板</div>`;
    }

    // ui_surface_get：完整 Spec 以 JSON 文本呈现（宿主负责长内容折叠）
    if (d?.surface && d.surface.spec !== undefined && d.surface.spec !== null) {
      let head = `<span class="tool-bg-id">${escapeHtml(d.surface.surfaceId ?? '')}</span>`;
      head += statusChip(d.surface.status);
      if (d.surface.revision !== undefined) head += `<span class="tool-bg-meta">rev ${escapeHtml(d.surface.revision)}</span>`;
      return `<div class="tool-bg-head">${head}</div>`
        + `<pre class="bash-output">${escapeHtml(JSON.stringify(d.surface.spec, null, 2))}</pre>`;
    }

    // ui_surface_upsert：更新回执
    if (d?.surface) {
      let head = `<span class="tool-bg-id">${escapeHtml(d.surface.surfaceId ?? '')}</span>`;
      head += '<span class="tool-chip ok">已更新</span>';
      head += statusChip(d.surface.status);
      if (d.surface.revision !== undefined) head += `<span class="tool-bg-meta">rev ${escapeHtml(d.surface.revision)}</span>`;
      return `<div class="tool-bg-head">${head}</div>`
        + '<div class="tool-result-note">面板已投递到右侧交互页面</div>';
    }

    // ui_surface_close：关闭回执
    if (d && typeof d.surfaceId === 'string') {
      const head = `<span class="tool-bg-id">${escapeHtml(d.surfaceId)}</span>`
        + '<span class="tool-chip ok">已关闭</span>'
        + (d.alreadyClosed ? '<span class="tool-bg-meta">幂等：此前已是关闭状态</span>' : '');
      return `<div class="tool-bg-head">${head}</div>`;
    }

    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return `<div class="tool-plain-text">${escapeHtml(text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
