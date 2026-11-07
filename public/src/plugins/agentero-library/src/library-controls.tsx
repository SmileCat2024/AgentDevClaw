import { DropdownMenu, Popover } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from './utils'

// Portals keep the library's scoped theme without changing the DSH shell.
const surface = 'agentero-library agentero-surface z-50 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg'

export function LibraryPopoverContent({ className, style, ...props }: ComponentProps<typeof Popover.Content>) {
  return (
    <Popover.Portal>
      <Popover.Content
        sideOffset={6}
        collisionPadding={12}
        className={cn(surface, 'w-72 max-w-[calc(100vw-1.5rem)] outline-none', className)}
        style={{ ...style, height: 'auto' }}
        {...props}
      />
    </Popover.Portal>
  )
}

export function LibraryMenuContent({ className, style, ...props }: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={6}
        collisionPadding={12}
        className={cn(surface, 'min-w-44 p-1 outline-none', className)}
        style={{ ...style, height: 'auto' }}
        {...props}
      />
    </DropdownMenu.Portal>
  )
}

export function LibraryMenuItem({ className, ...props }: ComponentProps<typeof DropdownMenu.Item>) {
  return <DropdownMenu.Item
    className={cn('flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none data-highlighted:bg-accent data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0', className)}
    {...props}
  />
}
