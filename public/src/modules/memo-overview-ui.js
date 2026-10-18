/**
 * memo-overview-ui.js — memo 首页「总览」block（即将提醒 + 最近便签的聚合门户）
 *
 * 心智：
 * - 总览是聚合只读投影：提醒取未完成前 6 条（按 fire_at 升序，已过期自然
 *   置顶并带警示徽标），便签取最近更新前 6 张卡（3 列 × 2 行整格）；
 *   两节都有硬性高度上限（条数 + 行数截断），总览永不无限变长；
 * - 本 block 不做管理操作（勾选/删除/编辑都在各自分页），导航已反转：分节
 *   标题本身即入口（memo-overview-entry 整行可点跳子页面），提醒行 → 提醒
 *   页，便签卡 → 笔记页并直接打开阅读态；子页面经「← 总览」返回；
 * - render() 是纯投影：缓存先显（零闪烁），后台重取后 repaint（SWR）；
 *   刷新时机与便签墙/提醒列表一致（回总览重渲染 + 窗口重新聚焦各拉一次）；
 * - 相对时间徽标复用 MemoRemindersUI.fmtRelativeBadge（提醒呈现域的公共
 *   纯函数，两处口径一致），缺席时退回绝对时间。
 *
 * 数据面：/protoclaw/memo-app/reminders 与 /protoclaw/memo-app/notes（GET，
 * 只读聚合），server 零改动。
 *
 * 依赖全局（运行时调用，加载顺序无关）：
 *   - currentLanguage, escapeHtml (app-core.js)
 *   - MemoRemindersUI.fmtRelativeBadge (modules/memo-reminders-ui.js)
 *   - MemoNotesUI.openNote (modules/memo-notes-ui.js)
 *   - runWorkspaceAction (workspace-actions.js)
 */

window.MemoOverviewUI = (() => {
  const LIMIT = 6;

  let remindersCache = []; // 未完成提醒（按 fire_at 升序，前 LIMIT 条）
  let remindersLoaded = false;
  let notesCache = []; // 便签索引（按 updatedAt 降序，前 LIMIT 条）
  let notesLoaded = false;
  let fetchSeq = 0; // 过期响应丢弃

  function isZh() {
    return typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  }

  function esc(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function fetchReminders() {
    const resp = await fetch('/protoclaw/memo-app/reminders');
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !Array.isArray(data?.reminders)) {
      throw new Error((data && data.error) || 'HTTP ' + resp.status);
    }
    return data.reminders;
  }

  async function fetchNotes() {
    const resp = await fetch('/protoclaw/memo-app/notes');
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !Array.isArray(data?.notes)) {
      throw new Error((data && data.error) || 'HTTP ' + resp.status);
    }
    return data.notes;
  }

  /** 两源并行取数，各自独立落缓存与 repaint（单源失败不拖累另一源）。 */
  function fetchAll() {
    const seq = ++fetchSeq;
    fetchReminders().then((reminders) => {
      if (seq !== fetchSeq) return;
      remindersCache = reminders
        .filter((item) => item && item.id && item.status !== 'fired')
        .sort((a, b) => {
          const ta = new Date(a.fire_at).getTime();
          const tb = new Date(b.fire_at).getTime();
          if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
          if (!Number.isFinite(ta)) return 1;
          if (!Number.isFinite(tb)) return -1;
          return ta - tb;
        })
        .slice(0, LIMIT);
      remindersLoaded = true;
      paint();
    }).catch(() => { /* 保留旧内容，下次渲染 / 聚焦再试 */ });
    fetchNotes().then((notes) => {
      if (seq !== fetchSeq) return;
      notesCache = notes
        .filter((item) => item && item.filename)
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, LIMIT);
      notesLoaded = true;
      paint();
    }).catch(() => { /* 保留旧内容，下次渲染 / 聚焦再试 */ });
  }

  function fmtFireAt(entry) {
    const date = new Date(entry.fire_at);
    if (!Number.isFinite(date.getTime())) return entry.fire_at || '';
    const opts = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
    if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return date.toLocaleString(isZh() ? 'zh-CN' : 'en-US', opts);
  }

  function tabAction(tab) {
    return esc(JSON.stringify({ type: 'show_workspace_tab', tab }));
  }

  /** 分节标题即入口：整行可点（分页栏已移除，这是总览到子页面的唯一导航面）。 */
  function entryHead(tab, zh, en) {
    return '<button class="memo-overview-entry" type="button" data-workspace-action="' + tabAction(tab)
      + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">'
      + '<span class="memo-overview-entry-title">' + esc(isZh() ? zh : en) + '</span>'
      + '<span class="memo-overview-entry-arrow" aria-hidden="true">→</span>'
      + '</button>';
  }

  function reminderRow(entry) {
    const badge = window.MemoRemindersUI?.fmtRelativeBadge?.(entry);
    const badgeHtml = badge && badge.text
      ? '<span class="memo-reminder-chip' + (badge.overdue ? ' is-overdue' : '') + '">'
        + esc(badge.text) + '</span>'
      : '';
    return '<li class="memo-overview-reminder-item">'
      + '<button type="button" title="' + esc(isZh() ? '查看提醒' : 'View reminders')
      + '" onclick="MemoOverviewUI.goReminders()">'
      + '<span class="memo-overview-reminder-main">'
      + '<span class="memo-overview-reminder-content">' + esc(entry.content || '') + '</span>'
      + '<span class="memo-reminder-meta">' + badgeHtml
      + '<span>' + esc(fmtFireAt(entry)) + '</span>'
      + '</span>'
      + '</span>'
      + '</button>'
      + '</li>';
  }

  function remindersSectionHtml() {
    const head = entryHead('reminders', '提醒事项', 'Reminders');
    if (!remindersLoaded) {
      return head + '<div class="memo-notes-state"><span class="chat-loading-spinner"></span></div>';
    }
    if (remindersCache.length === 0) {
      return head + '<div class="memo-notes-state">'
        + esc(isZh()
          ? '暂无提醒。跟 Memo 说一句，比如「明天 9 点提醒我开会」。'
          : 'No reminders yet. Tell Memo in chat, e.g. "Remind me tomorrow at 9".')
        + '</div>';
    }
    return head + '<ul class="memo-overview-reminder-list">' + remindersCache.map(reminderRow).join('') + '</ul>';
  }

  function noteCard(note) {
    const filename = String(note?.filename || '');
    const stamp = (() => {
      const date = new Date(Number(note?.updatedAt));
      if (!Number.isFinite(date.getTime())) return '';
      return date.toLocaleString(isZh() ? 'zh-CN' : 'en-US', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    })();
    return '<button class="memo-note-card" type="button" data-note-filename="' + esc(filename) + '"'
      + ' onclick="MemoOverviewUI.openNote(this.dataset.noteFilename)">'
      + '<div class="memo-note-title">' + esc(note?.title || filename) + '</div>'
      + '<div class="memo-note-preview">' + esc(note?.preview || '') + '</div>'
      + '<div class="memo-note-meta">' + esc(stamp) + '</div>'
      + '</button>';
  }

  function notesSectionHtml() {
    const head = entryHead('notes', '最近便签', 'Recent notes');
    if (!notesLoaded) {
      return head + '<div class="memo-notes-state"><span class="chat-loading-spinner"></span></div>';
    }
    if (notesCache.length === 0) {
      return head + '<div class="memo-notes-state">'
        + esc(isZh() ? '还没有便签。跟 Memo 说一句，让它帮你记下。' : 'No notes yet. Tell Memo and it will note it down.')
        + '</div>';
    }
    return head + '<div class="memo-notes-grid">' + notesCache.map(noteCard).join('') + '</div>';
  }

  /** 左右双栏：提醒在左、便签在右（窄视口回落堆叠，断点在 memo-overview.css）。 */
  function sectionInnerHtml() {
    return '<div class="memo-overview-cols">'
      + '<div class="memo-overview-col">' + remindersSectionHtml() + '</div>'
      + '<div class="memo-overview-col">' + notesSectionHtml() + '</div>'
      + '</div>';
  }

  function paint() {
    const host = document.getElementById('memo-overview-panel');
    if (host) host.innerHTML = sectionInnerHtml();
  }

  function render() {
    fetchAll(); // SWR：缓存先显，后台重取后重绘
    return '<section class="workspace-section memo-overview-panel" id="memo-overview-panel">'
      + sectionInnerHtml()
      + '</section>';
  }

  // ── 跳页动作 ─────────────────────────────────────────────────────

  function goReminders() {
    if (typeof runWorkspaceAction === 'function') {
      runWorkspaceAction({ type: 'show_workspace_tab', tab: 'reminders' });
    }
  }

  /** 跳笔记页并打开阅读态：tab 切换重建 surface 后 openNote 落进便签墙；
   *  顺序颠倒也自愈（openNote 先置 currentNote，随后的重渲染自然带出阅读态）。 */
  function openNote(filename) {
    if (typeof runWorkspaceAction === 'function') {
      runWorkspaceAction({ type: 'show_workspace_tab', tab: 'notes' });
    }
    window.MemoNotesUI?.openNote?.(String(filename || ''));
  }

  // 窗口重新聚焦时刷新一次（对话内新增 / 编辑后的兜底；回总览重渲染走 render()）。
  window.addEventListener('focus', () => {
    if (document.getElementById('memo-overview-panel')) fetchAll();
  });

  return { render, goReminders, openNote };
})();
