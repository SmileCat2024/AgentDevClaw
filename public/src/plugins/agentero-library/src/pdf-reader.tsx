/**
 * PdfReader — PDF.js 自渲染阅读器（panel 内 / 全屏共用）。
 *
 * 内置 viewer（iframe）拿不到 JS 选区，划词提问需要真实 DOM 文本层：
 * canvas 渲染 + pdfjs TextLayer（透明 span 层），浏览器原生 selection 直接
 * 可用。worker / cMaps / 标准字体经构建器 `?asset` 约定从根 node_modules
 * 拷贝到 dist/assets/，与主库版本精确对齐（构建器头注）。
 *
 * 划词提问：selectionchange 监听 → 选区落在 textLayer 内且非空 → 原生
 * ::selection 浅蓝高亮（全字高，不自绘覆盖层）+ 浮条（问 AI → 输入问题 →
 * 发送经 onAsk({ quote, page, question })）。选区矩形只算给浮条/编辑器定位，
 * 不作视觉。浮条与编辑器用 reader
 * 本地坐标 absolute 定位（不 Portal、不 fixed：玻璃容器会劫持 fixed 的包含
 * 块）；编辑器靠点击时的数据快照存活（mousedown 在按钮上会清除浏览器选区，
 * 同 annotations.js 的 popoverCtx 模式）。滚动/缩放即失效（rect 坐标过期）。
 *
 * 性能：全部页先建占位（viewport 定尺寸），IntersectionObserver 进入
 * 视口才真正渲染（canvas + textLayer），已渲染页缓存不重绘。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?asset'
import cmapsUrl from 'pdfjs-dist/cmaps?asset'
import standardFontsUrl from 'pdfjs-dist/standard_fonts?asset'

// asset URL 相对产物（dist/index.js）解析为绝对 URL；worker 必须在首帧前配置。
// 目录型 asset（cmaps / standard_fonts）按 PDF.js 约定补尾斜杠（factory url 校验）。
const assetUrl = (value: string): string => new URL(value + '/', import.meta.url).toString().replace(/\/+$/, '/')
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(workerUrl, import.meta.url).toString()

const CMAP_URL = assetUrl(cmapsUrl)
const STANDARD_FONT_DATA_URL = assetUrl(standardFontsUrl)

/** 引文入消息正文的截断（保留完整语义的证据段，避免超长引文淹没问题）。 */
const QUOTE_MAX_CHARS = 1200

/** 选区单行矩形（reader 本地坐标：相对 .pdf-reader 左上角）。 */
interface SelectionRect {
  left: number
  top: number
  width: number
  height: number
}

/** 选区命中：引文 + 页码 + 逐行矩形（浮条与编辑器定位共用）。 */
interface SelectionHit {
  quote: string
  page: number
  rects: SelectionRect[]
}

/** 选区 → 提问请求载荷。 */
export interface PdfAskRequest {
  quote: string
  page: number
  question: string
}

interface PdfReaderProps {
  url: string
  onAsk(request: PdfAskRequest): void
  /** 发送后浮层的成功回调（父组件 Toast）；缺省时仍会清空选区与浮层。 */
  onAsked?(): void
}

interface PageLayout {
  pageNumber: number
  width: number
  height: number
}

export function PdfReader({ url, onAsk, onAsked }: PdfReaderProps) {
  const readerRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [layout, setLayout] = useState<PageLayout[]>([])
  const [baseWidth, setBaseWidth] = useState(0)
  const [scale, setScale] = useState(1)
  const [fitScale, setFitScale] = useState<number | null>(null)
  const [loadError, setLoadError] = useState('')
  const [selection, setSelection] = useState<SelectionHit | null>(null)
  // 编辑器与选区解耦：点"问 AI"时快照 quote/page/anchor（对齐 annotations.js
  // 的 popoverCtx 模式——mousedown 在按钮上会清除浏览器选区，编辑器必须靠
  // 快照存活，否则闪现即消失）。
  const [ask, setAsk] = useState<{ question: string; quote: string; page: number; anchor: SelectionRect } | null>(null)

  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null)

  // 文档加载：url 变化即重置（论文切换）
  useEffect(() => {
    let cancelled = false
    setLayout([])
    setLoadError('')
    setAsk(null)
    setFitScale(null)
    setScale(1)
    docRef.current?.destroy().catch(() => undefined)
    docRef.current = null
    const task = pdfjsLib.getDocument({
      url,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    })
    void task.promise.then(async (doc) => {
      if (cancelled) { void doc.destroy(); return }
      docRef.current = doc
      const pages: PageLayout[] = []
      for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await doc.getPage(n)
        if (cancelled) return
        const viewport = page.getViewport({ scale: 1 })
        pages.push({ pageNumber: n, width: viewport.width, height: viewport.height })
      }
      if (cancelled) return
      setLayout(pages)
    }).catch((error: unknown) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [url])

  // fit-width：按第一页宽与容器可用宽计算一次基准；用户手动缩放后（scale 偏离
  // fitScale）不再自动 refit，避免容器尺寸抖动时强制重置阅读位置。
  const refit = useCallback(() => {
    const container = scrollRef.current
    const first = layout[0]
    if (!container || !first || first.width <= 0) return
    const padding = 24
    const next = Math.max(0.2, Math.min(4, (container.clientWidth - padding) / first.width))
    setFitScale(next)
    setScale((current) => (fitScale === null || current === fitScale) ? next : current)
  }, [layout, fitScale])

  useEffect(() => {
    const container = scrollRef.current
    if (!container || layout.length === 0) return
    refit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => refit())
    observer.observe(container)
    return () => observer.disconnect()
  }, [layout, refit])

  // 划词监听：selectionchange + 滚动隐藏。selection 必须完全落在 textLayer 内。
  useEffect(() => {
    const selectionInReader = (): SelectionHit | null => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed) return null
      const range = selection.getRangeAt(0)
      const startLayer = (range.startContainer.nodeType === 1
        ? range.startContainer : range.startContainer.parentElement)?.closest('.pdf-text-layer')
      if (startLayer === null || startLayer === undefined) return null
      const quote = selection.toString().trim()
      if (quote === '') return null
      const pageElement = startLayer.closest<HTMLElement>('[data-page-number]')
      const page = pageElement ? Number(pageElement.dataset.pageNumber) : 0
      const reader = readerRef.current
      if (reader === null) return null
      // 逐行矩形转 reader 本地坐标：浮条与编辑器定位共用，全屏切换时随
      // reader 整体移动，无需换算。
      const origin = reader.getBoundingClientRect()
      const rects: SelectionRect[] = []
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue
        rects.push({
          left: rect.left - origin.left,
          top: rect.top - origin.top,
          width: rect.width,
          height: rect.height,
        })
      }
      return rects.length > 0 ? { quote, page, rects } : null
    }

    const onSelectionChange = (): void => {
      const hit = selectionInReader()
      setSelection(hit)
      if (hit !== null) setAsk(null)
    }
    const onScroll = (): void => {
      setSelection(null)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    // 只监听阅读器自身滚动与窗口滚动：selection rect 是视口坐标，其他区域
    // （聊天区自动滚动等）滚动不影响浮层位置，不该误杀选区浮层。
    const scrollEl = scrollRef.current
    scrollEl?.addEventListener('scroll', onScroll)
    window.addEventListener('scroll', onScroll)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      scrollEl?.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll)
    }
  }, [])

  // 缩放变化即失效选区：rects 是旧缩放下的坐标，且 textLayer 重建后选区消失。
  useEffect(() => {
    setSelection(null)
    setAsk(null)
  }, [scale, url])

  const submitAsk = useCallback((): void => {
    if (ask === null) return
    const question = ask.question.trim()
    if (question === '') return
    onAsk({ quote: ask.quote.slice(0, QUOTE_MAX_CHARS), page: ask.page, question })
    setAsk(null)
    window.getSelection()?.removeAllRanges()
    setSelection(null)
    onAsked?.()
  }, [ask, onAsk, onAsked])

  const zoomStep = useCallback((factor: number): void => {
    setScale((current) => Math.max(0.2, Math.min(4, current * factor)))
  }, [])

  const totalPages = useMemo(() => layout.length, [layout])

  const firstRect: SelectionRect | null = selection !== null ? selection.rects[0] : null

  return (
    <div ref={readerRef} className="pdf-reader" style={{ position: 'relative', height: '100%', minHeight: 0 }}>
      {loadError !== '' && (
        <div className="pdf-reader-status">PDF 加载失败：{loadError}</div>
      )}
      {loadError === '' && layout.length === 0 && (
        <div className="pdf-reader-status">PDF 加载中…</div>
      )}
      <div ref={scrollRef} className="pdf-scroll">
        {layout.map((item) => (
          <PdfPage
            key={item.pageNumber}
            docRef={docRef}
            layout={item}
            scale={scale}
          />
        ))}
        {totalPages > 0 && (
          <div className="pdf-page-end">共 {totalPages} 页</div>
        )}
      </div>

      {totalPages > 0 && (
        <div className="pdf-zoom-bar">
          <button type="button" className="pdf-zoom-btn" aria-label="缩小"
            onClick={() => zoomStep(1 / 1.2)}>−</button>
          <span className="pdf-zoom-label">{Math.round(scale * 100)}%</span>
          <button type="button" className="pdf-zoom-btn" aria-label="放大"
            onClick={() => zoomStep(1.2)}>+</button>
        </div>
      )}

      {/* 选区视觉 = 原生 ::selection（浅蓝全字高，见 tailwind.css）；这里不再
          自绘覆盖层。rects 只用于浮条/编辑器定位。 */}

      {selection !== null && ask === null && firstRect !== null && (
        <div className="pdf-ask-pop" style={{
          left: Math.max(8, firstRect.left + firstRect.width / 2 - 52),
          top: Math.max(8, firstRect.top - 40),
        }}>
          <button type="button" className="pdf-ask-btn" onClick={() => selection !== null && firstRect !== null
            && setAsk({ question: '', quote: selection.quote, page: selection.page, anchor: firstRect })}>
            问 AI
          </button>
        </div>
      )}

      {ask !== null && (
        <div className="pdf-ask-pop pdf-ask-editor" style={{
          left: Math.max(8, Math.min(
            (readerRef.current?.clientWidth ?? 1200) - 316,
            ask.anchor.left + ask.anchor.width / 2 - 150,
          )),
          top: Math.max(8, ask.anchor.top - 96),
        }}>
          <textarea
            autoFocus
            className="pdf-ask-input"
            placeholder="问点什么…（Enter 发送）"
            value={ask.question}
            onChange={(event) => setAsk({ ...ask, question: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                submitAsk()
              }
              if (event.key === 'Escape') {
                setAsk(null)
              }
            }}
            rows={2}
          />
          <div className="pdf-ask-editor-actions">
            <span className="pdf-ask-meta">第 {ask.page} 页 · {ask.quote.length} 字</span>
            <button type="button" className="pdf-ask-btn" onClick={submitAsk}>发送</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 单页：占位定尺寸 + 进入视口才渲染（canvas + textLayer）。 */
function PdfPage({ docRef, layout, scale }: {
  docRef: React.RefObject<pdfjsLib.PDFDocumentProxy | null>
  layout: PageLayout
  scale: number
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const renderTaskRef = useRef<{ cancel(): void } | null>(null)
  const lastRenderedRef = useRef('')
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = hostRef.current
    if (el === null || visible) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { root: null, rootMargin: '150% 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [visible])

  useEffect(() => {
    // 缩放变化即重绘。只与"最后一次成功渲染"比较：canvas 是单缓冲，
    // 任何新渲染都会覆盖旧内容，历史 key 集合（曾渲染过≠现在还是）会导致
    // 往返缩放（67%→96%→67%）时旧档命中缓存跳过重绘、canvas 停在别档内容。
    const renderKey = `${layout.pageNumber}@${scale.toFixed(3)}`
    if (!visible || lastRenderedRef.current === renderKey) return
    const pageWidth = Math.floor(layout.width * scale)
    const pageHeight = Math.floor(layout.height * scale)
    let cancelled = false
    // PDF.js 不允许同一 canvas 并发 render：缩放切换时先取消上一任务，
    // 否则新 render 抛 "multiple render() operations"、canvas 停在清空态（全屏切换白页的根因）
    renderTaskRef.current?.cancel()
    renderTaskRef.current = null
    void (async () => {
      const doc = docRef.current
      if (doc === null) return
      const page = await doc.getPage(layout.pageNumber)
      if (cancelled) return
      const host = hostRef.current
      if (host === null) return
      const canvas = host.querySelector('canvas')
      const textLayer = host.querySelector('.pdf-text-layer')
      if (canvas === null || textLayer === null) return
      const viewport = page.getViewport({ scale })
      const outputScale = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * outputScale)
      canvas.height = Math.floor(viewport.height * outputScale)
      canvas.style.width = `${pageWidth}px`
      canvas.style.height = `${pageHeight}px`
      const context = canvas.getContext('2d')
      if (context === null) return
      const task = page.render({
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
      })
      renderTaskRef.current = task
      await task.promise
      if (cancelled) return
      // TextLayer render 是追加语义：重绘（缩放）前清空，避免叠字
      textLayer.textContent = ''
      const textContent = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textLayer as HTMLElement,
        viewport,
      })
      await textContent.render()
      if (!cancelled) lastRenderedRef.current = renderKey
    })().catch(() => undefined)
    return () => { cancelled = true }
  }, [visible, scale, layout, docRef])

  const width = Math.floor(layout.width * scale)
  const height = Math.floor(layout.height * scale)

  return (
    <div
      ref={hostRef}
      className="pdf-page"
      data-page-number={layout.pageNumber}
      style={{ width: `${width}px`, height: `${height}px` }}
    >
      <canvas />
      {/* --total-scale-factor：官方体系里由 viewer 外层设置的缩放因子，
          standalone 集成必须自己按当前 viewport.scale 内联——span 的
          font-size = factor × --font-height（PDF 原始 pt），缺了它字号
          不随缩放、与 canvas 脱节（选区几何错位的根因）。 */}
      <div
        className="pdf-text-layer"
        style={{ width: `${width}px`, height: `${height}px`, '--total-scale-factor': scale } as React.CSSProperties}
      />
    </div>
  )
}
