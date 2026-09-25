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
  type Timeline,
} from '../player/timeline'
import { engine } from '../player/engine'
import { getSectionTimings, requestGeneration } from '../api/client'

export interface PlayerState {
  bookId: string | null
  document: BookDocument | null
  manifest: Manifest | null
  timeline: Timeline | null
  /** section -> chunk idxs synthesized since the last section reload */
  chunkDone: Record<number, number[]>
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
    resume?: Progress | null,
  ) => Promise<void>
  setManifest: (manifest: Manifest) => void
  noteChunk: (sec: number, chunk: number) => void
  clearChunkDone: (sec: number) => void
  /** merge full word timings for one section (fetched lazily);
   *  resolves to the merged manifest so callers can mirror it in local state */
  ensureTimings: (idx: number) => Promise<Manifest | null>
  setPercent: (percent: number) => void

  play: () => void
  pause: () => void
  toggle: () => void
  setRate: (r: number) => void
  seek: (globalMs: number) => void
  jumpToSection: (idx: number) => void
  jump: { idx: number; nonce: number } | null
  seekBy: (deltaMs: number) => void
  nextSection: () => void
  prevSection: () => void
  nextReadySection: () => void
  setFollow: (on: boolean) => void
  /** snapshot for progress persistence */
  currentProgress: () => Progress | null
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  bookId: null,
  document: null,
  manifest: null,
  timeline: null,
  chunkDone: {},
  manifestVersion: 0,
  globalMs: 0,
  playing: false,
  rate: 1,
  sectionIdx: 0,
  jump: null,
  followMode: true,
  percent: 0,

  async load(bookId, document, manifest, percent, resume) {
    const timeline = buildTimeline(manifest)
    engine.load(bookId, manifest) // first, so nearestReady works below
    // Start where the reader left off when we know it — the first render
    // then mounts the right section window, so opening a book never jumps.
    let first = timeline.entries.find((e) => e.ready) ?? timeline.entries[0]
    let startMs = first ? first.startMs : 0
    if (resume && timeline.entries.length) {
      const e = timeline.byIndex[resume.section_idx]
      if (e?.ready) {
        first = e
        startMs =
          e.startMs +
          Math.max(0, Math.min(resume.ms_into_section ?? 0, e.durationMs))
      } else {
        const near = engine.nearestReady(resume.section_idx)
        const ne = near !== null ? timeline.byIndex[near] : undefined
        if (ne) {
          first = ne
          startMs = ne.startMs
        }
      }
    }
    set({
      bookId,
      document,
      manifest,
      timeline,
      percent,
      sectionIdx: first ? first.section : 0,
      globalMs: startMs,
      followMode: true,
    })
    if (resume) void engine.seekToGlobalMs(startMs) // parks <audio> at the same spot
  },

  async ensureTimings(idx) {
    const { manifest, bookId } = get()
    const sec = manifest?.sections.find((s) => s.idx === idx)
    if (!manifest || !bookId || !sec) return null
    if (sec.status !== 'ready' || sec.chunks?.some((c) => c.words?.length)) return null
    try {
      const full = await getSectionTimings(bookId, idx)
      const merged: Manifest = {
        ...manifest,
        sections: manifest.sections.map((s) => (s.idx === idx ? full : s)),
      }
      set({ manifest: merged, manifestVersion: get().manifestVersion + 1 })
      engine.setManifest(merged)
      return merged
    } catch {
      /* section went pending again / server busy — highlighter stays off */
      return null
    }
  },

  noteChunk(sec, chunk) {
    const cur = get().chunkDone[sec]
    if (cur?.includes(chunk)) return
    set({ chunkDone: { ...get().chunkDone, [sec]: [...(cur ?? []), chunk] } })
  },

  clearChunkDone(sec) {
    if (!(sec in get().chunkDone)) return
    const rest = { ...get().chunkDone }
    delete rest[sec]
    set({ chunkDone: rest })
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

  // Chapter jump: reading first, audio second. Ready section -> a plain seek.
  // Otherwise pause, move the reading cursor, and boost this section's audio
  // (lane 1, server-side) — text must never wait for TTS. ReaderView watches
  // `jump` and scrolls once the section has rendered.
  jumpToSection: (idx) => {
    const e = get().timeline?.byIndex[idx]
    set({
      followMode: true,
      jump: { idx, nonce: (get().jump?.nonce ?? 0) + 1 },
    })
    if (e?.ready) {
      get().seek(e.startMs)
      return
    }
    if (get().playing) get().pause()
    set({ sectionIdx: idx })
    const id = get().bookId
    if (id) void requestGeneration(id, idx).catch(() => undefined)
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
    // Percent is derived, never stored: global position over total audio
    // length. state.percent alone would sit frozen at the value we arrived
    // with, so the ring and the library card never rose.
    const pct =
      timeline.totalMs > 0
        ? Math.min(100, Math.max(0, (globalMs / timeline.totalMs) * 100))
        : percent
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
      percent: pct,
      active: get().playing ? 1 : 0,
      section_start_ms: timeline.byIndex[pos.section]?.startMs ?? 0,
    }
  },
}))

// Engine → store plumbing (module scope: registered once).
engine.onTick((ms) => {
  const st = usePlayerStore.getState()
  if (ms !== st.globalMs) {
    // ring tracks position live, one decimal to avoid per-frame re-renders
    const total = st.timeline?.totalMs ?? 0
    const pct =
      total > 0 ? Math.round(Math.min(100, (ms / total) * 1000)) / 10 : st.percent
    usePlayerStore.setState({ globalMs: ms, percent: pct })
  }
})
engine.onState(({ playing, sectionIdx }) => {
  usePlayerStore.setState({ playing, sectionIdx })
})
