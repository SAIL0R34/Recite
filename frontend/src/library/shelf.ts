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
export const CLOTHS = [
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

/** Spine width classes — real shelves mix slim novels and thick tomes
 *  (the reference row spans 7–41px widths). Average ≈ 40px, which
 *  Bookcase's per-row estimate uses. */
const WIDTHS = [30, 33, 36, 40, 40, 44, 44, 48, 54]

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

/** Everything the shelf needs to pose one book. */
export interface SpineSlot {
  cloth: string
  /** px */
  width: number
  /** 0.9–1.0 */
  scale: number
  /** '82deg'–'85deg' */
  tilt: string
  floatDelay: string
}

/**
 * Deterministic displacement: try offsets in a seed-rotated order and take
 * the first index `bad` doesn't reject. Our set sizes (10 cloths, 7 distinct
 * widths, 4 tilts) always leave a free index, so the final return is
 * unreachable — it keeps the function total.
 */
function dislodge(base: number, n: number, bad: (idx: number) => boolean,
                  seed: number): number {
  const first = 1 + (seed % (n - 1))
  for (let k = 0; k < n - 1; k++) {
    const step = ((first - 1 + k) % (n - 1)) + 1
    const idx = (base + step) % n
    if (!bad(idx)) return idx
  }
  return base % n
}

/**
 * Assorted spines for a section's books: the per-title hash as base, then a
 * left-to-right walk that never lets a book repeat the previous two books'
 * cloth (or the previous book's width/tilt — width compares VALUES, since
 * the weighted set holds duplicates). Title hashes alone produced runs of
 * identical dark spines. Output depends only on the list's content and
 * order, so a given library ordering is stable across renders and resize
 * (adjacency is the section list, never the wrapping rows, whose size
 * changes with the viewport). Books whose cover yields a tint keep these
 * slots too and simply override `cloth` — two neighbors with the same real
 * cover hue may then repeat, deliberately: matching the actual book
 * outranks anti-repetition.
 */
export function assortSpines(books: BookSummary[]): Map<string, SpineSlot> {
  const out = new Map<string, SpineSlot>()
  let prev1 = -1 // last resolved cloth idx
  let prev2 = -1 // …and the one before it
  let prevW = -1 // last resolved width VALUE (the set holds duplicates)
  let prevT = -1
  for (const b of books) {
    const t = b.title
    let ci = hash32(t) % CLOTHS.length
    if (ci === prev1 || ci === prev2) {
      ci = dislodge(ci, CLOTHS.length, (i) => i === prev1 || i === prev2,
                    hash32('#' + t))
    }
    let wi = hash32('|' + t) % WIDTHS.length
    if (WIDTHS[wi] === prevW) {
      wi = dislodge(wi, WIDTHS.length, (i) => WIDTHS[i] === prevW,
                    hash32('w#' + t))
    }
    let ti = hash32('=' + t) % 4
    if (ti === prevT) ti = dislodge(ti, 4, (i) => i === prevT, hash32('t#' + t))
    out.set(b.id, {
      cloth: CLOTHS[ci],
      width: WIDTHS[wi],
      scale: 0.9 + (hash32('~' + t) % 11) / 100,
      tilt: `${82 + ti}deg`,
      floatDelay: `${(hash32(t) % 40) / 10}s`,
    })
    prev2 = prev1
    prev1 = ci
    prevW = WIDTHS[wi]
    prevT = ti
  }
  return out
}
