import { Download, FileInput, MoreHorizontal, Plus, RefreshCw, Search } from 'lucide-react'
import { DropdownMenu, Popover } from 'radix-ui'
import { useRef, useState } from 'react'
import { Button } from './button'
import { Input } from './input'
import { controlButtonClass } from './library-columns'
import { LibraryMenuContent, LibraryMenuItem, LibraryPopoverContent } from './library-controls'
import type { LibraryT } from './papers'

type LibraryActionsProps = {
  t: LibraryT
  busy: boolean
  onImport: (text: string) => Promise<boolean>
  onDiscover: (keyword: string) => Promise<boolean>
  onImportBib: (file: File) => Promise<boolean>
  onExport: () => void
  onReload: () => void
}

/** Import drafts stay outside the catalog, so typing never re-renders paper rows. */
export function LibraryActions({ t, busy, onImport, onDiscover, onImportBib, onExport, onReload }: LibraryActionsProps) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'import' | 'discover'>('import')
  const [text, setText] = useState('')
  const [keyword, setKeyword] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const importTrigger = useRef<HTMLButtonElement>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const openDiscovery = useRef(false)
  const discovering = mode === 'discover'
  const value = discovering ? keyword : text

  return (
    <div className='flex items-center justify-end gap-0.5'>
      <input
        ref={fileInput}
        type='file'
        accept='.bib,.bibtex,text/plain'
        hidden
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) void onImportBib(file)
        }}
      />
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            ref={importTrigger}
            type='button'
            className={controlButtonClass()}
            aria-label={t('importAction')}
            title={t('importAction')}
            disabled={busy}
            onClick={() => { setMode('import') }}
          >
            <Plus className='size-3.5' aria-hidden />
          </button>
        </Popover.Trigger>
        <LibraryPopoverContent align='end' aria-label={t(discovering ? 'discoverAction' : 'importAction')} onCloseAutoFocus={(event) => {
          event.preventDefault()
          importTrigger.current?.focus({ preventScroll: true })
        }}>
          <p className='m-0 px-1 pb-2 text-xs font-medium'>{t(discovering ? 'discoverAction' : 'importAction')}</p>
          <form
            className='flex gap-1.5'
            onSubmit={(event) => {
              event.preventDefault()
              if (busy || value.trim() === '') return
              void (discovering ? onDiscover(value.trim()) : onImport(value.trim())).then((saved) => {
                if (!saved) return
                if (discovering) setKeyword('')
                else setText('')
                setOpen(false)
              })
            }}
          >
            <Input
              value={value}
              placeholder={t(discovering ? 'discoverPlaceholder' : 'importPlaceholder')}
              aria-label={t(discovering ? 'discoverPlaceholder' : 'importPlaceholder')}
              onChange={(event) => {
                if (discovering) setKeyword(event.target.value)
                else setText(event.target.value)
              }}
              disabled={busy}
              className='h-7 text-xs'
            />
            <Button type='submit' size='sm' disabled={busy || value.trim() === ''}>
              {t(discovering ? 'discoverAction' : 'importAction')}
            </Button>
          </form>
        </LibraryPopoverContent>
      </Popover.Root>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button ref={menuTrigger} type='button' className={controlButtonClass()} aria-label={t('moreActions')} title={t('moreActions')}>
            <MoreHorizontal className='size-3.5' aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <LibraryMenuContent align='end' onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (openDiscovery.current) {
            openDiscovery.current = false
            setOpen(true)
          } else {
            menuTrigger.current?.focus({ preventScroll: true })
          }
        }}>
          <LibraryMenuItem disabled={busy} onSelect={onReload}>
            <RefreshCw aria-hidden />{t('refresh')}
          </LibraryMenuItem>
          <LibraryMenuItem disabled={busy} onSelect={() => {
            setMode('discover')
            // Transfer focus after the menu has released its modal layer.
            openDiscovery.current = true
          }}>
            <Search aria-hidden />{t('discoverAction')}
          </LibraryMenuItem>
          <DropdownMenu.Separator className='my-1 h-px bg-border' />
          <LibraryMenuItem disabled={busy} onSelect={() => { fileInput.current?.click() }}>
            <FileInput aria-hidden />{t('importBib')}
          </LibraryMenuItem>
          <LibraryMenuItem disabled={busy} onSelect={onExport}>
            <Download aria-hidden />{t('exportBib')}
          </LibraryMenuItem>
        </LibraryMenuContent>
      </DropdownMenu.Root>
    </div>
  )
}
