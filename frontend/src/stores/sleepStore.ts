// Sleep timer state. One 1 s ticker while armed; expiry fades the audio
// out over its final seconds (engine.fadeOutAndPause), pauses, and toasts.
// "End of section" stores the section, not a frozen timestamp — partial
// audio growing (or a manifest shift) moves the honest end, so the end is
// derived from the live timeline on every tick.

import { create } from 'zustand'
import { engine } from '../player/engine'
import { useLibraryStore } from './libraryStore'
import {
  clearPausePraiseSuppression,
  suppressNextPausePraise,
} from '../readingSession'

export type SleepMode = 'off' | 'time' | 'section'

/** The final N seconds ramp to silence. */
export const FADE_TRIGGER_MS = 8_000

export function timeRemainingMs(endsAt: number, now: number): number {
  return Math.max(0, endsAt - now)
}

/** Audio time runs at rate × wall clock, so wall remaining = audio / rate. */
export function sectionRemainingMs(
  sectionEndGlobalMs: number,
  globalMs: number,
  rate: number,
): number {
  return Math.max(0, (sectionEndGlobalMs - globalMs) / Math.max(0.5, rate))
}

interface SleepState {
  mode: SleepMode
  /** epoch ms — time mode */
  endsAt: number | null
  /** section axis — section mode */
  sectionIdx: number | null
  /** wall-clock ms left; recomputed each tick */
  remainingMs: number
  menuOpen: boolean
  /** the final fade has been triggered */
  fading: boolean

  armMinutes: (m: number) => void
  armSection: () => void
  cancel: () => void
  toggleMenu: () => void
  setMenuOpen: (v: boolean) => void
  /** one ticker step; also where expiry and fade triggering live */
  tick: () => void
  /** reader unmount / book switch: silent disarm */
  dispose: () => void
}

let ticker: ReturnType<typeof setInterval> | null = null
const startTicker = () => {
  if (ticker === null)
    ticker = setInterval(() => useSleepStore.getState().tick(), 1000)
}
const stopTicker = () => {
  if (ticker !== null) {
    clearInterval(ticker)
    ticker = null
  }
}

const DISARM = {
  mode: 'off',
  endsAt: null,
  sectionIdx: null,
  remainingMs: 0,
  fading: false,
} as const

const finish = () => {
  stopTicker()
  useSleepStore.setState(DISARM)
  useLibraryStore.getState().toast('info', 'Sleep timer ended')
}

export const useSleepStore = create<SleepState>((set, get) => ({
  mode: 'off',
  endsAt: null,
  sectionIdx: null,
  remainingMs: 0,
  menuOpen: false,
  fading: false,

  armMinutes: (m) => {
    set({
      mode: 'time',
      endsAt: Date.now() + m * 60_000,
      remainingMs: m * 60_000,
      fading: false,
    })
    startTicker()
  },

  armSection: () => {
    const tl = engine.timeline
    if (!tl) return
    const cur = tl.byIndex[engine.sectionIdx]
    // the playing section when it has audio; otherwise the next one that
    // does (forward bias, like nearestReady) — nothing ready: stay off
    const e =
      cur && cur.ready && cur.durationMs > 0
        ? cur
        : tl.entries.find((x) => x.section > engine.sectionIdx && x.ready && x.durationMs > 0)
    if (!e) return
    set({ mode: 'section', sectionIdx: e.section, fading: false })
    startTicker()
    get().tick()
  },

  cancel: () => {
    stopTicker()
    engine.cancelFade() // mid-fade cancel: back to full volume, keep playing
    clearPausePraiseSuppression()
    set(DISARM)
  },

  toggleMenu: () => set((s) => ({ menuOpen: !s.menuOpen })),
  setMenuOpen: (v) => set({ menuOpen: v }),

  tick: () => {
    const { mode, endsAt, sectionIdx, fading } = get()
    if (mode === 'off') return
    const remaining =
      mode === 'time'
        ? timeRemainingMs(endsAt ?? 0, Date.now())
        : sectionRemainingMs(
            engine.timeline?.byIndex[sectionIdx ?? 0]?.endMs ?? 0,
            engine.getGlobalMs(),
            engine.rate,
          )
    set({ remainingMs: remaining })
    if (remaining <= 0) {
      // faded (or never played) — plain stop; a throttled tab that missed
      // the fade window pauses immediately
      if (engine.playing) engine.pause()
      finish()
      return
    }
    if (!fading && remaining <= FADE_TRIGGER_MS && engine.playing) {
      set({ fading: true })
      suppressNextPausePraise() // the lullaby stop earns no confetti
      void engine
        .fadeOutAndPause(Math.min(FADE_TRIGGER_MS, remaining))
        .then(() => {
          // cancel() during the fade also resets `fading` — don't toast
          if (get().fading) finish()
        })
    }
  },

  dispose: () => {
    stopTicker()
    engine.cancelFade()
    clearPausePraiseSuppression()
    set({ ...DISARM, menuOpen: false })
  },
}))
