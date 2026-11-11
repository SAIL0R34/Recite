// Shelf contract: assorted spines never repeat adjacently, stay inside the
// curated palette, and reproduce the per-title hashes as their base.

import { describe, expect, it } from 'vitest'
import type { BookSummary } from '../types'
import {
  CLOTHS,
  assortSpines,
  chunk,
  sectionBooks,
  spineScale,
  spineTint,
  spineWidth,
  floatDelay,
} from '../library/shelf'

function book(id: string, title: string, over: Partial<BookSummary> = {}): BookSummary {
  return {
    id,
    title,
    author: 'A. Author',
    format: 'epub',
    status: 'ready',
    warnings: [],
    total_words: 1000,
    percent: 0,
    path: `/books/${id}.epub`,
    created_at: 1,
    updated_at: 1,
    last_read: null,
    generation: { ready: 1, total: 1, failed: 0 },
    ...over,
  } as BookSummary
}

const TITLES = [
  'The Elements of Power', 'The Power of Logic',
  'Introducing Symbolic Logic', 'Graph Theory and Its Applications',
  'A Book of Abstract Algebra', 'Topology from the Ground',
  'Real Analysis in One Variable', 'Set Theory for Beginners',
  'Category Theory Made Simple', 'Proofs and Refutations',
]

describe('assortSpines', () => {
  it('never repeats a cloth within the previous two books', () => {
    const books = TITLES.flatMap((t, i) => [
      book(`b${i}`, t),
      book(`b${i}x`, t + ' — Vol. II'), // force hash collisions often
    ])
    const slots = [...assortSpines(books).values()]
    expect(slots.length).toBe(books.length)
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].cloth).not.toBe(slots[i - 1].cloth)
      if (i >= 2) expect(slots[i].cloth).not.toBe(slots[i - 2].cloth)
    }
  })

  it('holds over 40 varied books', () => {
    const books = Array.from({ length: 40 }, (_, i) =>
      book(`x${i}`, `Volume ${i} of the Encyclopaedia`))
    const slots = [...assortSpines(books).values()]
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].cloth).not.toBe(slots[i - 1].cloth)
      expect(slots[i].width).not.toBe(slots[i - 1].width)
      expect(slots[i].tilt).not.toBe(slots[i - 1].tilt)
    }
  })

  it('uses only curated cloths', () => {
    const books = TITLES.map((t, i) => book(`c${i}`, t))
    for (const slot of assortSpines(books).values()) {
      expect(CLOTHS).toContain(slot.cloth)
      expect([30, 33, 36, 40, 44, 48, 54]).toContain(slot.width)
      expect(slot.tilt).toMatch(/^8[2-5]deg$/)
    }
  })

  it('is deterministic', () => {
    const books = TITLES.map((t, i) => book(`d${i}`, t))
    expect(assortSpines(books)).toEqual(assortSpines(books))
  })

  it('reproduces the base hashes when nothing collides (single book)', () => {
    const b = book('solo', 'One Lonely Book')
    const slot = assortSpines([b]).get('solo')!
    expect(slot.cloth).toBe(spineTint('One Lonely Book'))
    expect(slot.width).toBe(spineWidth('One Lonely Book'))
    expect(slot.scale).toBe(spineScale('One Lonely Book'))
    expect(slot.floatDelay).toBe(floatDelay('One Lonely Book'))
  })

  it('maps an empty library to nothing', () => {
    expect(assortSpines([]).size).toBe(0)
  })
})

describe('sectionBooks', () => {
  it('splits by progress and generation, dropping empty sections', () => {
    const out = sectionBooks([
      book('r1', 'Reading One', { percent: 42, last_read: 200 }),
      book('r2', 'Reading Two', { percent: 10, last_read: 300 }),
      book('g1', 'Cooking', { generation: { ready: 1, total: 9, failed: 0 } }),
      book('u1', 'Fresh'),
    ])
    expect(out.map((s) => s.key)).toEqual(['reading', 'generating', 'unread'])
    expect(out.map((s) => s.label)).toEqual([
      'Reading', 'Generating narration', 'Generated',
    ])
    expect(out[0].books.map((b) => b.id)).toEqual(['r2', 'r1']) // by recency
    expect(out[1].books.map((b) => b.id)).toEqual(['g1'])
  })
})

describe('chunk', () => {
  it('splits with a remainder row', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 3)).toEqual([])
  })
})
