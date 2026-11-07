import { Plus } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useRef, useState, type ReactNode, type Ref } from 'react'
import { Input } from './input'
import { LibraryPopoverContent } from './library-controls'
import { PaperTagChip, PaperTagRemoveButton } from './paper-tag-chip'
import type { LibraryT, PaperRow } from './papers'
import { cn, controlReset } from './utils'

type TagComposerProps = {
  /** Placeholder and accessible name, e.g. "标签". */
  label: string
  disabled: boolean
  /** Resolves true when the tag was saved, so the draft can be cleared. */
  onAdd: (tag: string) => Promise<boolean>
  inputRef?: Ref<HTMLInputElement>
}

/**
 * Per-row tag input. The draft lives here rather than in the panel so typing
 * re-renders one cell instead of every row in the table.
 */
export function TagComposer({ label, disabled, onAdd, inputRef }: TagComposerProps): ReactNode {
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)

  return (
    <form className='flex items-center gap-1.5' onSubmit={(event) => {
      event.preventDefault()
      const tag = value.trim()
      if (tag === '' || pending || disabled) return
      setPending(true)
      void onAdd(tag)
        .then((saved) => { if (saved) setValue('') })
        .finally(() => { setPending(false) })
    }}>
      <Input
        ref={inputRef}
        value={value}
        placeholder={label}
        aria-label={label}
        disabled={disabled || pending}
        className='h-7 text-xs'
        onChange={(event) => { setValue(event.target.value) }}
        onKeyDown={(event) => { event.stopPropagation() }}
      />
      <button type='submit' className={cn(controlReset, 'flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50')} aria-label={label} disabled={disabled || pending || value.trim() === ''}>
        <Plus className='size-3.5' aria-hidden />
      </button>
    </form>
  )
}

/** Read first, edit on demand: long tag names never increase the catalog row height. */
export function PaperTags({ paper, t, busy, onAdd, onRemove }: {
  paper: PaperRow
  t: LibraryT
  busy: boolean
  onAdd: (ref: string, tag: string) => Promise<boolean>
  onRemove: (ref: string, name: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type='button'
          className={cn(controlReset, 'flex h-5 w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring')}
          aria-label={`${t('editTags')}: ${paper.title}`}
          title={paper.tags.map(tag => tag.name).join(', ') || t('addTag')}
        >
          {paper.tags.length === 0 ? <span className='text-muted-foreground/60'>—</span> : (
            <>
              <PaperTagChip tag={paper.tags[0]} className='min-w-0 max-w-full truncate' />
              {paper.tags.length > 1 ? <span className='shrink-0 text-caption tabular-nums text-muted-foreground'>+{paper.tags.length - 1}</span> : null}
            </>
          )}
        </button>
      </Popover.Trigger>
      <LibraryPopoverContent align='start' aria-label={t('editTags')} onOpenAutoFocus={(event) => {
        event.preventDefault()
        inputRef.current?.focus()
      }} onClick={(event) => { event.stopPropagation() }} onKeyDown={(event) => { event.stopPropagation() }}>
        <div className='flex max-h-48 flex-col gap-0.5 overflow-y-auto pb-2'>
          {paper.tags.map(tag => (
            <div key={tag.name} className='flex min-w-0 items-center justify-between gap-2 rounded-md px-1 py-1 hover:bg-accent/50'>
              <PaperTagChip tag={tag} className='min-w-0 truncate' title={tag.name} />
              <PaperTagRemoveButton tagName={tag.name} label={`${t('removeTag')} ${tag.name}`} disabled={busy} onRemove={(name) => { onRemove(paper.openId, name) }} />
            </div>
          ))}
        </div>
        <TagComposer inputRef={inputRef} label={t('addTag')} disabled={busy} onAdd={(tag) => onAdd(paper.openId, tag)} />
      </LibraryPopoverContent>
    </Popover.Root>
  )
}
