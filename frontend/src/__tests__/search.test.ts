// In-book search: pure functions only — no DOM.

import { describe, expect, it } from 'vitest'
import type { BookDocument } from '../types'
import { buildSearchIndex, searchIndex, snippet } from '../reader/search'

const doc: BookDocument = {
  id: 'b1',
  title: 'Test Book',
  author: 'Anon',
  format: 'epub',
  warnings: [],
  sections: [
    {
      idx: 0,
      title: 'Down the Hole',
      paragraphs: [
        {
          idx: 0,
          page: 1,
          anchor: null,
          no_tts: false,
          sentences: [
            { idx: 0, text: 'Alice was beginning to get very tired.', words: [] },
            { idx: 1, text: 'So she considered a daisy chain.', words: [] },
          ],
        },
      ],
    },
    {
      idx: 1,
      title: 'The Pool',
      paragraphs: [
        {
          idx: 0,
          page: 2,
          anchor: null,
          no_tts: false,
          sentences: [{ idx: 0, text: 'ALICE swam in her own tears.', words: [] }],
        },
      ],
    },
  ],
}

describe('buildSearchIndex', () => {
  it('carries section/para/sentence coordinates and titles', () => {
    const items = buildSearchIndex(doc)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({
      sec: 0, para: 0, sent: 0, title: 'Down the Hole',
    })
    expect(items[2].title).toBe('The Pool')
  })
})

describe('searchIndex', () => {
  const items = buildSearchIndex(doc)

  it('is case-insensitive and reports bounds', () => {
    const hits = searchIndex(items, 'alice')
    expect(hits).toHaveLength(2) // sentence + section title "The Pool"? no — title hit is "Pool" free
    expect(hits[0].start).toBe('Alice was…'.indexOf('Alice'))
    expect(hits[0].end).toBe(hits[0].start + 5)
  })

  it('matches section titles once per section', () => {
    const hits = searchIndex(items, 'pool')
    expect(hits).toHaveLength(1)
    expect(hits[0].sec).toBe(1)
    expect(hits[0].sent).toBe(-1)
    expect(hits[0].text).toBe('The Pool')
  })

  it('ignores queries shorter than 2 characters', () => {
    expect(searchIndex(items, 'a')).toEqual([])
    expect(searchIndex(items, '  ')).toEqual([])
  })

  it('caps results', () => {
    const many: BookDocument = {
      ...doc,
      sections: [
        {
          idx: 0,
          title: undefined as unknown as string,
          paragraphs: [
            {
              idx: 0,
              page: 1,
              anchor: null,
              no_tts: false,
              sentences: Array.from({ length: 50 }, (_, i) => ({
                idx: i,
                text: `teapot row ${i}`,
                words: [],
              })),
            },
          ],
        },
      ],
    }
    const hits = searchIndex(buildSearchIndex(many), 'teapot', 30)
    expect(hits).toHaveLength(30)
  })
})

describe('snippet', () => {
  it('wraps the match and clamps at the edges', () => {
    const hit = {
      sec: 0, para: 0, sent: 0, title: 't',
      text: 'word '.repeat(30) + 'needle' + ' word'.repeat(30),
      start: 150, end: 156,
    }
    const sn = snippet(hit)
    expect(sn.match).toBe('needle')
    expect(sn.pre.startsWith('…')).toBe(true)
    expect(sn.post.endsWith('…')).toBe(true)
    // no ellipses when the sentence is short
    const tight = { ...hit, text: 'a needle here', start: 2, end: 8 }
    expect(snippet(tight).pre).not.toContain('…')
  })
})
