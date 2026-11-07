import { BookOpen, Download, MoreHorizontal, Trash2 } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { Fragment, memo, type KeyboardEvent, type MouseEvent } from 'react'
import {
  COLUMN_META,
  COLUMN_ORDER,
  controlButtonClass,
  type CellCtx,
} from './library-columns'
import type { PaperRow } from './papers'
import { LibraryMenuContent, LibraryMenuItem } from './library-controls'
import { cn } from './utils'

type LibraryPaperRowProps = {
  paper: PaperRow
  ctx: CellCtx
  busy: boolean
  /** Handlers take the row's ref so the panel can keep one stable identity per action. */
  onOpen: (ref: string) => void
  onDownload: (ref: string) => void
  onDelete: (ref: string) => void
}

function ignoresRowOpen(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, input') !== null
}

/**
 * One catalog row. Memoized: the panel re-renders on every filter keystroke, and
 * without this each one rebuilt all rows and their tag inputs.
 */
export const LibraryPaperRow = memo(function LibraryPaperRow({
  paper,
  ctx,
  busy,
  onOpen,
  onDownload,
  onDelete,
}: LibraryPaperRowProps) {
  const open = (): void => { onOpen(paper.openId) }

  return (
    <tr
      className='group/row cursor-pointer border-b border-border/40 transition-colors duration-100 hover:bg-accent/70 focus-visible:bg-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring active:bg-accent motion-reduce:transition-none'
      tabIndex={0}
      onClick={(event: MouseEvent<HTMLTableRowElement>) => {
        if (ignoresRowOpen(event.target)) return
        open()
      }}
      onKeyDown={(event: KeyboardEvent<HTMLTableRowElement>) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        open()
      }}
    >
      {COLUMN_ORDER.map(key => (
        <Fragment key={key}>
          {COLUMN_META[key].render(paper, ctx)}
        </Fragment>
      ))}
      <td className='w-16 min-w-16 px-2 py-2'>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type='button' className={cn(controlButtonClass(), 'ml-auto opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100')} aria-label={`${ctx.t('moreActions')}: ${paper.title}`} title={ctx.t('moreActions')}>
              <MoreHorizontal className='size-3.5' aria-hidden />
            </button>
          </DropdownMenu.Trigger>
          <LibraryMenuContent align='end' onClick={(event) => { event.stopPropagation() }} onKeyDown={(event) => { event.stopPropagation() }}>
            <LibraryMenuItem onSelect={open}><BookOpen aria-hidden />{ctx.t('openPaper')}</LibraryMenuItem>
            <LibraryMenuItem disabled={busy} onSelect={() => { onDownload(paper.openId) }}><Download aria-hidden />{ctx.t('download')}</LibraryMenuItem>
            <DropdownMenu.Separator className='my-1 h-px bg-border' />
            <LibraryMenuItem className='text-destructive' disabled={busy} onSelect={() => {
              if (window.confirm(ctx.t('confirmDelete'))) onDelete(paper.openId)
            }}><Trash2 aria-hidden />{ctx.t('deletePaper')}</LibraryMenuItem>
          </LibraryMenuContent>
        </DropdownMenu.Root>
      </td>
    </tr>
  )
})
