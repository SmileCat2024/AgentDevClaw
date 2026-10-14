/**
 * memo-notes-ui.js — memo APP 首页的便签墙与页内阅读视图
 *
 * 心智：
 * - 墙 = 一组 Markdown 便签的索引投影（标题 / 纯文本预览 / 更新时间），
 *   每张卡片自带容器，外层 section 不再包一层面板（无界主题），
 *   网格每行最多 5 个；
 * - 点击卡片不弹窗，页内切换为阅读视图：顶栏「← 便签」返回 + meta +
 *   markdown-body 正文（与指南工作空间的 guide-article 同款阅读排版）；
 * - 阅读态是模块局部状态（currentNote），render() 重建视图时直接还原
 *   （缓存先显、后台重取，SWR），与 guide-docset 的 currentDoc 语义一致。
 *
 * 数据面：/protoclaw/memo-app/notes（不带 filename 列索引，带 filename 读
 * 单篇全文）。墙的刷新时机是「回首页重渲染」与「窗口重新聚焦」各拉一次，
 * 不做常驻轮询。
 *
 * 依赖全局（运行时调用，加载顺序无关）：
 *   - escapeHtml, currentLanguage (app-core.js)
 *   - renderMarkdown (markdown-utils.js)
 *   - .chat-loading-spinner (components.css)
 */

window.MemoNotesUI = (() => {
  let cache = []; // 最近一次成功拉取的便签索引
  let loaded = false; // 区分「加载中」与「空态」
  let fetchSeq = 0; // 过期响应丢弃
  let currentNote = ''; // '' = 墙；非空 = 阅读态（便签文件名）
  const noteCache = new Map(); // filename -> { filename, title, content, updatedAt, fetchedAt } | { missing|error, fetchedAt }

  function isZh() {
    return typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  }

  function esc(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function formatStamp(ms) {
    const date = new Date(Number(ms));
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString(isZh() ? 'zh-CN' : 'en-US', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  async function fetchNotes() {
    const seq = ++fetchSeq;
    try {
      const resp = await fetch('/protoclaw/memo-app/notes');
      const data = await resp.json().catch(() => null);
      if (seq !== fetchSeq) return;
      cache = Array.isArray(data?.notes) ? data.notes : [];
      loaded = true;
      if (!currentNote) paint();
    } catch {
      /* 拉取失败：保留旧内容，下次渲染 / 聚焦再试 */
    }
  }

  async function fetchNote(filename) {
    const key = String(filename || '');
    try {
      const resp = await fetch('/protoclaw/memo-app/notes?filename=' + encodeURIComponent(key));
      const data = await resp.json().catch(() => null);
      const note = data?.note || null;
      noteCache.set(key, note
        ? { ...note, fetchedAt: Date.now() }
        : { missing: true, fetchedAt: Date.now() });
    } catch {
      noteCache.set(key, { error: true, fetchedAt: Date.now() });
    }
    if (currentNote === key) paint();
  }

  function card(note) {
    const filename = String(note?.filename || '');
    return '<button class="memo-note-card" type="button" data-note-filename="' + esc(filename) + '"'
      + ' onclick="window.MemoNotesUI.openNote(this.dataset.noteFilename)">'
      + '<div class="memo-note-title">' + esc(note?.title || filename) + '</div>'
      + '<div class="memo-note-preview">' + esc(note?.preview || '') + '</div>'
      + '<div class="memo-note-meta">' + esc(formatStamp(note?.updatedAt)) + '</div>'
      + '</button>';
  }

  function wallBodyHtml() {
    if (!loaded) {
      return '<div class="memo-notes-state">' + esc(isZh() ? '便签加载中…' : 'Loading notes…') + '</div>';
    }
    if (cache.length === 0) {
      return '<div class="memo-notes-state">'
        + esc(isZh() ? '还没有便签。跟 Memo 说一句，让它帮你记下。' : 'No notes yet. Tell Memo and it will note it down.')
        + '</div>';
    }
    return '<div class="memo-notes-grid">' + cache.map(card).join('') + '</div>';
  }

  function readerHtml() {
    const entry = noteCache.get(currentNote);
    const top =
      '<div class="memo-note-reader-top">'
      + '<button class="memo-note-back" type="button" onclick="window.MemoNotesUI.closeNote()">← '
      + esc(isZh() ? '便签' : 'Notes') + '</button>'
      + '<span class="memo-note-reader-meta">' + esc(currentNote)
      + (entry && !entry.missing && !entry.error && entry.updatedAt
        ? ' · ' + esc(isZh() ? '更新于 ' : 'Updated ') + esc(formatStamp(entry.updatedAt))
        : '')
      + '</span>'
      + '</div>';
    let body;
    if (!entry) {
      body = '<div class="memo-note-reader-state"><span class="chat-loading-spinner"></span>'
        + esc(isZh() ? '便签加载中…' : 'Loading note…') + '</div>';
    } else if (entry.missing) {
      body = '<div class="memo-note-reader-state">'
        + esc(isZh() ? '便签不存在或已被删除。' : 'Note not found or deleted.') + '</div>';
    } else if (entry.error) {
      body = '<div class="memo-note-reader-state">'
        + esc(isZh() ? '便签加载失败。' : 'Failed to load note.') + '</div>';
    } else {
      body = '<div class="memo-note-reader-body markdown-body">' + renderMarkdown(entry.content || '') + '</div>';
    }
    return top + body;
  }

  function sectionInnerHtml() {
    if (currentNote) {
      return '<div class="memo-note-reader">' + readerHtml() + '</div>';
    }
    const countSuffix = loaded ? '（' + cache.length + '）' : '';
    return '<div class="workspace-section-header"><div>'
      + '<div class="workspace-section-title">' + esc(isZh() ? '便签' : 'Notes') + esc(countSuffix) + '</div>'
      + '</div></div>'
      + wallBodyHtml();
  }

  function paint() {
    const host = document.getElementById('memo-notes-wall');
    if (host) host.innerHTML = sectionInnerHtml();
  }

  function render() {
    if (currentNote) fetchNote(currentNote); // SWR：缓存先显，后台重取后重绘
    else fetchNotes();
    return '<section class="workspace-section memo-notes-wall" id="memo-notes-wall">'
      + sectionInnerHtml()
      + '</section>';
  }

  function openNote(filename) {
    currentNote = String(filename || '');
    paint();
    fetchNote(currentNote);
  }

  function closeNote() {
    currentNote = '';
    paint();
    fetchNotes();
  }

  // 窗口重新聚焦时刷新一次（跨窗口写便签的兜底；回首页重渲染走 render()）。
  // 阅读态不刷，避免后台重取打断阅读。
  window.addEventListener('focus', () => {
    if (document.getElementById('memo-notes-wall') && !currentNote) fetchNotes();
  });

  return { render, openNote, closeNote };
})();
