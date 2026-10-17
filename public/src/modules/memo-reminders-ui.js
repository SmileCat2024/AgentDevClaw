/**
 * memo-reminders-ui.js — memo APP 首页的提醒列表 block（只读列表 + 完成勾选 + 删除）
 *
 * 心智：
 * - 提醒是 APP 级资产（workspaces/memo/reminders.json，线程零绑定），本 block
 *   是它的只读呈现与管理面：勾选 = 完成（不再触发，条目保留），✕ = 删除；
 *   登记入口只在对话内（自然语言），首页不做表单（工单 039 裁决）。
 * - render() 是纯投影：缓存先显（零闪烁），后台重取后 repaint（SWR）。
 *   完成与删除走乐观更新（先改缓存再请求），失败 toast 并回取真实数据。
 * - 刷新时机与便签墙一致：「回首页重渲染」与「窗口重新聚焦」各拉一次，
 *   不做常驻轮询（到点提醒的实时触达走 038 的 app-notification SSE 通道，
 *   不经本 block）。
 *
 * 数据面：/protoclaw/memo-app/reminders（GET 列表 / POST complete、delete），
 * server 侧 memo-app.js 持有，与 runtime 侧 memo-reminders 工具面同域。
 *
 * 依赖全局（运行时调用，加载顺序无关）：
 *   - escapeHtml, currentLanguage (app-core.js)
 *   - ClawToast (modules/toast-notify.js)
 */

window.MemoRemindersUI = (() => {
  let cache = []; // 最近一次成功拉取的提醒条目
  let loaded = false; // 区分「加载中」与「空态」
  let fetchSeq = 0; // 过期响应丢弃
  let actionSeq = 0; // 过期动作响应丢弃

  function isZh() {
    return typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  }

  function esc(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function toastError(id, title, desc) {
    if (typeof ClawToast !== 'undefined') {
      ClawToast.show({ id, status: 'error', title, desc: String(desc || '') });
    }
  }

  async function fetchReminders() {
    const seq = ++fetchSeq;
    try {
      const resp = await fetch('/protoclaw/memo-app/reminders');
      const data = await resp.json().catch(() => null);
      if (seq !== fetchSeq) return;
      cache = Array.isArray(data?.reminders) ? data.reminders : [];
      loaded = true;
      paint();
    } catch {
      /* 拉取失败：保留旧内容，下次渲染 / 聚焦再试 */
    }
  }

  function fmtFireAt(entry) {
    const date = new Date(entry.fire_at);
    if (!Number.isFinite(date.getTime())) return entry.fire_at || '';
    const opts = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
    if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return date.toLocaleString(isZh() ? 'zh-CN' : 'en-US', opts);
  }

  const ZH_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function recurrenceLabel(entry) {
    switch (entry.recurrence) {
      case 'daily':
        return isZh() ? '每天' : 'Daily';
      case 'weekly': {
        const days = Array.isArray(entry.weekdays) ? entry.weekdays : [];
        return isZh()
          ? '每周' + days.map((d) => '周' + (ZH_WEEKDAYS[d] || d)).join('')
          : 'Weekly ' + days.map((d) => EN_WEEKDAYS[d] || d).join(', ');
      }
      case 'monthly': {
        const date = new Date(entry.fire_at);
        const day = Number.isFinite(date.getTime()) ? date.getDate() : '';
        return isZh() ? `每月 ${day} 日` : `Monthly on day ${day}`;
      }
      default:
        return isZh() ? '单次' : 'Once';
    }
  }

  function deliveryLabel(entry) {
    return entry.delivery === 'agent'
      ? (isZh() ? '唤醒' : 'Agent')
      : (isZh() ? '直弹' : 'Direct');
  }

  function metaHtml(entry) {
    const parts = [`<span>${esc(fmtFireAt(entry))}</span>`, `<span>${esc(recurrenceLabel(entry))}</span>`,
      `<span>${esc(deliveryLabel(entry))}</span>`];
    if (entry.status !== 'fired') {
      const fireMs = new Date(entry.fire_at).getTime();
      if (Number.isFinite(fireMs) && fireMs < Date.now()) {
        parts.push(`<span class="memo-reminder-overdue">${esc(isZh() ? '已过期' : 'Overdue')}</span>`);
      }
    }
    return parts.join('<span class="memo-reminder-dot">·</span>');
  }

  function itemHtml(entry) {
    if (!entry || !entry.id) return '';
    const fired = entry.status === 'fired';
    return '<li class="memo-reminder-item' + (fired ? ' is-fired' : '') + '">'
      + '<input type="checkbox" class="memo-reminder-check" title="'
      + esc(isZh() ? '标记完成' : 'Mark done') + '"'
      + (fired ? ' checked' : '')
      + ' onclick="MemoRemindersUI.complete(\'' + esc(entry.id) + '\')">'
      + '<div class="memo-reminder-main">'
      + '<div class="memo-reminder-content">' + esc(entry.content || '') + '</div>'
      + '<div class="memo-reminder-meta">' + metaHtml(entry) + '</div>'
      + '</div>'
      + '<button type="button" class="memo-reminder-delete" title="'
      + esc(isZh() ? '删除' : 'Delete') + '"'
      + ' onclick="MemoRemindersUI.remove(\'' + esc(entry.id) + '\')">✕</button>'
      + '</li>';
  }

  function bodyHtml() {
    if (!loaded) {
      return '<div class="memo-notes-state"><span class="chat-loading-spinner"></span></div>';
    }
    if (cache.length === 0) {
      return '<div class="memo-notes-state">'
        + esc(isZh()
          ? '还没有提醒。在对话里说一句，比如「明天 9 点提醒我开会」。'
          : 'No reminders yet. Tell Memo in chat, e.g. "Remind me tomorrow at 9".')
        + '</div>';
    }
    // 未触发的在前，已完成的沉底
    const scheduled = cache.filter((entry) => entry && entry.status !== 'fired');
    const fired = cache.filter((entry) => entry && entry.status === 'fired');
    return '<ul class="memo-reminder-list">'
      + scheduled.map(itemHtml).join('')
      + fired.map(itemHtml).join('')
      + '</ul>';
  }

  function sectionInnerHtml() {
    const countSuffix = loaded && cache.length > 0
      ? `<span class="workspace-section-count">${cache.length}</span>` : '';
    return '<div class="workspace-section-header"><div>'
      + '<div class="workspace-section-title">' + esc(isZh() ? '提醒' : 'Reminders') + countSuffix + '</div>'
      + '</div></div>'
      + bodyHtml();
  }

  function paint() {
    const host = document.getElementById('memo-reminders-panel');
    if (host) host.innerHTML = sectionInnerHtml();
  }

  function render() {
    fetchReminders(); // SWR：缓存先显，后台重取后重绘
    return '<section class="workspace-section memo-reminders-panel" id="memo-reminders-panel">'
      + sectionInnerHtml()
      + '</section>';
  }

  /** 完成勾选（乐观置 fired；失败 toast 并回取真实数据）。 */
  async function complete(id) {
    const entry = cache.find((item) => item && item.id === id);
    if (!entry || entry.status === 'fired') return;
    entry.status = 'fired';
    paint();
    const seq = ++actionSeq;
    try {
      const resp = await fetch('/protoclaw/memo-app/reminders/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await resp.json().catch(() => null);
      if (seq !== actionSeq) return;
      if (!resp.ok || !data?.ok) throw new Error((data && data.error) || 'HTTP ' + resp.status);
    } catch (err) {
      toastError('memo-reminder-complete', isZh() ? '提醒操作失败' : 'Failed to update reminder', err?.message || err);
      fetchReminders();
    }
  }

  /** 删除（乐观移除；失败 toast 并回取真实数据）。 */
  async function remove(id) {
    const before = cache;
    cache = cache.filter((item) => item && item.id !== id);
    paint();
    const seq = ++actionSeq;
    try {
      const resp = await fetch('/protoclaw/memo-app/reminders/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await resp.json().catch(() => null);
      if (seq !== actionSeq) return;
      if (!resp.ok || !data?.ok) throw new Error((data && data.error) || 'HTTP ' + resp.status);
    } catch (err) {
      cache = before;
      toastError('memo-reminder-delete', isZh() ? '提醒删除失败' : 'Failed to delete reminder', err?.message || err);
      paint();
    }
  }

  // 窗口重新聚焦时刷新一次（对话内登记 / 完成后的兜底；回首页重渲染走 render()）。
  window.addEventListener('focus', () => {
    if (document.getElementById('memo-reminders-panel')) fetchReminders();
  });

  return { render, complete, remove };
})();
