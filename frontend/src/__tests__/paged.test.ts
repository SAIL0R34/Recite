// Pagination math: pure functions only — no DOM.

import { describe, expect, it } from 'vitest'
import {
  clampPage,
  pageCountFor,
  pageForX,
  pageStep,
  sectionForPage,
} from '../reader/paged'

const g = { pageW: 400, gap: 48 }

describe('pageStep', () => {
  it('is page width plus gutter', () => {
    expect(pageStep(g)).toBe(448)
  })
})

describe('pageForX', () => {
  it('maps anchors and near-anchors to their page', () => {
    expect(pageForX(0, g)).toBe(0)
    expect(pageForX(448, g)).toBe(1)
    expect(pageForX(896, g)).toBe(2)
    // rounding: within ±half a step of an anchor snaps to it
    expect(pageForX(448 - 20, g)).toBe(1)
    expect(pageForX(448 + 20, g)).toBe(1)
  })

  it('clamps negatives to page 0', () => {
    expect(pageForX(-30, g)).toBe(0)
  })

  it('degrades to page 0 on degenerate geometry', () => {
    expect(pageForX(500, { pageW: 0, gap: 0 })).toBe(0)
  })
})

describe('pageCountFor', () => {
  it('is 1 for a short or empty strip', () => {
    expect(pageCountFor(0, g)).toBe(1)
    expect(pageCountFor(-5, g)).toBe(1)
    expect(pageCountFor(300, g)).toBe(1)
  })

  it('counts exact and ragged strips', () => {
    expect(pageCountFor(448, g)).toBe(1) // exactly one page, no overflow
    expect(pageCountFor(449, g)).toBe(2) // one px into the second column
    expect(pageCountFor(896, g)).toBe(2)
    expect(pageCountFor(2 * 448 + 10, g)).toBe(3)
  })
})

describe('clampPage', () => {
  it('bounds the page into [0, count-1]', () => {
    expect(clampPage(-1, 5)).toBe(0)
    expect(clampPage(3, 5)).toBe(3)
    expect(clampPage(9, 5)).toBe(4)
    expect(clampPage(0, 0)).toBe(0)
  })
})

describe('sectionForPage', () => {
  const bounds = [
    { sec: 0, page: 0 },
    { sec: 1, page: 3 },
    { sec: 2, page: 7 },
  ]

  it('returns the section whose start page precedes the page', () => {
    expect(sectionForPage(bounds, 0)).toBe(0)
    expect(sectionForPage(bounds, 2)).toBe(0)
    expect(sectionForPage(bounds, 3)).toBe(1)
    expect(sectionForPage(bounds, 6)).toBe(1)
    expect(sectionForPage(bounds, 7)).toBe(2)
    expect(sectionForPage(bounds, 99)).toBe(2)
  })

  it('falls back to the first section', () => {
    expect(sectionForPage([], 4)).toBe(0)
  })
})
