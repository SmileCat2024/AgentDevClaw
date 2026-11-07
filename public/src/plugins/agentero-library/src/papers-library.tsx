import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ArrowLeft, ExternalLink, FileText, RefreshCw, Search, X } from 'lucide-react'
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
  }, [loadPapers, notifyError, revision, t, vault])

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return papers.filter(paper => needle === '' || paper.title.toLocaleLowerCase().includes(needle) || paper.authors.toLocaleLowerCase().includes(needle))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  }, [papers, query])

  const closeDetail = useCallback(() => { setSelectedPaper(null); setDetailError('') }, [])
  const openPaper = useCallback((ref: string) => {
    setSelectedPaper(null); setDetailError(''); setDetailLoading(true)
    void loadPaper(ref).then(setSelectedPaper)
      .catch((error: unknown) => setDetailError(error instanceof Error ? error.message : t('actionFailed')))
      .finally(() => setDetailLoading(false))
  }, [loadPaper, t])

  const detail = (selectedPaper !== null || detailLoading || detailError !== '') ? createPortal(
    <div className='agentero-library agentero-surface agentero-reader-host'>
      <div className='agentero-reader-portal' role='dialog' aria-modal='true' aria-label={t('paperDetails')}>
      <header className='agentero-reader-topbar'>
        <button type='button' className='agentero-icon-button' onClick={closeDetail} aria-label={t('backToLibrary')} title={t('backToLibrary')}><ArrowLeft size={18} /></button>
        <div className='agentero-reader-heading'>
          <span className='agentero-kicker'>{t('paperDetails')}</span>
          <h1 title={selectedPaper?.title}>{selectedPaper?.title || t('loading')}</h1>
        </div>
        {selectedPaper?.pdfAvailable ? <a className='agentero-secondary-button' href={selectedPaper.pdfUrl} target='_blank' rel='noreferrer'><ExternalLink size={15} />{t('openPdfNewTab')}</a> : null}
        <button type='button' className='agentero-icon-button agentero-reader-close' onClick={closeDetail} aria-label={t('backToLibrary')} title={t('backToLibrary')}><X size={18} /></button>
      </header>
      {detailLoading ? <div className='agentero-reader-message' role='status'>{t('loading')}</div> : null}
      {detailError ? <div className='agentero-reader-message agentero-reader-error' role='alert'>{detailError}</div> : null}
      {selectedPaper ? <main className='agentero-reader-main'>
        <aside className='agentero-paper-info'>
          <div className='agentero-paper-meta'>{selectedPaper.year || '—'}<span>·</span>{selectedPaper.authors.join(', ') || '—'}</div>
          {(selectedPaper.arxiv_id || selectedPaper.doi) ? <div className='agentero-paper-identifiers'>{selectedPaper.arxiv_id ? <span>arXiv:{selectedPaper.arxiv_id}</span> : null}{selectedPaper.doi ? <span>DOI: {selectedPaper.doi}</span> : null}</div> : null}
          <h2>{t('paperAbstract')}</h2>
          <p>{selectedPaper.abstract || '—'}</p>
          {selectedPaper.tags.length ? <div className='agentero-paper-tags'>{selectedPaper.tags.map(tag => <span key={tag.name}>{tag.name}</span>)}</div> : null}
        </aside>
        <section className='agentero-pdf-stage' aria-label={selectedPaper.title}>
          {selectedPaper.pdfAvailable ? <iframe src={`${selectedPaper.pdfUrl}#zoom=page-width`} title={selectedPaper.title} /> : <div className='agentero-reader-message'>{t('pdfMissing')}</div>}
        </section>
      </main> : null}
      </div>
    </div>, document.documentElement,
  ) : null

  return <div className='agentero-library agentero-surface agentero-library-page'>
    <header className='agentero-library-heading'>
      <div><span className='agentero-kicker'>{t('title')}</span><h1>{t('title')}</h1><p>{vault?.name || vault?.path || ''}</p></div>
      <button type='button' className='agentero-icon-button' onClick={() => setRevision(value => value + 1)} disabled={loading} aria-label={t('refresh')} title={t('refresh')}><RefreshCw size={17} className={loading ? 'agentero-spin' : ''} /></button>
    </header>
    <div className='agentero-library-toolbar'>
      <label className='agentero-search'><Search size={17} aria-hidden="true"/><input type='search' value={query} onChange={event => setQuery(event.target.value)} aria-label={t('filter')} placeholder={t('filter')}/>{query ? <button type='button' onClick={() => setQuery('')} aria-label={t('clearResults')}><X size={15}/></button> : null}</label>
      <span className='agentero-result-count'>{t(query.trim() === '' ? 'paperCount' : 'filteredCount', { count: filtered.length, total: papers.length })}</span>
    </div>
    <section className='agentero-paper-list' aria-busy={loading} aria-label={t('title')}>
      {!filtered.length ? <div className='agentero-library-empty' role='status'><FileText size={23}/><span>{!loaded || loading ? t('loading') : vault?.path === '' ? t('vaultMissing') : loadError || (papers.length ? t('noMatches') : t('empty'))}</span>{loadError ? <button type='button' className='agentero-secondary-button' onClick={() => setRevision(value => value + 1)}>{t('refresh')}</button> : null}</div> : filtered.map((paper, index) => <button type='button' className='agentero-paper-card' key={paper.key} onClick={() => openPaper(paper.openId)}>
        <span className='agentero-paper-index'>{String(index + 1).padStart(2, '0')}</span>
        <span className='agentero-paper-card-content'><strong title={paper.title}>{paper.title || '—'}</strong><span className='agentero-paper-card-authors' title={paper.authors}>{paper.authors || '—'}</span><span className='agentero-paper-card-tags'>{paper.tags.slice(0, 3).map(tag => <i key={tag.name}>{tag.name}</i>)}{paper.tags.length > 3 ? <i>+{paper.tags.length - 3}</i> : null}</span></span>
        <span className='agentero-paper-card-year'>{paper.year || '—'}</span>
      </button>)}
    </section>
    {detail}
  </div>
}
