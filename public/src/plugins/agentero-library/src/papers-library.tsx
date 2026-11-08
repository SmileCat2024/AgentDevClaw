import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ArrowLeft, ExternalLink, FileText, Maximize2, Minimize2, RefreshCw, Search, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { PdfReader } from './pdf-reader'
import { papersFrom, shown, type LibraryFace, type PaperDetail, type PaperRow, type VaultInfo } from './papers'

type LibraryPanelProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'agentero.library'> & LibraryFace

export function LibraryPanel({ t, loadPapers, loadPaper, askAgent, notifyError, loadVault }: LibraryPanelProps): ReactNode {
  const [vault, setVault] = useState<VaultInfo | null>(null)
  const [papers, setPapers] = useState<PaperRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const [selectedPaper, setSelectedPaper] = useState<PaperDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailFullscreen, setDetailFullscreen] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadVault().then(value => { if (!cancelled) setVault(value) })
      .catch((error: unknown) => {
        if (cancelled) return
        notifyError(shown(error instanceof Error ? error.message : '', t))
        setVault({ path: '', name: '', scope: '', recentVaults: [], canPick: false })
      })
    return () => { cancelled = true }
  }, [loadVault, notifyError, t])

  useEffect(() => {
    if (vault === null) return
    if (vault.path === '') { setLoaded(true); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    loadPapers().then(body => {
      if (cancelled) return
      setPapers(papersFrom(body)); setLoadError(''); setLoaded(true)
    }).catch((error: unknown) => {
      if (cancelled) return
      const message = shown(error instanceof Error ? error.message : '', t)
      setLoadError(message); notifyError(message); setLoaded(true)
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [loadPapers, revision, t, vault])

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return papers.filter(paper => needle === '' || paper.title.toLocaleLowerCase().includes(needle) || paper.authors.toLocaleLowerCase().includes(needle))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  }, [papers, query])

  const closeDetail = useCallback(() => { setSelectedPaper(null); setDetailError(''); setDetailFullscreen(false) }, [])
  const openPaper = useCallback((ref: string) => {
    setSelectedPaper(null); setDetailError(''); setDetailLoading(true); setDetailFullscreen(false)
    void loadPaper(ref).then(setSelectedPaper)
      .catch((error: unknown) => setDetailError(error instanceof Error ? error.message : t('actionFailed')))
      .finally(() => setDetailLoading(false))
  }, [loadPaper, t])

  /** 划词提问投递：失败走 notice（输入已不可恢复，提示用户重试）。 */
  const handleAsk = useCallback((request: { quote: string, page: number, question: string }) => {
    if (selectedPaper === null) return
    void askAgent({ paperId: selectedPaper.id, title: selectedPaper.title, ...request })
      .then(() => notifyError(t('askSent')))
      .catch((error: unknown) => notifyError(shown(error instanceof Error ? error.message : '', t)))
  }, [askAgent, notifyError, selectedPaper, t])

  const detailActive = selectedPaper !== null || detailLoading || detailError !== ''
  const detailMeta = selectedPaper
    ? [selectedPaper.year ? String(selectedPaper.year) : '', selectedPaper.authors.join(', ')].filter(Boolean).join(' · ') || '—'
    : ''

  /**
   * 详情视图骨架：panel 内嵌与全屏共用同一 React 子树（条件 Portal：全屏
   * 时 Portal 到 body，panel 时留在面板容器）——切换模式只移动 DOM 宿主，
   * PdfReader 不卸载、PDF 不重载（此前两分支渲染导致 iframe 重挂载）。
   * 顶栏 = 返回/退出全屏 + 标题与元信息行 + 全屏切换 + 新标签页打开。
   */
  const detailBody = (
    <div
      className={detailFullscreen ? 'agentero-library agentero-surface agentero-reader agentero-reader-fullscreen' : 'agentero-reader agentero-reader-panel'}
      role='dialog'
      aria-modal={detailFullscreen ? 'true' : undefined}
      aria-label={t('paperDetails')}
      style={detailFullscreen ? { position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex', flexDirection: 'column', width: '100vw', height: '100dvh' } : undefined}
    >
      <header className='agentero-reader-topbar'>
        {detailFullscreen
          ? <button type='button' className='agentero-icon-button' onClick={() => setDetailFullscreen(false)} aria-label={t('exitFullscreen')} title={t('exitFullscreen')}><Minimize2 size={18} /></button>
          : <button type='button' className='agentero-icon-button' onClick={closeDetail} aria-label={t('backToLibrary')} title={t('backToLibrary')}><ArrowLeft size={18} /></button>}
        <div className='agentero-reader-heading'>
          <h1 title={selectedPaper?.title}>{selectedPaper?.title || t('loading')}</h1>
          {detailMeta ? <div className='agentero-reader-meta' title={detailMeta}>{detailMeta}</div> : null}
        </div>
        {!detailFullscreen && selectedPaper?.pdfAvailable
          ? <button type='button' className='agentero-icon-button' onClick={() => setDetailFullscreen(true)} aria-label={t('openFullscreen')} title={t('openFullscreen')}><Maximize2 size={18} /></button>
          : null}
        {selectedPaper?.pdfAvailable
          ? <a className='agentero-icon-button' href={selectedPaper.pdfUrl} target='_blank' rel='noreferrer' aria-label={t('openPdfNewTab')} title={t('openPdfNewTab')}><ExternalLink size={17} /></a>
          : null}
      </header>
      {detailLoading ? <div className='agentero-reader-message' role='status'>{t('loading')}</div> : null}
      {detailError ? (
        <div className='agentero-reader-message agentero-reader-error' role='alert'>
          <span>{detailError}</span>
          <button type='button' className='agentero-secondary-button' onClick={closeDetail}>{t('backToLibrary')}</button>
        </div>
      ) : null}
      {selectedPaper ? (
        <main className='agentero-reader-main'>
          <section className='agentero-pdf-stage' aria-label={selectedPaper.title}>
            {selectedPaper.pdfAvailable
              ? <PdfReader url={selectedPaper.pdfUrl} onAsk={handleAsk} />
              : <div className='agentero-reader-message'>{t('pdfMissing')}</div>}
          </section>
        </main>
      ) : null}
    </div>
  )

  // 列表视图：宿主面板 header 已显示“文献”标题，面板内部不再重复大标题；
  // 搜索框独占一行（右接刷新按钮），计数与 vault 路径放独立 meta 行，互不挤压。
  const libraryPage = (
    <div className='agentero-library-page'>
      <div className='agentero-library-toolbar'>
        <label className='agentero-search'><Search size={16} aria-hidden="true"/><input type='search' value={query} onChange={event => setQuery(event.target.value)} aria-label={t('filter')} placeholder={t('filter')}/>{query ? <button type='button' onClick={() => setQuery('')} aria-label={t('clearResults')}><X size={15}/></button> : null}</label>
        <button type='button' className='agentero-icon-button' onClick={() => setRevision(value => value + 1)} disabled={loading} aria-label={t('refresh')} title={t('refresh')}><RefreshCw size={16} className={loading ? 'agentero-spin' : ''} /></button>
      </div>
      <div className='agentero-library-meta'>
        <span className='agentero-result-count'>{t(query.trim() === '' ? 'paperCount' : 'filteredCount', { count: filtered.length, total: papers.length })}</span>
        {vault?.path ? <span className='agentero-vault-path' title={vault.path}>{vault.name || vault.path}</span> : null}
      </div>
      <section className='agentero-paper-list' aria-busy={loading} aria-label={t('title')}>
        {!filtered.length ? <div className='agentero-library-empty' role='status'><FileText size={23}/><span>{!loaded || loading ? t('loading') : vault?.path === '' ? t('vaultMissing') : loadError || (papers.length ? t('noMatches') : t('empty'))}</span>{loadError ? <button type='button' className='agentero-secondary-button' onClick={() => setRevision(value => value + 1)}>{t('refresh')}</button> : null}</div> : filtered.map((paper, index) => (
          <button type='button' className='agentero-paper-card' key={paper.key} onClick={() => openPaper(paper.openId)}>
            <span className='agentero-paper-index'>{String(index + 1).padStart(2, '0')}</span>
            <span className='agentero-paper-card-content'><strong title={paper.title}>{paper.title || '—'}</strong><span className='agentero-paper-card-authors' title={paper.authors}>{paper.authors || '—'}</span></span>
            <span className='agentero-paper-card-year'>{paper.year || '—'}</span>
          </button>
        ))}
      </section>
    </div>
  )

  return (
    <>
      {detailActive
        ? (detailFullscreen ? createPortal(detailBody, document.body) : detailBody)
        : libraryPage}
    </>
  )
}
