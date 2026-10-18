/**
 * memo-reminders-ui.js — memo「提醒」子页面的时间分组列表（完成勾选 + 删除）
 *
 * 心智：
 * - 提醒是 APP 级资产（workspaces/memo/reminders.json，线程零绑定），本 block
 *   是它的只读呈现与管理面：勾选 = 完成（不再触发，条目保留），✕ = 删除；
 *   登记入口只在对话内（自然语言），分页不做表单（工单 039 裁决）。
 * - 时间分组（已过期 / 今天 / 明天 / 更晚 / 已完成沉底）按本地日历日判定，
 *   组内按 fire_at 升序；相对时间徽标（"40 分钟后""已过期 2 天"）由
 *   fmtRelativeBadge 计算——呈现域公共纯函数，总览 block 复用同口径。
 * - render() 是纯投影：缓存先显（零闪烁），后台重取后 repaint（SWR）。
 *   完成与删除走乐观更新（先改缓存再请求），失败 toast 并回取真实数据。
 *   相对时间按渲染时刻计算，不做常驻定时刷新（刷新时机见下）。
 * - 刷新时机：进入分页的导航事件（app-ui.js 的 refreshVisibleWorkspacePanelData）
 *   与「窗口重新聚焦」各拉一次，不做常驻轮询（到点提醒的实时触达走 038 的
 *   app-notification SSE 通道，不经本 block）；render 仅冷启动无缓存时
 *   幂等兜底一次（im-ui ensure 先例），此后纯投影。
 *
 * 数据面：/protoclaw/memo-app/reminders（GET 列表 / POST complete、delete），
 * server 侧 memo-app.js 持有，与 runtime 侧 memo-reminders 工具面同域。
 *
 * 依赖全局（运行时调用，加载顺序无关）：
 *   - escapeHtml, currentLanguage (app-core.js)
 *   - ClawToast (modules/toast-notify.js)
 * 消费方：
 *   app-ui.js renderWorkspaceBlock（block.type === 'memo-reminders'）
 *   memo-overview-ui.js（fmtRelativeBadge）
 */

window.MemoRemindersUI = (() => {
  let cache = []; // 最近一次成功拉取的提醒条目
  let loaded = false; // 区分「加载中」与「空态」
  let fetchSeq = 0; // 过期响应丢弃
  let fetchInFlight = false; // 在途去重：导航重取与渲染兜底并发时只发一次
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
    if (fetchInFlight) return;
    fetchInFlight = true;
    const seq = ++fetchSeq;
    try {
      const resp = await fetch('/protoclaw/memo-app/reminders');
      const data = await resp.json().catch(() => null);
      if (seq !== fetchSeq) return;
      cache = Array.isArray(data?.reminders) ? data.reminders : [];
      loaded = true;
      paint();
    } catch {
      /* 拉取失败：保留旧内容，下次导航 / 聚焦再试 */
    } finally {
      if (seq === fetchSeq) fetchInFlight = false;
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

  // ── 相对时间徽标与时间分组（呈现域公共纯函数，总览 block 复用同口径）──

  const DAY_MS = 24 * 60 * 60 * 1000;

  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** 人类时长：≥24h 取天，≥1h 取小时，否则取分钟（向下取整，下限 1）。 */
  function humanSpan(ms, zh) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) {
      const n = Math.max(minutes, 1);
      return zh ? (n + ' 分钟') : (n + ' min');
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return zh ? (hours + ' 小时') : (hours + ' h');
    }
    const days = Math.max(Math.floor(hours / 24), 1);
    return zh ? (days + ' 天') : (days + 'd');
  }

  /**
   * 相对时间徽标：已过期 / 即将到来；远期退化为日历表述（明天 HH:mm、
   * 周X HH:mm、MM-DD HH:mm），比「N 天后」更可行动。
   * 返回 { text, overdue }；fire_at 不可解析时 text 为空串。
   */
  function fmtRelativeBadge(entry, nowMs = Date.now()) {
    const t = new Date(entry?.fire_at).getTime();
    if (!Number.isFinite(t)) return { text: '', overdue: false };
    const zh = isZh();
    const diff = t - nowMs;
    if (diff < 0) {
      const span = humanSpan(nowMs - t, zh);
      return { text: zh ? ('已过期 ' + span) : (span + ' overdue'), overdue: true };
    }
    const dayDiff = Math.round((startOfDay(t) - startOfDay(nowMs)) / DAY_MS);
    const date = new Date(t);
    const clock = date.toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
    if (dayDiff === 0) {
      const span = humanSpan(diff, zh);
      return { text: zh ? (span + '后') : ('in ' + span), overdue: false };
    }
    if (dayDiff === 1) return { text: (zh ? '明天 ' : 'Tomorrow ') + clock, overdue: false };
    if (dayDiff < 7) {
      const wd = zh ? ('周' + ZH_WEEKDAYS[date.getDay()]) : EN_WEEKDAYS[date.getDay()];
      return { text: wd + ' ' + clock, overdue: false };
    }
    const opts = { month: '2-digit', day: '2-digit' };
    if (date.getFullYear() !== new Date(nowMs).getFullYear()) opts.year = 'numeric';
    return { text: date.toLocaleDateString(zh ? 'zh-CN' : 'en-US', opts) + ' ' + clock, overdue: false };
  }

  /** 时间分组：已过期 / 今天 / 明天 / 更晚 / 已完成（fire_at 不可解析归「更晚」）。 */
  function groupOf(entry, nowMs = Date.now()) {
    if (entry?.status === 'fired') return 'done';
    const t = new Date(entry?.fire_at).getTime();
    if (!Number.isFinite(t)) return 'later';
    if (t < nowMs) return 'overdue';
    const dayDiff = Math.round((startOfDay(t) - startOfDay(nowMs)) / DAY_MS);
    if (dayDiff === 0) return 'today';
    if (dayDiff === 1) return 'tomorrow';
    return 'later';
  }

  function groupLabel(group) {
    const zh = isZh();
    switch (group) {
      case 'overdue': return zh ? '已过期' : 'Overdue';
      case 'today': return zh ? '今天' : 'Today';
      case 'tomorrow': return zh ? '明天' : 'Tomorrow';
      case 'done': return zh ? '已完成' : 'Done';
      default: return zh ? '更晚' : 'Later';
    }
  }

  function metaHtml(entry) {
    const texts = [
      '<span>' + esc(fmtFireAt(entry)) + '</span>',
      '<span>' + esc(recurrenceLabel(entry)) + '</span>',
      '<span>' + esc(deliveryLabel(entry)) + '</span>',
    ];
    const joined = texts.join('<span class="memo-reminder-dot">·</span>');
    // 相对时间徽标只给未完成条目（完成条目的 fire_at 是历史时刻，无紧迫语义）
    if (entry.status === 'fired') return joined;
    const badge = fmtRelativeBadge(entry);
    if (!badge.text) return joined;
    return '<span class="memo-reminder-chip' + (badge.overdue ? ' is-overdue' : '') + '">'
      + esc(badge.text) + '</span>' + joined;
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
    // 时间分组（已过期 / 今天 / 明天 / 更晚 / 已完成沉底），组内按 fire_at 升序
    const now = Date.now();
    const sorted = [...cache].filter(Boolean).sort((a, b) => {
      const ta = new Date(a.fire_at).getTime();
      const tb = new Date(b.fire_at).getTime();
      if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
      if (!Number.isFinite(ta)) return 1;
      if (!Number.isFinite(tb)) return -1;
      return ta - tb;
    });
    const groups = { overdue: [], today: [], tomorrow: [], later: [], done: [] };
    for (const entry of sorted) {
      const group = groupOf(entry, now);
      (groups[group] || groups.later).push(entry);
    }
    let html = '';
    for (const key of ['overdue', 'today', 'tomorrow', 'later', 'done']) {
      if (groups[key].length === 0) continue;
      html += '<div class="memo-reminder-group' + (key === 'overdue' ? ' is-overdue' : '') + '">'
        + '<div class="memo-reminder-group-title">' + esc(groupLabel(key))
        + '<span class="memo-reminder-group-count">' + groups[key].length + '</span></div>'
        + '<ul class="memo-reminder-list">' + groups[key].map(itemHtml).join('') + '</ul>'
        + '</div>';
    }
    return html;
  }

  function sectionInnerHtml() {
    const countSuffix = loaded && cache.length > 0 ? `（${cache.length}）` : '';
    // 子页面顶栏：返回总览（导航反转后分页栏不再存在）+ 页标题
    return '<div class="memo-subpage-head">'
      + '<button class="memo-back-link" type="button" data-workspace-action="'
      + esc(JSON.stringify({ type: 'show_home' }))
      + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">'
      + esc(isZh() ? '← 总览' : '← Overview') + '</button>'
      + '<div class="memo-subpage-title">' + esc(isZh() ? '提醒事项' : 'Reminders') + esc(countSuffix) + '</div>'
      + '</div>'
      + bodyHtml();
  }

  function paint() {
    const host = document.getElementById('memo-reminders-panel');
    if (host) host.innerHTML = sectionInnerHtml();
  }

  /** 后台重取（导航进入分页 / 窗口聚焦触发；数据加载不挂渲染——渲染规范 §1）。 */
  function refresh() {
    fetchReminders();
  }

  function render() {
    // 冷启动兜底（im-ui ensure 先例）：无导航事件直达本分页且尚无缓存时
    // 幂等取一次（在途去重）；此后 render 纯投影，刷新由导航与聚焦事件驱动。
    if (!loaded) fetchReminders();
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

  // 窗口重新聚焦时刷新一次（对话内登记 / 完成后的兜底；导航刷新走 app-ui
  // 的 refreshVisibleWorkspacePanelData）。
  window.addEventListener('focus', () => {
    if (document.getElementById('memo-reminders-panel')) fetchReminders();
  });

  return { render, refresh, complete, remove, fmtRelativeBadge, groupOf };
})();
