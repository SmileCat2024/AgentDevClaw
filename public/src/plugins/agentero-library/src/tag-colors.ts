const TAG_COLOR_IDS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'indigo',
  'purple',
] as const

type TagColorId = (typeof TAG_COLOR_IDS)[number]

type TagColorTokens = {
  swatch: string
  bg: string
  fg: string
}

const TOKENS: Record<TagColorId, TagColorTokens> = {
  red: {
    swatch: 'oklch(0.62 0.22 25)',
    bg: 'oklch(0.88 0.06 25)',
    fg: 'oklch(0.38 0.14 25)',
  },
  orange: {
    swatch: 'oklch(0.72 0.17 55)',
    bg: 'oklch(0.9 0.055 55)',
    fg: 'oklch(0.4 0.12 55)',
  },
  yellow: {
    swatch: 'oklch(0.78 0.14 85)',
    bg: 'oklch(0.92 0.045 85)',
    fg: 'oklch(0.42 0.1 85)',
  },
  green: {
    swatch: 'oklch(0.65 0.17 145)',
    bg: 'oklch(0.88 0.055 145)',
    fg: 'oklch(0.33 0.11 145)',
  },
  teal: {
    swatch: 'oklch(0.65 0.12 185)',
    bg: 'oklch(0.89 0.045 185)',
    fg: 'oklch(0.33 0.08 185)',
  },
  blue: {
    swatch: 'oklch(0.62 0.18 250)',
    bg: 'oklch(0.88 0.055 250)',
    fg: 'oklch(0.35 0.12 250)',
  },
  indigo: {
    swatch: 'oklch(0.55 0.18 285)',
    bg: 'oklch(0.87 0.055 285)',
    fg: 'oklch(0.33 0.12 285)',
  },
  purple: {
    swatch: 'oklch(0.58 0.19 305)',
    bg: 'oklch(0.87 0.06 305)',
    fg: 'oklch(0.35 0.13 305)',
  },
}

function isTagColorId(value: string | null | undefined): value is TagColorId {
  return typeof value === 'string' && (TAG_COLOR_IDS as readonly string[]).includes(value)
}

function tagColorTokens(id: string | null | undefined): TagColorTokens | null {
  if (!isTagColorId(id)) return null
  return TOKENS[id]
}

/** Chip inline style when a color is set; undefined = default muted classes. */
export function tagChipStyle(
  id: string | null | undefined,
): { backgroundColor: string, color: string } | undefined {
  const tokens = tagColorTokens(id)
  if (!tokens) return undefined
  return {
    backgroundColor: `color-mix(in oklch, ${tokens.swatch} 18%, var(--background))`,
    color: `color-mix(in oklch, ${tokens.swatch} 70%, var(--foreground))`,
  }
}

export function tagSwatchStyle(
  id: string | null | undefined,
): { backgroundColor: string } | undefined {
  const tokens = tagColorTokens(id)
  if (!tokens) return undefined
  return { backgroundColor: tokens.swatch }
}
