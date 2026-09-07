// Timeline & seek-target equivalence tests. Pure functions only — no DOM.

import { describe, expect, it } from 'vitest'
import type { Manifest, ManifestChunk, ManifestSection } from '../types'
import {
  buildTimeline,
  globalToPosition,
  globalToReady,
  mergeSectionWords,
  positionToGlobal,
  readyToGlobal,
  wordAt,
  wordAtMs,
  type Timeline,
} from '../player/timeline'

const W = (w: number, s: number, e: number) => ({ w, s, e })

function chunk(
  idx: number,
  gs: number,
  words: { w: number; s: number; e: number }[],
  duration = 5000,
): ManifestChunk {
  return {
    idx,
    section: 0,
    para: idx,
    sentence_range: [0, 0],
    text: '',
    global_start_ms: gs,
    duration_ms: duration,
    status: 'ready',
    words,
  }
}

function section(
  idx: number,
  duration_ms: number,
  status: string,
  chunks: ManifestChunk[],
): ManifestSection {
  return {
    idx,
    title: `Section ${idx}`,
    audio: `audio/section-${String(idx).padStart(3, '0')}.mp3`,
    duration_ms,
    status,
    chunks,
  }
}

/**
 * 3-section book used across (a) and (b):
 *   s0 [0, 30000)   two chunks: words 0-2 then 3-4
 *   s1 [30000, 75000)  pending (gap) — used only in the gap tests
 *   s2 [75000, 135000) one chunk: words 0-1
 */
const M: Manifest = {
  engine: 'kokoro-test',
  voice: 'af_heart',
  alignment: 'interp',
  sections: [
    section(0, 30000, 'ready', [
      chunk(0, 0, [W(0, 100, 400), W(1, 400, 900), W(2, 900, 1400)], 1400),
      chunk(1, 5000, [W(3, 5100, 5600), W(4, 5600, 6200)], 1300),
    ]),
    section(1, 45000, 'pending', []),
    section(2, 60000, 'ready', [
      chunk(2, 0, [W(0, 200, 700), W(1, 700, 1200)], 1200),
    ]),
  ],
}

const TL: Timeline = buildTimeline(M)

describe('buildTimeline', () => {
  it('prefix-sums sections and ready-only totals', () => {
    expect(TL.totalMs).toBe(135000)
    expect(TL.readyMs).toBe(90000) // 30000 + 60000, the pending gap excluded
    expect(TL.byIndex[2].startMs).toBe(75000)
  })
})

describe('(a) wordAt across chunk boundaries', () => {
  it('section start → first word of first chunk', () => {
    const w = wordAt(TL, M, 0)!
    expect(w.chunk).toBe(0)
    expect(w.w).toBe(0)
    expect(w.s).toBe(100)
  })

  it('first word exactly at its start time', () => {
    const w = wordAt(TL, M, 100)!
    expect(w.w).toBe(0)
  })

  it('inter-chunk gap (t=2000) highlights the previous word', () => {
    const w = wordAt(TL, M, 2000)!
    expect(w.w).toBe(2)
    expect(w.chunk).toBe(0)
  })

  it('inter-chunk gap keeps the previous word active until the next starts', () => {
    // t=5000 sits in the inter-chunk gap; word 3 starts at s=5100
    expect(wordAt(TL, M, 5000)!.w).toBe(2)
    const w = wordAt(TL, M, 5100)! // chunk boundary: first word of chunk 1
    expect(w.chunk).toBe(1)
    expect(w.w).toBe(3)
  })

  it('last word of a section just before its end', () => {
    const w = wordAt(TL, M, 29999)! // last ms inside s0 (s1 is pending)
    expect(w.chunk).toBe(1)
    expect(w.w).toBe(4)
    expect(w.e).toBe(6200)
  })

  it('section start of the last section → its first word', () => {
    const w = wordAt(TL, M, 75000)!
    expect(w.section).toBe(2)
    expect(w.chunk).toBe(2)
    expect(w.w).toBe(0)
    expect(w.s).toBe(75200)
  })

  it('end of book → last word', () => {
    const w = wordAt(TL, M, 135000)!
    expect(w.w).toBe(1)
    expect(w.chunk).toBe(2)
    expect(w.e).toBe(76200)
  })

  it('merged array is sorted and wordAtMs picks the last-started word', () => {
    const words = mergeSectionWords(0, 0, M.sections[0].chunks)
    expect(words.map((w) => w.s)).toEqual([100, 400, 900, 5100, 5600])
    expect(wordAtMs(words, 899)!.w).toBe(1)
    expect(wordAtMs(words, 900)!.w).toBe(2)
    expect(wordAtMs(words, 699)!.w).toBe(1) // inside word 1's span [400,900)
    expect(wordAtMs(words, 6999)!.w).toBe(4)
  })
})

describe('(b) globalToPosition round-trips over 50 samples of a 3-section book', () => {
  it('positionToGlobal(globalToPosition(t)) === t for 50 sampled timestamps', () => {
    const { totalMs } = TL
    for (let i = 0; i < 50; i++) {
      // spread across the book, avoiding the exact end (clamping)
      const t = Math.floor((i * (totalMs - 1)) / 49)
      const pos = globalToPosition(TL, t)
      expect(positionToGlobal(TL, pos.section, pos.offset)).toBe(t)
    }
  })

  it('section boundaries resolve to the following section, offset 0', () => {
    expect(globalToPosition(TL, 30000)).toEqual({ section: 1, offset: 0 })
    expect(globalToPosition(TL, 75000)).toEqual({ section: 2, offset: 0 })
  })
})

describe('(c) seek-target equivalence', () => {
  // Every UI gesture reduces to a global-ms target; from the same target
  // they must produce an identical {section, offset}.
  const fromScrubber = (readyMs: number) =>
    globalToPosition(TL, readyToGlobal(TL, readyMs))
  const fromDelta = (cur: number, d: number) =>
    globalToPosition(TL, cur + d)
  const fromJump = (sec: number) =>
    globalToPosition(TL, positionToGlobal(TL, sec, 0))
  const fromBookmark = (sec: number, ms: number) =>
    globalToPosition(TL, positionToGlobal(TL, sec, ms))
  const fromResume = fromBookmark

  it('scrubber ↔ ±10s: same logical target, same resolution', () => {
    // a ready-axis target: global 90000 (= 80000 +10s, inside s2)
    const target = 90000
    expect(fromDelta(80000, 10000)).toEqual(globalToPosition(TL, target))
    // the scrubber maps back to the identical position
    expect(fromScrubber(globalToReady(TL, target))).toEqual(
      globalToPosition(TL, target),
    )
  })

  it('chapter jump ↔ resume: same {section, offset}', () => {
    // resume at section 2, +12345ms == bookmark at section 2 +12345 == jump
    expect(fromResume(2, 12345)).toEqual(fromBookmark(2, 12345))
    expect(fromResume(2, 12345)).toEqual({ section: 2, offset: 12345 })
    expect(fromJump(2)).toEqual(fromResume(2, 0))
    expect(fromJump(0)).toEqual(fromResume(0, 0))
  })

  it('±10s near the start clamps to the same position as an explicit 0 seek', () => {
    expect(fromDelta(5000, -10000)).toEqual(globalToPosition(TL, 0))
  })

  it('scrubber round-trips exactly for timestamps inside ready sections', () => {
    for (const g of [0, 12345, 29999, 75000, 99999, 134999]) {
      if (g >= 30000 && g < 75000) continue
      expect(readyToGlobal(TL, globalToReady(TL, g))).toBe(g)
    }
  })

  it('scrubber can never land inside a pending gap', () => {
    // the ready-axis boundary resolves to the NEXT ready section's start —
    // playback continues instead of dying at the very end of s0
    const g = readyToGlobal(TL, TL.readySegments[0].durationMs)
    expect(g).toBe(75000)
    // a timestamp inside the gap maps to the boundary, then onward to s2
    const inGap = globalToReady(TL, 50000)
    expect(inGap).toBe(30000)
    expect(readyToGlobal(TL, inGap)).toBe(75000)
  })
})
