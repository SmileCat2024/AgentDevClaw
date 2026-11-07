import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

export type LibraryT = PropsLocale<'agentero.library'>['t']

export interface VaultInfo {
  path: string
  name: string
  scope: string
  recentVaults: { path: string, name: string }[]
  canPick: boolean
}

export interface LibraryFace {
  notifyError(message: string): void
  loadVault(): Promise<VaultInfo>
  loadPapers(): Promise<unknown>
  openPaper(id: string): boolean
  loadPaper(id: string): Promise<PaperDetail>
  importId(text: string): Promise<void>
  importBib(text: string): Promise<void>
  exportBib(): Promise<string>
  discover(keyword: string): Promise<{ id: string, title: string }[]>
  addTag(ref: string, tag: string): Promise<void>
  removeTag(ref: string, tag: string): Promise<void>
  deletePaper(ref: string): Promise<void>
  download(ref: string): Promise<void>
}

export interface PaperTag {
  name: string
  color?: string | null
}

export interface PaperDetail {
  id: string
  title: string
  authors: string[]
  year: number | string | null
  tags: PaperTag[]
  abstract: string
  doi: string | null
  arxiv_id: string | null
  pdfUrl: string
  pdfAvailable: boolean
}

export interface PaperRow {
  key: string
  openId: string
  title: string
  authors: string
  year: string
  tags: PaperTag[]
}

export function errorText(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || !('error' in body)) return undefined
  const error = body.error
  if (typeof error === 'string' && error.trim() !== '') return error
  if (error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return undefined
}

/**
 * Rows from the CLI JSON document.
 * `--json` prints `{ ok: true, data: [...] }`. `data` is the slim list
 * (`id`, `path`, `title`, `year`, `authors`, `tags`, `date`). A bare array
 * or `{ items: [...] }` is accepted as well.
 */
function paperItems(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) return body
  if (body === null || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  if (record.ok === false) return undefined
  if (Array.isArray(record.items)) return record.items
  const data = record.data
  if (Array.isArray(data)) return data
  if (data !== null && typeof data === 'object') {
    const nested = data as Record<string, unknown>
    if (Array.isArray(nested.items)) return nested.items
  }
  return undefined
}

function authorsText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').join(', ')
}

function tagFrom(value: unknown): PaperTag | undefined {
  if (typeof value === 'string') {
    const name = value.trim()
    return name === '' ? undefined : { name }
  }
  if (value === null || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string') {
    return undefined
  }
  const name = value.name.trim()
  if (name === '') return undefined
  const color = 'color' in value && typeof value.color === 'string' && value.color.trim() !== ''
    ? value.color.trim()
    : undefined
  return color === undefined ? { name } : { name, color }
}

function tagsFrom(value: unknown): PaperTag[] {
  if (typeof value === 'string') {
    return value.split(',').map(name => name.trim()).filter(name => name !== '').map(name => ({ name }))
  }
  if (!Array.isArray(value)) return []
  const tags: PaperTag[] = []
  for (const item of value) {
    const tag = tagFrom(item)
    if (tag !== undefined) tags.push(tag)
  }
  return tags
}

function yearText(record: Record<string, unknown>): string {
  const year = record.year
  if (typeof year === 'number' && Number.isFinite(year)) return String(year)
  if (typeof year === 'string' && year.trim() !== '') return year.trim()
  const date = record.date
  if (typeof date === 'string' && date.trim() !== '') return date.trim()
  return ''
}

function toRow(item: unknown, index: number): PaperRow | undefined {
  if (item === null || typeof item !== 'object') return undefined
  const record = item as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  const openId = id
  const title = typeof record.title === 'string' ? record.title : ''
  return {
    key: openId !== '' ? `${openId}:${index}` : String(index),
    openId,
    title,
    authors: authorsText(record.authors),
    year: yearText(record),
    tags: tagsFrom(record.tags),
  }
}

export function papersFrom(body: unknown): PaperRow[] {
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && (body as { ok?: unknown }).ok === false) {
    throw new Error(errorText(body) ?? 'invalid papers response')
  }
  const items = paperItems(body)
  if (items === undefined) throw new Error('invalid papers response')
  const rows: PaperRow[] = []
  for (let index = 0; index < items.length; index += 1) {
    const row = toRow(items[index], index)
    if (row !== undefined) rows.push(row)
  }
  return rows
}

export function shown(message: string, t: LibraryT): string {
  if (message === 'vault is not configured') return t('vaultMissing')
  if (message === 'invalid vault') return t('invalidVault')
  if (message === 'directory picker unavailable') return t('pickerUnavailable')
  if (message === 'invalid papers response') return t('invalid')
  if (message === '') return t('actionFailed')
  return message
}

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export async function postJson(url: string, body: unknown, request: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<unknown> {
  const response = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const parsed = await readJson(response)
  if (!response.ok) throw new Error(errorText(parsed) ?? '')
  return parsed
}

function dataRecord(body: unknown): Record<string, unknown> | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  if (record.data !== null && typeof record.data === 'object' && !Array.isArray(record.data)) {
    return record.data as Record<string, unknown>
  }
  return record
}

export function discoverItems(body: unknown): { id: string, title: string }[] {
  const data = dataRecord(body)
  const items = data?.items
  if (!Array.isArray(items)) return []
  const rows: { id: string, title: string }[] = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = typeof record.arxivId === 'string'
      ? record.arxivId
      : typeof record.arxiv_id === 'string' ? record.arxiv_id : ''
    if (id.trim() === '') continue
    const title = typeof record.title === 'string' && record.title.trim() !== '' ? record.title : id
    rows.push({ id, title })
  }
  return rows
}

export function bibText(body: unknown): string {
  const data = dataRecord(body)
  const content = data?.content
  return typeof content === 'string' ? content : ''
}
