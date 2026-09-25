// markdown-utils.js
// Phase 2d-1: Markdown / 数学公式渲染（Domain O-a）
// 从 app-ui.js 提取的渲染工具函数

const renderer = new marked.Renderer();

renderer.codespan = function(code) {
  const text = typeof code === 'string'
    ? code
    : (code && typeof code === 'object' && 'text' in code
      ? code.text
      : String(code ?? ''));
  return '<code class="inline-code-accent">' + escapeHtml(text) + '</code>';
};

function escapeHtml(text) {
  const str = String(text);
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]);
}

renderer.html = function(token) {
  const raw = String(token?.raw || '');
  if (
    /^<claw-display-math\s+data-token="claw-display-math-\d+">$/.test(raw)
    || raw === '</claw-display-math>'
  ) {
    return raw;
  }
  // 指南工作空间占位 token（与 claw-display-math 同款占位技法，见 guide-docset.js）
  if (/^<claw-guide-img data-token="guide-img-\d+">(?:<\/claw-guide-img>)?$/.test(raw) || raw === '</claw-guide-img>') {
    return raw;
  }
  if (/^<claw-guide-callout data-token="guide-callout-\d+">(?:<\/claw-guide-callout>)?$/.test(raw) || raw === '</claw-guide-callout>') {
    return raw;
  }
  if (/^<claw-guide-imgrow data-token="guide-imgrow-\d+">(?:<\/claw-guide-imgrow>)?$/.test(raw) || raw === '</claw-guide-imgrow>') {
    return raw;
  }
  return escapeHtml(raw);
};

marked.setOptions({
  renderer,
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true
});

function extractDisplayMathBlocks(text) {
  const source = String(text ?? '');
  const segments = source.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  const blocks = [];
  let index = 0;

  const transformSegment = (segment) => {
    let output = '';
    let cursor = 0;

    while (cursor < segment.length) {
      const start = segment.indexOf('$$', cursor);
      if (start === -1) {
        output += segment.slice(cursor);
        break;
      }

      if (start > 0 && segment[start - 1] === '\\') {
        output += segment.slice(cursor, start + 2);
        cursor = start + 2;
        continue;
      }

      const end = segment.indexOf('$$', start + 2);
      if (end === -1) {
        output += segment.slice(cursor);
        break;
      }

      const latex = segment.slice(start + 2, end).trim();
      const token = `claw-display-math-${index++}`;
      blocks.push({ token, latex });
      output += segment.slice(cursor, start);
      output += `\n\n<claw-display-math data-token="${token}"></claw-display-math>\n\n`;
      cursor = end + 2;
    }

    return output;
  };

  const markdown = segments.map((segment) => {
    if (!segment) return '';
    if (segment.startsWith('```') || segment.startsWith('~~~')) {
      return segment;
    }
    return transformSegment(segment);
  }).join('');

  return { markdown, blocks };
}

function renderDisplayMathLatex(latex) {
  if (window.katex?.renderToString) {
    try {
      return katex.renderToString(latex, {
        displayMode: true,
        throwOnError: false,
        strict: 'ignore',
        output: 'htmlAndMathml',
      });
    } catch (error) {
      console.warn('Display math render failed:', error);
    }
  }
  return `<span class="math-render-fallback">${escapeHtml(latex)}</span>`;
}

function renderMarkdown(text) {
  const { markdown, blocks } = extractDisplayMathBlocks(text);
  let html = marked.parse(markdown);
  blocks.forEach(({ token, latex }) => {
    const rendered = `<div class="katex-display-block">${renderDisplayMathLatex(latex)}</div>`;
    const tagPattern = new RegExp(`<claw-display-math\\s+data-token="${token}"><\\/claw-display-math>`, 'g');
    const wrappedTagPattern = new RegExp(`<p><claw-display-math\\s+data-token="${token}"><\\/claw-display-math><\\/p>`, 'g');
    html = html.replace(wrappedTagPattern, rendered);
    html = html.replace(tagPattern, rendered);
  });
  return wrapMarkdownTables(html);
}

// marked 输出的表格不嵌套，非贪婪标签配对即可安全包裹。
// 布局契约见 components.css：block 承载 is-wide 突破与底部留白（含右下角
// 动作条），wrap 负责横向滚动、圆角裁剪、外边距与右缘渐隐，
// table 完整展开（列不被压扁）。动作条放 block 不放 wrap：
// 渐隐 mask 与横向滚动都只作用于 wrap，按钮不参与滚动、不被渐隐。
const MD_TABLE_ICON_COPY_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path></svg>';
const MD_TABLE_ICON_CHECK_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L1.72 8.78a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg>';
// 四角外扩（lucide maximize 同款 stroke 几何）：fill path 在小尺寸下
// 易出现笔画粗细不均与裁切，stroke 绘制由 stroke-width 统一控制
const MD_TABLE_ICON_EXPAND_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';

function wrapMarkdownTables(html) {
  return html
    .replace(/<table>/g, '<div class="md-table-block"><div class="md-table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>'
      + '<div class="md-table-actions">'
      + '<button type="button" class="message-icon-action" title="复制表格" onclick="copyMarkdownTable(this)">' + MD_TABLE_ICON_COPY_SVG + '</button>'
      + '<button type="button" class="message-icon-action" title="放大查看" onclick="openTableZoom(this)">' + MD_TABLE_ICON_EXPAND_SVG + '</button>'
      + '</div></div>');
}

// ── 表格布局状态：双缘渐隐（左端隐右缘、中间两端、右端隐左缘）───
// 状态判定基于滚动容器 scroller：普通管线是 wrapper 自身；
// 主对话 is-wide 升级结构后是 .md-table-scrollbar（见下）。
function updateMarkdownTableFadeState(wrap, scroller) {
  // 窗口化隐藏的行宽高为 0，读到的是假溢出，保留原状态
  if (wrap.offsetWidth === 0) return;
  const s = scroller || wrap;
  const maxScroll = s.scrollWidth - s.clientWidth;
  const overflow = maxScroll > 1;
  wrap.classList.toggle('is-overflow', overflow);
  wrap.classList.toggle('at-scroll-start', overflow && s.scrollLeft <= 1);
  wrap.classList.toggle('at-scroll-end', !overflow || maxScroll - s.scrollLeft <= 1);
}

// ── 主对话宽表升级：滚动条与表格分层 ─────────────────────────
// table 移交 transform 驱动（合成器属性，滚动热路径零 reflow），
// 滚动条由独立的 8px 高 .md-table-scrollbar 承载，margin-left 隔开
// 左侧突破区——滚动条左端永远与正文文本对齐，不伸进留白区；
// 表格左移溢出 wrapper 的部分由 overflow:hidden 裁剪 + 外层渐隐 mask。
function upgradeWideTable(wrap) {
  const table = wrap.querySelector(':scope > table');
  if (!table || wrap.querySelector(':scope > .md-table-scrollbar')) return;
  const scrollbar = document.createElement('div');
  scrollbar.className = 'md-table-scrollbar';
  const ghost = document.createElement('div');
  ghost.className = 'md-table-scrollbar-ghost';
  scrollbar.appendChild(ghost);
  wrap.appendChild(scrollbar);
  const sync = () => {
    ghost.style.width = table.offsetWidth + 'px';
    table.style.transform = scrollbar.scrollLeft > 0 ? `translateX(${-scrollbar.scrollLeft}px)` : '';
  };
  sync();
  wrap._tableScrollSync = sync;
  scrollbar.addEventListener('scroll', () => {
    sync();
    updateMarkdownTableFadeState(wrap, scrollbar);
  }, { passive: true });
}

function enhanceMarkdownTables(root) {
  const wraps = root?.matches?.('.md-table-wrap')
    ? [root]
    : Array.from(root?.querySelectorAll?.('.md-table-wrap') || []);
  const pending = [];
  wraps.forEach((wrap) => {
    if (wrap.dataset.tableEnhanced === 'true') return;
    if (wrap.offsetWidth === 0) return;
    pending.push(wrap);
  });
  if (pending.length === 0) return;
  // 先集中读尺寸再集中写类名：classList 变更会失效布局缓存，
  // 读写交错会让每个表格各触发一次 reflow
  const states = pending.map((wrap) => {
    const maxScroll = wrap.scrollWidth - wrap.clientWidth;
    const overflow = maxScroll > 1;
    return { wrap, overflow };
  });
  states.forEach(({ wrap, overflow }) => {
    wrap.dataset.tableEnhanced = 'true';
    if (overflow && wrap.closest('.message-row')) {
      // 主对话宽表：升级为"transform 表格 + 独立滚动条"结构；
      // is-wide 挂在 block（承载双侧突破与动作条），wrap 的渐隐状态类不变
      const block = wrap.closest('.md-table-block');
      if (block) block.classList.add('is-wide');
      upgradeWideTable(wrap);
      updateMarkdownTableFadeState(wrap, wrap.querySelector(':scope > .md-table-scrollbar'));
    } else {
      // 其他管线（群聊气泡等）：wrapper 自身滚动
      wrap.classList.toggle('is-overflow', overflow);
      wrap.addEventListener('scroll', () => {
        updateMarkdownTableFadeState(wrap);
      }, { passive: true });
      updateMarkdownTableFadeState(wrap);
    }
  });
}

// ── 表格动作条：复制 / 放大 ──────────────────────────────────────

// DOM 表格 → Markdown 文本（首行为表头，紧随分隔行；竖线转义、换行压平）
function tableToMarkdown(table) {
  const rows = Array.from(table?.rows || []);
  const lines = [];
  rows.forEach((row, i) => {
    const cells = Array.from(row.cells).map((cell) => {
      return (cell.textContent || '').trim().replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
    });
    if (cells.length === 0) return;
    lines.push('| ' + cells.join(' | ') + ' |');
    if (i === 0) lines.push('| ' + cells.map(() => '---').join(' | ') + ' |');
  });
  return lines.join('\n');
}

function findTableFromActionButton(btn) {
  return btn?.closest('.md-table-block')?.querySelector('table') || null;
}

// 复制表格为 Markdown（剪贴板模式对齐 chat-renderer.js 的 copyMessageContent）
window.copyMarkdownTable = async function(btn) {
  const table = findTableFromActionButton(btn);
  const text = table ? tableToMarkdown(table) : '';
  if (!text) return;
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { ok = false; }
  }
  if (!ok) {
    // 非安全上下文回退（如局域网 IP 访问 UI）
    try {
      let ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { ok = false; }
  }
  if (!ok) {
    if (typeof ClawToast !== 'undefined') {
      const isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
      ClawToast.show({ id: 'md-table-copy', status: 'error', title: isZh ? '复制失败' : 'Failed to copy table' });
    }
    return;
  }
  if (btn) {
    btn.innerHTML = MD_TABLE_ICON_CHECK_SVG;
    btn.classList.add('copied');
    if (btn._copyResetTimer) clearTimeout(btn._copyResetTimer);
    btn._copyResetTimer = setTimeout(function() {
      btn.innerHTML = MD_TABLE_ICON_COPY_SVG;
      btn.classList.remove('copied');
    }, 1200);
  }
};

// 表格放大查看（lightbox 交互对齐 chat-renderer.js 的 openImageZoom：
// 点背景关闭、Esc 关闭；面板 overflow:auto 长表上下滚动，长列上限放宽）
window.openTableZoom = function(btn) {
  const table = findTableFromActionButton(btn);
  if (!table) return;

  let existing = document.getElementById('md-table-zoom-overlay');
  if (existing) existing.remove();

  let overlay = document.createElement('div');
  overlay.id = 'md-table-zoom-overlay';
  overlay.className = 'md-table-zoom-overlay';

  // markdown-body 上下文让克隆表格直接继承表格样式（背景/斑马纹/主题自适应）
  let panel = document.createElement('div');
  panel.className = 'markdown-body md-table-zoom-panel';
  panel.appendChild(table.cloneNode(true));
  panel.onclick = function(e) { e.stopPropagation(); };
  overlay.appendChild(panel);

  let onKey = function(e) {
    if (e.key === 'Escape') close();
  };
  let close = function() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  overlay.onclick = close;
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
};

// ── 主对话表格的右侧突破宽度（--md-table-bleed）────────────────
// .message-row 有 max-width:800px 居中，两侧留白随窗口变化；溢出表格
// 向右吃掉右侧留白（锚定 #chat-container 内容区右缘，不会超出屏幕）。
// 变量只在 .message-row 作用域的 CSS 规则里消费，其他管线不受影响。
const CHAT_ROW_MAX_WIDTH_PX = 800; // 与 components.css 的 .message-row max-width 保持一致
let _currentBleed = 0; // 渐隐判定读取（左缘何时开始裁内容）；CSS 变量读取昂贵，滚动热路径不能用

function refreshMarkdownTableBleed() {
  const chat = document.getElementById('chat-container');
  if (!chat) return;
  const style = getComputedStyle(chat);
  const contentWidth = chat.clientWidth
    - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  _currentBleed = Math.max(0, (contentWidth - CHAT_ROW_MAX_WIDTH_PX) / 2);
  document.documentElement.style.setProperty('--md-table-bleed', _currentBleed + 'px');
}

function initMarkdownTableBleedObserver() {
  if (typeof ResizeObserver === 'undefined') return;
  const chat = document.getElementById('chat-container');
  if (!chat || chat.dataset.tableBleedObserved === 'true') return;
  chat.dataset.tableBleedObserved = 'true';
  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      refreshMarkdownTableBleed();
      // bleed / 列宽变化后同步升级结构的 ghost 宽度、transform 与渐隐状态
      document.querySelectorAll('.md-table-wrap').forEach((wrap) => {
        if (wrap._tableScrollSync) {
          wrap._tableScrollSync();
          updateMarkdownTableFadeState(wrap, wrap.querySelector(':scope > .md-table-scrollbar'));
        } else {
          updateMarkdownTableFadeState(wrap);
        }
      });
    });
  }).observe(chat);
}

function enhanceMathInElement(root) {
  if (!root || typeof renderMathInElement !== 'function') {
    return;
  }

  const markdownRoots = root.matches?.('.markdown-body')
    ? [root]
    : Array.from(root.querySelectorAll?.('.markdown-body') || []);

  markdownRoots.forEach((element) => {
    if (!element || element.dataset.mathEnhanced === 'true') {
      return;
    }
    try {
      renderMathInElement(element, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
        strict: 'ignore',
        output: 'htmlAndMathml',
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        ignoredClasses: ['katex'],
      });
      element.dataset.mathEnhanced = 'true';
    } catch (error) {
      console.warn('Math render failed:', error);
    }
  });
}

window.addEventListener('load', () => {
  enhanceMathInElement(document.body);
  refreshMarkdownTableBleed();
  initMarkdownTableBleedObserver();
});
