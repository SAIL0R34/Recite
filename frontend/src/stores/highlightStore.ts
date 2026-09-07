// User highlights: select words in the reader -> tag -> persisted server-side.
// Anchored by (section_idx, para_idx, start_ti, end_ti) — the book text is
// static, so token offsets are stable anchors.

import { create } from 'zustand'
import type { Highlight } from '../types'
import {
  createHighlight,
  deleteHighlight,
  getHighlights,
} from '../api/client'

export interface NewHighlight {
  section_idx: number
  para_idx: number
  start_ti: number
  end_ti: number
  color: string
  text: string
}

interface HighlightState {
  bookId: string | null
  list: Highlight[]
  refresh: (bookId: string) => Promise<void>
  add: (h: NewHighlight) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useHighlightStore = create<HighlightState>((set, get) => ({
  bookId: null,
  list: [],

  async refresh(bookId) {
    try {
      const list = await getHighlights(bookId)
      set({ bookId, list })
    } catch {
      /* transient failure — highlights reappear on the next refresh */
    }
  },

  async add(h) {
    const { bookId, list } = get()
    if (!bookId) return
    try {
      const created = await createHighlight(bookId, h)
      set({ bookId, list: [...list, created] })
    } catch {
      /* transient server error; the mark is missing until retry */
    }
  },

  async remove(id) {
    const { bookId, list } = get()
    if (!bookId) return
    set({ bookId, list: list.filter((h) => h.id !== id) }) // optimistic
    try {
      await deleteHighlight(bookId, id)
    } catch {
      set({ bookId, list }) // restore
    }
  },
}))
