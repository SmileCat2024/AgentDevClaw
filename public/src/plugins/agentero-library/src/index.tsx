/**
 * Agentero library 面板 — Claw 插件入口（ADR-0044 P6 样本三件套之三）。
 *
 * 搬迁自 agentero-dsh-plugin packages/library（组件源码保持上游原样，可
 * diff / 可回流）；dsh 宿主依赖经 src/shim/alias.json 在构建期拦截：
 *   - dsh-client-store → createSnapshotStore 最小实现
 *   - dsh-client-ui-primitives → 自绘 Toast
 *   - dsh-client-ui-slots → 类型桩
 *
 * 与 dsh 入口（apply(ctx) 注册右栏 tab + slot + locale 服务）的对等替换：
 *   - 面板注册走 claw-host 插件协议（panels + mountBody 容器型通道），
 *     React root 生命周期 = 面板打开/关闭
 *   - locale：zh / en 字典内嵌（上游原样），语言读 localStorage
 *     'agentdev-language'（Claw 全局语言持久化约定）
 *   - 数据面：只读对接 Claw server 路由（/protoclaw/agentero/*，#2 交付，
 *     信封与 CLI --json 同构，papers.ts 的宽容解析直接吃）；写操作
 *     （import/export/discover/tags/delete/download）按对接决策不开放，
 *     reject 带 message 经组件 catch → Toast 提示
 *   - openPaper：详情在 panel 内打开（顶栏可切全屏 Portal 阅读 PDF；panel
 *     与全屏共用同一 React 子树，模式切换不重载 PDF）
 *   - PDF.js 自渲染阅读器（pdf-reader.tsx，worker/cMaps 经构建器 ?asset
 *     约定拷贝），划词提问经 askAgent 投递 user-turn（metadata.agentero
 *     随消息流动，agent 侧 AgenteroFeature 消费并注入论文上下文 reminder）
 *   - CSS：__clawPanelCss（构建器 banner 注入，tailwind scope .agentero-library）
 *     在 mountBody 注入、unmountBody 移除（插件协议生命周期自治）
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSyncExternalStore } from 'react'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { LibraryPanel } from './papers-library'
import { LibraryFeedback, type LibraryNotice } from './library-feedback'
import {
  errorText,
  papersFrom,
  readJson,
  type LibraryFace,
  type PaperDetail,
  type VaultInfo,
} from './papers'
/** 构建器 banner 注入的 scoped CSS。 */
declare const __clawPanelCss: string

const zh = {
  title: '文献',
  filter: '按标题或作者筛选',
  colTitle: '标题',
  colAuthors: '作者',
  colYear: '年份',
  colTags: '标签',
  loading: '加载中…',
  empty: '没有文献',
  noMatches: '没有匹配的文献',
  backToLibrary: '返回文献列表',
  openFullscreen: '全屏阅读',
  exitFullscreen: '退出全屏',
  pdfUnavailable: '这篇论文没有可用的 PDF 文件',
  openPdfNewTab: '新标签页打开 PDF',
  paperAbstract: '摘要',
  paperDetails: '论文详情',
  pdfMissing: '此论文没有本地 PDF，详情仍可查看。',
  vaultMissing: '尚未配置 Vault',
  invalid: '无法读取文献列表',
  loadFailed: '无法加载文献',
  importPlaceholder: 'arXiv / DOI / URL',
  importAction: '导入',
  discoverPlaceholder: '关键词',
  discoverAction: '发现',
  exportBib: '导出 BibTeX',
  importBib: '导入 BibTeX',
  deletePaper: '删除',
  download: '下载',
  addTag: '标签',
  removeTag: '移除标签',
  confirmDelete: '移到回收站？',
  actionFailed: '操作失败',
  moreActions: '更多操作',
  refresh: '刷新',
  openPaper: '打开论文',
  editTags: '编辑标签',
  paperCount: '{count} 篇文献',
  filteredCount: '{count} / {total} 篇文献',
  clearResults: '关闭发现结果',
  askSent: '已发送到当前会话',
}

const en = {
  title: 'Library',
  filter: 'Filter by title or authors',
  colTitle: 'Title',
  colAuthors: 'Authors',
  colYear: 'Year',
  colTags: 'Tags',
  loading: 'Loading…',
  empty: 'No papers',
  noMatches: 'No matching papers',
  backToLibrary: 'Back to library',
  openFullscreen: 'Fullscreen reading',
  exitFullscreen: 'Exit fullscreen',
  pdfUnavailable: 'No PDF is available for this paper',
  openPdfNewTab: 'Open PDF in new tab',
  paperAbstract: 'Abstract',
  paperDetails: 'Paper details',
  pdfMissing: 'No local PDF is available; paper details are still available.',
  vaultMissing: 'Vault is not configured',
  invalid: 'Could not read the paper list',
  loadFailed: 'Could not load papers',
  importPlaceholder: 'arXiv / DOI / URL',
  importAction: 'Import',
  discoverPlaceholder: 'Keyword',
  discoverAction: 'Discover',
  exportBib: 'Export BibTeX',
  importBib: 'Import BibTeX',
  deletePaper: 'Delete',
  download: 'Download',
  addTag: 'Tag',
  removeTag: 'Remove tag',
  confirmDelete: 'Move to the recycle bin?',
  actionFailed: 'Action failed',
  moreActions: 'More actions',
  refresh: 'Refresh',
  openPaper: 'Open paper',
  editTags: 'Edit tags',
  paperCount: '{count} papers',
  filteredCount: '{count} of {total} papers',
  clearResults: 'Close discovery results',
  askSent: 'Sent to the current session',
}

type Dict = typeof zh

function pickLang(): Dict {
  try {
    const lang = localStorage.getItem('agentdev-language') || 'zh'
    return lang === 'en' ? en : zh
  } catch {
    return zh
  }
}

function makeT(dict: Dict) {
  return (key: string, params?: Record<string, unknown>): string => {
    const value = (dict as Record<string, string>)[key] ?? key
    if (!params) return value
    return value.replace(/\{(\w+)\}/g, (match, name: string) => (
      name in params ? String(params[name]) : match
    ))
  }
}

const READONLY_MESSAGE = '当前为只读集成：写操作（导入 / 导出 / 标签 / 删除 / 下载）未开放，请经 agentero CLI 或 Agent 工具执行'

/** 面板数据面：只读 server 路由 + 只读降级的写操作。 */
function makeFace(notice: ObservableSnapshot<LibraryNotice>): LibraryFace {
  const request = (url: string, init?: RequestInit): Promise<Response> => fetch(url, { cache: 'no-store', ...init })
  const readonly = (): Promise<never> => Promise.reject(new Error(READONLY_MESSAGE))
  return {
    notifyError(message) {
      const current = notice.get()
      notice.set({ text: message, sequence: (current?.sequence ?? 0) + 1 })
    },
    async loadVault(): Promise<VaultInfo> {
      const response = await request('/protoclaw/agentero/status')
      const body = await readJson(response)
      if (!response.ok) throw new Error(errorText(body) ?? 'vault status failed')
      // server 信封 {ok:true, data:{...}}：readJson 只 parse 不解包，这里取 data
      const envelope = body as { ok?: boolean, data?: unknown, error?: { message?: string } } | undefined
      if (!envelope || envelope.ok !== true || typeof envelope.data !== 'object' || envelope.data === null) {
        throw new Error(errorText(envelope) ?? 'invalid vault status response')
      }
      const record = envelope.data as { configured?: boolean, vaultPath?: string | null }
      return {
        path: record.configured && record.vaultPath ? record.vaultPath : '',
        name: '',
        scope: '',
        recentVaults: [],
        canPick: false,
      }
    },
    async loadPapers() {
      const response = await request('/protoclaw/agentero/papers')
      const body = await readJson(response)
      if (!response.ok) throw new Error(errorText(body) ?? '')
      if (body === undefined) throw new Error('invalid papers response')
      return body
    },
    async loadPaper(ref): Promise<PaperDetail> {
      const paperId = ref.startsWith('papers/') ? ref.slice('papers/'.length) : ref
      const response = await request(`/protoclaw/agentero/papers/${encodeURIComponent(paperId)}`)
      const body = await readJson(response) as { ok?: boolean, data?: Record<string, unknown>, error?: { message?: string } } | undefined
      if (!response.ok || !body || body.ok !== true || !body.data) {
        throw new Error(body?.error?.message || 'paper details unavailable')
      }
      const data = body.data
      const id = typeof data.id === 'string' ? data.id : paperId
      return {
        id,
        title: typeof data.title === 'string' ? data.title : id,
        authors: Array.isArray(data.authors) ? data.authors.filter((item): item is string => typeof item === 'string') : [],
        year: typeof data.year === 'number' || typeof data.year === 'string' ? data.year : null,
        tags: Array.isArray(data.tags) ? data.tags.filter((item): item is { name: string } => typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string') : [],
        abstract: typeof data.abstract === 'string' ? data.abstract : '',
        doi: typeof data.doi === 'string' ? data.doi : null,
        arxiv_id: typeof data.arxiv_id === 'string' ? data.arxiv_id : null,
        pdfUrl: `/protoclaw/agentero/papers/${encodeURIComponent(id)}/pdf`,
        pdfAvailable: data.pdfAvailable === true,
      }
    },
    importId: readonly,
    importBib: readonly,
    exportBib: readonly,
    discover: readonly,
    addTag: readonly,
    removeTag: readonly,
    deletePaper: readonly,
    download: readonly,
    /**
     * 划词提问：投递一条 user turn 到当前聚焦会话（框架 UserTurnInput 面，
     * 与主输入框同通道）。text 是人可读正文；metadata.agentero 随消息流动，
     * agent 侧 AgenteroFeature（onTurnMetadata / CallStart）消费它注入论文
     * 上下文 reminder——面板不打包完整元数据，上下文补全归 feature。
     */
    // 参数名不可叫 request：会遮蔽 makeFace 顶部的 fetch 助手 request，
    // 方法体内的 request(url, init) 将拿到载荷对象而抛 "request is not a
    // function"（构建产物里经 esbuild 重命名为 request2，即曾出现的报错）。
    async askAgent(ask) {
      const runtimeId = window.ClawHost?.workspace?.focusedRuntimeId?.() || ''
      if (!runtimeId) {
        throw new Error('当前没有正在对话的会话，先在主视图打开或新建一个会话再提问')
      }
      const quoteLines = ask.quote.split('\n').map(line => '> ' + line).join('\n')
      const text = [
        `[文献面板提问] 《${ask.title}》第 ${ask.page} 页划线：`,
        '',
        quoteLines,
        '',
        ask.question,
      ].join('\n')
      const response = await request(`/api/agents/${encodeURIComponent(runtimeId)}/user-turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          source: 'agentero-panel',
          metadata: { agentero: { paperId: ask.paperId, page: ask.page, quote: ask.quote } },
          operationId: `agentero-ask:${Date.now()}`,
        }),
      })
      // 成功判定与主输入框（persistent-input.js）同口径：只看 HTTP 状态。
      // 成功体是 viewer 契约 { success:true, delivery }，没有 ok 字段；失败体
      // { ok:false, error } 由 errorText 提取。
      const body = await readJson(response)
      if (!response.ok) {
        throw new Error(errorText(body) || '提问投递失败')
      }
    },
  }
}

/** Toast 容器组件：常驻面板根（fixed 定位，不受面板布局影响）。 */
function PanelRoot({ t, face, notice, dismiss }: {
  t: ReturnType<typeof makeT>
  face: LibraryFace
  notice: ObservableSnapshot<LibraryNotice>
  dismiss(): void
}) {
  const noticeValue = useSyncExternalStore(
    (listener) => notice.subscribe(listener),
    () => notice.get(),
  )
  return createElement('div', { className: 'agentero-library agentero-surface h-full min-h-0' },
    createElement(LibraryPanel, { t, ...face }),
    createElement(LibraryFeedback, {
      useNotice: (select: (value: LibraryNotice) => LibraryNotice) => select(noticeValue),
      dismiss,
    }),
  )
}

let activeRoot: Root | null = null
let disposeStyle: (() => void) | null = null
const noticeStore = createSnapshotStore<LibraryNotice>(null)

function ensurePanelStyle(): () => void {
  const styleId = 'agentero-library-style'
  let style = document.getElementById(styleId)
  if (style || !__clawPanelCss) return () => undefined
  style = document.createElement('style')
  style.id = styleId
  style.textContent = __clawPanelCss
  document.head.appendChild(style)
  const el = style
  return () => { if (el.isConnected) el.remove() }
}

/** rail 按钮图标（svg 字符串，与 dsh 侧 LibraryArtwork 同视觉）。 */
const RAIL_ICON = '<svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect x="8" y="7" width="20" height="22" rx="2" stroke="#8AB4F8" stroke-width="2"/><path d="M13 14h10M13 19h10M13 24h6" stroke="#8AB4F8" stroke-width="2" stroke-linecap="round"/></svg>'

export default {
  id: 'agentero-library',

  panels: {
    'agentero-library': {
      label: { zh: zh.title, en: en.title },
      icon: RAIL_ICON,
      order: 92,
      mountBody(bodyEl: HTMLElement) {
        // 容器无留白契约（2026-11 迁移）：容器自身不再有 padding / min-width
        // 几何，面板全幅自持设计（tailwind scope 内 p-4 留白体系），
        // 无需任何挂载期覆盖。此前在此覆盖容器内联样式并在卸载时恢复，
        // 恢复条件依赖 dataset.panel 时序，切换面板时恒不触发、几何残留，
        // 误伤所有后续面板——已随容器契约迁移整体删除。
        disposeStyle = ensurePanelStyle()
        noticeStore.set(null)
        activeRoot = createRoot(bodyEl)
        const t = makeT(pickLang())
        const face = makeFace(noticeStore)
        activeRoot.render(createElement(PanelRoot, {
          t,
          face,
          notice: noticeStore,
          dismiss: () => { noticeStore.set(null) },
        }))
      },
      unmountBody() {
        try { activeRoot?.unmount() } finally {
          activeRoot = null
          noticeStore.set(null)
          disposeStyle?.()
          disposeStyle = null
        }
      },
    },
  },
}

export { papersFrom, READONLY_MESSAGE }
