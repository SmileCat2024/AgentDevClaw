/**
 * memo-notes-ui.js — memo APP 首页的便签墙与页内阅读视图（块级就地编辑）
 *
 * 心智：
 * - 墙 = 一组 Markdown 便签的索引投影（标题 / 纯文本预览 / 更新时间），
 *   每张卡片自带容器，外层 section 不再包一层面板（无界主题），
 *   网格每行最多 5 个；
 * - 点击卡片不弹窗，页内切换为阅读视图：顶栏「← 便签」返回 + meta +
 *   markdown-body 正文（与指南工作空间的 guide-article 同款阅读排版）；
 * - 正文按 markdown 顶层块渲染（splitMarkdownBlocks），双击某块只有该块
 *   原地换成源码 textarea（复刻该块的排版度量：字体/行高/边距/底色/左边线，
 *   切换瞬间除「富文本变源码」外视觉不动），其余块保持渲染态；失焦提交：新源码
 *   经 replaceMarkdownBlock 替换该块切片 → 整篇覆盖写回（POST），重新切块
 *   渲染。编辑期间 800ms 防抖静默中途保存，防中断丢稿。全程无按钮。
 *   空块提交 = 删除该块；块内输入多段内容保存后自然裂成多块；
 * - 阅读态是模块局部状态（currentNote），render() 重建视图时直接还原
 *   （缓存先显、后台重取，SWR），与 guide-docset 的 currentDoc 语义一致。
 *   编辑期间 SWR 重取不重绘（不打断 textarea），草稿在 editing.draft 里，
 *   任何重建都无损。
 *
 * 数据面：/protoclaw/memo-app/notes（GET 不带 filename 列索引 / 带 filename
 * 读单篇全文；POST 整篇覆盖写，只覆盖已有便签）。墙的刷新时机是
 * 「回首页重渲染」与「窗口重新聚焦」各拉一次，不做常驻轮询。
 *
 * 依赖全局（运行时调用，加载顺序无关）：
 *   - escapeHtml, currentLanguage (app-core.js)
 *   - renderMarkdown, splitMarkdownBlocks, isEditableMarkdownBlock,
 *     replaceMarkdownBlock (markdown-utils.js)
 *   - .chat-loading-spinner (components.css)
 */

window.MemoNotesUI = (() => {
  let cache = []; // 最近一次成功拉取的便签索引
  let loaded = false; // 区分「加载中」与「空态」
  let fetchSeq = 0; // 过期响应丢弃
  let currentNote = ''; // '' = 墙；非空 = 阅读态（便签文件名）
  const noteCache = new Map(); // filename -> { filename, title, content, updatedAt, fetchedAt } | { missing|error, fetchedAt }

  // 就地编辑态（同一时间至多一块）：
  //   blockIndex  splitMarkdownBlocks 数组下标（含 space 段）；-1 = 空便签占位块
  //   baseContent 进入编辑时的整篇源码（提交重组的基底，编辑期间不随后台刷新漂移）
  //   draft       textarea 实时草稿（重建视图无损还原）
  //   timer       800ms 防抖中途保存句柄
  let editing = null;
  let saveSeq = 0; // 过期保存响应丢弃

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
    if (currentNote === key && !editing) paint();
  }

  /** 整篇覆盖写（乐观：调用方先改缓存再调这里；失败 toast，本地保留乐观内容待下次保存自愈）。 */
  async function saveNote(filename, content) {
    const seq = ++saveSeq;
    try {
      const resp = await fetch('/protoclaw/memo-app/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content }),
      });
      const data = await resp.json().catch(() => null);
      if (seq !== saveSeq) return;
      if (!resp.ok || !data?.ok) {
        throw new Error((data && data.error) || 'HTTP ' + resp.status);
      }
      const entry = noteCache.get(filename);
      if (entry && !entry.missing && !entry.error) {
        entry.content = data.note.content;
        entry.updatedAt = data.note.updatedAt;
      }
    } catch (err) {
      if (typeof ClawToast !== 'undefined') {
        ClawToast.show({
          id: 'memo-note-save',
          status: 'error',
          title: isZh() ? '便签保存失败' : 'Failed to save note',
          desc: String(err?.message || err),
        });
      }
    }
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

  /** 采集渲染块的排版度量（paint 替换前），编辑器 inline style 原样复刻，
   *  使切换瞬间除「富文本变源码」外位置/大小/间距/底色不动。
   *  度量取块内第一个元素子节点（h2 / p / ul / blockquote / pre 本身）。
   *  多行结构块（ul/ol/blockquote）的行间距来自子元素 margin（li+li 0.25em、
   *  blockquote 内 p 10px），textarea 只有统一 line-height 无法逐行表达——
   *  将行间折叠间隙并入 line-height（合成行距），行与行对齐；原块高度另记为
   *  min-height 兜底，进入编辑瞬间下方内容绝不上移。 */
  function captureBlockMetrics(blockIndex) {
    if (blockIndex === -1) return null; // 空占位块无渲染度量，回落 CSS 默认
    const host = document.getElementById('memo-notes-wall');
    const blockEl = host && host.querySelector
      ? host.querySelector('.memo-note-block[data-block-index="' + blockIndex + '"]')
      : null;
    const el = blockEl ? blockEl.firstElementChild : null;
    if (!el || typeof window === 'undefined' || !window.getComputedStyle) return null;
    const cs = window.getComputedStyle(el);
    const props = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
      'color', 'textAlign', 'marginTop', 'marginBottom', 'paddingTop', 'paddingRight',
      'paddingBottom', 'paddingLeft'];
    const m = {};
    for (const p of props) m[p] = cs[p];
    m.minHeight = Math.round(el.offsetHeight) + 'px';
    // 引用块的左边线、标题的分节下边线是视觉身份的一部分；代码块/引用的底色
    // 同理（透明则不加，让 CSS 的编辑中弱着色生效）
    if (parseFloat(cs.borderLeftWidth) > 0) {
      m.borderLeft = cs.borderLeftWidth + ' ' + cs.borderLeftStyle + ' ' + cs.borderLeftColor;
    }
    if (parseFloat(cs.borderBottomWidth) > 0) {
      m.borderBottom = cs.borderBottomWidth + ' ' + cs.borderBottomStyle + ' ' + cs.borderBottomColor;
    }
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') {
      m.backgroundColor = cs.backgroundColor;
    }
    // 合成行距：行间折叠间隙（max(margin-top, margin-bottom)，与 CSS 折叠同构）
    // 并入 line-height；子元素 padding（若首子带内衬）一并计入
    if (el.tagName === 'UL' || el.tagName === 'OL' || el.tagName === 'BLOCKQUOTE') {
      const child = el.firstElementChild;
      if (child) {
        const ccs = window.getComputedStyle(child);
        const lh = parseFloat(ccs.lineHeight);
        const gap = Math.max(parseFloat(ccs.marginTop) || 0, parseFloat(ccs.marginBottom) || 0)
          + (parseFloat(ccs.paddingTop) || 0) + (parseFloat(ccs.paddingBottom) || 0);
        if (Number.isFinite(lh) && gap > 0) m.lineHeight = (lh + gap) + 'px';
      }
    }
    return m;
  }

  function editorStyleHtml(metrics) {
    if (!metrics) return '';
    let style = '';
    for (const key of Object.keys(metrics)) {
      const cssKey = key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
      style += cssKey + ':' + esc(metrics[key]) + ';';
    }
    return style ? ' style="' + style + '"' : '';
  }

  function editorHtml(draft, metrics) {
    return '<textarea class="memo-note-block-editor" spellcheck="false"'
      + editorStyleHtml(metrics)
      + ' oninput="window.MemoNotesUI.onEditorInput(this)"'
      + ' onblur="window.MemoNotesUI.commitEditBlock()"'
      + ' onkeydown="window.MemoNotesUI.onEditorKeydown(event)">'
      + esc(draft) + '</textarea>';
  }

  /** 正文按顶层块渲染；正在编辑的块换成源码 textarea。块容器不加内衬（保住 markdown-body 的 margin 折叠）。 */
  function noteBodyHtml(entry) {
    const blocks = splitMarkdownBlocks(entry.content || '');
    let html = '';
    let hasEditable = false;
    for (let i = 0; i < blocks.length; i++) {
      if (!isEditableMarkdownBlock(blocks[i])) continue;
      hasEditable = true;
      if (editing && editing.blockIndex === i) {
        html += editorHtml(editing.draft, editing.metrics);
      } else {
        html += '<div class="memo-note-block" data-block-index="' + i + '"'
          + ' ondblclick="window.MemoNotesUI.startEditBlock(' + i + ', event)">'
          + renderMarkdown(blocks[i].raw) + '</div>';
      }
    }
    if (!hasEditable) {
      if (editing && editing.blockIndex === -1) return editorHtml(editing.draft, editing.metrics);
      return '<div class="memo-note-block is-empty" data-block-index="-1"'
        + ' ondblclick="window.MemoNotesUI.startEditBlock(-1, event)">'
        + esc(isZh() ? '空便签——双击开始写' : 'Empty note — double-click to write')
        + '</div>';
    }
    return html;
  }

  function readerHtml() {
    const entry = noteCache.get(currentNote);
    const top =
      '<div class="memo-note-reader-top">'
      // 返回按钮走项目统一的 feature-detail-close 图标形态（详情页返回先例）：
      // feature-store / mcp-gateway / codex 连接页 / ph-model-config 同款
      + '<button class="feature-detail-close" type="button" title="' + esc(isZh() ? '返回' : 'Back') + '" onclick="window.MemoNotesUI.closeNote()" style="margin-right:8px;font-size:16px;">'
      + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path></svg>'
      + '</button>'
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
      body = '<div class="memo-note-reader-body markdown-body">' + noteBodyHtml(entry) + '</div>';
    }
    return top + body;
  }

  function sectionInnerHtml() {
    if (currentNote) {
      return '<div class="memo-note-reader">' + readerHtml() + '</div>';
    }
    const countSuffix = loaded ? '（' + cache.length + '）' : '';
    // 子页面顶栏：返回总览（导航反转后分页栏不再存在）+ 页标题
    return '<div class="memo-subpage-head">'
      + '<button class="memo-back-link" type="button" data-workspace-action="'
      + esc(JSON.stringify({ type: 'show_home' }))
      + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">'
      + esc(isZh() ? '← 总览' : '← Overview') + '</button>'
      + '<div class="memo-subpage-title">' + esc(isZh() ? '便签' : 'Notes') + esc(countSuffix) + '</div>'
      + '</div>'
      + wallBodyHtml();
  }

  function paint() {
    const host = document.getElementById('memo-notes-wall');
    if (host) {
      host.innerHTML = sectionInnerHtml();
      // 阅读态类同步给 section 自身（CSS :has() 据此隐藏首页其余块）
      host.classList.toggle('is-reading', !!currentNote);
    }
  }

  function render() {
    if (currentNote) fetchNote(currentNote); // SWR：缓存先显，后台重取后重绘
    else fetchNotes();
    // is-reading 在输出时即带上：外层重建 workspace-surface 的路径零闪烁
    return '<section class="workspace-section memo-notes-wall'
      + (currentNote ? ' is-reading' : '') + '" id="memo-notes-wall">'
      + sectionInnerHtml()
      + '</section>';
  }

  // ── 块级就地编辑 ──────────────────────────────────────────────────

  function findEditor() {
    const host = document.getElementById('memo-notes-wall');
    return (host && host.querySelector) ? host.querySelector('.memo-note-block-editor') : null;
  }

  function autoSizeEditor(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 24) + 'px';
  }

  /** paint() 重建 DOM 后重挂编辑器：恢复高度、焦点与光标（末尾）。 */
  function reattachEditor() {
    const ta = findEditor();
    if (!ta) return;
    autoSizeEditor(ta);
    ta.focus();
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
  }

  function startEditBlock(blockIndex, event) {
    const entry = noteCache.get(currentNote);
    if (!entry || entry.missing || entry.error) return;
    if (editing) return; // 同一时间只编辑一块
    // 块内链接 / 按钮（如代码块复制）有自己的行为，双击也不进编辑
    const target = event?.target;
    if (target && target.closest && target.closest('a, button')) return;
    const baseContent = entry.content || '';
    let draft = '';
    if (blockIndex !== -1) {
      const blocks = splitMarkdownBlocks(baseContent);
      if (!isEditableMarkdownBlock(blocks[blockIndex])) return;
      draft = blocks[blockIndex].raw;
    }
    // 先采集排版度量（此刻原渲染块还在 DOM），再替换
    const metrics = captureBlockMetrics(blockIndex);
    editing = { blockIndex, baseContent, draft, metrics, timer: null };
    paint();
    reattachEditor();
  }

  function onEditorInput(ta) {
    if (!editing) return;
    editing.draft = ta.value.replace(/\r\n/g, '\n'); // 归一 Windows 换行
    autoSizeEditor(ta);
    if (editing.timer) clearTimeout(editing.timer);
    editing.timer = setTimeout(() => {
      if (!editing) return;
      editing.timer = null;
      const next = editing.blockIndex === -1
        ? editing.draft
        : replaceMarkdownBlock(editing.baseContent, editing.blockIndex, editing.draft);
      if (next !== editing.baseContent) saveNote(currentNote, next);
    }, 800);
  }

  function onEditorKeydown(event) {
    if (event.key === 'Escape' && event.target && typeof event.target.blur === 'function') {
      event.preventDefault();
      event.target.blur(); // 提交并回到渲染态
    }
  }

  /** 失焦提交：重组整篇 → 乐观更新缓存 → 回渲染态 → 后台覆盖写。 */
  function commitEditBlock() {
    if (!editing) return;
    const ta = findEditor();
    const { blockIndex, baseContent } = editing;
    const draft = ta ? ta.value.replace(/\r\n/g, '\n') : editing.draft;
    if (editing.timer) {
      clearTimeout(editing.timer);
      editing.timer = null;
    }
    editing = null;
    const entry = noteCache.get(currentNote);
    if (!ta || !entry || entry.missing || entry.error) {
      paint();
      return;
    }
    const next = blockIndex === -1 ? draft : replaceMarkdownBlock(baseContent, blockIndex, draft);
    if (next !== (entry.content || '')) {
      entry.content = next;
      entry.updatedAt = Date.now();
      saveNote(currentNote, next);
    }
    paint();
  }

  function openNote(filename) {
    if (editing) commitEditBlock();
    currentNote = String(filename || '');
    paint();
    fetchNote(currentNote);
  }

  function closeNote() {
    if (editing) commitEditBlock();
    currentNote = '';
    paint();
    fetchNotes();
  }

  // 窗口重新聚焦时刷新一次（跨窗口写便签的兜底；回首页重渲染走 render()）。
  // 阅读态不刷，避免后台重取打断阅读；编辑态同理由 fetchNote 的 !editing 守卫。
  window.addEventListener('focus', () => {
    if (document.getElementById('memo-notes-wall') && !currentNote) fetchNotes();
  });

  return {
    render, openNote, closeNote,
    startEditBlock, onEditorInput, onEditorKeydown, commitEditBlock,
  };
})();
