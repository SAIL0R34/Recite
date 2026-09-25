// Highlight menu toggle semantics: pure functions only — no DOM.

import { describe, expect, it } from 'vitest'
import { planMarkAction } from '../reader/highlights'

describe('planMarkAction', () => {
  it('adds a fresh mark on an unmarked passage', () => {
    expect(planMarkAction([], 'amber')).toEqual({
      removeIds: [],
      addColor: 'amber',
    })
  })

  it('removes the mark when the same color is chosen again', () => {
    expect(
      planMarkAction([{ id: 'h1', color: 'amber' }], 'amber'),
    ).toEqual({ removeIds: ['h1'], addColor: null })
  })

  it('replaces the mark with a different color instead of stacking', () => {
    expect(
      planMarkAction([{ id: 'h1', color: 'amber' }], 'sky'),
    ).toEqual({ removeIds: ['h1'], addColor: 'sky' })
  })

  it('clears every overlapping mark, toggling off if any matched', () => {
    const existing = [
      { id: 'h1', color: 'amber' },
      { id: 'h2', color: 'green' },
    ]
    expect(planMarkAction(existing, 'green')).toEqual({
      removeIds: ['h1', 'h2'],
      addColor: null,
    })
    expect(planMarkAction(existing, 'rose')).toEqual({
      removeIds: ['h1', 'h2'],
      addColor: 'rose',
    })
  })
})
