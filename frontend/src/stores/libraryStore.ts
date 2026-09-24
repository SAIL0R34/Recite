import { create } from 'zustand'
import type { BookSummary, LibraryEntry } from '../types'
import * as api from '../api/client'

export interface Toast {
  id: number
  kind: 'error' | 'info'
  msg: string
}

interface LibraryState {
  books: BookSummary[]
  loading: boolean
  error: string | null

  dialogOpen: boolean
  adding: boolean
  addError: string | null
  entries: LibraryEntry[]

  toasts: Toast[]

  refresh: () => Promise<void>
  remove: (id: string) => Promise<void>
  openDialog: () => void
  closeDialog: () => void
  refreshBrowse: () => Promise<void>
  addByPath: (path: string) => Promise<boolean>
  addSample: () => Promise<void>
  toast: (kind: Toast['kind'], msg: string) => void
  dismissToast: (id: number) => void
}

let toastSeq = 1

export const useLibraryStore = create<LibraryState>((set, get) => ({
  books: [],
  loading: false,
  error: null,

  dialogOpen: false,
  adding: false,
  addError: null,
  entries: [],

  toasts: [],

  async refresh() {
    set({ loading: true, error: null })
    try {
      const books = await api.listBooks()
      set({ books, loading: false })
    } catch (e) {
      set({ loading: false, error: (e as Error).message })
    }
  },

  async remove(id) {
    try {
      await api.deleteBook(id)
      set({ books: get().books.filter((b) => b.id !== id) })
    } catch (e) {
      get().toast('error', (e as Error).message)
    }
  },

  openDialog: () => {
    set({ dialogOpen: true, addError: null })
    void get().refreshBrowse()
  },
  closeDialog: () => set({ dialogOpen: false }),

  async refreshBrowse() {
    try {
      set({ entries: await api.getLibrary() })
    } catch {
      set({ entries: [] })
    }
  },

  async addByPath(path) {
    set({ adding: true, addError: null })
    try {
      const { already_present } = await api.addBook(path)
      set({ adding: false })
      await get().refresh()
      if (already_present) get().toast('info', 'Already in your library.')
      else get().toast('info', 'Added — generating audio in the background.')
      return true
    } catch (e) {
      // 422/415 refusal (image-heavy, unreadable, …): surface backend detail.
      set({ adding: false, addError: (e as Error).message })
      return false
    }
  },

  async addSample() {
    if (get().adding) return
    set({ adding: true, addError: null })
    try {
      const { already_present } = await api.addSample()
      set({ adding: false })
      await get().refresh()
      get().toast(
        'info',
        already_present
          ? 'Sample book is already in your library.'
          : 'Sample added — generating audio in the background.',
      )
    } catch (e) {
      set({ adding: false })
      get().toast('error', (e as Error).message)
    }
  },

  toast(kind, msg) {
    const id = toastSeq++
    set({ toasts: [...get().toasts, { id, kind, msg }] })
    setTimeout(() => get().dismissToast(id), 4200)
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },
}))
