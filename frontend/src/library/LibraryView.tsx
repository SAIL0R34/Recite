import { useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useLibraryStore } from '../stores/libraryStore'
import { useFlightStore } from '../stores/flightStore'
import { startBookFlight } from '../motion'
import BookCard, { BookCover } from './BookCard'
import AddBookDialog from './AddBookDialog'

export default function LibraryView() {
  const books = useLibraryStore((s) => s.books)
  const loading = useLibraryStore((s) => s.loading)
  const error = useLibraryStore((s) => s.error)
  const dialogOpen = useLibraryStore((s) => s.dialogOpen)
  const openDialog = useLibraryStore((s) => s.openDialog)
  const adding = useLibraryStore((s) => s.adding)

  useEffect(() => {
    void useLibraryStore.getState().refresh()
  }, [])

  // While any book is still generating narration, refresh the list so its
  // progress bar moves; stop once everything is done.
  const generating = books.some(
    (b) => b.generation && b.generation.ready < b.generation.total,
  )
  useEffect(() => {
    if (!generating) return
    const t = setInterval(() => void useLibraryStore.getState().refresh(), 4000)
    return () => clearInterval(t)
  }, [generating])

  const hero = useMemo(
    () =>
      books
        .filter((b) => (b.percent ?? 0) > 0 && b.last_read)
        .sort((a, b) => (b.last_read! - a.last_read!))[0],
    [books],
  )
  const heroCoverRef = useRef<HTMLDivElement>(null)
  // while a cover lifts off the grid, the library recedes behind the scrim
  const flightActive = useFlightStore((s) => s.active)

  return (
    <div className="recite-scroll h-full overflow-y-auto">
      <div className={`mx-auto max-w-5xl p-6${flightActive ? ' library-recede' : ''}`}>
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

      {hero && (
        <Link
          to={`/book/${encodeURIComponent(hero.id)}`}
          className="card mb-6 flex items-center gap-5 p-4 transition-shadow hover:shadow-lg"
          title="Resume where you left off"
          onClick={(e) => {
            // hand off to the flight overlay (it navigates after the lift);
            // otherwise let the Link proceed normally
            if (startBookFlight(heroCoverRef.current, hero)) e.preventDefault()
          }}
        >
          <div className="w-20 shrink-0" ref={heroCoverRef}>
            <BookCover book={hero} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--accent)' }}>
              Continue reading
            </p>
            <h2 className="truncate text-lg font-semibold leading-snug">{hero.title}</h2>
            <p className="truncate text-sm" style={{ color: 'var(--muted)' }}>
              {hero.author || 'Unknown'} · {Math.round(hero.percent)}% read
            </p>
          </div>
          <span className="btn btn-accent shrink-0">Continue →</span>
        </Link>
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
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button className="btn btn-accent" onClick={openDialog}>
              + Add your first book
            </button>
            <button
              className="btn"
              disabled={adding}
              onClick={() => void useLibraryStore.getState().addSample()}
            >
              {adding ? 'Adding…' : 'Try the sample book'}
            </button>
          </div>
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
