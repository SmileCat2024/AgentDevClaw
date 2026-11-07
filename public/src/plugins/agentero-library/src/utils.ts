import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Form controls do not inherit type from their parent unless preflight says so.
 * This package's Tailwind entry does not import preflight.
 */
export const controlReset =
  'm-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[length:inherit] leading-[inherit] [font-weight:inherit]'
