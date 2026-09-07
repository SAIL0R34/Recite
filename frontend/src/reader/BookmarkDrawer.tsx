import { useEffect, useState } from 'react'
import type { Bookmark } from '../types'
import {
  createBookmark,
  deleteBookmark,
  listBookmarks,
} from '../api/client'
import { usePlayerStore } from '../stores/playerStore'

/** Slide-over bookmark drawer: pin, rename, jump (seek), delete. */
export default function BookmarkDrawer({
  bookId,
  open,
  onClose,
  onPinned,
}: {
  bookId: string
  open: boolean
  onClose: () => void
  onPinned: (b: Bookmark) => void
}) {
  const [items, setItems] = useState<Bookmark[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const refresh = () =>
    listBookmarks(bookId)
      .then(setItems)
      .catch(() => setItems([]))

  // No PATCH route — rename = replace (delete + recreate keeps ms/section).
  const commitRename = async (b: Bookmark, name: string) => {
    if (name === b.name) return
    await deleteBookmark(bookId, b.id).catch(() => {})
    await createBookmark(bookId, {
      name,
      section_idx: b.section_idx,
      ms: b.ms,
    }).catch(() => {})
    await refresh()
  }

  useEffect(() => {
    if (open) refresh()
  }, [open, bookId])

  const pin = async () => {
    const st = usePlayerStore.getState()
    const pos = st.timeline
      ? (() => {
          const g = st.globalMs
          const e = st.timeline!.byIndex[st.sectionIdx]
          return { section_idx: st.sectionIdx, ms: e ? g - e.startMs : 0 }
        })()
      : { section_idx: 0, ms: 0 }
    try {
      const b = await createBookmark(bookId, {
        name: '',
        section_idx: pos.section_idx,
        ms: Math.round(pos.ms),
      })
      setItems((xs) => [...xs, b].sort((a, b2) => a.section_idx - b2.section_idx))
      onPinned(b)
    } catch {
      /* toast host handles */
    }
  }

  return (
    <aside
      className={`absolute right-0 top-0 z-30 flex h-full w-80 flex-col border-l transition-transform ${
        open ? 'translate-x-0' : 'translate-x-full'
      }`}
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <div className="flex items-center justify-between border-b p-3" style={{ borderColor: 'var(--border)' }}>
        <h3 className="font-semibold">Bookmarks</h3>
        <div className="flex gap-1">
          <button className="btn btn-sm" onClick={() => void pin()}>
            + Pin here
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <div className="recite-scroll flex-1 overflow-y-auto p-2">
        {items.length === 0 && (
          <p className="p-2 text-sm" style={{ color: 'var(--muted)' }}>
            None yet. Press B to pin the current passage.
          </p>
        )}
        {items.map((b) => (
          <div
            key={b.id}
            className="mb-1 flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--surface-2)]"
          >
            <button
              className="min-w-0 flex-1 truncate text-left text-sm"
              onClick={() => {
                const e = usePlayerStore.getState().timeline?.byIndex[b.section_idx]
                if (e)
                  usePlayerStore
                    .getState()
                    .seek(e.startMs + b.ms)
              }}
            >
              {editing === b.id ? (
                <input
                  autoFocus
                  className="input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    setEditing(null)
                    void commitRename(b, draft)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setEditing(null)
                      void commitRename(b, draft)
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  {b.name || `p. section ${b.section_idx + 1}`}{' '}
                  <span style={{ color: 'var(--muted)' }}>
                    ({b.section_idx + 1})
                  </span>
                </>
              )}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setEditing(b.id)
                setDraft(b.name)
              }}
              title="Rename"
            >
              ✎
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                void deleteBookmark(bookId, b.id).then(refresh)
              }}
              title="Delete"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </aside>
  )
}
