// Shared motion helpers. Motion is opt-in via settings.pageAnimations;
// prefers-reduced-motion always wins.

import type { BookSummary } from './types'
import { useSettingsStore } from './stores/settingsStore'
import { useFlightStore } from './stores/flightStore'

export const animOK = () =>
  useSettingsStore.getState().settings?.pageAnimations === true &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Capture a cover's viewport rect and arm the flight store just before
 *  navigate(). No-op (zero overhead) unless animations are enabled. */
export function startBookFlight(
  el: Element | null,
  book: Pick<BookSummary, 'id' | 'title' | 'author'>,
): void {
  if (!el || !animOK()) return
  const r = el.getBoundingClientRect()
  if (r.width < 8 || r.height < 12) return // degenerate rect → skip flight
  useFlightStore.getState().begin({
    bookId: book.id,
    title: book.title,
    author: book.author,
    kind: 'img', // the overlay falls back to typo on its own img error
    from: { x: r.left, y: r.top, w: r.width, h: r.height },
  })
}
