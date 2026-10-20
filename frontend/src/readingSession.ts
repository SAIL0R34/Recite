// Reading-session tracking: one sitting = mount → unmount of the reader
// route. The duration is beaconed to the backend for statistics and left
// in a store for the library's close celebration — a store, not module
// state, because React 18 gives no ordering guarantee between the deleted
// reader's cleanup and the new library's mount effects.

import { create } from 'zustand'
import { sendSessionBeacon } from './api/client'

export interface EndedSession {
  bookId: string
  title: string
  startedMs: number
  ms: number
}

/** Sittings shorter than this don't get celebrated (still recorded). */
export const MIN_CELEBRATE_MS = 60_000

interface EndedState {
  ended: EndedSession | null
}

/** The library subscribes; endReadingSession publishes. */
export const useEndedSession = create<EndedState>(() => ({ ended: null }))

let current: { bookId: string; title: string; start: number } | null = null

export function beginReadingSession(bookId: string, title: string): void {
  // close any dangling sitting (rapid book → book navigation)
  endReadingSession()
  current = { bookId, title, start: Date.now() }
}

export function endReadingSession(): EndedSession | null {
  if (!current) return null
  const { bookId, title, start } = current
  current = null
  const now = Date.now()
  const s: EndedSession = { bookId, title, startedMs: start, ms: now - start }
  if (s.ms >= 1000) sendSessionBeacon(s)
  if (s.ms >= MIN_CELEBRATE_MS) useEndedSession.setState({ ended: s })
  return s
}

/** One-shot: the library takes (and clears) the session to celebrate.
 *  A sitting that ended long ago (tab hidden mid-reader, returned to
 *  hours later) is dropped rather than celebrated out of the blue. */
export function takeEndedSession(): EndedSession | null {
  const s = useEndedSession.getState().ended
  if (!s) return null
  useEndedSession.setState({ ended: null })
  if (Date.now() - (s.startedMs + s.ms) > 5 * 60_000) return null
  return s
}

/** "1h 12m" / "47m" / "2h 05m" — for the celebration card. */
export function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  return `${h}h ${String(m).padStart(2, '0')}m`
}
