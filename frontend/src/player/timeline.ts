// Pure timeline math over manifest v2. No DOM, no state — vitest covers
// this file directly (src/__tests__/timeline.test.ts).
//
// Coordinate systems
//   • GLOBAL ms  — prefix sums over ALL sections (incl. pending gaps).
//   • READY ms   — prefix sums over READY sections only; this is the axis the
//     scrubber shows, so un-generated audio never inflates the position bar.
//   • SECTION-RELATIVE ms — word timings in the manifest, plus a chunk's
//     global_start_ms offset within its section.

import type { Manifest, ManifestChunk, ManifestSection } from '../types'

export interface SectionEntry {
  section: number
  startMs: number
  durationMs: number
  endMs: number
  status: string
  ready: boolean
  title: string
}

export interface ReadySegment {
  section: number
  /** start on the READY axis */
  readyStart: number
  /** start on the GLOBAL axis */
  globalStart: number
  durationMs: number
}

export interface Timeline {
  entries: SectionEntry[]
  byIndex: Record<number, SectionEntry>
  /** total book duration on the global axis */
  totalMs: number
  /** total duration of ready sections only */
  readyMs: number
  readySegments: ReadySegment[]
}

export interface SectionPosition {
  section: number
  /** ms offset within that section */
  offset: number
}

export function buildTimeline(manifest: Manifest): Timeline {
  const sections: ManifestSection[] = [...(manifest?.sections ?? [])].sort(
    (a, b) => a.idx - b.idx,
  )
  const entries: SectionEntry[] = []
  const byIndex: Record<number, SectionEntry> = {}
  let cursor = 0
  for (const s of sections) {
    const durationMs = Math.max(0, s.duration_ms ?? 0)
    const e: SectionEntry = {
      section: s.idx,
      startMs: cursor,
      durationMs,
      endMs: cursor + durationMs,
      status: s.status,
      ready: s.status === 'ready',
      title: s.title ?? '',
    }
    entries.push(e)
    byIndex[s.idx] = e
    cursor += durationMs
  }
  const readySegments: ReadySegment[] = []
  let r = 0
  for (const e of entries) {
    if (e.ready) {
      readySegments.push({
        section: e.section,
        readyStart: r,
        globalStart: e.startMs,
        durationMs: e.durationMs,
      })
      r += e.durationMs
    }
  }
  return { entries, byIndex, totalMs: cursor, readyMs: r, readySegments }
}

/**
 * Resolve a global ms position to its section + offset. The section owning a
 * timestamp is the last section whose start is <= t (positions inside a
 * pending gap resolve to the section that follows them, so callers can look
 * for the next ready one). Out-of-range input is clamped.
 */
export function globalToPosition(tl: Timeline, ms: number): SectionPosition {
  const { entries } = tl
  if (!entries.length) return { section: 0, offset: 0 }
  const t = Math.max(0, Math.min(ms, tl.totalMs))
  let lo = 0
  let hi = entries.length - 1
  let idx = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (entries[mid].startMs <= t) {
      idx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const e = entries[idx]
  const offset = Math.max(0, Math.min(t - e.startMs, e.durationMs))
  return { section: e.section, offset }
}

/** Inverse of globalToPosition: section + offset → global ms (clamped). */
export function positionToGlobal(
  tl: Timeline,
  section: number,
  offset = 0,
): number {
  const e = tl.byIndex[section]
  if (!e) return 0
  return e.startMs + Math.max(0, Math.min(offset, e.durationMs))
}

/** READY-axis ms → GLOBAL ms. Positions landing in a gap clamp to the start
 * of the following ready segment (you can never seek into a gap). */
export function readyToGlobal(tl: Timeline, readyMs: number): number {
  const segs = tl.readySegments
  if (!segs.length) return 0
  const r = Math.max(0, Math.min(readyMs, tl.readyMs))
  let lo = 0
  let hi = segs.length - 1
  let idx = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segs[mid].readyStart <= r) {
      idx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const seg = segs[idx]
  if (r <= seg.readyStart + seg.durationMs) {
    return seg.globalStart + (r - seg.readyStart)
  }
  const next = segs[idx + 1]
  return next ? next.globalStart : seg.globalStart + seg.durationMs
}

/** GLOBAL ms → READY-axis ms (for the scrubber). Positions inside a pending
 * gap snap to the end of the previous ready segment. */
export function globalToReady(tl: Timeline, ms: number): number {
  const segs = tl.readySegments
  if (!segs.length) return 0
  const g = Math.max(0, Math.min(ms, tl.totalMs))
  for (const seg of segs) {
    if (g < seg.globalStart) return seg.readyStart
    if (g <= seg.globalStart + seg.durationMs) {
      return seg.readyStart + (g - seg.globalStart)
    }
  }
  return tl.readyMs
}

/** The chunk covering a section-relative ms offset (last chunk whose
 * global_start_ms is <= offset; first chunk if before all). */
export function chunkAt(
  chunks: ManifestChunk[],
  offsetMs: number,
): ManifestChunk | null {
  if (!chunks.length) return null
  let lo = 0
  let hi = chunks.length - 1
  let idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (chunks[mid].global_start_ms <= offsetMs) {
      idx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return idx < 0 ? chunks[0] : chunks[idx]
}

/** A word with GLOBAL-ms timing plus enough provenance to drive the reader. */
export interface FlatWord {
  s: number
  e: number
  section: number
  chunk: number
  /** index of the word within its chunk's words[] array */
  wordIdx: number
  /** the manifest `w` ordinal (word index within the chunk) */
  w: number
}

/**
 * Merge every ready chunk of one section into a single sorted (by s) array of
 * global-ms word timings. Chunks that aren't ready or lack word timings are
 * skipped — the shimmer/fallback path renders those without data attributes.
 */
export function mergeSectionWords(
  sectionIdx: number,
  globalStartMs: number,
  chunks: ManifestChunk[],
): FlatWord[] {
  const out: FlatWord[] = []
  for (const c of chunks) {
    if (c.status !== 'ready' || !c.words) continue
    const words = c.words
    for (let i = 0; i < words.length; i++) {
      const t = words[i]
      if (!t) continue
      out.push({
        s: globalStartMs + t.s,
        e: globalStartMs + t.e,
        section: sectionIdx,
        chunk: c.idx,
        wordIdx: i,
        w: t.w,
      })
    }
  }
  out.sort((a, b) => a.s - b.s)
  return out
}

/**
 * Binary-search a sorted word array for the word active at time t:
 * the last word with s <= t (so inter-word gaps highlight the previous
 * word — standard karaoke behaviour), or the first word if t precedes all.
 */
export function wordAtMs<T extends { s: number }>(
  words: T[],
  t: number,
): T | null {
  if (!words.length) return null
  let lo = 0
  let hi = words.length - 1
  let idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].s <= t) {
      idx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return idx < 0 ? words[0] : words[idx]
}

/** The word playing at a GLOBAL timestamp. */
export function wordAt(
  tl: Timeline,
  manifest: Manifest,
  ms: number,
): FlatWord | null {
  const pos = globalToPosition(tl, ms)
  const entry = tl.byIndex[pos.section]
  const sec = manifest?.sections?.find((s) => s.idx === pos.section)
  if (!entry || !sec) return null
  // merged timings are GLOBAL ms — binary-search on the global axis,
  // clamped to this section's range
  const t = Math.max(entry.startMs, Math.min(ms, entry.endMs))
  return wordAtMs(mergeSectionWords(pos.section, entry.startMs, sec.chunks), t)
}

/**
 * The single seek-target helper every UI gesture funnels through:
 * scrubber (READY axis), ±10s, chapter jump, bookmark, and resume all reduce
 * to "resolve a logical target to {section, offset}" — which is this.
 */
export function seekTargetFor(
  tl: Timeline,
  globalMs: number,
): SectionPosition {
  return globalToPosition(tl, globalMs)
}
