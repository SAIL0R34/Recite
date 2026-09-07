// Player state. Word index is DERIVED (engine + timeline.wordAt) and lives
// nowhere here — that's a contract invariant, not an oversight.

import { create } from 'zustand'
import type {
  BookDocument,
  Manifest,
  Progress,
} from '../types'
import {
  buildTimeline,
  chunkAt,
  positionToGlobal,
  type Timeline,
} from '../player/timeline'
import { engine } from '../player/engine'
import { getSectionTimings } from '../api/client'

export interface PlayerState {
  bookId: string | null
  document: BookDocument | null
  manifest: Manifest | null
  timeline: Timeline | null
  /** monotonic bump whenever the manifest is refetched (SSE/poll) */
  manifestVersion: number
  globalMs: number
  playing: boolean
  rate: number
  sectionIdx: number
  followMode: boolean
  /** server-reported completion %, shown on the ring */
  percent: number

  load: (
    bookId: string,
    document: BookDocument,
    manifest: Manifest,
    percent: number,
  ) => Promise<void>
  setManifest: (manifest: Manifest) => void
  /** merge full word timings for one section (fetched lazily) */
  ensureTimings: (idx: number) => Promise<void>
  setPercent: (percent: number) => void

  play: () => void
  pause: () => void
  toggle: () => void
  setRate: (r: number) => void
  seek: (globalMs: number) => void
  seekBy: (deltaMs: number) => void
  nextSection: () => void
  prevSection: () => void
  nextReadySection: () => void
  setFollow: (on: boolean) => void
  /** snapshot for progress persistence */
  currentProgress: () => Progress | null
  /** global ms from stored progress (sectionStart + ms_into_section) */
  resumeFrom: (p: Progress) => void
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  bookId: null,
  document: null,
  manifest: null,
  timeline: null,
  manifestVersion: 0,
  globalMs: 0,
  playing: false,
  rate: 1,
  sectionIdx: 0,
  followMode: true,
  percent: 0,

  async load(bookId, document, manifest, percent) {
    const timeline = buildTimeline(manifest)
    const first = timeline.entries.find((e) => e.ready) ?? timeline.entries[0]
    set({
      bookId,
      document,
      manifest,
      timeline,
      percent,
      sectionIdx: first ? first.section : 0,
      globalMs: first ? first.startMs : 0,
      followMode: true,
    })
    engine.load(bookId, manifest)
  },

  async ensureTimings(idx) {
    const { manifest, bookId } = get()
    const sec = manifest?.sections.find((s) => s.idx === idx)
    if (!manifest || !bookId || !sec) return
    if (sec.status !== 'ready' || sec.chunks?.some((c) => c.words?.length)) return
    try {
      const full = await getSectionTimings(bookId, idx)
      const merged: Manifest = {
        ...manifest,
        sections: manifest.sections.map((s) => (s.idx === idx ? full : s)),
      }
      set({ manifest: merged, manifestVersion: get().manifestVersion + 1 })
      engine.setManifest(merged)
    } catch {
      /* section went pending again / server busy — highlighter stays off */
    }
  },

  setManifest(manifest) {
    set({
      manifest,
      timeline: buildTimeline(manifest),
      manifestVersion: get().manifestVersion + 1,
    })
    engine.setManifest(manifest)
  },

  setPercent: (percent) => set({ percent }),

  play: () => void engine.play(),
  pause: () => engine.pause(),
  toggle: () => engine.toggle(),
  setRate: (r) => {
    engine.setRate(r)
    set({ rate: engine.rate })
  },

  // An explicit seek re-engages follow mode — the user means to go there.
  seek: (globalMs) => {
    set({ followMode: true })
    void engine.seekToGlobalMs(globalMs)
  },
  seekBy: (deltaMs) => {
    const g = get().globalMs + deltaMs
    const tl = get().timeline
    if (tl) void engine.seekToGlobalMs(Math.max(0, Math.min(g, tl.totalMs)))
  },

  nextSection: () => {
    const { timeline, sectionIdx } = get()
    if (!timeline) return
    const next = timeline.entries.find(
      (e) => e.section > sectionIdx && e.ready,
    )
    if (next) get().seek(next.startMs)
  },
  prevSection: () => {
    const { timeline, sectionIdx } = get()
    if (!timeline) return
    const before = timeline.entries.filter(
      (e) => e.ready && e.section < sectionIdx,
    )
    if (before.length) get().seek(before[before.length - 1].startMs)
    else {
      const cur = timeline.entries[sectionIdx]
      if (cur) get().seek(cur.startMs)
    }
  },
  nextReadySection: () => {
    const { timeline, sectionIdx } = get()
    if (!timeline) return
    const cur = timeline.byIndex[sectionIdx]
    const from = cur && !cur.ready ? sectionIdx - 1 : sectionIdx
    const next = timeline.entries.find(
      (e) => e.section > from && e.ready,
    )
    if (next) get().seek(next.startMs)
  },

  setFollow: (on) => set({ followMode: on }),

  currentProgress() {
    const { timeline, manifest, globalMs, percent } = get()
    if (!timeline || !manifest) return null
    const pos = timeline
      ? engine.positionFor(globalMs)
      : { section: 0, offset: 0 }
    const sec = manifest.sections.find((s) => s.idx === pos.section)
    let wordIdx = 0
    if (sec) {
      const chunk = chunkAt(sec.chunks, pos.offset)
      if (chunk?.words) {
        const arr = chunk.words
        let lo = 0
        let hi = arr.length - 1
        let idx = -1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (arr[mid].s <= pos.offset) {
            idx = mid
            lo = mid + 1
          } else {
            hi = mid - 1
          }
        }
        wordIdx = idx < 0 ? 0 : arr[idx].w
      }
    }
    return {
      section_idx: pos.section,
      word_idx: wordIdx,
      ms_into_section: pos.offset,
      percent,
    }
  },

  resumeFrom(p) {
    const { timeline } = get()
    if (!timeline) return
    const g = positionToGlobal(timeline, p.section_idx, p.ms_into_section)
    get().seek(g)
  },
}))

// Engine → store plumbing (module scope: registered once).
engine.onTick((ms) => {
  if (ms !== usePlayerStore.getState().globalMs) {
    usePlayerStore.setState({ globalMs: ms })
  }
})
engine.onState(({ playing, sectionIdx }) => {
  usePlayerStore.setState({ playing, sectionIdx })
})
