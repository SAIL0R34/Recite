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
 * Deterministic per-title spine tint — every rendering of a book gets the
 * same cloth color with nothing stored. Depth/lightening happens in CSS via
 * color-mix so all three themes share one hue.
 */
export function spineTint(title: string): string {
  const hue = hash32(title) % 360
  return `hsl(${hue} 27% 34%)`
}

/** Grokipedia's shelves mix book heights (292/280px…) — same trick, hashed. */
export function spineScale(title: string): number {
  return 0.93 + (hash32('~' + title) % 8) / 100
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
