import { COLUMN_META, COLUMN_ORDER, SortIcon, type ColumnKey, type SortDir } from './library-columns'
import type { LibraryT } from './papers'
import { cn, controlReset } from './utils'

type LibraryTableHeaderProps = {
  t: LibraryT
  sortKey: ColumnKey
  sortDir: SortDir
  onSort: (key: ColumnKey) => void
}

export function LibraryTableHeader({
  t,
  sortKey,
  sortDir,
  onSort,
}: LibraryTableHeaderProps) {
  return (
    <thead
      data-library-header
      className='sticky top-0 z-[1] select-none border-b border-border/60 bg-background shadow-[0_1px_0_0_color-mix(in_oklch,var(--border)_35%,transparent)]'
    >
      <tr className='text-xs tracking-wide text-muted-foreground'>
        {COLUMN_ORDER.map(key => {
          const meta = COLUMN_META[key]
          const active = sortKey === key
          return (
            <th
              key={key}
              className={cn(meta.headerClassName, 'relative p-0 font-medium')}
              aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              <div className='flex h-9 min-w-0 items-center px-3'>
                <button
                  type='button'
                  className={cn(
                    controlReset,
                    'flex min-w-0 shrink cursor-pointer items-center gap-1 py-0.5 text-left',
                    'hover:text-foreground',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    active && 'text-foreground',
                  )}
                  onClick={() => { onSort(key) }}
                  aria-label={t(meta.labelKey)}
                >
                  <span className='truncate'>{t(meta.labelKey)}</span>
                  <SortIcon active={active} dir={sortDir} />
                </button>
              </div>
            </th>
          )
        })}
      </tr>
    </thead>
  )
}
