import { useMemo, useState } from 'react'
import { useLibraryStore } from '../stores/libraryStore'

/** Add-book modal: path field + searchable browse list from
 *  GET /api/books/library. Surfaces the backend's 422 refusal detail. */
export default function AddBookDialog() {
  const entries = useLibraryStore((s) => s.entries)
  const adding = useLibraryStore((s) => s.adding)
  const addError = useLibraryStore((s) => s.addError)
  const closeDialog = useLibraryStore((s) => s.closeDialog)
  const refreshBrowse = useLibraryStore((s) => s.refreshBrowse)

  const [path, setPath] = useState('')
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q),
    )
  }, [entries, search])

  const add = async (p: string) => {
    const ok = await useLibraryStore.getState().addByPath(p)
    if (ok) closeDialog()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={closeDialog}
    >
      <div
        className="card flex max-h-[80vh] w-full max-w-xl flex-col p-5"
        style={{ background: 'var(--surface)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add a book</h2>
          <button className="btn btn-ghost btn-sm" onClick={closeDialog}>
            Esc
          </button>
        </div>

        <div className="mb-2 flex gap-2">
          <input
            className="input"
            placeholder="~/Documents/BOOKS/Title.epub"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && path.trim()) void add(path.trim()) }}
          />
          <button
            className="btn btn-accent"
            disabled={adding || !path.trim()}
            onClick={() => void add(path.trim())}
          >
            {adding ? 'Ingesting…' : 'Add'}
          </button>
        </div>

        {addError && (
          <div
            className="mb-2 rounded-lg border p-2 text-sm"
            style={{
              borderColor: 'color-mix(in srgb, red 40%, transparent)',
              color: 'rebeccapurple',
            }}
          >
            <strong>Refused: </strong>
            {addError}
          </div>
        )}

        <input
          className="input mb-2"
          placeholder="Search library folder…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div
          className="recite-scroll min-h-0 flex-1 overflow-y-auto rounded-lg border"
          style={{ borderColor: 'var(--border)' }}
        >
          {filtered.length === 0 ? (
            <p className="p-4 text-sm" style={{ color: 'var(--muted)' }}>
              Nothing here — try refreshing.
            </p>
          ) : (
            filtered.map((e) => (
              <button
                key={e.path}
                className="flex w-full items-baseline justify-between gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-[var(--surface-2)]"
                style={{ borderColor: 'var(--border)' }}
                disabled={adding}
                onClick={() => {
                  setPath(e.path)
                  void add(e.path)
                }}
              >
                <span className="truncate">{e.name}</span>
                <span className="shrink-0 text-xs" style={{ color: 'var(--muted)' }}>
                  {e.size ? `${Math.round(e.size / 1024)} KB` : ''}
                </span>
              </button>
            ))
          )}
        </div>
        <button
          className="btn btn-ghost btn-sm mt-2 self-start"
          onClick={() => void refreshBrowse()}
        >
          ↻ refresh list
        </button>
        {adding && (
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            Ingesting — parsing the document now…
          </p>
        )}
      </div>
    </div>
  )
}
