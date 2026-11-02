// Pure helpers for the bookcase: deterministic spine tints, sectioning,
// and row chunking. No React, trivially testable.

import type { BookSummary } from '../types'

/** Horizontal gap between books on a shelf — keep in sync with --shelf-gap. */
export const SHELF_GAP = 10

/** FNV-1a 32-bit hash. */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * The cloth palette, tuned to the reference shelf: a narrow family of
 * bookish hues — dusty rose, muted purple, dark umber, warm near-black —
 * plus the same-saturation classics (teal, oxblood, forest, navy). No
 * random rainbow: a real bookcase collects worn, low-sat cloth. Measured
 * reference range: sat 17–26%, light 24–41%.
 */
const CLOTHS = [
  'hsl(4 19% 39%)', // dusty rose
  'hsl(4 26% 27%)', // deep rose-brown
  'hsl(300 22% 32%)', // muted purple
  'hsl(300 18% 40%)', // lighter mauve
  'hsl(40 45% 15%)', // dark umber
  'hsl(45 12% 13%)', // warm near-black
  'hsl(190 18% 28%)', // slate teal
  'hsl(8 30% 24%)', // oxblood
  'hsl(150 16% 22%)', // forest
  'hsl(220 20% 26%)', // navy
] as const

/**
 * Deterministic per-title cloth — every rendering of a book gets the same
 * color with nothing stored. Depth/lightening happens in CSS via
 * color-mix so all three themes share one hue.
 */
export function spineTint(title: string): string {
  return CLOTHS[hash32(title) % CLOTHS.length]
}

/**
 * Per-title spine width from a weighted set — real shelves mix slim novels
 * and thick tomes (the reference row spans 7–41px widths). Average ≈ 40px,
 * which Bookcase's per-row estimate uses.
 */
export function spineWidth(title: string): number {
  const WIDTHS = [30, 33, 36, 40, 40, 44, 44, 48, 54]
  return WIDTHS[hash32('|' + title) % WIDTHS.length]
}

/** Grokipedia's shelves mix book heights (292/280px…) — same trick, hashed. */
export function spineScale(title: string): number {
  return 0.9 + (hash32('~' + title) % 11) / 100
}

/** Resting lean, 82–85°: real shelves aren't machine-square. */
export function restTilt(title: string): string {
  return `${82 + (hash32('=' + title) % 4)}deg`
}

/** Stagger for the idle float, so a shelf doesn't bob in unison. */
export function floatDelay(title: string): string {
  return `${(hash32(title) % 40) / 10}s`
}

export interface ShelfSection {
  key: 'reading' | 'generating' | 'unread'
  label: string
  books: BookSummary[]
}

/**
 * Split the library into shelf sections. In-progress books sit up front by
 * recency; still-synthesizing unread books get their own workshop shelf and
 * visibly migrate off it as the 4s poll reports them done.
 */
export function sectionBooks(books: BookSummary[]): ShelfSection[] {
  // created_at/updated_at are epoch seconds (numbers) despite the old type
  const byUpdated = (a: BookSummary, b: BookSummary) => b.updated_at - a.updated_at
  const reading = books
    .filter((b) => (b.percent ?? 0) > 0)
    .sort((a, b) => (b.last_read ?? 0) - (a.last_read ?? 0))
  const generating = books
    .filter(
      (b) =>
        (b.percent ?? 0) === 0 &&
        b.generation != null &&
        b.generation.ready < b.generation.total,
    )
    .sort(byUpdated)
  const unread = books
    .filter(
      (b) =>
        (b.percent ?? 0) === 0 &&
        !(b.generation != null && b.generation.ready < b.generation.total),
    )
    .sort(byUpdated)
  const out: ShelfSection[] = [
    { key: 'reading', label: 'Reading', books: reading },
    { key: 'generating', label: 'Generating narration', books: generating },
    { key: 'unread', label: 'To read', books: unread },
  ]
  return out.filter((s) => s.books.length > 0)
}

/** Split into fixed-size rows (one wooden plank each). */
export function chunk<T>(items: T[], perRow: number): T[][] {
  const n = Math.max(1, perRow)
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += n) rows.push(items.slice(i, i + n))
  return rows
}
