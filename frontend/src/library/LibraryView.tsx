import { useEffect } from 'react'
import { useLibraryStore } from '../stores/libraryStore'
import BookCard from './BookCard'
import AddBookDialog from './AddBookDialog'

export default function LibraryView() {
  const books = useLibraryStore((s) => s.books)
  const loading = useLibraryStore((s) => s.loading)
  const error = useLibraryStore((s) => s.error)
  const dialogOpen = useLibraryStore((s) => s.dialogOpen)
  const openDialog = useLibraryStore((s) => s.openDialog)

  useEffect(() => {
    void useLibraryStore.getState().refresh()
  }, [])

  return (
    <div className="recite-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl p-6">
        <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Library</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {books.length} book{books.length === 1 ? '' : 's'}
          </p>
        </div>
        <button className="btn btn-accent btn-lg" onClick={openDialog}>
          + Add book
        </button>
      </div>

      {error && (
        <div
          className="mb-4 rounded-lg border p-3 text-sm"
          style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
        >
          Backend unreachable: {error}
        </div>
      )}

      {loading && books.length === 0 ? (
        <div style={{ color: 'var(--muted)' }}>Loading…</div>
      ) : books.length === 0 ? (
        <div
          className="card flex flex-col items-center gap-4 p-12 text-center"
        >
          <p style={{ color: 'var(--muted)' }}>
            Your library is empty. Add a PDF or EPUB from{' '}
            <code>~/Documents/BOOKS</code>.
          </p>
          <button className="btn btn-accent" onClick={openDialog}>
            + Add your first book
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {books.map((b) => (
            <BookCard key={b.id} book={b} />
          ))}
        </div>
      )}

      {dialogOpen && <AddBookDialog />}
      </div>
    </div>
  )
}
