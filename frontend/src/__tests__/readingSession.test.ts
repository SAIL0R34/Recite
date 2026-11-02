// Reading-session contract: sitting accumulation, the pause-praise
// threshold/cooldown decision, and the one-shot sleep suppression.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginReadingSession,
  clearPausePraiseSuppression,
  endReadingSession,
  formatDuration,
  markReading,
  MIN_CELEBRATE_MS,
  PAUSE_PRAISE_COOLDOWN_MS,
  shouldShowPausePraise,
  sittingMs,
  suppressNextPausePraise,
  takePausePraiseSuppressed,
} from '../readingSession'

const T0 = new Date('2026-01-01T00:00:00Z').getTime()
const at = (s: number) => vi.setSystemTime(T0 + s)

describe('readingSession', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    vi.setSystemTime(T0)
    endReadingSession()
    clearPausePraiseSuppression()
  })
  afterEach(() => vi.useRealTimers())

  it('sittingMs counts the open interval live and accumulates closed ones', () => {
    beginReadingSession('b', 'Book')
    expect(sittingMs()).toBe(0)
    markReading(true)
    at(30_000)
    expect(sittingMs()).toBe(30_000)
    markReading(false)
    expect(sittingMs()).toBe(30_000)
    markReading(true)
    at(70_000)
    markReading(false)
    expect(sittingMs()).toBe(70_000)
  })

  it('endReadingSession returns the sitting and resets the accumulator', () => {
    beginReadingSession('b', 'Book')
    markReading(true)
    at(40_000)
    markReading(false)
    const s = endReadingSession()
    expect(s?.ms).toBe(40_000)
    expect(sittingMs()).toBe(0)
  })

  it('beginReadingSession closes a dangling sitting first', () => {
    beginReadingSession('a', 'A')
    markReading(true)
    at(10_000)
    markReading(false)
    beginReadingSession('b', 'B')
    expect(sittingMs()).toBe(0)
  })

  it('shouldShowPausePraise gates on the celebration threshold', () => {
    expect(shouldShowPausePraise(MIN_CELEBRATE_MS - 1, null, T0)).toBe(false)
    expect(shouldShowPausePraise(MIN_CELEBRATE_MS, null, T0)).toBe(true)
  })

  it('shouldShowPausePraise enforces the cooldown after one card', () => {
    const shown = T0 - PAUSE_PRAISE_COOLDOWN_MS / 2
    expect(shouldShowPausePraise(120_000, shown, T0)).toBe(false)
    const earlier = T0 - PAUSE_PRAISE_COOLDOWN_MS - 1
    expect(shouldShowPausePraise(120_000, earlier, T0)).toBe(true)
  })

  it('the sleep suppression is consumed exactly once', () => {
    suppressNextPausePraise()
    expect(takePausePraiseSuppressed()).toBe(true)
    expect(takePausePraiseSuppressed()).toBe(false)
    suppressNextPausePraise()
    clearPausePraiseSuppression()
    expect(takePausePraiseSuppressed()).toBe(false)
  })

  it('formatDuration renders the card forms', () => {
    expect(formatDuration(47 * 60_000)).toBe('47m')
    expect(formatDuration(125 * 60_000)).toBe('2h 05m')
  })
})
