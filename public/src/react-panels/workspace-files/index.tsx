// 文件面板（DSH 式页签/分栏模型）：
// - 一切皆页签：每个 pane = 上方 gen-ui-surface-tabs 页签条 + 下方单一内容区，
//   默认单 pane；「文件树」是首个 pane 里不可关闭的常驻页签，可像文件页签
//   一样拖拽分栏/转移（源 pane 只剩它时不可拆）。
// - 文件页签可拖到 pane 内容区左/右半区（虚线提示卡）→ 拆出左右分栏；
//   docked pane 最多 2 个，中间 divider 可拖宽且带可视分隔线。已是双 pane
//   时落区按既有分区分：整个对方 pane 高亮（不再左右半拆），松开 = 移动
//   页签到对方 pane（源 pane 因此变空则并回单 pane）。
// - 页签行滚轮：悬停页签条时滚轮不穿透滚动页面；该行有隐藏页签（溢出）
//   时滚轮量转为该行横向滚动，未溢出则只拦截不动作。
// - 非激活页签保持挂载（display:none），滚动与视图状态不丢。
// - 按会话缓存状态：切换会话时把页签/分栏/展开/文件内容快照进内存缓存，
//   切回原会话即恢复（面板关闭重开也恢复，上限 8 个会话，LRU 淘汰）。
// - 无任何轮询：会话身份经 claw:session-view-changed 事件感知；目录在
//   面板打开与每次展开目录时读取（展开即取最新，无需手动刷新按钮）。
// - 文件按类型渲染（对齐 DSH DocumentPreview 支持矩阵）：markdown 走全局
//   renderMarkdown 管线；代码用全局 hljs 高亮 + 行号槽；图片走服务端 base64
//   dataUrl；csv/tsv 表格化；html/htm 以沙箱 iframe（禁脚本）渲染源码；
//   pdf/video/audio 经 base64 → object URL 用浏览器原生查看器。
// - 树行图标照搬 DSH：目录 = 开/合文件夹图标（三级墨色），文件 = 按类型
//   着色的 FileTypeIcon（代码/配置为全彩方章，其余为「页身 + 类型角标」）。
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import cssText from './style.css';
import { FileTypeIcon, FolderCloseIcon, FolderOpenIcon } from './icons.tsx';
import type { ReactNode } from 'react';

type Entry = { name: string; path: string; kind: 'directory' | 'file'; supported?: boolean; size?: number };
type TreeNode = { entries?: Entry[]; loading?: boolean; error?: string };
type Preview =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'text'; content: string }
  | { state: 'image'; dataUrl: string; mimeType: string }
  | { state: 'pdf' | 'video' | 'audio'; url: string; mimeType: string };
type FileTab = { path: string; name: string; preview: Preview };
type Identity = { agentId: string; sessionId: string };
type Pane = { id: number; tabs: string[]; active: string }; // 页签 id：'tree' 或文件路径
// center = 双 pane 时的落区形态：整个对方 pane 高亮，语义是移动页签而非再拆分。
type DockHint = { paneId: number; side: 'left' | 'right' | 'center' };
type PanelSnapshot = {
  tree: Record<string, TreeNode>;
  expanded: Set<string>;
  files: Record<string, FileTab>;
  panes: Pane[];
  activePaneId: number;
  splitRatio: number;
  imageModes: Record<string, 'fit' | 'full'>;
  nextPaneId: number;
};

const TREE_TAB = 'tree';
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const CSV_EXTENSIONS = new Set(['.csv', '.tsv']);
const HLJS_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.json': 'json', '.jsonc': 'json',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.html': 'xml', '.htm': 'xml', '.xml': 'xml', '.svg': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'ini', '.ini': 'ini', '.env': 'ini',
  '.sh': 'bash', '.bash': 'bash', '.ps1': 'powershell', '.bat': 'dos', '.cmd': 'dos',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.kt': 'kotlin', '.kts': 'kotlin', '.swift': 'swift', '.dart': 'dart',
  '.scala': 'scala', '.lua': 'lua', '.pl': 'perl',
  '.sql': 'sql', '.diff': 'diff', '.patch': 'diff',
  '.md': 'markdown', '.markdown': 'markdown', '.graphql': 'graphql', '.proto': 'protobuf',
};

// 会话级状态缓存：面板卸载/会话切换都不丢，LRU 上限 8 个会话。
const sessionStateCache = new Map<string, PanelSnapshot>();
const MAX_CACHED_SESSIONS = 8;

function extensionOf(filePath: string) {
  const name = filePath.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function readIdentity(explicit?: { agentId?: string; sessionId?: string } | null): Identity {
  const source = explicit && (explicit.agentId || explicit.sessionId)
    ? explicit
    : (typeof window.getCurrentSessionViewIdentity === 'function' ? window.getCurrentSessionViewIdentity() : null);
  return { agentId: String(source?.agentId || ''), sessionId: String(source?.sessionId || '') };
}

function identityEquals(a: Identity, b: Identity) {
  return a.agentId === b.agentId && a.sessionId === b.sessionId;
}

function clampRatio(value: number) {
  return Math.min(0.8, Math.max(0.2, value));
}

// pdf / video / audio 的预览地址：同源 raw 端点直连（页面 CSP default-src 'self'
// 允许同源 iframe/media；data: 与 blob: 均会被 CSP 拦截，不可用）。
function rawFileUrl(identity: Identity, filePath: string) {
  const params = new URLSearchParams({
    agentId: identity.agentId,
    sessionId: identity.sessionId,
    path: filePath,
  });
  return `/protoclaw/workspace-files/raw?${params.toString()}`;
}

function renderMarkdownHtml(text: string): string | null {
  try {
    if (typeof window.renderMarkdown === 'function') return String(window.renderMarkdown(text) ?? '');
  } catch { /* 渲染管线不可用时回退源码视图 */ }
  return null;
}

/** RFC4180 风格分隔表解析：引号转义 + 换行符归一，分隔符按首行频次探测。 */
function parseDelimitedTable(text: string, forcedDelimiter?: string): string[][] {
  const firstBreak = text.indexOf('\n');
  const firstLine = text.slice(0, firstBreak === -1 ? text.length : firstBreak);
  let delimiter = forcedDelimiter ?? ',';
  if (!forcedDelimiter) {
    let best = -1;
    for (const candidate of [',', ';', '\t', '|']) {
      const count = firstLine.split(candidate).length - 1;
      if (count > best) { best = count; delimiter = candidate; }
    }
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

const CSV_MAX_ROWS = 2000;
const CSV_MAX_COLUMNS = 80;

/** docx 预览：raw URL 取字节流交给 docx-preview 保留排版渲染。
 *  DSH 的 word 方案是 LibreOffice 转 PDF（本机无该引擎），此处取等效浏览器端渲染；
 *  渲染库按需动态 import，面板未打开 docx 时不付出加载成本。 */
function DocxView({ url, name }: { url: string; name: string }) {
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    setError(null);
    container.replaceChildren();
    (async () => {
      try {
        const [response, module] = await Promise.all([fetch(url), import('docx-preview')]);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (cancelled) return;
        await module.renderAsync(await response.arrayBuffer(), container, undefined, {
          inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false,
        });
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { cancelled = true; };
  }, [url]);
  if (error) return <div className="wf-empty wf-error">无法渲染文档：{error}</div>;
  return <div className="wf-docx-scroll" ref={containerRef} aria-label={name} />;
}

/** xlsx 预览：SheetJS 读取首个工作表，按单元格数据自渲染表格（复用 CSV 表样式，
 *  不引入 sheet_to_html 的原始 HTML 注入面）。与 DSH 自研 Excel 解析器语义一致：
 *  展示数据网格而非还原排版。 */
function XlsxView({ url }: { url: string }) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    (async () => {
      try {
        const [response, XLSX] = await Promise.all([fetch(url), import('xlsx')]);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const workbook = XLSX.read(await response.arrayBuffer(), { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
        if (!sheet) throw new Error('工作簿中没有工作表');
        const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });
        if (cancelled) return;
        setRows(matrix.map(row => row.map(cell => String(cell ?? ''))));
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { cancelled = true; };
  }, [url]);
  if (error) return <div className="wf-empty wf-error">无法读取表格：{error}</div>;
  if (!rows) return <div className="wf-empty">正在解析表格…</div>;
  const truncatedRows = rows.length > CSV_MAX_ROWS;
  const truncatedColumns = rows.some(row => row.length > CSV_MAX_COLUMNS);
  const visible = rows.slice(0, CSV_MAX_ROWS).map(row => row.slice(0, CSV_MAX_COLUMNS));
  return (
    <div className="wf-csv-wrap">
      <table className="wf-csv-table">
        <tbody>
          {visible.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex === 0 ? 'wf-csv-head' : undefined}>
              {row.map((cell, columnIndex) => <td key={columnIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {(truncatedRows || truncatedColumns) && (
        <div className="wf-csv-note">仅显示首个工作表前 {CSV_MAX_ROWS} 行 / {CSV_MAX_COLUMNS} 列，完整内容请打开源文件</div>
      )}
    </div>
  );
}


function CsvView({ content, delimiter }: { content: string; delimiter?: string }) {
  const rows = useMemo(() => parseDelimitedTable(content, delimiter), [content, delimiter]);
  const truncatedRows = rows.length > CSV_MAX_ROWS;
  const truncatedColumns = rows.some(row => row.length > CSV_MAX_COLUMNS);
  const visible = useMemo(() => rows.slice(0, CSV_MAX_ROWS).map(row => row.slice(0, CSV_MAX_COLUMNS)), [rows]);
  return (
    <div className="wf-csv-wrap">
      <table className="wf-csv-table">
        <tbody>
          {visible.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex === 0 ? 'wf-csv-head' : undefined}>
              {row.map((cell, columnIndex) => <td key={columnIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {(truncatedRows || truncatedColumns) && (
        <div className="wf-csv-note">仅显示前 {CSV_MAX_ROWS} 行 / {CSV_MAX_COLUMNS} 列，完整内容请打开源文件</div>
      )}
    </div>
  );
}

function CodeView({ path, content }: { path: string; content: string }) {
  const lineNumbers = useMemo(() => content.split('\n').map((_, index) => index + 1).join('\n'), [content]);
  const language = HLJS_LANGUAGE_BY_EXTENSION[extensionOf(path)];
  const highlighted = useMemo(() => {
    if (!language || !window.hljs || typeof window.hljs.getLanguage !== 'function'
      || !window.hljs.getLanguage(language) || typeof window.hljs.highlight !== 'function') return null;
    try { return String(window.hljs.highlight(content, { language }).value ?? ''); } catch { return null; }
  }, [content, language]);
  return (
    <div className="wf-code-wrap">
      <div className="wf-gutter" aria-hidden="true">{lineNumbers}</div>
      {highlighted !== null
        ? <pre className="wf-code"><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
        : <pre className="wf-code"><code>{content}</code></pre>}
    </div>
  );
}

function FileView({ file, imageMode, onToggleImageMode }: {
  file: FileTab;
  imageMode: 'fit' | 'full';
  onToggleImageMode: (path: string) => void;
}) {
  const preview = file.preview;
  if (preview.state === 'loading') return <div className="wf-empty">正在读取文件…</div>;
  if (preview.state === 'error') return <div className="wf-empty wf-error">无法打开文件：{preview.message}</div>;
  if (preview.state === 'image') {
    return <>
      <div className="wf-image-bar">
        <button type="button" className="wf-image-toggle" onClick={() => onToggleImageMode(file.path)}>
          {imageMode === 'fit' ? '原始大小' : '适应窗口'}
        </button>
        <span className="wf-image-meta">{imageMode === 'fit' ? '适应窗口' : '原始大小'}</span>
      </div>
      <div className={`wf-image-stage${imageMode === 'full' ? ' is-full' : ''}`}>
        <img src={preview.dataUrl} alt={file.name} draggable={false} />
      </div>
    </>;
  }
  if (preview.state === 'pdf') {
    return <iframe className="wf-binary-frame" src={preview.url} title={file.name} />;
  }
  if (preview.state === 'docx') {
    return <DocxView url={preview.url} name={file.name} />;
  }
  if (preview.state === 'xlsx') {
    return <XlsxView url={preview.url} name={file.name} />;
  }
  if (preview.state === 'video') {
    return <div className="wf-media-stage"><video controls preload="metadata" src={preview.url} /></div>;
  }
  if (preview.state === 'audio') {
    return <div className="wf-media-stage wf-media-audio"><audio controls preload="metadata" src={preview.url} /></div>;
  }
  const extension = extensionOf(file.path);
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    const html = renderMarkdownHtml(preview.content);
    if (html !== null) return <div className="wf-md markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (CSV_EXTENSIONS.has(extension)) return <CsvView content={preview.content} delimiter={extension === '.tsv' ? '\t' : undefined} />;
  if (HTML_EXTENSIONS.has(extension)) {
    return <iframe className="wf-binary-frame" srcDoc={preview.content} sandbox="" title={file.name} />;
  }
  return <CodeView path={file.path} content={preview.content} />;
}

/* ── 页签分行：确定性算法（用户澄清的规则）─────────────────
 * 换行判定只有一个：不换行就会完全隐藏的页签才换到下一行。
 * 全部页签按压缩宽度（104，与全局 tab-item 的 min-width 对齐）计，
 * 本行容量 capacity = ceil(容器宽 / 104)：第 capacity 个页签左缘仍在
 * 容器内（部分可见，溢出部分由行滚动容器裁切）；只有左缘会越过容器
 * 右缘的页签才换行。因此满行行尾永远顶到右缘，不出现空档；最后一行
 * 允许不满（它是行尾，无空档问题）。
 * 不做逐页签宽度测量——只依赖容器宽度，天然免疫字体加载/布局时序。 */
const TAB_MIN_WIDTH = 104;

function computeTabRows(tabIds: string[], available: number): string[][] {
  if (available <= 0 || tabIds.length <= 1) return [tabIds];
  const capacity = Math.max(1, Math.ceil(available / TAB_MIN_WIDTH));
  if (tabIds.length <= capacity) return [tabIds];
  const rows: string[][] = [];
  for (let index = 0; index < tabIds.length; index += capacity) {
    rows.push(tabIds.slice(index, index + capacity));
  }
  return rows;
}

function insertTabAt(tabs: string[], tabId: string, targetId: string, after: boolean) {
  const withoutDragged = tabs.filter(id => id !== tabId);
  const targetIndex = withoutDragged.indexOf(targetId);
  if (targetIndex < 0) return [...withoutDragged, tabId];
  withoutDragged.splice(targetIndex + (after ? 1 : 0), 0, tabId);
  return withoutDragged;
}

/* 拖拽手势门槛：
 * - DRAG_ARM_DELAY：按住该时长后才进入“已拿起”状态（此前移动视为点击/误触）。
 * - DRAG_INTENT_DISTANCE：从拖拽起点算的意图距离。原生拖拽在按住后只需
 *   约 4-5px 的无感位移就会启动并持续触发 dragover，配合“始终显示最近
 *   槽位”会让蓝线在体感“没动”时就出现（多行页签下纵向漂移到相邻行同理）。
 *   位移不足该距离期间一律不显示插入线与停靠提示，释放也不触发排序。 */
const DRAG_ARM_DELAY = 180;
const DRAG_INTENT_DISTANCE = 24;

function WorkspaceFiles() {
  const [identity, setIdentity] = useState<Identity>(readIdentity);
  const [tree, setTree] = useState<Record<string, TreeNode>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [files, setFiles] = useState<Record<string, FileTab>>({});
  const [panes, setPanes] = useState<Pane[]>([{ id: 1, tabs: [TREE_TAB], active: TREE_TAB }]);
  const [activePaneId, setActivePaneId] = useState(1);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [dragReadyTab, setDragReadyTab] = useState<string | null>(null);
  const [dragOverTab, setDragOverTab] = useState<{ paneId: number; rowKey: string; tabId: string; side: 'before' | 'after'; offsetX: number } | null>(null);
  const dragArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragArmedRef = useRef(false);
  const dragArmOrigin = useRef<{ x: number; y: number } | null>(null);
  const dragStartOrigin = useRef<{ x: number; y: number } | null>(null);
  const [dockHint, setDockHint] = useState<DockHint | null>(null);
  const [imageModes, setImageModes] = useState<Record<string, 'fit' | 'full'>>({});
  const paneRowRef = useRef<HTMLDivElement | null>(null);
  const tabstripRefs = useRef(new Map<number, HTMLDivElement | null>());
  const [tabRows, setTabRows] = useState<Record<number, string[][]>>({});

  // 页签分行重算：tab 集变化与容器宽度变化（ResizeObserver）都触发。
  // 确定性算法只读容器宽度，无逐页签测量，无时序问题。
  const recomputeTabRows = useCallback(() => {
    setTabRows(current => {
      const next: Record<number, string[][]> = {};
      let changed = false;
      for (const pane of panes) {
        const strip = tabstripRefs.current.get(pane.id) ?? null;
        const rows = computeTabRows(pane.tabs, strip ? strip.clientWidth : 0);
        next[pane.id] = rows;
        if (current[pane.id]?.join('\u0001') !== rows.join('\u0001')) changed = true;
      }
      return changed ? next : current;
    });
  }, [panes]);

  useLayoutEffect(() => { recomputeTabRows(); }, [panes, recomputeTabRows]);

  useEffect(() => {
    const observer = new ResizeObserver(() => recomputeTabRows());
    for (const element of tabstripRefs.current.values()) {
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [panes, recomputeTabRows]);

  // 页签行滚轮接管（原生监听，passive:false）：React 17+ 把 onWheel 以 passive
  // 注册在 root 上，preventDefault 不生效，无法拦截穿透滚动，必须原生注册。
  // 行为约定：悬停页签条时滚轮一律不带动页面/面板滚动（页签条是固定 UI）；
  // 该行溢出（scrollWidth > clientWidth，有被裁切的页签）时把滚轮量（纵+横）
  // 转为该行横向滚动；未溢出只拦截不动作。deltaMode 归一化兼容行/页模式。
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    for (const strip of tabstripRefs.current.values()) {
      if (!strip) continue;
      const onWheel = (event: WheelEvent) => {
        const row = event.target instanceof Element ? event.target.closest('.wf-tab-row') : null;
        if (!row) return;
        event.preventDefault();
        if (row.scrollWidth <= row.clientWidth + 1) return;
        const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? row.clientHeight : 1;
        row.scrollLeft += (event.deltaY + event.deltaX) * unit;
      };
      strip.addEventListener('wheel', onWheel, { passive: false });
      cleanups.push(() => strip.removeEventListener('wheel', onWheel));
    }
    return () => { for (const cleanup of cleanups) cleanup(); };
  }, [panes]);

  // 选中部分隐藏的页签 → 所在行横向滚动让它完整露出（含关闭按钮）；
  // 此后左侧出现部分隐藏项时，选中它则往回滚动露出。
  // 亚像素级（≤1px）的偏差直接忽略：flex 拉伸的行内和常带小数，逐次触发
  // 平滑滚动会让行持续微动，既无视觉价值也干扰指针交互的稳定性判定。
  useLayoutEffect(() => {
    for (const strip of tabstripRefs.current.values()) {
      const active = strip?.querySelector<HTMLElement>('.gen-ui-surface-tab-item.is-active');
      const row = active?.closest<HTMLElement>('.wf-tab-row');
      if (!strip || !active || !row) continue;
      const left = active.offsetLeft;
      const right = left + active.offsetWidth;
      const overshoot = right - (row.scrollLeft + row.clientWidth);
      const undershoot = row.scrollLeft - left;
      if (overshoot > 1) {
        row.scrollTo({ left: row.scrollLeft + overshoot, behavior: 'smooth' });
      } else if (undershoot > 1) {
        row.scrollTo({ left: left, behavior: 'smooth' });
      }
    }
  }, [panes, tabRows]);

  const renderTab = (pane: Pane, tabId: string) => {
    const isTree = tabId === TREE_TAB;
    const file = files[tabId];
    const isActive = pane.active === tabId;
    const label = isTree ? '文件树' : (file?.name ?? (tabId.split('/').pop() || tabId));
    return (
      <div
        key={tabId}
        data-tab-id={tabId}
        className={`gen-ui-surface-tab-item${isActive ? ' is-active' : ''} wf-draggable-tab${dragTab === tabId ? ' is-drag-source' : ''}${dragReadyTab === tabId ? ' is-drag-ready' : ''}`}
        draggable
        onPointerDown={onTabPointerDown(tabId)}
        onDragStart={onTabDragStart(tabId)}
        onDragEnd={onTabDragEnd}
        onClick={event => {
          if (event.target instanceof Element && event.target.closest('.gen-ui-surface-tab-close')) return;
          activateTab(pane.id, tabId);
        }}
      >
        <button
          type="button"
          className="gen-ui-surface-tab"
          role="tab"
          aria-selected={isActive}
          title={isTree ? '工作目录文件树' : tabId}
        >
          <span className="wf-tab-icon" aria-hidden="true">
            {isTree ? <FolderCloseIcon size={14} /> : <FileTypeIcon path={label} size={14} />}
          </span>
          <span className="wf-tab-label">{label}</span>
        </button>
        {!isTree && (
          <button
            type="button"
            className="gen-ui-surface-tab-close"
            title={`关闭 ${label}`}
            aria-label={`关闭 ${label}`}
            onClick={() => closeTab(pane.id, tabId)}
          >×</button>
        )}
      </div>
    );
  };
  const nextPaneId = useRef(2);
  const identityKey = `${identity.agentId}:${identity.sessionId}`;
  // null = 组件刚挂载、尚未恢复过状态：保证 remount（面板折叠再展开）也走缓存恢复分支。
  const stateKeyRef = useRef<string | null>(null);

  // 每次提交后把状态快照进会话缓存（值为不可变快照，存引用即可）。
  // 先于身份切换 effect 定义：切换渲染发生时，本 effect 仍以旧 key 保存旧状态。
  // 挂载首轮（key 尚为 null）跳过：此时组件状态还是初始空值，写入会污染缓存。
  useEffect(() => {
    if (stateKeyRef.current === null) return;
    sessionStateCache.set(stateKeyRef.current, {
      tree, expanded, files, panes, activePaneId, splitRatio, imageModes, nextPaneId: nextPaneId.current,
    });
  });

  // 会话身份变化：事件驱动（session-view-state 广播），无轮询。
  useEffect(() => {
    const onViewChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail as { identity?: { agentId?: string; sessionId?: string } } | undefined;
      const next = readIdentity(detail?.identity ?? null);
      setIdentity(current => (identityEquals(current, next) ? current : next));
    };
    window.addEventListener('claw:session-view-changed', onViewChanged);
    return () => window.removeEventListener('claw:session-view-changed', onViewChanged);
  }, []);

  // 身份切换：当前状态已由上面的快照 effect 存进旧 key；此处从缓存恢复
  // 新会话状态（无缓存则复位为初始单 pane 形态），并做 LRU 淘汰。
  useEffect(() => {
    if (stateKeyRef.current === identityKey) return;
    while (sessionStateCache.size > MAX_CACHED_SESSIONS) {
      const oldest = sessionStateCache.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === stateKeyRef.current || oldest === identityKey) break;
      sessionStateCache.delete(oldest);
    }
    const cached = sessionStateCache.get(identityKey);
    if (cached) {
      setTree(cached.tree);
      setExpanded(cached.expanded);
      setFiles(cached.files);
      setPanes(cached.panes);
      setActivePaneId(cached.activePaneId);
      setSplitRatio(cached.splitRatio);
      setImageModes(cached.imageModes);
      nextPaneId.current = cached.nextPaneId;
    } else {
      setTree(identity.agentId && identity.sessionId ? { '': { loading: true } } : {});
      setExpanded(new Set(['']));
      setFiles({});
      setPanes([{ id: 1, tabs: [TREE_TAB], active: TREE_TAB }]);
      setActivePaneId(1);
      setSplitRatio(0.5);
      setImageModes({});
      nextPaneId.current = 2;
    }
    stateKeyRef.current = identityKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);

  const loadDirectory = useCallback(async (directory: string) => {
    if (!identity.agentId || !identity.sessionId) return;
    setTree(current => ({ ...current, [directory]: { ...current[directory], loading: true, error: undefined } }));
    try {
      const response = await fetch('/protoclaw/workspace-files/list', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...identity, path: directory }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (!identityEquals(readIdentity(), identity)) return;
      setTree(current => ({ ...current, [directory]: { entries: body.entries } }));
    } catch (error) {
      if (!identityEquals(readIdentity(), identity)) return;
      setTree(current => ({ ...current, [directory]: { ...current[directory], loading: false, error: error instanceof Error ? error.message : String(error) } }));
    }
  }, [identity]);

  useEffect(() => {
    if (!identity.agentId || !identity.sessionId) return;
    void loadDirectory('');
  }, [identityKey, loadDirectory]);

  const identityGuarded = () => identityEquals(readIdentity(), identity);

  const openFile = async (entry: Entry) => {
    if (!entry.supported || !identity.agentId || !identity.sessionId) return;
    const existing = panes.find(pane => pane.tabs.includes(entry.path));
    if (existing) {
      setPanes(current => current.map(pane => pane.id === existing.id ? { ...pane, active: entry.path } : pane));
      setActivePaneId(existing.id);
      return;
    }
    const target = panes.find(pane => pane.id === activePaneId) || panes[0];
    setPanes(current => current.map(pane => pane.id === target.id
      ? { ...pane, tabs: [...pane.tabs, entry.path], active: entry.path } : pane));
    setActivePaneId(target.id);
    setFiles(current => ({ ...current, [entry.path]: { path: entry.path, name: entry.name, preview: { state: 'loading' } } }));
    try {
      const response = await fetch('/protoclaw/workspace-files/read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...identity, path: entry.path }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (!identityGuarded()) return;
      let preview: Preview;
      if (body.kind === 'image') {
        preview = { state: 'image', dataUrl: String(body.dataUrl || ''), mimeType: String(body.mimeType || '') };
      } else if (body.kind === 'pdf' || body.kind === 'video' || body.kind === 'audio'
        || body.kind === 'docx' || body.kind === 'xlsx') {
        preview = { state: body.kind, url: rawFileUrl(identity, entry.path), mimeType: String(body.mimeType || '') };
      } else {
        preview = { state: 'text', content: String(body.content ?? '') };
      }
      setFiles(current => {
        const tab = current[entry.path];
        if (!tab) return current;
        return { ...current, [entry.path]: { ...tab, preview } };
      });
    } catch (error) {
      setFiles(current => current[entry.path]
        ? { ...current, [entry.path]: { ...current[entry.path], preview: { state: 'error', message: error instanceof Error ? error.message : String(error) } } }
        : current);
    }
  };

  const activateTab = (paneId: number, tabId: string) => {
    setPanes(current => current.map(pane => pane.id === paneId && pane.active !== tabId ? { ...pane, active: tabId } : pane));
    setActivePaneId(paneId);
  };

  const closeTab = (paneId: number, tabId: string) => {
    if (tabId === TREE_TAB) return;
    const pane = panes.find(item => item.id === paneId);
    if (!pane) return;
    setFiles(current => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    setImageModes(current => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    const remaining = pane.tabs.filter(id => id !== tabId);
    if (remaining.length === 0 && panes.length === 2) {
      const otherPaneId = panes.find(item => item.id !== paneId)?.id;
      setPanes(current => current.filter(item => item.id !== paneId));
      if (otherPaneId !== undefined) setActivePaneId(otherPaneId);
      return;
    }
    const fallbackActive = pane.active === tabId
      ? (pane.tabs[Math.max(0, pane.tabs.indexOf(tabId) - 1)] ?? remaining[0] ?? TREE_TAB)
      : pane.active;
    setPanes(current => current.map(item => item.id === paneId ? { ...item, tabs: remaining, active: fallbackActive } : item));
  };

  const toggleDirectory = (entry: Entry) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else {
        next.add(entry.path);
        void loadDirectory(entry.path); // 展开即取最新目录内容
      }
      return next;
    });
  };

  const clearDragArm = () => {
    if (dragArmTimer.current !== null) clearTimeout(dragArmTimer.current);
    dragArmTimer.current = null;
    dragArmedRef.current = false;
    dragArmOrigin.current = null;
  };

  const onTabPointerDown = (tabId: string) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType === 'touch'
      || (event.target instanceof Element && event.target.closest('.gen-ui-surface-tab-close'))) return;
    clearDragArm();
    dragArmOrigin.current = { x: event.clientX, y: event.clientY };
    dragArmTimer.current = setTimeout(() => {
      dragArmedRef.current = true;
      dragArmTimer.current = null;
      setDragReadyTab(tabId);
    }, DRAG_ARM_DELAY);
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (dragArmTimer.current === null || dragArmedRef.current) return;
      const origin = dragArmOrigin.current;
      if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 5) clearDragArm();
    };
    const onPointerUp = () => {
      clearDragArm();
      setDragReadyTab(null);
    };
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    return () => {
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      clearDragArm();
    };
  }, []);

  const onTabDragStart = (tabId: string) => (event: ReactDragEvent) => {
    if (!dragArmedRef.current) {
      event.preventDefault();
      return;
    }
    clearDragArm();
    setDragTab(tabId);
    dragStartOrigin.current = { x: event.clientX, y: event.clientY };
    event.dataTransfer.setData('text/plain', tabId);
    event.dataTransfer.effectAllowed = 'move';
  };

  const moveTabToPosition = (targetPaneId: number, targetTabId: string, after: boolean) => {
    if (!dragTab || dragTab === targetTabId) return;
    const sourcePane = panes.find(pane => pane.tabs.includes(dragTab));
    const targetPane = panes.find(pane => pane.id === targetPaneId);
    if (!sourcePane || !targetPane) return;
    if (sourcePane.id === targetPaneId) {
      setPanes(current => current.map(pane => pane.id === targetPaneId
        ? { ...pane, tabs: insertTabAt(pane.tabs, dragTab, targetTabId, after) }
        : pane));
    } else {
      const sourceRemaining = sourcePane.tabs.filter(id => id !== dragTab);
      const targetTabs = insertTabAt(targetPane.tabs, dragTab, targetTabId, after);
      setPanes(current => current
        .map(pane => {
          if (pane.id === sourcePane.id) {
            return { ...pane, tabs: sourceRemaining, active: pane.active === dragTab ? (sourceRemaining[0] ?? TREE_TAB) : pane.active };
          }
          if (pane.id === targetPaneId) return { ...pane, tabs: targetTabs, active: dragTab };
          return pane;
        })
        .filter(pane => pane.tabs.length > 0));
      setActivePaneId(targetPaneId);
    }
    setDragTab(null);
    setDragOverTab(null);
    setDockHint(null);
  };

  const getRowDropPosition = (row: HTMLElement, clientX: number) => {
    const items = Array.from(row.querySelectorAll<HTMLElement>(':scope > .gen-ui-surface-tab-item'))
      .filter(item => item.dataset.tabId !== dragTab);
    if (!items.length) return null;
    const bounds = items.map(item => ({ item, rect: item.getBoundingClientRect() }));
    const slots: Array<{ tabId: string; after: boolean; edge: number }> = [];
    slots.push({ tabId: bounds[0].item.dataset.tabId ?? '', after: false, edge: bounds[0].rect.left - 1 });
    for (let index = 0; index < bounds.length - 1; index++) {
      slots.push({
        tabId: bounds[index].item.dataset.tabId ?? '',
        after: true,
        edge: (bounds[index].rect.right + bounds[index + 1].rect.left) / 2,
      });
    }
    const last = bounds[bounds.length - 1];
    slots.push({ tabId: last.item.dataset.tabId ?? '', after: true, edge: last.rect.right + 1 });
    const nearest = slots.reduce((best, slot) =>
      Math.abs(slot.edge - clientX) < Math.abs(best.edge - clientX) ? slot : best);
    const rowRect = row.getBoundingClientRect();
    return {
      tabId: nearest.tabId,
      after: nearest.after,
      // Absolute child position uses the scroll content coordinate system.
      offsetX: Math.round(nearest.edge - rowRect.left + row.scrollLeft - row.clientLeft),
    };
  };

  const keepRowPositionVisible = (row: HTMLElement, contentX: number) => {
    const left = row.scrollLeft;
    const right = left + row.clientWidth;
    if (contentX < left) row.scrollLeft = contentX;
    else if (contentX > right) row.scrollLeft = contentX - row.clientWidth;
  };

  const hasDragIntent = (event: ReactDragEvent) => {
    const origin = dragStartOrigin.current;
    if (!origin) return true;
    return Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= DRAG_INTENT_DISTANCE;
  };

  const onTabRowDragOver = (paneId: number) => (event: ReactDragEvent) => {
    if (!dragTab) return;
    if (!hasDragIntent(event)) {
      setDragOverTab(null);
      setDockHint(null);
      return;
    }
    const row = event.currentTarget as HTMLElement;
    const position = getRowDropPosition(row, event.clientX);
    if (!position?.tabId) {
      // 行内没有可参照的其他页签（典型：该栏只含被拖页签；多行时被拖
      // 页签独占一行同理）。此行不存在有效插入槽，也不允许落点——
      // 同栏单页签拖动应是无效操作，释放即取消，收尾交给 dragend。
      // 跨栏不会走到这里：目标栏不含被拖页签，其行内必有其他页签可参照。
      setDragOverTab(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDockHint(null);
    keepRowPositionVisible(row, position.offsetX);
    const sourcePane = panes.find(pane => pane.tabs.includes(dragTab));
    if (sourcePane?.id === paneId) {
      const reordered = insertTabAt(sourcePane.tabs, dragTab, position.tabId, position.after);
      if (reordered.every((id, index) => id === sourcePane.tabs[index])) {
        setDragOverTab(current => current?.paneId === paneId ? current : null);
        return;
      }
    }
    const side = position.after ? 'after' : 'before';
    const rowKey = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(':scope > .gen-ui-surface-tab-item'))
      .map(item => item.dataset.tabId ?? '').join('\u0000');
    setDragOverTab(current => current?.paneId === paneId && current.rowKey === rowKey
      && current.tabId === position.tabId && current.side === side
      ? current
      : { paneId, rowKey, tabId: position.tabId, side, offsetX: position.offsetX });
  };

  const onTabRowDragLeave = (event: ReactDragEvent) => {
    const row = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
    setDragOverTab(null);
  };

  const onTabRowDrop = (paneId: number) => (event: ReactDragEvent) => {
    if (!dragTab) return;
    if (!hasDragIntent(event)) {
      // 无拖拽意图的释放：只阻止浏览器默认落点行为，不排序，收尾交给 dragend。
      event.preventDefault();
      setDragOverTab(null);
      setDockHint(null);
      return;
    }
    const position = getRowDropPosition(event.currentTarget as HTMLElement, event.clientX);
    if (position) {
      event.preventDefault();
      event.stopPropagation();
      moveTabToPosition(paneId, position.tabId, position.after);
      return;
    }
    // 行内无可参照页签（同栏单页签/独占一行）：无效落点，无事可做。
    // dragover 已不允许此类落点，这里只做防御性清理。
    setDragOverTab(null);
    setDockHint(null);
  };

  const onTabDragEnd = () => {
    clearDragArm();
    setDragReadyTab(null);
    setDragTab(null);
    setDragOverTab(null);
    setDockHint(null);
    dragStartOrigin.current = null;
  };

  const canDock = (targetPaneId: number) => {
    if (!dragTab) return false;
    const sourcePane = panes.find(pane => pane.tabs.includes(dragTab));
    if (!sourcePane) return false;
    return panes.length === 1 || sourcePane.id !== targetPaneId;
  };

  const onPaneBodyDragOver = (paneId: number) => (event: ReactDragEvent) => {
    if (!dragTab || !canDock(paneId)) return;
    if (!hasDragIntent(event)) {
      setDockHint(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    // 落区形态：单 pane 按内容区左/右半区拆分栏；双 pane 按既有分区分——
    // 整个对方 pane 都是落区（side='center'），语义是移动页签到对方 pane，
    // 不再左右半拆（用户澄清：开了两个之后从左往右拖 = 转移到右边 pane）。
    let side: DockHint['side'] = 'center';
    if (panes.length === 1) {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      side = event.clientX - rect.left < rect.width / 2 ? 'left' : 'right';
    }
    setDockHint(current => (current && current.paneId === paneId && current.side === side ? current : { paneId, side }));
  };

  const onPaneBodyDragLeave = (paneId: number) => (event: ReactDragEvent) => {
    if (dockHint?.paneId !== paneId) return;
    if (event.relatedTarget && (event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) return;
    setDockHint(null);
  };

  const performDock = (targetPaneId: number, side: 'left' | 'right') => {
    if (!dragTab || !canDock(targetPaneId)) return;
    const sourcePane = panes.find(pane => pane.tabs.includes(dragTab));
    if (!sourcePane) return;
    if (panes.length === 1) {
      const remaining = sourcePane.tabs.filter(id => id !== dragTab);
      if (remaining.length === 0) return;
      const newPaneId = nextPaneId.current++;
      const newPane: Pane = { id: newPaneId, tabs: [dragTab], active: dragTab };
      const updatedSource: Pane = {
        ...sourcePane,
        tabs: remaining,
        active: sourcePane.active === dragTab ? remaining[0] : sourcePane.active,
      };
      setPanes(side === 'left' ? [newPane, updatedSource] : [updatedSource, newPane]);
      setSplitRatio(0.5);
      setActivePaneId(newPaneId);
    } else {
      const target = panes.find(pane => pane.id === targetPaneId);
      if (!target || targetPaneId === sourcePane.id) return;
      const sourceRemaining = sourcePane.tabs.filter(id => id !== dragTab);
      setPanes(current => current
        .map(pane => {
          if (pane.id === sourcePane.id) {
            return { ...pane, tabs: sourceRemaining, active: pane.active === dragTab ? (sourceRemaining[0] ?? TREE_TAB) : pane.active };
          }
          if (pane.id === targetPaneId) return { ...pane, tabs: [...pane.tabs, dragTab], active: dragTab };
          return pane;
        })
        .filter(pane => pane.tabs.length > 0));
      setActivePaneId(targetPaneId);
    }
    setDragTab(null);
    setDockHint(null);
  };

  const onDividerPointerDown = (event: ReactPointerEvent) => {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onDividerPointerMove = (event: ReactPointerEvent) => {
    if (event.buttons !== 1) return;
    const rect = paneRowRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setSplitRatio(clampRatio((event.clientX - rect.left) / rect.width));
  };

  const onDividerPointerUp = (event: ReactPointerEvent) => {
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  };

  const toggleImageMode = (path: string) => {
    setImageModes(current => ({ ...current, [path]: current[path] === 'full' ? 'fit' : 'full' }));
  };

  const renderTreeEntries = (directory: string, depth = 0): ReactNode => {
    const node = tree[directory];
    if (node?.entries?.length) {
      return node.entries.map(entry => (
        <div key={entry.path}>
          <button
            className={`wf-entry ${entry.kind === 'directory' ? 'wf-directory' : ''} ${!entry.supported && entry.kind === 'file' ? 'wf-unsupported' : ''}`}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            disabled={entry.kind === 'file' && !entry.supported}
            title={!entry.supported && entry.kind === 'file' ? '此文件类型暂不支持预览' : entry.path}
            onClick={() => entry.kind === 'directory' ? toggleDirectory(entry) : void openFile(entry)}
          >
            <span className="wf-entry-icon" aria-hidden="true">
              {entry.kind === 'directory'
                ? (expanded.has(entry.path) ? <FolderOpenIcon size={16} /> : <FolderCloseIcon size={16} />)
                : <FileTypeIcon path={entry.name} size={16} />}
            </span>
            <span className="wf-entry-name">{entry.name}</span>
          </button>
          {entry.kind === 'directory' && expanded.has(entry.path) && renderTreeEntries(entry.path, depth + 1)}
        </div>
      ));
    }
    const depthPadding = `${8 + depth * 14}px`;
    if (node?.loading) return <div className="wf-tree-state" style={{ paddingLeft: depthPadding }}>加载中…</div>;
    if (node?.error) return <button className="wf-tree-state wf-retry" style={{ paddingLeft: depthPadding }} onClick={() => void loadDirectory(directory)}>读取失败，点击重试</button>;
    return <div className="wf-tree-state" style={{ paddingLeft: depthPadding }}>{directory ? '空目录' : '暂无内容'}</div>;
  };

  const renderTabContent = (tabId: string) => {
    if (tabId === TREE_TAB) {
      return <div className="wf-tree">
        {identity.agentId && identity.sessionId ? renderTreeEntries('') : <div className="wf-tree-state">未选择会话</div>}
      </div>;
    }
    const file = files[tabId];
    if (!file) return <div className="wf-empty">页签已失效</div>;
    return <FileView file={file} imageMode={imageModes[tabId] ?? 'fit'} onToggleImageMode={toggleImageMode} />;
  };

  return (
    <div className={`wf-panel${dragTab ? ' is-dragging' : ''}`}>
      <div className="wf-pane-row" ref={paneRowRef}>
        {panes.map((pane, index) => (
          <Fragment key={pane.id}>
            {index > 0 && (
              <div
                className="wf-divider"
                role="separator"
                aria-orientation="vertical"
                title="拖动调整分栏宽度"
                onPointerDown={onDividerPointerDown}
                onPointerMove={onDividerPointerMove}
                onPointerUp={onDividerPointerUp}
              />
            )}
            <section
              className="wf-pane"
              style={{ flex: panes.length === 2 ? `0 0 ${(index === 0 ? splitRatio : 1 - splitRatio) * 100}%` : '1 1 0%' }}
            >
              <div
                ref={element => { tabstripRefs.current.set(pane.id, element); }}
                className={`settings-tab-bar gen-ui-surface-tabs wf-tabstrip${(tabRows[pane.id]?.length ?? 1) > 1 ? ' is-multi' : ''}`}
                role="tablist"
                aria-label="文件面板页签"
              >
                {(tabRows[pane.id] ?? [pane.tabs]).map(row => (
                  <div
                    className="wf-tab-row"
                    key={row.join('\u0000')}
                    onDragOver={onTabRowDragOver(pane.id)}
                    onDragLeave={onTabRowDragLeave}
                    onDrop={onTabRowDrop(pane.id)}
                  >
                    {row.map(tabId => renderTab(pane, tabId))}
                    {dragOverTab?.paneId === pane.id
                      && dragOverTab.rowKey === row.join('\u0000')
                      && dragTab !== dragOverTab.tabId && (
                        <span
                          className="wf-tab-row-drop-indicator"
                          style={{ left: `${dragOverTab.offsetX}px` }}
                          aria-hidden="true"
                        />
                      )}
                  </div>
                ))}
              </div>
              <div
                className="wf-pane-body"
                onDragOver={onPaneBodyDragOver(pane.id)}
                onDragLeave={onPaneBodyDragLeave(pane.id)}
                onDrop={event => {
                  event.preventDefault();
                  if (!dragTab || !hasDragIntent(event)) {
                    setDockHint(null);
                    return;
                  }
                  if (dockHint?.paneId === pane.id) performDock(pane.id, dockHint.side);
                  else setDockHint(null);
                }}
              >
                {pane.tabs.map(tabId => (
                  <div
                    key={tabId}
                    role="tabpanel"
                    className="wf-tab-page"
                    style={pane.active === tabId ? undefined : { display: 'none' }}
                  >
                    {renderTabContent(tabId)}
                  </div>
                ))}
                {dockHint?.paneId === pane.id && <div className="wf-dock-scrim" aria-hidden="true" />}
                {dockHint?.paneId === pane.id && (
                  <div className={`wf-dock-hint wf-dock-${dockHint.side}`} role="status" data-drop-active>
                    <div className="wf-dock-card">
                      <svg className="wf-dock-glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
                        <rect
                          x={dockHint.side === 'right' ? 12.5 : 4.5}
                          y="4.5"
                          width={dockHint.side === 'center' ? 15 : 7}
                          height="15"
                          rx="1"
                          fill="currentColor"
                          fillOpacity="0.45"
                        />
                      </svg>
                      <span className="wf-dock-label">
                        {dockHint.side === 'center'
                          ? '移动到此分栏'
                          : `停靠到${dockHint.side === 'left' ? '左侧' : '右侧'}`}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

declare global {
  interface Window {
    getCurrentSessionViewIdentity?: () => { agentId?: string; sessionId?: string } | null;
    readCurrentSessionViewState?: () => { sessionMeta?: { openDirectory?: string } } | null;
    renderMarkdown?: (text: string) => string;
    hljs?: {
      getLanguage?: (name: string) => unknown;
      highlight?: (code: string, options: { language: string }) => { value?: string };
    };
  }
}

export function mount(host: HTMLElement) {
  if (!document.getElementById('workspace-files-style')) {
    const style = document.createElement('style');
    style.id = 'workspace-files-style';
    style.textContent = cssText;
    document.head.append(style);
  }
  const root = createRoot(host);
  root.render(<WorkspaceFiles />);
  return () => root.unmount();
}
