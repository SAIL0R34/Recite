// Shared motion helpers. Motion is opt-in via settings.pageAnimations;
// prefers-reduced-motion always wins.

import type { BookSummary } from './types'
import { useSettingsStore } from './stores/settingsStore'
import { useFlightStore } from './stores/flightStore'

export const animOK = () =>
  useSettingsStore.getState().settings?.pageAnimations === true &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Capture a cover's viewport rect and arm the flight store. The overlay
 * takes over from here — including the navigation. Returns false when the
 * flight cannot run (animations off / reduced motion / degenerate rect),
 * in which case the caller navigates directly.
 */
export function startBookFlight(
  el: Element | null,
  book: Pick<BookSummary, 'id' | 'title' | 'author'>,
): boolean {
  if (!el || !animOK()) return false
  const r = el.getBoundingClientRect()
  if (r.width < 8 || r.height < 12) return false
  useFlightStore.getState().begin({
    bookId: book.id,
    title: book.title,
    author: book.author,
    kind: 'img', // the overlay falls back to typo on its own img error
    from: { x: r.left, y: r.top, w: r.width, h: r.height },
  })
  return true
}
