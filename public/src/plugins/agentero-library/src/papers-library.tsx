import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ArrowLeft, ExternalLink, FileText, Maximize2, Minimize2, RefreshCw, Search, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { papersFrom, shown, type LibraryFace, type PaperDetail, type PaperRow, type VaultInfo } from './papers'

type LibraryPanelProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'agentero.library'> & LibraryFace

export function LibraryPanel({ t, loadPapers, loadPaper, notifyError, loadVault }: LibraryPanelProps): ReactNode {
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

  const detailActive = selectedPaper !== null || detailLoading || detailError !== ''
  const detailMeta = selectedPaper
    ? [selectedPaper.year ? String(selectedPaper.year) : '', selectedPaper.authors.join(', ')].filter(Boolean).join(' · ') || '—'
    : ''

  /**
   * 详情视图骨架：panel 内嵌与全屏 Portal 共用。
   * 顶栏 = 返回/退出全屏 + 标题与元信息行 + 全屏切换 + 新标签页打开；
   * 内容 = PDF 占满剩余空间（panel 窄栏不设摘要/标签侧栏）。
   */
  const detailBody = (fullscreen: boolean): ReactNode => (
    <div
      className={fullscreen ? 'agentero-library agentero-surface agentero-reader agentero-reader-fullscreen' : 'agentero-reader agentero-reader-panel'}
      role='dialog'
      aria-modal={fullscreen ? 'true' : undefined}
      aria-label={t('paperDetails')}
      style={fullscreen ? { position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex', flexDirection: 'column', width: '100vw', height: '100dvh' } : undefined}
    >
      <header className='agentero-reader-topbar'>
        {fullscreen
          ? <button type='button' className='agentero-icon-button' onClick={() => setDetailFullscreen(false)} aria-label={t('exitFullscreen')} title={t('exitFullscreen')}><Minimize2 size={18} /></button>
          : <button type='button' className='agentero-icon-button' onClick={closeDetail} aria-label={t('backToLibrary')} title={t('backToLibrary')}><ArrowLeft size={18} /></button>}
        <div className='agentero-reader-heading'>
          <h1 title={selectedPaper?.title}>{selectedPaper?.title || t('loading')}</h1>
          {detailMeta ? <div className='agentero-reader-meta' title={detailMeta}>{detailMeta}</div> : null}
        </div>
        {!fullscreen && selectedPaper?.pdfAvailable
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
              ? (
                // panel 与全屏用不同 query 区分 URL：iframe 跨模式重新挂载时，
                // 同 URL 导航会让 Chromium PDF viewer 复用会话缩放、忽略
                // #zoom fragment（退回 100%）；两模式各自首次导航才能应用 page-width。
                <iframe src={`${selectedPaper.pdfUrl}?view=${fullscreen ? 'full' : 'panel'}#zoom=page-width`} title={selectedPaper.title} />
              )
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
      {detailActive && !detailFullscreen ? detailBody(false) : libraryPage}
      {detailActive && detailFullscreen ? createPortal(detailBody(true), document.body) : null}
    </>
  )
}
