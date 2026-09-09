/**
 * guide-docset.js — 「AgentDevClaw 指南」工作空间渲染模块
 *
 * 手册阅读器：左侧目录树 + 右侧 markdown 正文。
 * 正文复用对话页渲染管线（renderMarkdown：marked + hljs + katex），
 * 其上叠加：
 *   - Typora 兼容图片语法（![alt](src =WxH align) 与原生 <img style="zoom:..">），
 *     相对路径统一改写为指南资产接口 URL，点击图片复用对话页的图片缩放层（openImageZoom）。
 *   - md 之间相对链接（含锚点）在阅读器内跳转，联动目录高亮。
 *   - 页内大纲（h2/h3）、上/下篇导航、阅读位置记忆（localStorage）。
 *
 * 依赖（全局作用域，运行时解析）：
 *   - markdown-utils.js: escapeHtml, renderMarkdown, enhanceMathInElement
 *   - app-core.js: currentLanguage, localizeWorkspaceValue, getCurrentAgentRecord
 *   - app-ui.js: renderCurrentMainView
 *
 * 数据来源：
 *   - workspace_data[block.id]（server/routes/workspace.js → guide.js 聚合目录树）
 *   - GET /protoclaw/guide_doc、GET /protoclaw/guide_asset
 */

// ══════════════════════════════════════════════════════════════
//  状态（模块局部；遵循 app-core 全局状态纪律：新增状态放模块作用域）
// ══════════════════════════════════════════════════════════════

const guideState = {
  agentId: '',
  blockId: '',
  currentDoc: '',           // 相对指南根的路径（正斜杠分隔）
  pendingAnchor: '',        // 加载完成后滚动到的标题文本
  cache: new Map(),         // docPath -> { title, html, fetchedAt }
  loadingDoc: '',
  loadingToken: 0,
  collapsedDirs: new Set(), // 目录默认全展开，只记录被手动收起的目录 id
  scrollMemory: new Map(),  // docPath -> article 滚动位置（会话内）
};

const GUIDE_DOC_CACHE_TTL_MS = 60 * 1000;
const GUIDE_LAST_DOC_PREFIX = 'guide:lastDoc:';

function guideText(key) {
  const zh = {
    loading: '加载中…',
    loadFailed: '文档加载失败',
    noDocs: '指南目录里还没有 md 文档。把手册文件放进指南文件夹即可自动出现在目录里。',
    noRoot: '还没有找到指南目录。',
    unresolved: '图片无法解析',
    emptyDoc: '这份文档还没有内容。',
  };
  const en = {
    loading: 'Loading…',
    loadFailed: 'Failed to load document',
    noDocs: 'No markdown documents in the guide folder yet.',
    noRoot: 'Guide root not found.',
    unresolved: 'Unresolved image',
    emptyDoc: 'This document is empty.',
  };
  return (currentLanguage === 'en' ? en : zh)[key] || zh[key] || key;
}

// ══════════════════════════════════════════════════════════════
//  纯函数（可单测）：语法解析与路径解析
// ══════════════════════════════════════════════════════════════

/**
 * 按代码围栏切段（与 markdown-utils 公式提取同款技法），
 * 只在非代码段内改写图片语法。
 */
function splitGuideFenceSegments(text) {
  return String(text ?? '').split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
}

function guideReadDim(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (/^\d+(\.\d+)?$/.test(raw)) return `${raw}px`;
  if (/^\d+(\.\d+)?(px|%)$/.test(raw)) return raw;
  return '';
}

/**
 * 解析 md 图片括号内的修饰 token：'=600x400'、'=600x'、'=50%'、'center' 等。
 */
function parseGuideImageTokens(tokens) {
  const spec = { width: '', height: '', align: '' };
  for (const token of tokens) {
    const lower = String(token || '').toLowerCase();
    if (lower === 'left' || lower === 'center' || lower === 'right') {
      spec.align = lower;
      continue;
    }
    if (!lower.startsWith('=')) continue;
    const size = lower.slice(1).trim().replace(/[x×]/g, 'x');
    if (!size) continue;
    if (size.includes('x')) {
      const dims = size.split('x');
      spec.width = guideReadDim(dims[0]);
      spec.height = guideReadDim(dims[1] || '');
    } else {
      spec.width = guideReadDim(size);
    }
  }
  return spec;
}

/** 解析原生 <img> 的 style 声明（zoom/width/height/text-align）。 */
function parseGuideImgStyle(style) {
  const spec = { width: '', height: '', zoom: '', align: '' };
  for (const decl of String(style || '').split(';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    const key = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (!key || !value) continue;
    if (key === 'zoom') spec.zoom = value;
    else if (key === 'width') spec.width = value;
    else if (key === 'height') spec.height = value;
    else if (key === 'text-align') spec.align = value.toLowerCase();
  }
  return spec;
}

/** 解析原生 <img> 标签的属性（Typora 粘贴产物）。 */
function parseGuideImgAttrs(rawTag) {
  const attrs = {};
  const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = attrRegex.exec(rawTag)) !== null) {
    const key = match[1].toLowerCase();
    attrs[key] = match[3] !== undefined ? match[3] : (match[4] !== undefined ? match[4] : match[5]);
  }
  return attrs;
}

/**
 * 相对当前文档解析 href（标准 markdown 语义：相对文档所在目录）。
 * 返回 { path, anchor }；path 为 '' 表示页内锚点；null 表示外部地址或越界。
 */
function resolveGuideHref(href, docPath) {
  const raw = String(href || '').trim().replace(/\\/g, '/');
  if (!raw) return null;
  if (/^(https?:|mailto:|data:|javascript:)/i.test(raw)) return null;

  let anchor = '';
  let target = raw;
  const hashIndex = raw.indexOf('#');
  if (hashIndex >= 0) {
    target = raw.slice(0, hashIndex);
    try {
      anchor = decodeURIComponent(raw.slice(hashIndex + 1)).trim();
    } catch {
      anchor = raw.slice(hashIndex + 1).trim();
    }
  }
  if (!target) return { path: '', anchor };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('//') || target.startsWith('/')) {
    return null;
  }

  const docDir = String(docPath || '').split('/').slice(0, -1).filter(Boolean);
  const parts = [...docDir];
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  if (parts.length === 0) return null;
  return { path: parts.join('/'), anchor };
}

// ══════════════════════════════════════════════════════════════
//  图片提取与渲染
// ══════════════════════════════════════════════════════════════

/**
 * 从 markdown 源文本提取图片（md 语法 + 原生 <img>），改写为受控 token，
 * 避免 marked 转义；代码围栏内的内容不动。
 * images[i] = { token, src, alt, width, height, zoom, align }
 */
function collectGuideImages(md) {
  const images = [];
  const markdown = splitGuideFenceSegments(md)
    .map((segment, index) => {
      if (index % 2 === 1 || !segment) return segment;

      let result = segment;

      // 1) 原生 <img> 标签（Typora 粘贴产物）
      result = result.replace(/<img\s[^>]*>/gi, (raw) => {
        const attrs = parseGuideImgAttrs(raw);
        if (!attrs.src) return raw;
        const styleSpec = parseGuideImgStyle(attrs.style);
        const token = `guide-img-${images.length}`;
        images.push({
          token,
          src: attrs.src || '',
          alt: attrs.alt || '',
          width: styleSpec.width || attrs.width || '',
          height: styleSpec.height || attrs.height || '',
          zoom: styleSpec.zoom || '',
          align: styleSpec.align || attrs.align || '',
        });
        return `\n\n<claw-guide-img data-token="${token}"></claw-guide-img>\n\n`;
      });

      // 2) md 图片语法 ![alt](src =WxH align)
      result = result.replace(/!\[([^\]]*)\]\(([^()\n]+)\)/g, (match, alt, inner) => {
        const pieces = String(inner).split(/\s+/).filter(Boolean);
        if (pieces.length === 0) return match;
        const src = pieces[0].replace(/^["'<]+|["'>]+$/g, '');
        if (!src) return match;
        const spec = parseGuideImageTokens(pieces.slice(1));
        const token = `guide-img-${images.length}`;
        images.push({
          token,
          src,
          alt: String(alt || ''),
          width: spec.width,
          height: spec.height,
          zoom: '',
          align: spec.align,
        });
        return `\n\n<claw-guide-img data-token="${token}"></claw-guide-img>\n\n`;
      });

      return result;
    })
    .join('');

  return { markdown, images };
}

function guideImageStyleAttr(image) {
  const parts = [];
  if (image.width) parts.push(`width:${guideReadDim(image.width)}`);
  if (image.height) parts.push(`height:${guideReadDim(image.height)}`);
  if (image.zoom) parts.push(`zoom:${escapeHtml(String(image.zoom))}`);
  return parts.length ? ` style="${parts.join(';')}"` : '';
}

function guideAlignClass(image) {
  const align = String(image.align || '').toLowerCase();
  if (align === 'left' || align === 'right') return `guide-align-${align}`;
  return 'guide-align-center';
}

function guideAssetUrl(agentId, path) {
  return `/protoclaw/guide_asset?agentId=${encodeURIComponent(agentId)}&path=${encodeURIComponent(path)}`;
}

/**
 * 生成最终图片 HTML：相对路径走资产接口；越界/外站路径渲染为占位提示。
 */
function buildGuideImageHtml(image, docPath, agentId) {
  const styleAttr = guideImageStyleAttr(image);
  const alignClass = guideAlignClass(image);
  const escapedAlt = escapeHtml(image.alt || '');

  let inner;
  if (guideIsExternalSrc(image.src)) {
    const safeSrc = escapeHtml(image.src);
    inner = `<img src="${safeSrc}" alt="${escapedAlt}" loading="lazy" data-guide-src="${safeSrc}" draggable="false"${styleAttr}>`;
  } else {
    const resolved = resolveGuideHref(image.src, docPath);
    if (resolved && resolved.path) {
      const safeSrc = escapeHtml(guideAssetUrl(agentId, resolved.path));
      inner = `<img src="${safeSrc}" alt="${escapedAlt}" loading="lazy" data-guide-src="${safeSrc}" draggable="false"${styleAttr}>`;
    } else {
      inner = `<span class="guide-image-missing" title="${escapeHtml(image.src || '')}">${escapeHtml(guideText('unresolved'))}：${escapeHtml(image.src || '')}</span>`;
    }
  }
  return `<span class="guide-image-block ${alignClass}">${inner}</span>`;
}

function guideIsExternalSrc(src) {
  return /^(https?:|data:|blob:)/i.test(String(src || '').trim());
}

/**
 * 文档正文渲染入口：图片语法 → 受控 token → 共享 renderMarkdown（marked+hljs+katex）→
 * token 回填为最终图片 HTML。占用与 markdown-utils 的公式提取同一技法，代码块不动。
 */
function buildGuideArticleHtml(doc, agentId) {
  const { markdown, images } = collectGuideImages(doc?.content || '');
  let html = renderMarkdown(markdown);
  images.forEach((image) => {
    const rendered = buildGuideImageHtml(image, doc.path, agentId);
    const tokenTag = `<claw-guide-img data-token="${image.token}"></claw-guide-img>`;
    html = html
      .replace(new RegExp(`<p>\\s*${tokenTag}\\s*</p>`, 'g'), rendered)
      .replace(new RegExp(tokenTag, 'g'), rendered);
  });
  return html;
}

// ══════════════════════════════════════════════════════════════
//  Block 渲染
// ══════════════════════════════════════════════════════════════

function getGuideData(agent, block) {
  const workspaceData = agent?.workspace_data;
  const blockId = String(block?.id || '');
  if (!workspaceData || typeof workspaceData !== 'object' || !blockId) return null;
  const data = workspaceData[blockId];
  return data && typeof data === 'object' ? data : null;
}

function flattenGuideDocs(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.type === 'doc') out.push(node);
    else flattenGuideDocs(node.children || [], out);
  }
  return out;
}

function findGuideDocInTree(nodes, docPath) {
  for (const node of nodes || []) {
    if (node.type === 'doc' && node.id === docPath) return node;
    const found = findGuideDocInTree(node.children || [], docPath);
    if (found) return found;
  }
  return null;
}

function guideDocLabel(node) {
  return node.title || node.name || node.id;
}

function guideAncestorDirIds(docPath) {
  const parts = String(docPath || '').split('/').filter(Boolean);
  parts.pop();
  const dirs = new Set();
  let acc = '';
  for (const segment of parts) {
    acc = acc ? `${acc}/${segment}` : segment;
    dirs.add(acc);
  }
  return dirs;
}

function guideGetLastDoc(agentId) {
  try {
    const raw = localStorage.getItem(GUIDE_LAST_DOC_PREFIX + agentId);
    if (!raw) return '';
    const parsed = JSON.parse(raw);
    return typeof parsed?.doc === 'string' ? parsed.doc : '';
  } catch {
    return '';
  }
}

function guideSaveLastDoc(agentId, docPath) {
  try {
    localStorage.setItem(GUIDE_LAST_DOC_PREFIX + agentId, JSON.stringify({ doc: docPath }));
  } catch {
    // localStorage 不可用时静默降级
  }
}

function renderGuideTreeNodes(nodes, ancestors) {
  return (nodes || []).map((node) => {
    if (node.type === 'dir') {
      const containsCurrent = ancestors.has(node.id);
      const expanded = containsCurrent || !guideState.collapsedDirs.has(node.id);
      return [
        '<div class="guide-toc-node">',
        // 文件路径是外部输入，点击统一走 data 属性 + document 级委托（防 onclick 字符串逃逸）
        `<button class="guide-toc-dir${containsCurrent ? ' branch-active' : ''}" type="button" data-guide-toggle-dir="${escapeHtml(node.id)}">`,
        `<span class="guide-toc-dir-name">${escapeHtml(node.name || node.id)}</span>`,
        '</button>',
        expanded ? `<div class="guide-toc-children">${renderGuideTreeNodes(node.children || [], ancestors)}</div>` : '',
        '</div>',
      ].join('');
    }
    const active = guideState.currentDoc === node.id;
    return [
      '<div class="guide-toc-node">',
      `<button class="guide-toc-doc${active ? ' active' : ''}" type="button" data-guide-doc-jump="${escapeHtml(node.id)}" title="${escapeHtml(node.id)}">`,
      `<span class="guide-toc-doc-label">${escapeHtml(guideDocLabel(node))}</span>`,
      '</button>',
      '</div>',
    ].join('');
  }).join('');
}

function renderGuideTreeHtml(nodes, ancestors) {
  return `<nav class="guide-toc-tree">${renderGuideTreeNodes(nodes || [], ancestors)}</nav>`;
}

function renderGuideDocsetBlock(agent, block) {
  guideEnsureDelegated();
  const data = getGuideData(agent, block);

  if (guideState.agentId !== agent.id || guideState.blockId !== String(block.id || '')) {
    guideState.agentId = agent.id;
    guideState.blockId = String(block.id || '');
    guideState.cache = new Map();
    guideState.loadingDoc = '';
    guideState.pendingAnchor = '';
  }

  if (!data?.exists) {
    return [
      '<div class="guide-shell guide-shell-empty">',
      `<div class="guide-empty">${escapeHtml(guideText('noRoot'))}</div>`,
      data?.path ? `<div class="guide-empty-path">${escapeHtml(String(data.path))}</div>` : '',
      '</div>',
    ].join('');
  }

  const tree = Array.isArray(data.tree) ? data.tree : [];
  const docs = flattenGuideDocs(tree);
  if (docs.length === 0) {
    return [
      '<div class="guide-shell guide-shell-empty">',
      `<div class="guide-empty">${escapeHtml(guideText('noDocs'))}</div>`,
      '</div>',
    ].join('');
  }

  if (!guideState.currentDoc || !findGuideDocInTree(tree, guideState.currentDoc)) {
    const remembered = guideGetLastDoc(agent.id);
    guideState.currentDoc = (remembered && findGuideDocInTree(tree, remembered))
      ? remembered
      : String(data.defaultDoc || docs[0].id);
    guideSaveLastDoc(agent.id, guideState.currentDoc);
  }

  const cached = guideState.cache.get(guideState.currentDoc);
  if (!cached || Date.now() - cached.fetchedAt > GUIDE_DOC_CACHE_TTL_MS) {
    guideScheduleDocLoad(agent.id, guideState.currentDoc);
  }

  const ancestors = guideAncestorDirIds(guideState.currentDoc);
  const articleInner = cached ? renderGuideArticleInner(cached) : renderGuideLoadingInner();
  const shellHtml = [
    '<div class="guide-shell" data-guide-agent="' + escapeHtml(agent.id) + '" data-guide-block="' + escapeHtml(String(block.id || '')) + '">',
    '<aside class="guide-toc">',
    `<nav class="guide-toc-tree">${renderGuideTreeNodes(tree, ancestors)}</nav>`,
    '</aside>',
    '<section class="guide-main">',
    `<div class="guide-article-scroll"><article class="guide-article"${cached ? ` data-guide-path="${escapeHtml(guideState.currentDoc)}" data-guide-fetched-at="${cached.fetchedAt}"` : ''}>${articleInner}</article>`,
    '<footer class="guide-pager"></footer>',
    '</div>',
    '</section>',
    '</div>',
  ].join('');

  // shell 可能被主渲染管线随时整串重建（轮询/切 tab），DOM 插入后统一补装饰与
  // 翻页器——这是它们生效的唯一入口，缓存命中路径同样必须走。
  requestAnimationFrame(() => guidePatchArticle(agent.id));
  return shellHtml;
}

function renderGuideArticleInner(entry) {
  return `<div class="guide-article-body markdown-body">${entry.html}</div>`;
}

function renderGuideLoadingInner() {
  return `<div class="guide-article-loading">${escapeHtml(guideText('loading'))}</div>`;
}

// ══════════════════════════════════════════════════════════════
//  文档加载与装饰
// ══════════════════════════════════════════════════════════════

function guideScheduleDocLoad(agentId, docPath) {
  if (guideState.loadingDoc === docPath) return;
  setTimeout(() => {
    guideLoadDoc(agentId, docPath).catch((error) => console.error('[guide] load failed', error));
  }, 0);
}

async function guideLoadDoc(agentId, docPath) {
  const token = ++guideState.loadingToken;
  guideState.loadingDoc = docPath;
  try {
    const response = await fetch(`/protoclaw/guide_doc?agentId=${encodeURIComponent(agentId)}&doc=${encodeURIComponent(docPath)}`);
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    if (guideState.agentId !== agentId) return;
    const doc = {
      path: docPath,
      title: payload.doc?.title || docPath,
      content: String(payload.doc?.content || ''),
    };
    guideState.cache.set(docPath, {
      path: docPath,
      title: doc.title,
      html: buildGuideArticleHtml(doc, agentId),
      fetchedAt: Date.now(),
    });
  } catch (error) {
    console.error('[guide] failed to load doc', docPath, error);
    guideState.cache.set(docPath, {
      path: docPath,
      title: docPath,
      html: `<div class="guide-article-error">${escapeHtml(guideText('loadFailed'))}<span class="guide-error-detail">${escapeHtml(String(error?.message || error))}</span></div>`,
      fetchedAt: Date.now(),
    });
  } finally {
    if (guideState.loadingDoc === docPath) guideState.loadingDoc = '';
    if (guideState.agentId === agentId && guideState.currentDoc === docPath && token === guideState.loadingToken) {
      guidePatchArticle(agentId);
    }
  }
}

function guideCurrentBlockData(agentId, blockId) {
  const agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
  if (agent?.id !== agentId) return null;
  return getGuideData(agent, { id: blockId });
}

/**
 * 文章区装饰与翻页器/大纲的唯一生效入口。幂等：同一 entry（fetchedAt 未变）
 * 不重写 innerHTML（避免 TTL 重取时闪烁），只补装饰、大纲与翻页器；
 * entry 变化（首次加载完成 / 重取完成）才整体重写。
 */
function guidePatchArticle(agentId) {
  const shell = document.querySelector(`.guide-shell[data-guide-agent="${CSS.escape(agentId)}"]`);
  if (!shell) return;
  const article = shell.querySelector('.guide-article');
  if (!article) return;

  const docPath = guideState.currentDoc;
  const entry = guideState.cache.get(docPath);
  if (!entry) {
    guideScheduleDocLoad(agentId, docPath);
    return;
  }

  const articleIsCurrent = article.dataset.guidePath === docPath
    && article.dataset.guideFetchedAt === String(entry.fetchedAt);
  if (!articleIsCurrent) {
    article.innerHTML = renderGuideArticleInner(entry);
    article.dataset.guidePath = docPath;
    article.dataset.guideFetchedAt = String(entry.fetchedAt);
    if (typeof enhanceMathInElement === 'function') {
      enhanceMathInElement(article);
    }
  }

  guideDecorateArticle(article, docPath);
  guideRenderPager(shell);

  const anchor = guideState.pendingAnchor;
  guideState.pendingAnchor = '';
  const scrollContainer = shell.querySelector('.guide-article-scroll') || article;
  requestAnimationFrame(() => {
    if (anchor) {
      guideScrollToHeading(shell, anchor);
    } else if (!articleIsCurrent) {
      // 仅内容变化时恢复滚动；chrome-only 重补不动阅读位置
      scrollContainer.scrollTop = guideState.scrollMemory.get(docPath) || 0;
    }
  });
}

function guideRenderPager(shell) {
  const pager = shell.querySelector('.guide-pager');
  if (!pager) return;
  const data = guideCurrentBlockData(guideState.agentId, guideState.blockId);
  const docs = flattenGuideDocs(Array.isArray(data?.tree) ? data.tree : []);
  const index = docs.findIndex((doc) => doc.id === guideState.currentDoc);
  if (index === -1) {
    pager.innerHTML = '';
    return;
  }
  const cell = (doc, label) => (doc
    ? `<button class="guide-pager-cell" type="button" data-guide-doc-jump="${escapeHtml(doc.id)}"><span class="guide-pager-label">${escapeHtml(label)}</span><span class="guide-pager-title">${escapeHtml(guideDocLabel(doc))}</span></button>`
    : '<span class="guide-pager-cell empty"></span>');
  pager.innerHTML = [
    cell(docs[index - 1], `← ${guideText('prev')}`),
    cell(docs[index + 1], `${guideText('next')} →`),
  ].join('');
}

let guideDelegated = false;

function guideEnsureDelegated() {
  if (guideDelegated) return;
  guideDelegated = true;

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !target.closest('.guide-shell')) return;

    // 目录树 / 翻页器的文档跳转（文件路径是外部输入，一律走 data 属性 + 委托，
    // 不用 inline onclick —— 文件名可携带 JS 逃逸字符）
    const jumpButton = target.closest('[data-guide-doc-jump]');
    if (jumpButton) {
      window.guideOpenDoc(jumpButton.dataset.guideDocJump || '', '');
      return;
    }
    const dirButton = target.closest('[data-guide-toggle-dir]');
    if (dirButton) {
      window.guideToggleDir(dirButton.dataset.guideToggleDir || '');
      return;
    }
    const docLink = target.closest('a[data-guide-doc]');
    if (docLink) {
      event.preventDefault();
      window.guideOpenDoc(docLink.dataset.guideDoc || '', docLink.dataset.guideAnchor || '');
      return;
    }
    const anchorLink = target.closest('a[data-guide-anchor]');
    if (anchorLink) {
      event.preventDefault();
      const shell = target.closest('.guide-shell');
      guideScrollToHeading(shell, anchorLink.dataset.guideAnchor || '');
      return;
    }
    const image = target.closest('.guide-image-block img[data-guide-src]');
    if (image) {
      event.preventDefault();
      window.openImageZoom(image.dataset.guideSrc || '');
    }
  });

  // 阅读位置持续记录：scroll 不冒泡，用 document 捕获监听各滚动容器
  document.addEventListener('scroll', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !target.classList?.contains('guide-article-scroll')) return;
    if (!guideState.currentDoc) return;
    guideState.scrollMemory.set(guideState.currentDoc, target.scrollTop || 0);
  }, { capture: true, passive: true });
}

/** 页内锚点定位：按标题文本匹配（跨文档锚点在装饰期转为本 data 属性）。 */
function guideScrollToHeading(shell, anchorText) {
  const article = shell?.querySelector('.guide-article-body');
  if (!article || !anchorText) return;
  const target = String(anchorText).trim().toLowerCase();
  const headings = article.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const heading of headings) {
    if ((heading.textContent || '').trim().toLowerCase() === target) {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
  }
}

/**
 * 文档渲染后装饰链接：
 *   - 相对 .md 链接（含锚点）→ 阅读器内跳转；纯锚点 → 页内滚动。
 *   - 其它相对路径（图片/附件等）→ 资产代理 URL，新窗口打开。
 *   - 外部链接 → 新窗口打开。
 */
function guideDecorateArticle(article, docPath) {
  article.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href') || '';
    if (!href) return;
    const resolved = resolveGuideHref(href, docPath);
    if (!resolved) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      return;
    }
    if (!resolved.path) {
      if (resolved.anchor) {
        link.dataset.guideAnchor = resolved.anchor;
        link.removeAttribute('href');
        link.classList.add('guide-anchor-link');
      }
      return;
    }
    if (/\.md$/i.test(resolved.path)) {
      link.dataset.guideDoc = resolved.path;
      if (resolved.anchor) link.dataset.guideAnchor = resolved.anchor;
      link.removeAttribute('href');
      link.classList.add('guide-doc-link');
      return;
    }
    link.setAttribute('href', guideAssetUrl(guideState.agentId, resolved.path));
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  });
}

// ══════════════════════════════════════════════════════════════
//  Window handlers
// ══════════════════════════════════════════════════════════════

window.guideOpenDoc = (docPath, anchor) => {
  if (!docPath) return;
  const scrollContainer = document.querySelector('.guide-article-scroll');
  if (scrollContainer && guideState.currentDoc) {
    guideState.scrollMemory.set(guideState.currentDoc, scrollContainer.scrollTop || 0);
  }
  guideState.currentDoc = docPath;
  guideState.pendingAnchor = String(anchor || '');
  guideSaveLastDoc(guideState.agentId, docPath);
  if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
};

window.guideToggleDir = (dirId) => {
  if (!dirId) return;
  if (guideState.collapsedDirs.has(dirId)) guideState.collapsedDirs.delete(dirId);
  else guideState.collapsedDirs.add(dirId);
  if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
};
