// Sleep timer contract: pure countdown math plus store transitions. The
// engine is mocked (node has no <audio>); the mock is a plain mutable
// object so each test can steer timeline/rate/playing directly.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../player/engine', () => ({
  engine: {
    timeline: {
      byIndex: {
        0: { section: 0, startMs: 0, endMs: 120_000, durationMs: 120_000, ready: true },
        1: { section: 1, startMs: 120_000, endMs: 300_000, durationMs: 180_000, ready: true },
        2: { section: 2, startMs: 300_000, endMs: 300_000, durationMs: 0, ready: false },
        3: { section: 3, startMs: 300_000, endMs: 420_000, durationMs: 120_000, ready: true },
      },
      entries: [
        { section: 0, startMs: 0, endMs: 120_000, durationMs: 120_000, ready: true },
        { section: 1, startMs: 120_000, endMs: 300_000, durationMs: 180_000, ready: true },
        { section: 2, startMs: 300_000, endMs: 300_000, durationMs: 0, ready: false },
        { section: 3, startMs: 300_000, endMs: 420_000, durationMs: 120_000, ready: true },
      ],
    },
    sectionIdx: 2, // parked on the unready section on purpose
    rate: 1,
    playing: true,
    getGlobalMs: vi.fn(() => 60_000),
    pause: vi.fn(),
    cancelFade: vi.fn(),
    fadeOutAndPause: vi.fn(() => Promise.resolve()),
  },
}))

import { engine } from '../player/engine'
import {
  FADE_TRIGGER_MS,
  sectionRemainingMs,
  timeRemainingMs,
  useSleepStore,
} from '../stores/sleepStore'
import { useLibraryStore } from '../stores/libraryStore'
import {
  clearPausePraiseSuppression,
  takePausePraiseSuppressed,
} from '../readingSession'

const T0 = new Date('2026-01-01T00:00:00Z').getTime()

describe('sleep countdown math', () => {
  it('time mode is plain wall-clock, clamped at zero', () => {
    expect(timeRemainingMs(T0 + 300_000, T0)).toBe(300_000)
    expect(timeRemainingMs(T0, T0 + 10_000)).toBe(0)
  })

  it('section mode divides audio ms by the rate', () => {
    expect(sectionRemainingMs(120_000, 60_000, 1)).toBe(60_000)
    expect(sectionRemainingMs(120_000, 60_000, 1.5)).toBe(40_000)
    expect(sectionRemainingMs(120_000, 60_000, 0.5)).toBe(120_000)
    expect(sectionRemainingMs(60_000, 90_000, 1)).toBe(0)
    expect(sectionRemainingMs(120_000, 60_000, 0.1)).toBe(120_000) // rate floor
  })
})

describe('sleepStore', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    vi.setSystemTime(T0)
    useSleepStore.getState().dispose()
    clearPausePraiseSuppression()
    useLibraryStore.setState({ toasts: [] })
    ;(engine as { playing: boolean }).playing = true
    ;(engine as { rate: number }).rate = 1
    vi.mocked(engine.getGlobalMs).mockImplementation(() => 60_000)
    vi.mocked(engine.pause).mockClear()
    vi.mocked(engine.cancelFade).mockClear()
    vi.mocked(engine.fadeOutAndPause).mockClear()
  })

  it('armMinutes counts down on the ticker', () => {
    useSleepStore.getState().armMinutes(5)
    const s = useSleepStore.getState()
    expect(s.mode).toBe('time')
    expect(s.remainingMs).toBe(300_000)
    vi.advanceTimersByTime(1000)
    expect(useSleepStore.getState().remainingMs).toBe(299_000)
  })

  it('expiry pauses, disarms, and toasts once', () => {
    useSleepStore.getState().armMinutes(5)
    vi.advanceTimersByTime(5 * 60_000 + 1000)
    expect(engine.pause).toHaveBeenCalled()
    expect(useSleepStore.getState().mode).toBe('off')
    expect(useSleepStore.getState().fading).toBe(false)
    expect(useLibraryStore.getState().toasts).toHaveLength(1)
    expect(useLibraryStore.getState().toasts[0].msg).toBe('Sleep timer ended')
  })

  it('expiry while paused never fades', () => {
    ;(engine as { playing: boolean }).playing = false
    useSleepStore.getState().armMinutes(5)
    vi.advanceTimersByTime(5 * 60_000 + 1000)
    expect(engine.fadeOutAndPause).not.toHaveBeenCalled()
    expect(engine.pause).not.toHaveBeenCalled()
    expect(useSleepStore.getState().mode).toBe('off')
  })

  it('the final window fades, suppresses the pause card, then finishes', async () => {
    useSleepStore.getState().armMinutes(5)
    useSleepStore.setState({ endsAt: T0 + 4_000 })
    useSleepStore.getState().tick()
    expect(useSleepStore.getState().fading).toBe(true)
    expect(engine.fadeOutAndPause).toHaveBeenCalledWith(4_000)
    expect(takePausePraiseSuppressed()).toBe(true)
    await Promise.resolve() // the fade promise resolves → finish()
    expect(useSleepStore.getState().mode).toBe('off')
    expect(useLibraryStore.getState().toasts[0].msg).toBe('Sleep timer ended')
  })

  it('cancel mid-fade restores volume and clears the suppression', () => {
    useSleepStore.getState().armMinutes(5)
    useSleepStore.setState({ endsAt: T0 + 4_000 })
    useSleepStore.getState().tick()
    useSleepStore.getState().cancel()
    expect(engine.cancelFade).toHaveBeenCalled()
    expect(takePausePraiseSuppressed()).toBe(false)
    expect(useSleepStore.getState().mode).toBe('off')
  })

  it('armSection falls forward past a section with no audio', () => {
    ;(engine as { sectionIdx: number }).sectionIdx = 2
    useSleepStore.getState().armSection()
    const s = useSleepStore.getState()
    expect(s.mode).toBe('section')
    expect(s.sectionIdx).toBe(3)
    expect(s.remainingMs).toBe(360_000) // endMs 420_000 − global 60_000
  })

  it('armSection at 2× halves the wall-clock remaining', () => {
    ;(engine as { sectionIdx: number }).sectionIdx = 2
    ;(engine as { rate: number }).rate = 2
    useSleepStore.getState().armSection()
    expect(useSleepStore.getState().remainingMs).toBe(180_000)
  })

  it('armSection stays off with no timeline', () => {
    const tl = (engine as { timeline: unknown }).timeline
    ;(engine as { timeline: unknown }).timeline = null
    useSleepStore.getState().armSection()
    expect(useSleepStore.getState().mode).toBe('off')
    ;(engine as { timeline: unknown }).timeline = tl
  })

  it('dispose stops the ticker silently', () => {
    useSleepStore.getState().armMinutes(5)
    useSleepStore.getState().dispose()
    expect(useSleepStore.getState().mode).toBe('off')
    vi.advanceTimersByTime(10 * 60_000)
    expect(useLibraryStore.getState().toasts).toHaveLength(0)
  })

  it('a second tick inside the fade window does not re-trigger it', () => {
    useSleepStore.getState().armMinutes(5)
    useSleepStore.setState({ endsAt: T0 + 4_000 })
    useSleepStore.getState().tick()
    vi.advanceTimersByTime(1000)
    expect(engine.fadeOutAndPause).toHaveBeenCalledTimes(1)
    expect(FADE_TRIGGER_MS).toBe(8_000)
  })
})
